// `ci-broker submit --github`: what a runner job needs beyond the receipt. Workflow commands stopped around anything
// test output can reach, failing shards' logs in groups, up to 10 `::error` annotations, the receipt in the step
// summary (capped), and the job's artifacts + shard logs in $GITHUB_WORKSPACE/ci-broker-artifacts/.
import { randomBytes } from 'node:crypto'
import { appendFileSync, closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { excerpt } from '../../core/summary.ts'
import { errorCommand, failurePlace, parseFailures, stripAnsi, type Failure } from './annotations.ts'
import type { JobView } from './receipt.ts'

export const MAX_ANNOTATIONS = 10
export const SUMMARY_CAP = 900 * 1024
export const GROUP_LOG_MAX = 2 * 1024 * 1024
export const ARTIFACTS_DIR = 'ci-broker-artifacts'

export type GithubEnv = { summaryFile: string; workspace: string; runUrl: string | null; runLabel: string | null }

/** The runner's env; throws when a required variable is missing. */
export function githubEnv(env: NodeJS.ProcessEnv): GithubEnv {
  const missing = ['GITHUB_STEP_SUMMARY', 'GITHUB_WORKSPACE'].filter((k) => !env[k])
  if (missing.length) throw new Error(`--github needs the GitHub Actions env (missing ${missing.join(', ')}); run it from a workflow step`)
  const runUrl = env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : null
  const runLabel = env.GITHUB_RUN_ID ? `github run ${env.GITHUB_RUN_ID}${env.GITHUB_RUN_ATTEMPT && env.GITHUB_RUN_ATTEMPT !== '1' ? `.${env.GITHUB_RUN_ATTEMPT}` : ''}${env.GITHUB_WORKFLOW ? ` (${env.GITHUB_WORKFLOW})` : ''}` : null
  return { summaryFile: env.GITHUB_STEP_SUMMARY!, workspace: env.GITHUB_WORKSPACE!, runUrl, runLabel }
}

/** A token for `::stop-commands::` that can't be guessed by test output. */
export const stopToken = () => randomBytes(16).toString('hex')

/** The last `max` bytes of a file (starting at a line boundary when cut). */
export function readTail(file: string, max: number): { text: string; cut: boolean } {
  if (!existsSync(file)) return { text: '', cut: false }
  const size = statSync(file).size
  if (size <= max) return { text: readFileSync(file, 'utf8'), cut: false }
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(max)
    readSync(fd, buf, 0, max, size - max)
    const s = buf.toString('utf8')
    const nl = s.indexOf('\n')
    return { text: nl >= 0 ? s.slice(nl + 1) : s, cut: true }
  } finally {
    closeSync(fd)
  }
}

const failing = (job: JobView) => (job.shards ?? []).filter((s) => s.state === 'failed' || s.state === 'error')
/** `dir`: where the job's `<shard>.log` files are readable (a split daemon's files.tar, extracted) */
const logOf = (dir: string, shard: string) => join(dir, `${shard}.log`)

/** Each failing shard's log (last 2 MB) in a collapsed group; commands stay stopped inside it. */
export function failingGroups(job: JobView, out: (s: string) => void, token = stopToken, dir = job.dir) {
  for (const s of failing(job)) {
    const { text, cut } = readTail(logOf(dir, s.name), GROUP_LOG_MAX)
    if (!text) continue
    const t = token()
    out(`::group::${s.name}\n`)
    out(`::stop-commands::${t}\n`)
    if (cut) out(`(the last 2 MB of the log; the whole log is in the ${ARTIFACTS_DIR} artifact)\n`)
    out(text.endsWith('\n') ? text : `${text}\n`)
    out(`::${t}::\n`)
    out('::endgroup::\n')
  }
}

/** Failing tests across the failing shards' logs, in shard order. */
export function failures(job: JobView, dir = job.dir): Failure[] {
  return failing(job).flatMap((s) => parseFailures(s.name, readTail(logOf(dir, s.name), GROUP_LOG_MAX).text, job.repo))
}

const fence = (s: string) => '`'.repeat(Math.max(3, ...[...s.matchAll(/`+/g)].map((m) => m[0].length + 1)))
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')
const md = (s: string) => s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!)
const bytes = (s: string) => Buffer.byteLength(s)

function cutBytes(s: string, max: number): string {
  if (bytes(s) <= max) return s
  return Buffer.from(s).subarray(0, Math.max(0, max)).toString('utf8').replace(/�$/, '')
}

export type SummaryInput = {
  job: JobView
  statusLine: string
  reused: boolean
  /** shown as annotations (the first MAX_ANNOTATIONS) */
  failures: Failure[]
  runUrl?: string | null
  /** what the client did when it didn't follow the job to its end */
  note?: string
  cap?: number
  /** where the shard logs are readable (default the job dir: a single daemon) */
  dir?: string
}

/** The step summary markdown, at most `cap` bytes: per-shard excerpts are trimmed first, then the failure list. */
export function stepSummary(i: SummaryInput): string {
  const cap = i.cap ?? SUMMARY_CAP
  const { job } = i
  const dir = i.dir ?? job.dir
  const state = job.state.toUpperCase()
  const icon = job.state === 'passed' ? '✅' : job.state === 'failed' ? '❌' : job.state === 'cancelled' ? '⏹️' : '⚠️'
  const head: string[] = [
    `### ${icon} ci-broker: ${state} — ${cell(job.profile)}/${cell(job.mode)}${job.args.length ? ` \`-- ${cell(job.args.join(' '))}\`` : ''}`,
    '',
    `\`${job.repo}\` \`${job.commit.slice(0, 12)}\`${job.source === 'snapshot' ? ' (snapshot)' : ''} · job \`${job.id}\`${job.summary ? ` · ${job.summary.secs}s` : ''}`,
  ]
  if (i.reused) head.push('', `Reused job \`${job.id}\`: the same tree, profile and args already passed.`)
  if (i.note) head.push('', md(i.note))
  if (job.error) head.push('', `**Error:** ${md(job.error)}`)
  const rows: any[] = job.summary?.json?.shards ?? (job.shards ?? []).map((s) => ({ name: s.name, size: s.size, where: s.where ?? '-', secs: s.startedAt && s.endedAt ? Math.round((s.endedAt - s.startedAt) / 1000) : 0, totals: '', reason: s.reason, pass: s.state === 'passed' }))
  const table: string[] = []
  if (rows.length) {
    table.push('', '| | shard | size | where | time | totals |', '|---|---|---|---|---|---|')
    for (const r of rows) table.push(`| ${r.pass ? '✅' : '❌'} | ${cell(r.name)} | ${cell(r.size)} | ${cell(r.where ?? '-')} | ${r.secs}s | ${cell(`${r.reason ? `${r.reason}; ` : ''}${r.totals ?? ''}`)} |`)
  }
  const foot: string[] = ['', `**${md(i.statusLine)}**`, '', `Logs: \`ci-broker logs ${job.id}\`${job.artifacts.length || failing(job).length ? ` · artifacts and shard logs: the \`${ARTIFACTS_DIR}\` artifact` : ''}${i.runUrl ? ` · [run](${i.runUrl})` : ''}`]
  const failLines = i.failures.map((f, n) => `- ${n < MAX_ANNOTATIONS ? '' : '(not annotated) '}\`${cell(f.shard)}\` ${failurePlace(f) ? `\`${cell(failurePlace(f))}\` ` : ''}${md(f.title)}${f.message ? ` — ${md(f.message)}` : ''}`)
  const failHead = i.failures.length
    ? ['', `#### Failing tests (${i.failures.length}${i.failures.length > MAX_ANNOTATIONS ? `; the first ${MAX_ANNOTATIONS} are annotations` : ''})`, '']
    : []
  const excerpts = failing(job).map((s) => ({ name: s.name, text: stripAnsi(excerpt(readTail(logOf(dir, s.name), GROUP_LOG_MAX).text)) })).filter((e) => e.text.trim())
  const render = (ex: { name: string; text: string }[], fl: string[], cutNote: string) => {
    const parts = [...head, ...table, ...failHead, ...fl]
    for (const e of ex) {
      const f = fence(e.text)
      parts.push('', `<details><summary>${md(e.name)} failures</summary>`, '', f, e.text, f, '', '</details>')
    }
    if (cutNote) parts.push('', cutNote)
    return [...parts, ...foot].join('\n') + '\n'
  }
  let s = render(excerpts, failLines, '')
  if (bytes(s) <= cap) return s
  // 1. trim the excerpts: an even share each, then none
  const note = '_(trimmed to fit the step summary; the whole logs are in the artifact)_'
  const fixed = bytes(render(excerpts.map((e) => ({ ...e, text: '' })), failLines, note))
  const share = Math.floor((cap - fixed - 64) / Math.max(1, excerpts.length))
  if (share > 200) {
    s = render(excerpts.map((e) => ({ ...e, text: cutBytes(e.text, share) + (bytes(e.text) > share ? '\n…' : '') })), failLines, note)
    if (bytes(s) <= cap) return s
  }
  s = render([], failLines, note)
  if (bytes(s) <= cap) return s
  // 2. then the failure list
  const lines = [...failLines]
  while (lines.length && bytes(render([], lines, note)) > cap) lines.splice(Math.max(0, lines.length - Math.ceil(lines.length / 4)))
  s = render([], [...lines, ...(lines.length < failLines.length ? [`- … and ${failLines.length - lines.length} more`] : [])], note)
  return bytes(s) <= cap ? s : cutBytes(s, cap - 4) + '\n…\n'
}

export function writeStepSummary(file: string, markdown: string) {
  appendFileSync(file, markdown)
}

/** Empty $GITHUB_WORKSPACE/ci-broker-artifacts/ (a runner's workspace outlives its jobs). */
export function emptyArtifactsDir(workspace: string): string {
  const dir = join(workspace, ARTIFACTS_DIR)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Copy the job's artifacts (`<shard>/…`) and `<shard>.log` files from `src` (the files dir) into `dir`; returns how many entries. */
export function fillArtifactsDir(src: string, dir: string): number {
  let n = 0
  const art = join(src, 'artifacts')
  if (existsSync(art))
    for (const e of readdirSync(art)) {
      cpSync(join(art, e), join(dir, e), { recursive: true })
      n++
    }
  if (existsSync(src))
    for (const f of readdirSync(src))
      if (f.endsWith('.log')) {
        cpSync(join(src, f), join(dir, f))
        n++
      }
  return n
}

export function annotationLines(fs: Failure[]): string[] {
  return fs.slice(0, MAX_ANNOTATIONS).map(errorCommand)
}
