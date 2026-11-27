// Failing tests found in a shard log (built in, not per profile): vitest `FAIL <file> > <name>` / `× <name>` lines and
// Playwright `✘ … <file>:<line>:<col> › <title>` lines. Plus the escaping of GitHub workflow commands.

export type Failure = {
  shard: string
  tool: 'vitest' | 'playwright'
  /** as printed by the runner (vitest: project-relative; Playwright: testDir-relative unless a stack line gives more) */
  file: string | null
  line: number | null
  col: number | null
  /** the test's name (suites joined with " > " / " › ") */
  title: string
  /** the first error line, when the log shows one */
  message: string | null
}

// CSI (colours, cursor), OSC (hyperlinks, titles) and two-byte escapes
const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g
export const stripAnsi = (s: string) => s.replace(ANSI, '')

const VITEST_FAIL = /^\s*FAIL\s+(?:\|[^|]+\|\s+)?(\S+?\.[cm]?[jt]sx?)\s+>\s+(.+?)\s*$/
const VITEST_FILE = /^\s*[❯›>]\s+(?:\|[^|]+\|\s+)?(\S+?\.[cm]?[jt]sx?)\s+\(\d+ tests?/
const VITEST_CROSS = /^\s*[×✗]\s+(.+?)(?:\s+\d+(?:\.\d+)?m?s)?\s*$/
const VITEST_AT = /^\s*❯\s+(\S+?\.[cm]?[jt]sx?):(\d+):(\d+)\s*$/
const PW_FAIL = /^\s*✘\s+(?:\d+\s+)?(?:\[[^\]]+\]\s+›\s+)?(\S+?):(\d+):(\d+)\s+›\s+(.+?)\s*$/
const PW_PASS = /^\s*[✓✔]\s+(?:\d+\s+)?(?:\[[^\]]+\]\s+›\s+)?(\S+?):(\d+):(\d+)\s+›\s+(.+?)\s*$/
const PW_BLOCK = /^\s*\d+\)\s+(?:\[[^\]]+\]\s+›\s+)?(\S+?):(\d+):(\d+)\s+›\s+(.+?)\s*$/
const PW_TAIL = /(?:\s+\(retry #\d+\))?(?:\s+\(\d+(?:\.\d+)?(?:ms|s|m)\))?$/

const pwTitle = (t: string) => t.replace(PW_TAIL, '').trim()

/** The first error line of the block that starts after line `i`. */
function firstError(lines: string[], i: number, stop: RegExp): string | null {
  for (let j = i + 1; j < Math.min(lines.length, i + 30); j++) {
    const l = lines[j].trim()
    if (stop.test(lines[j])) return null
    if (l) return l.slice(0, 500)
  }
  return null
}

/** Repo-relative path for a Playwright file printed relative to its testDir, using a stack line's absolute path when
 * the checkout's directory (`<name>` or `<owner>__<name>`) shows in it. */
function repoPath(file: string, lines: string[], from: number, repo: string | undefined): string {
  if (!repo) return file
  const [owner, name] = repo.split('/')
  for (let j = from; j < Math.min(lines.length, from + 200); j++) {
    const m = /\bat (\/\S+?):\d+:\d+/.exec(lines[j])
    if (!m || !m[1].endsWith(`/${file}`)) continue
    const parts = m[1].split('/')
    const k = Math.max(parts.lastIndexOf(name), parts.lastIndexOf(`${owner}__${name}`))
    if (k >= 0) return parts.slice(k + 1).join('/')
  }
  return file
}

/** Failing tests in one shard's log, in log order, one per test (retries and repeats folded; Playwright tests that
 * passed on a retry are flaky, not failures). */
export function parseFailures(shard: string, log: string, repo?: string): Failure[] {
  const lines = stripAnsi(log).replace(/\r(?!\n)/g, '\n').split(/\r?\n/)
  const out: Failure[] = []
  const seen = new Set<string>()
  const add = (f: Failure) => {
    const k = `${f.tool}\u0000${f.file}\u0000${f.title}`
    if (seen.has(k)) return
    seen.add(k)
    out.push(f)
  }

  // vitest: FAIL lines (file + full name; the next `❯ file:line:col` gives the place)
  const vitest: Failure[] = []
  lines.forEach((l, i) => {
    const m = VITEST_FAIL.exec(l)
    if (!m) return
    let line: number | null = null
    let col: number | null = null
    for (let j = i + 1; j < Math.min(lines.length, i + 60); j++) {
      if (VITEST_FAIL.test(lines[j])) break
      const at = VITEST_AT.exec(lines[j])
      if (at && (at[1] === m[1] || m[1].endsWith(`/${at[1]}`) || at[1].endsWith(`/${m[1]}`))) {
        line = Number(at[2])
        col = Number(at[3])
        break
      }
    }
    vitest.push({ shard, tool: 'vitest', file: m[1], line, col, title: m[2], message: firstError(lines, i, VITEST_FAIL) })
  })
  // vitest: `×` lines under a `❯ file (n tests | m failed)` line, when no FAIL line names the test
  let file: string | null = null
  lines.forEach((l) => {
    const f = VITEST_FILE.exec(l)
    if (f) {
      file = f[1]
      return
    }
    const m = VITEST_CROSS.exec(l)
    if (!m || !file) return
    const name = m[1]
    if (vitest.some((v) => v.file === file && (v.title === name || v.title.endsWith(` > ${name}`)))) return
    vitest.push({ shard, tool: 'vitest', file, line: null, col: null, title: name, message: null })
  })
  vitest.forEach(add)

  // Playwright: ✘ lines; a later ✓ for the same test means it was flaky
  const passed = new Set<string>()
  for (const l of lines) {
    const m = PW_PASS.exec(l)
    if (m) passed.add(`${m[1]}:${m[2]}:${m[3]} ${pwTitle(m[4])}`)
  }
  const messages = new Map<string, { message: string | null; at: number }>()
  lines.forEach((l, i) => {
    const m = PW_BLOCK.exec(l)
    if (m) {
      const k = `${m[1]}:${m[2]}:${m[3]} ${pwTitle(m[4])}`
      if (!messages.has(k)) messages.set(k, { message: firstError(lines, i, PW_BLOCK), at: i })
    }
  })
  lines.forEach((l, i) => {
    const m = PW_FAIL.exec(l)
    if (!m) return
    const title = pwTitle(m[4])
    const k = `${m[1]}:${m[2]}:${m[3]} ${title}`
    if (passed.has(k)) return
    const block = messages.get(k)
    add({
      shard, tool: 'playwright', file: repoPath(m[1], lines, block?.at ?? i, repo), line: Number(m[2]), col: Number(m[3]), title,
      message: block?.message ?? null,
    })
  })
  return out
}

// ------------------------------------------------------------------ workflow commands

/** Escape a workflow command's message (data). */
export const escapeData = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
/** Escape a workflow command's property value. */
export const escapeProperty = (s: string) => escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C')

/** `::error file=…,line=…,col=…,title=…::message` */
export function errorCommand(f: Failure): string {
  const props: string[] = []
  if (f.file) props.push(`file=${escapeProperty(f.file)}`)
  if (f.file && f.line !== null) props.push(`line=${f.line}`)
  if (f.file && f.col !== null) props.push(`col=${f.col}`)
  props.push(`title=${escapeProperty(`[${f.shard}] ${f.title}`.slice(0, 250))}`)
  const msg = f.message ? `${f.title}\n${f.message}` : f.title
  return `::error ${props.join(',')}::${escapeData(msg)}`
}

/** `file:line` for the summary list */
export const failurePlace = (f: Failure) => (f.file ? `${f.file}${f.line !== null ? `:${f.line}` : ''}` : '')
