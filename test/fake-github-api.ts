// A fake `gh api -i` behind the daemon's GithubApi (the real parser reads its output). Every answer is built from a
// fixture recorded from the real API in the stage-0 spike (test/ci/fixtures/github/), with the fields a test needs set,
// so a field GitHub names differently fails a test. Knobs: offline, timeouts, failNext (status + headers), primary and
// secondary rate limits, a mutator per path (null a field), and setters that flip a repo at any moment.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { GhRun } from '../src/ci/daemon/github-api.ts'

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'ci', 'fixtures', 'github')

/** The recorded raw `gh api -i` text of a fixture. */
export const fixtureRaw = (name: string): { raw: string; ghExit: number } => {
  const f = JSON.parse(readFileSync(join(FIX, `${name}.json`), 'utf8'))
  return { raw: f.ghApiI, ghExit: f.ghExit }
}
/** The JSON body of a fixture. */
export const fixtureBody = (name: string): any => {
  const raw = fixtureRaw(name).raw
  const i = raw.indexOf('\r\n\r\n')
  return JSON.parse(raw.slice(i + 4))
}
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))

export type Account = { login: string; id: number; type?: string }
export const SIMPLE10: Account = { login: 'simple10', id: 104495 }
export const VU: Account = { login: 'octo-other', id: 304762783 }
export const EVE: Account = { login: 'eve', id: 9 }
export const DEPENDABOT: Account = { login: 'dependabot[bot]', id: 49699333, type: 'Bot' }

const who = (a: Account) => ({ ...clone(fixtureBody('attempt-pr.hook').actor), login: a.login, id: a.id, type: a.type ?? 'User' })

type Fail = { re: RegExp; status: number; headers: Record<string, string>; body: string; times: number }

export class FakeGithubApi {
  /** every path asked for (after `api -i`), in order */
  calls: string[] = []
  offline = false
  /** paths matching this time out */
  timeout: RegExp | null = null
  private fails: Fail[] = []
  private mutators: { re: RegExp; fn: (body: any) => void }[] = []
  private repos = new Map<string, { full: string; private: boolean; push: boolean; defaultBranch: string } | null>()
  private bodies = new Map<string, any>()
  /** repos with no setRepo answer as this (the harness: every test repo private with push); null = 404 */
  everyRepo: { private: boolean; push: boolean } | null = null
  /** answers wait for this (a slow API: tests hold a call mid-flight) */
  gate: Promise<void> | null = null
  /** called before each answer (tests flip state mid-flight) */
  onCall: ((path: string) => void) | null = null
  /** the epoch seconds a primary rate limit resets at */
  resetAt = 1_794_376_718

  /** A repo answer; null = 404. Default: private with push, default branch main. */
  setRepo(repo: string, o: Partial<{ private: boolean; push: boolean; defaultBranch: string; fullName: string }> | null = {}) {
    if (o === null) return void this.repos.set(repo.toLowerCase(), null)
    const prev = this.repos.get(repo.toLowerCase())
    this.repos.set(repo.toLowerCase(), { full: o.fullName ?? prev?.full ?? repo, private: o.private ?? prev?.private ?? true, push: o.push ?? prev?.push ?? true, defaultBranch: o.defaultBranch ?? prev?.defaultBranch ?? 'main' })
  }

  /** A run attempt plus its jobs answer. */
  addRun(o: {
    repo: string; runId: number; attempt?: number; event?: string; sha: string; branch?: string; actor?: Account; triggering?: Account
    path?: string; title?: string; status?: string; headRepo?: string; runner?: string | null; jobStatus?: string
  }) {
    const attempt = o.attempt ?? 1
    const base = clone(fixtureBody(o.event === 'pull_request' ? 'attempt-pr.hook' : 'attempt-dispatch.hook'))
    Object.assign(base, {
      id: o.runId, run_attempt: attempt, event: o.event ?? 'workflow_dispatch', status: o.status ?? 'in_progress', path: o.path ?? '.github/workflows/broker.yml',
      head_sha: o.sha, head_branch: o.branch ?? 'main', display_title: o.title ?? `broker all ${o.sha} -`,
    })
    base.repository = { ...base.repository, full_name: o.repo }
    base.head_repository = { ...base.head_repository, full_name: o.headRepo ?? o.repo }
    base.actor = who(o.actor ?? VU)
    base.triggering_actor = who(o.triggering ?? o.actor ?? VU)
    this.bodies.set(`repos/${o.repo}/actions/runs/${o.runId}/attempts/${attempt}`, base)
    const jobs = clone(fixtureBody('attempt-jobs-dispatch.hook'))
    jobs.jobs[0].status = o.jobStatus ?? 'in_progress'
    jobs.jobs[0].runner_name = o.runner === undefined ? 'host-app-r1' : o.runner
    jobs.jobs[0].run_id = o.runId
    this.bodies.set(`repos/${o.repo}/actions/runs/${o.runId}/attempts/${attempt}/jobs?per_page=100`, jobs)
    return base
  }

  /** A PR and its files (default: one README change). */
  addPull(o: { repo: string; n: number; sha: string; branch: string; author?: Account; state?: string; base?: string; headRepo?: string | null; files?: { filename: string; previous_filename?: string }[]; changedFiles?: number }) {
    const p = clone(fixtureBody('pull-pr.hook'))
    const files = o.files ?? [{ filename: 'README.md' }]
    Object.assign(p, { number: o.n, state: o.state ?? 'open', changed_files: o.changedFiles ?? files.length })
    p.user = who(o.author ?? VU)
    p.head = { ...p.head, ref: o.branch, sha: o.sha, repo: o.headRepo === null ? null : { ...p.head.repo, full_name: o.headRepo ?? o.repo } }
    p.base = { ...p.base, ref: o.base ?? 'main', repo: { ...p.base.repo, full_name: o.repo } }
    this.bodies.set(`repos/${o.repo}/pulls/${o.n}`, p)
    const f0 = fixtureBody('pull-files')[0]
    const all = files.map((f) => ({ ...clone(f0), ...f }))
    const pages = Math.max(1, Math.ceil(p.changed_files / 100))
    for (let page = 1; page <= pages; page++) this.bodies.set(`repos/${o.repo}/pulls/${o.n}/files?per_page=100&page=${page}`, all.slice((page - 1) * 100, page * 100))
    return p
  }

  /** `commits/{sha}/pulls`: the PRs whose head (or history) holds the sha. */
  setCommitPulls(repo: string, sha: string, pulls: { n: number; state?: string; headSha?: string; headRepo?: string | null; author?: Account }[]) {
    const base = fixtureBody('commit-pulls')[0]
    this.bodies.set(
      `repos/${repo}/commits/${sha}/pulls`,
      pulls.map((x) => {
        const p = clone(base)
        Object.assign(p, { number: x.n, state: x.state ?? 'open' })
        p.user = who(x.author ?? VU)
        p.head = { ...p.head, sha: x.headSha ?? sha, repo: x.headRepo === null ? null : { ...p.head.repo, full_name: x.headRepo ?? repo } }
        return p
      }),
    )
  }

  /** `GET /repos/{repo}/branches/{branch}`: its `protected` flag */
  setBranch(repo: string, branch: string, isProtected: boolean) {
    this.bodies.set(`repos/${repo}/branches/${branch}`, { name: branch, protected: isProtected, commit: { sha: 'a'.repeat(40) } })
  }

  setUser(a: Account) {
    const u = clone(fixtureBody(a.type === 'Bot' ? 'user-bot' : 'user-simple10'))
    Object.assign(u, { login: a.login, id: a.id, type: a.type ?? 'User' })
    this.bodies.set(`users/${a.login}`, u)
  }

  /** The next `times` calls whose path matches answer this status (a 5xx, a 403 with headers, …). */
  failNext(re: RegExp, status: number, headers: Record<string, string> = {}, times = 1, body = '{"message":"Server Error"}') {
    this.fails.push({ re, status, headers, body, times })
  }
  /** Rate limits as GitHub documents them (403/429; primary: remaining 0 + reset; secondary: retry-after + message). */
  rateLimited(kind: 'primary' | 'secondary', times = 1, retryAfter: string | null = '60') {
    if (kind === 'primary') this.failNext(/./, 403, { 'X-Ratelimit-Remaining': '0', 'X-Ratelimit-Reset': String(this.resetAt) }, times, '{"message":"API rate limit exceeded for user ID 304762783."}')
    else this.failNext(/./, 429, retryAfter ? { 'Retry-After': retryAfter } : {}, times, '{"message":"You have exceeded a secondary rate limit. Please wait a few minutes before you try again."}')
  }
  /** Change an answer's body before it is sent (e.g. null a required field). */
  mutate(re: RegExp, fn: (body: any) => void) {
    this.mutators.push({ re, fn })
  }

  private answer(path: string): { status: number; headers: Record<string, string>; body: string } {
    const f = this.fails.find((x) => x.re.test(path) && x.times > 0)
    if (f) {
      f.times--
      return { status: f.status, headers: f.headers, body: f.body }
    }
    const m = /^repos\/([^/]+\/[^/?]+)$/.exec(path)
    if (m) {
      const r = this.repos.has(m[1].toLowerCase()) ? this.repos.get(m[1].toLowerCase()) : this.everyRepo ? { full: m[1], ...this.everyRepo, defaultBranch: 'main' } : null
      if (!r) return { status: 404, headers: {}, body: fixtureRaw('repo-404').raw.split('\r\n\r\n')[1] }
      const b = clone(fixtureBody(r.private ? 'repo-private' : 'repo-public'))
      Object.assign(b, { full_name: r.full, name: r.full.split('/')[1], private: r.private, default_branch: r.defaultBranch })
      b.permissions = { ...b.permissions, push: r.push, admin: r.push, maintain: r.push }
      return this.ok(path, b)
    }
    if (path.startsWith('users/') && !this.bodies.has(path)) {
      return { status: 404, headers: {}, body: '{"message":"Not Found","status":"404"}' }
    }
    if (this.bodies.has(path)) return this.ok(path, clone(this.bodies.get(path)))
    return { status: 404, headers: {}, body: '{"message":"Not Found","status":"404"}' }
  }
  private ok(path: string, body: any) {
    for (const m of this.mutators) if (m.re.test(path)) m.fn(body)
    return { status: 200, headers: {}, body: JSON.stringify(body) }
  }

  /** The GhRun the daemon's GithubApi calls (`gh api -i <path>`). */
  run: GhRun = async (args) => {
    if (args[0] !== 'api' || args[1] !== '-i') return { code: 1, stdout: '', stderr: `fake gh: ${args.join(' ')}` }
    const path = args[args.length - 1]
    this.calls.push(path)
    this.onCall?.(path)
    if (this.gate) await this.gate
    if (this.offline) return { code: 1, stdout: '', stderr: 'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com' }
    if (this.timeout?.test(path)) return { code: 1, stdout: '', stderr: '', timedOut: true }
    const a = this.answer(path)
    const reason = { 200: 'OK', 403: 'Forbidden', 404: 'Not Found', 429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway' }[a.status] ?? 'Status'
    // the recorded framing: "HTTP/2.0 <status>\n" then CRLF headers, a blank line, the body
    const head = fixtureRaw('repo-private').raw.split('\r\n\r\n')[0].split('\n').slice(1).join('\n').split('\r\n').filter((l) => !/^x-ratelimit-remaining:/i.test(l))
    const extra = Object.entries(a.headers).map(([k, v]) => `${k}: ${v}`)
    const remaining = Object.keys(a.headers).some((k) => /^x-ratelimit-remaining$/i.test(k)) ? [] : ['X-Ratelimit-Remaining: 4800']
    const stdout = `HTTP/2.0 ${a.status} ${reason}\n${[...head, ...remaining, ...extra].join('\r\n')}\r\n\r\n${a.body}`
    return { code: a.status >= 400 ? 1 : 0, stdout, stderr: a.status >= 400 ? `gh: ${reason} (HTTP ${a.status})` : '' }
  }

  /** How many calls had a path matching. */
  count(re: RegExp) {
    return this.calls.filter((p) => re.test(p)).length
  }
}
