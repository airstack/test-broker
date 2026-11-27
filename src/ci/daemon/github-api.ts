// The GitHub REST calls the trust layer makes, through `gh api -i` (so the status and headers are seen), with the
// daemon's own credential in the child's env. Every call has a 15 s timeout. A 5xx is retried twice (after 1 s and
// 3 s); 4xx, rate limits and timeouts are not. A rate limit (primary: 403/429 + remaining 0 + reset; secondary:
// 403/429 + retry-after or the "secondary rate limit" message) stops every call until it resets. The strict readers
// turn an answer into typed fields; a missing, null or mistyped field is a `Missing` naming it, never a TypeError.

export type GhRun = (args: string[], o: { timeoutSec: number }) => Promise<{ code: number; stdout: string; stderr: string; timedOut?: boolean }>

export type Answer = { status: number; headers: Record<string, string>; body: unknown; text: string }

/** `gh api -i` output: the status line, headers, a blank line, the body. null when it isn't that. */
export function parseGhApiI(raw: string): Answer | null {
  const cut = raw.search(/\r?\n\r?\n/)
  const head = cut < 0 ? raw : raw.slice(0, cut)
  const text = cut < 0 ? '' : raw.slice(cut).replace(/^\r?\n\r?\n/, '')
  const [statusLine = '', ...lines] = head.split(/\r?\n/)
  const m = /^HTTP\/[\d.]+ (\d{3})/.exec(statusLine)
  if (!m) return null
  const headers: Record<string, string> = {}
  for (const l of lines) {
    const i = l.indexOf(':')
    if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim()
  }
  let body: unknown = null
  if (text.trim()) {
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
  }
  return { status: Number(m[1]), headers, body, text }
}

export type FailKind = 'rate' | 'http' | 'timeout' | 'parse'

/** The call could not be made or answered usefully. `until`: a rate limit's end (epoch ms). */
export class ApiFail extends Error {
  readonly kind: FailKind
  readonly status: number | null
  readonly until: number | null
  constructor(kind: FailKind, message: string, status: number | null = null, until: number | null = null) {
    super(message)
    this.kind = kind
    this.status = status
    this.until = until
  }
}

/** A required field is missing, null or of the wrong type. */
export class Missing extends Error {
  readonly field: string
  constructor(field: string) {
    super(`the answer has no valid ${field}`)
    this.field = field
  }
}

export type Who = { id: number; login: string; type: string }
export type RepoInfo = { fullName: string; private: boolean; push: boolean; defaultBranch: string }
export type RunAttempt = {
  id: number; runAttempt: number; repo: string; status: string; event: string; path: string; headSha: string; headBranch: string
  headRepo: string; displayTitle: string; actor: Who; triggeringActor: Who
}
export type AttemptJob = { status: string; runnerName: string | null }
export type Pull = { number: number; state: string; baseRepo: string; baseRef: string; headRepo: string | null; headRef: string; headSha: string; user: Who; changedFiles: number }
export type PullFile = { filename: string; previousFilename: string | null }
export type CommitPull = { number: number; state: string; headSha: string; headRepo: string | null; user: Who }

const at = (o: unknown, path: string): unknown => path.split('.').reduce<any>((x, k) => (x !== null && typeof x === 'object' ? x[k] : undefined), o)
const str = (o: unknown, path: string): string => {
  const v = at(o, path)
  if (typeof v !== 'string') throw new Missing(path)
  return v
}
const int = (o: unknown, path: string): number => {
  const v = at(o, path)
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new Missing(path)
  return v
}
const bool = (o: unknown, path: string): boolean => {
  const v = at(o, path)
  if (typeof v !== 'boolean') throw new Missing(path)
  return v
}
const obj = (o: unknown, path: string): unknown => {
  const v = at(o, path)
  if (v === null || typeof v !== 'object') throw new Missing(path)
  return v
}
const who = (o: unknown, path: string): Who => {
  obj(o, path)
  return { id: int(o, `${path}.id`), login: str(o, `${path}.login`), type: str(o, `${path}.type`) }
}
/** `x.repo.full_name`, null when `x.repo` is null (a deleted fork) */
const repoName = (o: unknown, path: string): string | null => (at(o, path) === null ? null : str(o, `${path}.full_name`))

export const readRepo = (b: unknown): RepoInfo => ({
  fullName: str(b, 'full_name'), private: bool(b, 'private'), push: bool(b, 'permissions.push'), defaultBranch: str(b, 'default_branch'),
})
export function readAttempt(b: unknown): RunAttempt {
  obj({ b }, 'b')
  return {
    id: int(b, 'id'), runAttempt: int(b, 'run_attempt'), repo: str(b, 'repository.full_name'), status: str(b, 'status'), event: str(b, 'event'), path: str(b, 'path'),
    headSha: str(b, 'head_sha'), headBranch: str(b, 'head_branch'), headRepo: (obj(b, 'head_repository'), str(b, 'head_repository.full_name')),
    displayTitle: str(b, 'display_title'), actor: who(b, 'actor'), triggeringActor: who(b, 'triggering_actor'),
  }
}
export function readAttemptJobs(b: unknown): AttemptJob[] {
  const jobs = at(b, 'jobs')
  if (!Array.isArray(jobs)) throw new Missing('jobs')
  return jobs.map((j, i) => {
    const rn = at(j, 'runner_name')
    if (rn !== null && rn !== undefined && typeof rn !== 'string') throw new Missing(`jobs.${i}.runner_name`)
    return { status: str(j, 'status'), runnerName: typeof rn === 'string' && rn ? rn : null }
  })
}
export const readPull = (b: unknown): Pull => ({
  number: int(b, 'number'), state: str(b, 'state'), baseRepo: str(b, 'base.repo.full_name'), baseRef: str(b, 'base.ref'),
  headRepo: repoName(b, 'head.repo'), headRef: str(b, 'head.ref'), headSha: str(b, 'head.sha'), user: who(b, 'user'), changedFiles: int(b, 'changed_files'),
})
export function readPullFiles(b: unknown): PullFile[] {
  if (!Array.isArray(b)) throw new Missing('files')
  return b.map((f) => {
    const prev = at(f, 'previous_filename')
    if (prev !== undefined && prev !== null && typeof prev !== 'string') throw new Missing('previous_filename')
    return { filename: str(f, 'filename'), previousFilename: typeof prev === 'string' ? prev : null }
  })
}
export function readCommitPulls(b: unknown): CommitPull[] {
  if (!Array.isArray(b)) throw new Missing('pulls')
  return b.map((p) => ({ number: int(p, 'number'), state: str(p, 'state'), headSha: str(p, 'head.sha'), headRepo: repoName(p, 'head.repo'), user: who(p, 'user') }))
}

const hhmm = (ms: number) => new Date(ms).toTimeString().slice(0, 5)

export type ApiDeps = {
  run: GhRun
  now: () => number
  /** the waits between 5xx retries (tests make them immediate) */
  sleep?: (ms: number) => Promise<void>
  timeoutSec?: number
  /** a 401: the daemon re-reads its token */
  onUnauthorized?: () => void
}

/** Counts each HTTP call made (the GitHub door's hourly budget). */
export type Meter = () => void

export class GithubApi {
  /** no call before this (epoch ms): a rate limit is in force */
  rateUntil = 0
  private d: ApiDeps
  constructor(d: ApiDeps) {
    this.d = d
  }

  /** One GET. Returns the answer for 2xx and 404; throws ApiFail for everything else. */
  async get(path: string, meter?: Meter): Promise<Answer> {
    const { d } = this
    const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
    const waits = [1000, 3000]
    for (let attempt = 0; ; attempt++) {
      if (d.now() < this.rateUntil) throw new ApiFail('rate', `rate limited until ${hhmm(this.rateUntil)}`, null, this.rateUntil)
      meter?.()
      const r = await d.run(['api', '-i', path], { timeoutSec: d.timeoutSec ?? 15 })
      if (r.timedOut) throw new ApiFail('timeout', `GET /${path}: timeout`)
      const a = parseGhApiI(r.stdout)
      if (!a) {
        const why = (r.stderr || r.stdout).trim().split('\n')[0]?.slice(0, 200)
        throw r.code !== 0 ? new ApiFail('http', `GET /${path}: GitHub unreachable (${why || `gh exit ${r.code}`})`) : new ApiFail('parse', `GET /${path}: unparsable answer`)
      }
      if (a.status === 403 || a.status === 429) {
        const msg = String((a.body as any)?.message ?? '')
        const reset = Number(a.headers['x-ratelimit-reset'])
        let until: number | null = null
        if (a.headers['x-ratelimit-remaining'] === '0' && Number.isFinite(reset) && reset > 0) until = reset * 1000
        else if (a.headers['retry-after'] && Number.isFinite(Number(a.headers['retry-after']))) until = d.now() + Number(a.headers['retry-after']) * 1000
        else if (/secondary rate limit/i.test(msg) || a.status === 429) until = d.now() + 60_000
        if (until !== null) {
          this.rateUntil = Math.max(this.rateUntil, until)
          throw new ApiFail('rate', `GET /${path}: rate limited until ${hhmm(until)}`, a.status, until)
        }
      }
      if (a.status >= 500 && attempt < waits.length) {
        await sleep(waits[attempt])
        continue
      }
      if (a.status === 401) d.onUnauthorized?.()
      if ((a.status >= 200 && a.status < 300) || a.status === 404) return a
      throw new ApiFail('http', `GET /${path}: HTTP ${a.status}${(a.body as any)?.message ? ` (${String((a.body as any).message).slice(0, 120)})` : ''}`, a.status)
    }
  }

  private async read<T>(path: string, reader: (b: unknown) => T, meter?: Meter): Promise<T | null> {
    const a = await this.get(path, meter)
    if (a.status === 404) return null
    return reader(a.body)
  }

  repo = (repo: string, meter?: Meter) => this.read(`repos/${repo}`, readRepo, meter)
  attempt = (repo: string, runId: string, attempt: string, meter?: Meter) => this.read(`repos/${repo}/actions/runs/${runId}/attempts/${attempt}`, readAttempt, meter)
  async attemptJobs(repo: string, runId: string, attempt: string, meter?: Meter): Promise<AttemptJob[]> {
    return (await this.read(`repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`, readAttemptJobs, meter)) ?? []
  }
  pull = (repo: string, n: number, meter?: Meter) => this.read(`repos/${repo}/pulls/${n}`, readPull, meter)
  async pullFiles(repo: string, n: number, changedFiles: number, meter?: Meter): Promise<PullFile[]> {
    const out: PullFile[] = []
    const pages = Math.max(1, Math.ceil(changedFiles / 100))
    for (let page = 1; page <= pages; page++) {
      const got = await this.read(`repos/${repo}/pulls/${n}/files?per_page=100&page=${page}`, readPullFiles, meter)
      if (got === null) throw new ApiFail('http', `GET /repos/${repo}/pulls/${n}/files: HTTP 404`, 404)
      out.push(...got)
    }
    return out
  }
  async commitPulls(repo: string, sha: string, meter?: Meter): Promise<CommitPull[]> {
    return (await this.read(`repos/${repo}/commits/${sha}/pulls`, readCommitPulls, meter)) ?? []
  }
  /** the branch's `protected` flag (doctor: the model assumes outsiders can't push to the default branch) */
  branchProtected = (repo: string, branch: string) => this.read(`repos/${repo}/branches/${encodeURIComponent(branch)}`, (b) => bool(b, 'protected'))
  user = (login: string, meter?: Meter) => this.read(`users/${login}`, (b) => who({ b }, 'b'), meter)
  /** GET /user: the credential's login and its token scopes (doctor). */
  async whoami(): Promise<{ login: string; scopes: string }> {
    const a = await this.get('user')
    if (a.status !== 200) throw new ApiFail('http', `GET /user: HTTP ${a.status}`, a.status)
    return { login: str(a.body, 'login'), scopes: a.headers['x-oauth-scopes'] ?? '' }
  }
}
