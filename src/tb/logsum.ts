// A shard's output in short, built line by line as it streams in (so a 7 MB log costs no second read). runs.db keeps
// it after the log file is compressed or deleted: `test-broker usage --runs --json` gives it to the analysis tools.
import type { LogSummary } from './runs-db.ts'

const MAX_PHASES = 30
const MAX_FAILING = 20
const MAX_NAME = 200
const TOP_SOURCES = 5
/** a source map this big is folded into the rest (a suite printing from thousands of files) */
const MAX_SOURCE_KEYS = 2000
const REST = '(rest)'

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g
/** `=== [12s] pnpm install` (the remote scripts' timed steps); `=== [85s] done: …` ends the last one */
const PHASE = /^=== \[(\d+)s\] (.+)$/
/** vitest `Tests  1 failed | 12332 passed | 4 skipped (12337)`, a test-runner total `Tests  15971 passed, 4 skipped (…)`,
 *  pytest `==== 28 passed, 2 failed in 2.45s ====`, playwright `  3 failed` / `  10 passed (1.2m)` */
const VITEST_COUNTS = /^\s*Tests\s{2,}\d/
const PYTEST_COUNTS = /^=+ \d+ (?:passed|failed|skipped|errors?)\b/
/** a line longer than this is only counted (no pattern runs on it: a dump of JSON is not a test line) */
const MAX_PARSED_LINE = 1000
const PW_COUNT = /^\s{2}(\d+) (passed|failed|skipped|flaky)\b/
/** vitest ` FAIL  <file> > <suite> > <test>`, pytest `FAILED <path>::<test> - …`, playwright `  1) [chromium] › <spec> › <title>` */
const FAILING = [/^\s*FAIL\s+(.+? > .+)$/, /^FAILED (\S+::\S+)/, /^\s*\d+\) \[[\w-]+\] › (.+)$/]
/** vitest's console blocks: `stdout | <file> > <test>` up to a blank line */
const BLOCK = /^(stdout|stderr) \| (\S+)/

export class LogSummer {
  private bytes = 0
  private lines = 0
  private part = ''
  private phases: { name: string; at: number }[] = []
  private end: number | null = null
  private tests: LogSummary['tests'] = null
  private pw: { passed: number; failed: number; skipped: number } | null = null
  private failing: string[] = []
  private source: string | null = null
  private sources = new Map<string, number>()

  feed(chunk: string) {
    this.bytes += Buffer.byteLength(chunk)
    const s = this.part + chunk
    const ls = s.split('\n')
    this.part = ls.pop()!
    // a line with no end in sight (a progress bar) is cut, not kept whole
    if (this.part.length > 65536) {
      this.line(this.part)
      this.part = ''
    }
    for (const l of ls) this.line(l)
  }

  private line(raw: string) {
    this.lines++
    const l = raw.replace(ANSI, '').replace(/\r$/, '')
    const n = Buffer.byteLength(raw) + 1
    const b = BLOCK.exec(l)
    if (b) this.source = b[2]
    else if (!l.trim()) this.source = null
    const key = this.source ?? REST
    if (this.sources.has(key) || this.sources.size < MAX_SOURCE_KEYS) this.sources.set(key, (this.sources.get(key) ?? 0) + n)
    else this.sources.set(REST, (this.sources.get(REST) ?? 0) + n)
    if (l.length > MAX_PARSED_LINE) return
    const p = PHASE.exec(l)
    if (p) {
      const at = Number(p[1])
      if (/^done\b/.test(p[2])) this.end = at
      else if (this.phases.length < MAX_PHASES) this.phases.push({ name: phaseName(p[2]), at })
      return
    }
    if (VITEST_COUNTS.test(l) || PYTEST_COUNTS.test(l)) this.tests = counts(l)
    const pw = PW_COUNT.exec(l)
    if (pw) {
      this.pw ??= { passed: 0, failed: 0, skipped: 0 }
      const k = pw[2] === 'flaky' ? 'passed' : (pw[2] as 'passed' | 'failed' | 'skipped')
      this.pw[k] = Number(pw[1])
    }
    if (this.failing.length < MAX_FAILING)
      for (const re of FAILING) {
        const m = re.exec(l)
        if (m) {
          const name = m[1].trim().slice(0, MAX_NAME)
          if (!this.failing.includes(name)) this.failing.push(name)
          break
        }
      }
  }

  result(): LogSummary {
    if (this.part) {
      this.line(this.part)
      this.part = ''
    }
    const phases = this.phases.map((p, i) => {
      const next = this.phases[i + 1]?.at ?? this.end
      return { name: p.name, secs: next != null ? Math.max(0, next - p.at) : 0 }
    })
    const top = [...this.sources.entries()].filter(([k]) => k !== REST).sort((a, b) => b[1] - a[1])
    const rest = (this.sources.get(REST) ?? 0) + top.slice(TOP_SOURCES).reduce((n, [, v]) => n + v, 0)
    return {
      bytes: this.bytes, lines: this.lines, phases, tests: this.tests ?? this.pw, failing: this.failing,
      sources: [...top.slice(0, TOP_SOURCES).map(([source, bytes]) => ({ source, bytes })), ...(rest ? [{ source: REST, bytes: rest }] : [])],
    }
  }
}

/** a step's name without what changes from run to run (commit shas, numbers in paths) */
function phaseName(s: string): string {
  return s.replace(/\b[0-9a-f]{12,40}\b/g, '<sha>').trim().slice(0, 80)
}

function counts(l: string): { passed: number; failed: number; skipped: number } {
  const n = (k: string) => {
    const m = new RegExp(`(\\d+) ${k}`).exec(l)
    return m ? Number(m[1]) : 0
  }
  return { passed: n('passed'), failed: n('failed') + n('errors?'), skipped: n('skipped') }
}
