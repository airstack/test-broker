// The trust layer: ci-broker runs a job only if someone we trust asked for it, for code that is ours.
//
// Two doors. The local door (the operator's socket) trusts its caller and checks the names, the profile, blocks and
// the repo's tier (cached; an API outage falls back to a recent tier, else the public lane: the lane can fall, never
// rise). The GitHub door (the runners' socket) trusts nothing it is told: checks 1–15 verify every claim live with
// the daemon's own token. The first failed check refuses: a 403 naming it, one log line, an `events` row. Exit 77 at
// the client.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { argsDigest, DISPATCH_TITLE } from '../client/dispatch.ts'
import { isRepoName, publicBoatEnv, type ApprovedEntry, type Config, type TrustCfg } from '../config.ts'
import type { Door, EnvClass, Lane, Tier, TrustDb } from '../db.ts'
import { localCommand, NAME_RE, ProfileError, type Profile } from '../profile.ts'
import { ApiFail, Missing, type AttemptJob, type CommitPull, type GithubApi, type Pull, type PullFile, type RepoInfo, type RunAttempt, type Who } from './github-api.ts'
import { HttpError } from './jobs.ts'

export type CheckId =
  | 'rate' | 'request' | 'profile' | 'repo' | 'host-mode' | 'blocked' | 'repo-access' | 'repo-tier' | 'github-api' | 'public-local-only' | 'public-net'
  | 'public-remote' | 'approved-list' | 'run' | 'workflow' | 'event' | 'actor' | 'runner' | 'pr' | 'pr-workflow' | 'dispatch' | 'match' | 'pr-mode'
  | 'sha' | 'run-used' | 'jobs-cap'

/** the hourly API budget is spent: no call is made */
class OverBudget extends Error {}

export type RefusalInfo = { check: CheckId; door: Door; repo: string | null; run: string | null }

/** A refusal: HTTP 403 with `{ error, trust: { check, door, repo, run } }`. */
export class TrustRefusal extends HttpError {
  readonly info: RefusalInfo
  constructor(info: RefusalInfo, reason: string) {
    super(403, `refused (trust/${info.check}): ${reason}`)
    this.info = info
  }
}

export { argsDigest, DISPATCH_TITLE }

const ARGS_MAX = 64
const ARGS_BYTES = 64 * 1024
const RUN_CACHE_MS = 10 * 60_000
const ADMITS_PER_RUN = 5
export const TICKET_GRACE_MS = 3600_000

/** The repo's approved list: a per-repo list REPLACES the global one. */
export function approvedList(t: TrustCfg, repo: string): ApprovedEntry[] {
  const k = Object.keys(t.repos).find((r) => r.toLowerCase() === repo.toLowerCase())
  return k && t.repos[k].githubUsers !== undefined ? t.repos[k].githubUsers! : t.githubUsers
}
export const pinned = (list: ApprovedEntry[]) => list.filter((e): e is { login: string; id: number } => typeof e === 'object')
/** By account id (a login can be renamed and taken), a pinned entry, and a User (a listed bot is still refused). */
export const isApproved = (list: ApprovedEntry[], w: Who) => w.type === 'User' && pinned(list).some((e) => e.id === w.id)

export function repoTrust(t: TrustCfg, repo: string) {
  const k = Object.keys(t.repos).find((r) => r.toLowerCase() === repo.toLowerCase())
  const r = k ? t.repos[k] : {}
  return { workflow: r.workflow ?? '.github/workflows/broker.yml', envForGithubDoor: r.envForGithubDoor === true, profile: r.profile ?? repo.split('/')[1] }
}

/** What GitHub says the repo is to our token. */
export function tierOf(info: RepoInfo | null, repo: string): { tier: Tier; why: string } {
  if (!info) return { tier: 'none', why: 'not found (or no access)' }
  if (info.fullName.toLowerCase() !== repo.toLowerCase()) return { tier: 'none', why: `renamed: GitHub answers for ${info.fullName}` }
  if (!info.push) return { tier: 'none', why: 'our token cannot push to it' }
  return { tier: info.private ? 'private' : 'public', why: info.private ? 'private, push' : 'public, push' }
}

const ago = (ms: number) => (ms < 90_000 ? `${Math.round(ms / 1000)}s` : ms < 5400_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 3600_000)}h`)

/** Names that reach a path, a ref, a volume or a log. Returns the problem, or null. */
export function nameProblem(r: { repo?: unknown; profile?: unknown; mode?: unknown; sha?: unknown; args?: unknown; runId?: unknown; runAttempt?: unknown; ref?: unknown }, need: { runId?: boolean; sha?: boolean; ref?: boolean } = {}): string | null {
  if (!isRepoName(r.repo)) return `repo must be owner/name (letters, digits, _ . -), got '${String(r.repo).slice(0, 80)}'`
  if (r.profile !== undefined && r.profile !== null && !(typeof r.profile === 'string' && NAME_RE.test(r.profile))) return `bad profile name '${String(r.profile).slice(0, 80)}'`
  if (r.mode !== undefined && !(typeof r.mode === 'string' && NAME_RE.test(r.mode))) return `bad mode name '${String(r.mode).slice(0, 80)}'`
  if ((need.sha || r.sha !== undefined) && !(typeof r.sha === 'string' && /^[0-9a-f]{40}$/.test(r.sha))) return 'sha must be a full 40-character sha'
  if (r.args !== undefined) {
    if (!Array.isArray(r.args) || !r.args.every((a) => typeof a === 'string')) return 'args must be an array of strings'
    if (r.args.length > ARGS_MAX) return `at most ${ARGS_MAX} args`
    if (Buffer.byteLength(JSON.stringify(r.args)) > ARGS_BYTES) return 'args over 64 KiB'
  }
  if (need.runId) {
    // no leading zeros: one run must have one spelling (run_uses and the per-run limit key on it)
    if (!(typeof r.runId === 'string' && /^[1-9][0-9]{0,19}$/.test(r.runId))) return 'runId must be digits (no leading zero)'
    if (!(typeof r.runAttempt === 'string' && /^[1-9][0-9]{0,19}$/.test(r.runAttempt))) return 'runAttempt must be digits (no leading zero)'
  }
  if (need.ref && !(typeof r.ref === 'string' && /^refs\/[A-Za-z0-9_./-]{1,250}$/.test(r.ref))) return 'ref must be a refs/… name'
  return null
}

export type TrustDeps = {
  cfg: Config
  tdb: TrustDb
  api: GithubApi
  now: () => number
  log: (m: string) => void
  /** load a profile by name (throws ProfileError) */
  profile: (name: string) => Profile
  /** a job secret: set, unset, or set but equal to the daemon's GitHub credential (refused) */
  secretState: (name: string) => 'set' | 'unset' | 'credential'
  /** an ssh resource serving this profile hands the remote script a job secret */
  sshSecret: (profile: Profile) => boolean
  /** after a fetch from origin that must succeed: the sha is an ancestor of refs/heads/<branch> */
  isMerged: (repo: string, sha: string, branch: string) => Promise<boolean>
  /** the runner names registered for a repo (runners.json) */
  runnerNames: (repo: string) => string[]
  /** active GitHub-door jobs now */
  activeGithubJobs: () => number
  /** the watchdog's last check of the public network; null = not checked yet */
  publicNet: () => { ok: boolean; why: string; at?: number } | null
  /** run the network probe now (a check older than 2×watchSec counts as none) */
  probeNet?: () => Promise<void>
}

export type LocalAdmission = { lane: Lane; env: EnvClass; profile: Profile; note: string | null; tier: Tier }
export type GithubReq = { repo: string; runId: string; runAttempt: string; ref: string; sha?: string; mode?: string; args?: string[]; profile?: string }
export type GithubAdmission = {
  lane: 'full'; env: EnvClass; profile: Profile; run: RunAttempt; runKey: string; actor: string; event: string
  /** '<runId>.<attempt> <event> <actor login>' (jobs.gh_run) */
  ghRun: string
}
export type Trace = (line: string) => void

type RunCache = { at: number; attempt?: RunAttempt | null; jobs?: AttemptJob[]; pull?: Pull | null; files?: PullFile[]; commitPulls: Map<string, CommitPull[]> }

export class Trust {
  readonly d: TrustDeps
  /** per repo: the door's requests (last minute) and API calls (last hour) */
  private doorReqs = new Map<string, number[]>()
  private apiCalls = new Map<string, number[]>()
  private admits = new Map<string, { n: number; at: number }>()
  private cache = new Map<string, RunCache>()
  private pendingRuns = new Set<string>()
  constructor(d: TrustDeps) {
    this.d = d
  }

  get cfg() {
    return this.d.cfg.trust
  }

  // ------------------------------------------------------------------ refusals and events

  refuse(info: RefusalInfo, reason: string, actor: string | null = null): never {
    const e = new TrustRefusal(info, reason)
    const { d } = this
    d.tdb.addEvent({ t: d.now(), door: info.door, repo: info.repo, run: info.run, actor, ok: 0, checkId: info.check, reason: e.message, job: null })
    d.log(`TRUST refused door=${info.door}${info.repo ? ` repo=${info.repo}` : ''}${info.run ? ` run=${info.run}` : ''}${actor ? ` actor=${actor}` : ''} check=${info.check}: ${reason}`)
    throw e
  }

  /** a GitHub-door admission (`job` once the submit made or found one) */
  admitted(a: GithubAdmission, job: string | null, sha?: string) {
    const { d } = this
    const run = a.runKey.split('#')[1]
    d.tdb.addEvent({ t: d.now(), door: 'github', repo: a.run.repo, run, actor: a.actor, ok: 1, checkId: null, reason: `admitted (${a.event})`, job })
    d.log(`TRUST admitted door=github repo=${a.run.repo} run=${run} event=${a.event} actor=${a.actor}${sha ? ` sha=${sha}` : ''}${job ? ` → job ${job}` : ' (hook)'}`)
  }

  // ------------------------------------------------------------------ tiers

  /** A live tier (no cache), stored in the cache. Throws ApiFail. */
  async liveTier(repo: string, meter?: () => void): Promise<{ tier: Tier; why: string; info: RepoInfo | null }> {
    let info: RepoInfo | null
    try {
      info = await this.d.api.repo(repo, meter)
    } catch (e) {
      if (e instanceof Missing) throw new ApiFail('parse', `GET /repos/${repo}: ${e.message}`)
      throw e
    }
    const t = tierOf(info, repo)
    this.d.tdb.setTier(repo, t.tier, this.d.now())
    return { ...t, info }
  }

  /** The local door's tier: the cache if young, else live; when GitHub is silent, a recent tier or the public lane. */
  async localTier(repo: string, live = false): Promise<{ tier: Tier; why: string; lane: Lane | null; note: string | null }> {
    const { d } = this
    const now = d.now()
    const row = d.tdb.tier(repo)
    if (live) {
      try {
        const t = await this.liveTier(repo)
        return { tier: t.tier, why: `${t.why} (live)`, lane: null, note: null }
      } catch (e) {
        if (e instanceof ApiFail) this.refuse({ check: 'github-api', door: 'local', repo, run: null }, `could not verify ${repo} (${e.message}); refusing`)
        throw e
      }
    }
    if (row && now - row.checkedAt < 2 * this.cfg.watchSec * 1000) return { tier: row.tier, why: `cached ${ago(now - row.checkedAt)} ago`, lane: null, note: null }
    try {
      const t = await this.liveTier(repo)
      return { tier: t.tier, why: t.why, lane: null, note: null }
    } catch (e) {
      if (!(e instanceof ApiFail)) throw e
      const why = e.kind === 'timeout' ? 'timeout' : e.kind === 'rate' ? e.message.replace(/^GET \S+: /, '') : e.message.replace(/^GET \S+: /, '')
      const note =
        row && now - row.checkedAt < this.cfg.localOfflineMaxAgeSec * 1000
          ? `trust: GitHub unreachable (${why}); using the tier ${row.tier} checked ${ago(now - row.checkedAt)} ago`
          : `trust: GitHub unreachable (${why}); no recent tier, running in the public lane`
      const fall = row && now - row.checkedAt < this.cfg.localOfflineMaxAgeSec * 1000
      if (!(fall && row!.tier === 'none')) {
        d.tdb.addEvent({ t: now, door: 'local', repo, run: null, actor: null, ok: 2, checkId: null, reason: note, job: null })
        d.log(note.replace(/^trust: /, `TRUST offline door=local repo=${repo}: `))
      }
      return fall ? { tier: row!.tier, why: `cached ${ago(now - row!.checkedAt)} ago (GitHub unreachable)`, lane: null, note } : { tier: 'public', why: 'GitHub unreachable, no recent tier', lane: 'public', note }
    }
  }

  // ------------------------------------------------------------------ the local door

  private loadProfile(name: string, repo: string, info: RefusalInfo): Profile {
    let p: Profile
    try {
      p = this.d.profile(name)
    } catch (e) {
      this.refuse({ ...info, check: 'profile' }, e instanceof ProfileError ? e.message : `profile ${name}: ${(e as Error).message}`)
    }
    if (p.repo.toLowerCase() !== repo.toLowerCase()) this.refuse({ ...info, check: 'profile' }, `profile ${name} is for ${p.repo}, not ${repo}`)
    return p
  }

  /**
   * POST /jobs and POST /resources/:id/check on the local socket. `resourceKind`: the check's resource (a non-local
   * one is refused for a public-lane repo). `trace` gets one line per check (`trust check`).
   */
  async admitLocal(req: { repo: string; profile?: string; mode?: string; args?: string[]; sha?: string }, o: { resourceKind?: string; trace?: Trace; live?: boolean } = {}): Promise<LocalAdmission> {
    const { d } = this
    const info: RefusalInfo = { check: 'request', door: 'local', repo: typeof req.repo === 'string' ? req.repo.slice(0, 200) : null, run: null }
    const ok = (check: string, what: string) => o.trace?.(`${check}: ${what} ✓`)
    const bad = nameProblem({ repo: req.repo, profile: req.profile, mode: req.mode, args: req.args, ...(req.sha !== undefined ? { sha: req.sha } : {}) })
    if (bad) this.refuse(info, bad)
    ok('request', 'names valid')
    const name = req.profile ?? req.repo.split('/')[1]
    const profile = this.loadProfile(name, req.repo, info)
    ok('profile', `${profile.name} is ${profile.repo}'s`)
    const cmd = req.mode ? localCommand(profile, req.mode, req.args ?? []) : null
    if (d.cfg.layout === 'split' && cmd !== null && profile.local?.where === 'host')
      this.refuse({ ...info, check: 'host-mode' }, `profile ${profile.name} runs ${req.mode} on the host; split has no host mode (use a container)`)
    if (d.cfg.layout === 'split') ok('host-mode', req.mode ? (cmd === null ? `no local command for ${req.mode}` : 'container') : 'per mode')
    const block = d.tdb.block(req.repo)
    if (block) this.refuse({ ...info, check: 'blocked' }, `${req.repo} is blocked since ${new Date(block.since).toISOString().slice(0, 16)}: ${block.reason} (after review: ci-broker trust unblock ${req.repo})`)
    ok('blocked', 'not blocked')
    const t = await this.localTier(req.repo, o.live)
    if (t.tier === 'none') this.refuse({ ...info, check: 'repo-access' }, `${req.repo} is not ours: ${t.why} (the daemon's GitHub token needs push to it; ci-broker doctor shows its login)`)
    const lane: Lane = t.lane ?? (t.tier === 'private' ? 'full' : 'public')
    ok('repo-access', `tier ${t.tier} (${t.why}) → lane ${lane}`)
    if (lane === 'public') {
      if (d.cfg.layout !== 'split') this.refuse({ ...info, check: 'public-local-only' }, `${req.repo} runs in the public lane, which needs the split layout's ${this.cfg.publicNetwork} network`)
      if (req.mode && (cmd === null || profile.local?.where !== 'container'))
        this.refuse({ ...info, check: 'public-local-only' }, `${req.repo} runs in the public lane: local container runs only, and profile ${profile.name} has ${cmd === null ? `no local command for ${req.mode}` : 'a host command'}`)
      const boat = publicBoatEnv(this.cfg, req.repo)
      if (o.resourceKind && o.resourceKind !== 'local' && !(o.resourceKind === 'boat' && boat))
        this.refuse({ ...info, check: 'public-remote' }, `${req.repo} runs in the public lane: only the local resource${boat ? ' or Boat' : ''}, not ${o.resourceKind}${o.resourceKind === 'boat' ? ` (root has not set trust.repos.${req.repo}.publicBoat)` : ''}`)
      let net = d.publicNet()
      const stale = (n: typeof net) => !!n && typeof n.at === 'number' && d.now() - n.at > 2 * this.cfg.watchSec * 1000
      if (stale(net)) {
        // the rules may be gone since (a Docker restart): check again before admitting
        await d.probeNet?.()
        net = d.publicNet()
        if (stale(net)) this.refuse({ ...info, check: 'public-net' }, `the public network's last check is older than ${2 * this.cfg.watchSec}s and could not be made again (ci-broker doctor; an admin runs install.sh --check)`)
      }
      if (!net?.ok) this.refuse({ ...info, check: 'public-net' }, `the public network ${this.cfg.publicNetwork} ${net ? `failed its check: ${net.why}` : 'has not been checked yet'} (ci-broker doctor; an admin runs install.sh --check)`)
      ok('public-local-only', 'local container')
      ok('public-net', 'checked')
    }
    // env: the run may get a job secret (local.env, or an ssh resource's secret); a noenv request never joins it
    const env: EnvClass = lane === 'full' && (Object.keys(profile.local?.env ?? {}).length || d.sshSecret(profile)) ? 'env' : 'noenv'
    if (env === 'env' && cmd !== null) this.needSecrets(profile, info)
    return { lane, env, profile, note: t.note, tier: t.tier }
  }

  private needSecrets(profile: Profile, info: RefusalInfo) {
    for (const [v, s] of Object.entries(profile.local?.env ?? {})) {
      const st = this.d.secretState(s)
      if (st === 'unset') this.refuse({ ...info, check: 'profile' }, `profile ${profile.name}: local.env.${v}: secret ${s} is not set (an admin sets it: install.sh --set-secret ${s})`)
      if (st === 'credential') this.refuse({ ...info, check: 'profile' }, `profile ${profile.name}: local.env.${v}: secret ${s} equals the daemon's GitHub credential: a job would get the daemon's token (an admin replaces it: install.sh --set-secret ${s})`)
    }
  }

  // ------------------------------------------------------------------ the GitHub door

  private within(list: number[], ms: number) {
    const cut = this.d.now() - ms
    while (list.length && list[0] <= cut) list.shift()
    return list.length
  }
  /** keys are bounded (repos with a profile here, plus '?'): no scan, no growth from made-up names */
  private bucket(m: Map<string, number[]>, key: string) {
    let l = m.get(key)
    if (!l) m.set(key, (l = []))
    return l
  }
  private allReqs: number[] = []
  private allCalls: number[] = []
  /** the bucket key: a repo with a profile here (its default one), else '?' shared by every other name */
  private repoKey(repo: unknown): string {
    if (!isRepoName(repo)) return '?'
    try {
      const p = this.d.profile(repoTrust(this.cfg, repo).profile)
      return p.repo.toLowerCase() === repo.toLowerCase() ? repo.toLowerCase() : '?'
    } catch {
      return '?'
    }
  }
  /** counts an API call for the repo's hourly budget and the global one; over either, no call is made */
  private meterFor(repoKey: string) {
    return () => {
      const l = this.bucket(this.apiCalls, repoKey)
      if (this.within(l, 3600_000) >= this.cfg.githubDoorCallsPerHour || this.within(this.allCalls, 3600_000) >= this.cfg.githubDoorCallsPerHourTotal) throw new OverBudget()
      l.push(this.d.now())
      this.allCalls.push(this.d.now())
    }
  }

  private runCache(key: string): RunCache {
    const now = this.d.now()
    for (const [k, v] of this.cache) if (now - v.at > RUN_CACHE_MS) this.cache.delete(k)
    for (const [k, v] of this.admits) if (now - v.at > RUN_CACHE_MS) this.admits.delete(k)
    let c = this.cache.get(key)
    if (!c) this.cache.set(key, (c = { at: now, commitPulls: new Map() }))
    return c
  }

  private async call<T>(info: RefusalInfo, what: string, fn: () => Promise<T>, actor: string | null = null): Promise<T> {
    try {
      return await fn()
    } catch (e) {
      if (e instanceof OverBudget) this.refuse({ ...info, check: 'rate' }, `the GitHub door made ${this.cfg.githubDoorCallsPerHour} API calls for ${info.repo} in the last hour`, actor)
      if (e instanceof ApiFail) this.refuse({ ...info, check: 'github-api' }, `could not verify ${info.repo} (${e.message}); refusing`, actor)
      if (e instanceof Missing) this.refuse({ ...info, check: what as CheckId }, `${what}: ${e.message}`, actor)
      throw e
    }
  }

  /**
   * POST /gh/admit (checks 1–12), POST /gh/jobs (1–15) and `trust check --run` (replay: 1–12, 13–14 with a sha; no
   * run_uses row, no per-minute or per-run limit, but the hourly API budget counts).
   */
  async admitGithub(req: GithubReq, kind: 'admit' | 'submit' | 'replay', trace?: Trace): Promise<GithubAdmission> {
    const { d } = this
    const t = this.cfg
    const repo0 = typeof req.repo === 'string' ? req.repo.slice(0, 200) : null
    const run0 = typeof req.runId === 'string' && typeof req.runAttempt === 'string' ? `${req.runId}.${req.runAttempt}`.slice(0, 50) : null
    const info: RefusalInfo = { check: 'rate', door: 'github', repo: repo0, run: run0 }
    const ok = (check: string, what: string) => trace?.(`${check}: ${what} ✓`)
    // 1. rate: before any API call
    const now = d.now()
    const repoKey = this.repoKey(req.repo)
    if (kind !== 'replay') {
      const reqs = this.bucket(this.doorReqs, repoKey)
      if (this.within(this.allReqs, 60_000) >= t.githubDoorPerMinTotal) this.refuse(info, `the GitHub door had ${t.githubDoorPerMinTotal} requests for all repos in the last minute`)
      if (this.within(reqs, 60_000) >= t.githubDoorPerMin) this.refuse(info, `the GitHub door had ${t.githubDoorPerMin} requests for ${repoKey} in the last minute`)
      reqs.push(now)
      this.allReqs.push(now)
    }
    if (this.within(this.allCalls, 3600_000) >= t.githubDoorCallsPerHourTotal) this.refuse(info, `the GitHub door made ${t.githubDoorCallsPerHourTotal} API calls for all repos in the last hour`)
    if (this.within(this.bucket(this.apiCalls, repoKey), 3600_000) >= t.githubDoorCallsPerHour) this.refuse(info, `the GitHub door made ${t.githubDoorCallsPerHour} API calls for ${repoKey} in the last hour`)
    const meter = this.meterFor(repoKey)
    const runKey = `${String(req.repo).toLowerCase()}#${req.runId}.${req.runAttempt}`
    if (kind === 'admit') {
      const a = this.admits.get(runKey) ?? { n: 0, at: now }
      if (a.n >= ADMITS_PER_RUN) this.refuse(info, `run ${run0} already asked to be admitted ${ADMITS_PER_RUN} times`)
      this.admits.set(runKey, { n: a.n + 1, at: a.at })
    }
    ok('rate', 'within limits')
    // 2. request
    const bad = nameProblem(
      { repo: req.repo, runId: req.runId, runAttempt: req.runAttempt, ref: req.ref, profile: req.profile, ...(kind === 'admit' ? {} : { mode: req.mode, args: req.args ?? [] }), ...(req.sha !== undefined || kind === 'submit' ? { sha: req.sha } : {}) },
      { runId: true, ref: kind !== 'replay' || req.ref !== undefined, sha: kind === 'submit' },
    )
    if (bad) this.refuse({ ...info, check: 'request' }, bad)
    if (kind === 'submit' && typeof req.mode !== 'string') this.refuse({ ...info, check: 'request' }, 'mode is required')
    ok('request', 'names valid')
    const repo = req.repo
    // 3. profile: only the repo's default one (the client can't pick another profile of the repo)
    const rt = repoTrust(t, repo)
    if (req.profile !== undefined && req.profile !== rt.profile) this.refuse({ ...info, check: 'profile' }, `the GitHub door uses ${repo}'s default profile ${rt.profile}, not ${req.profile}`)
    const profile = this.loadProfile(rt.profile, repo, info)
    ok('profile', `${profile.name} is ${profile.repo}'s`)
    // 4. blocked
    const block = d.tdb.block(repo)
    if (block) this.refuse({ ...info, check: 'blocked' }, `${repo} is blocked since ${new Date(block.since).toISOString().slice(0, 16)}: ${block.reason}`)
    ok('blocked', 'not blocked')
    // 5. repo: always live
    const live = await this.call(info, 'repo', () => this.liveTier(repo, meter))
    if (live.tier === 'none') this.refuse({ ...info, check: 'repo-access' }, `${repo} is not ours: ${live.why} (the daemon's GitHub token needs push to it; ci-broker doctor shows its login)`)
    if (live.tier !== 'private') this.refuse({ ...info, check: 'repo-tier' }, `${repo} is public: the GitHub door serves private repos only`)
    const defaultBranch = live.info!.defaultBranch
    ok('repo', `private, push, default branch ${defaultBranch}`)
    // 6. approved-list
    const list = approvedList(t, repo)
    if (!pinned(list).length) this.refuse({ ...info, check: 'approved-list' }, `the approved list for ${repo} has no pinned entry (an admin adds one: install.sh --approve <login>)`)
    ok('approved-list', `${pinned(list).map((e) => e.login).join(', ')}`)
    // 7. run
    const rc = this.runCache(runKey)
    if (rc.attempt === undefined) rc.attempt = await this.call(info, 'run', () => d.api.attempt(repo, req.runId, req.runAttempt, meter))
    const run = rc.attempt
    if (!run) this.refuse({ ...info, check: 'run' }, `no run ${run0} in ${repo}`)
    const actor = run.actor.login
    if (String(run.id) !== req.runId) this.refuse({ ...info, check: 'run' }, `the API answered run id ${run.id} for ${req.runId}`, actor)
    if (String(run.runAttempt) !== req.runAttempt) this.refuse({ ...info, check: 'run' }, `the run answers attempt ${run.runAttempt}, not ${req.runAttempt}`, actor)
    if (run.repo.toLowerCase() !== repo.toLowerCase()) this.refuse({ ...info, check: 'run' }, `run ${run0} belongs to ${run.repo}`, actor)
    if (run.status !== 'in_progress') {
      delete rc.attempt // a status changes: never cache a refusal of it
      this.refuse({ ...info, check: 'run' }, `run ${run0} is ${run.status}, not in_progress`, actor)
    }
    ok('run', `status ${run.status}, event ${run.event}, path ${run.path}`)
    // 8. workflow
    if (run.path !== rt.workflow) this.refuse({ ...info, check: 'workflow' }, `run ${run0} is ${run.path}, not ${rt.workflow}`, actor)
    ok('workflow', run.path)
    // 9. event
    if (run.event !== 'pull_request' && run.event !== 'workflow_dispatch') this.refuse({ ...info, check: 'event' }, `event ${run.event} is not admitted (pull_request and workflow_dispatch only)`, actor)
    ok('event', run.event)
    // 10. actor
    for (const [what, w] of [['actor', run.actor], ['triggering_actor', run.triggeringActor]] as const)
      if (!isApproved(list, w)) this.refuse({ ...info, check: 'actor' }, `${what} ${w.login} (id ${w.id}${w.type !== 'User' ? `, ${w.type}` : ''}) is not on the approved list for ${repo}`, actor)
    ok('actor', `${run.actor.login}, ${run.triggeringActor.login}`)
    // 11. runner
    if (rc.jobs === undefined) rc.jobs = await this.call(info, 'runner', () => d.api.attemptJobs(repo, req.runId, req.runAttempt, meter), actor)
    const names = new Set(d.runnerNames(repo))
    if (!rc.jobs.some((j) => j.status === 'in_progress' && j.runnerName !== null && names.has(j.runnerName))) {
      const seen = rc.jobs.map((j) => `${j.runnerName ?? '(no runner)'} ${j.status}`).join(', ') || 'no jobs'
      delete rc.jobs
      this.refuse({ ...info, check: 'runner' }, `run ${run0} has no in-progress job on a runner of ${repo} (${seen})`, actor)
    }
    ok('runner', 'an in-progress job on our runner')
    // 12. the event's own checks
    if (kind === 'replay' && req.ref === undefined) {
      // `trust check --run` names no ref: the one the runner would have
      if (run.event === 'pull_request') {
        const pulls = await this.call(info, 'pr', () => d.api.commitPulls(repo, run.headSha, meter), actor)
        const p = pulls.find((x) => x.state === 'open' && x.headSha === run.headSha)
        if (!p) this.refuse({ ...info, check: 'pr' }, `no open PR has head ${run.headSha.slice(0, 12)}`, actor)
        req = { ...req, ref: `refs/pull/${p.number}/merge` }
      } else req = { ...req, ref: `refs/heads/${run.headBranch}` }
      ok('ref', req.ref)
    }
    if (run.event === 'pull_request') {
      const m = /^refs\/pull\/([0-9]{1,10})\/merge$/.exec(req.ref)
      if (!m) this.refuse({ ...info, check: 'pr' }, `ref ${req.ref} is not a PR merge ref`, actor)
      const n = Number(m[1])
      if (rc.pull === undefined || rc.pull?.number !== n) rc.pull = await this.call(info, 'pr', () => d.api.pull(repo, n, meter), actor)
      const pr = rc.pull
      if (!pr) this.refuse({ ...info, check: 'pr' }, `no PR #${n} in ${repo}`, actor)
      const why =
        pr.state !== 'open' ? `PR #${n} is ${pr.state}`
        : pr.baseRepo.toLowerCase() !== repo.toLowerCase() ? `PR #${n} is against ${pr.baseRepo}`
        : pr.headRepo === null || pr.headRepo.toLowerCase() !== repo.toLowerCase() ? `PR #${n} comes from ${pr.headRepo ?? 'a deleted fork'} (no forks)`
        : pr.baseRef !== defaultBranch ? `PR #${n} is against ${pr.baseRef}, not the default branch ${defaultBranch}`
        : pr.headSha !== run.headSha ? `PR #${n} head is ${pr.headSha.slice(0, 12)}, the run's is ${run.headSha.slice(0, 12)}`
        : pr.headRef !== run.headBranch ? `PR #${n} head branch ${pr.headRef} is not the run's ${run.headBranch}`
        : !isApproved(list, pr.user) ? `PR #${n} author ${pr.user.login} (id ${pr.user.id}${pr.user.type !== 'User' ? `, ${pr.user.type}` : ''}) is not on the approved list for ${repo}`
        : null
      if (why) {
        rc.pull = undefined
        this.refuse({ ...info, check: 'pr' }, why, actor)
      }
      ok('pr', `#${n} by ${pr.user.login}, head ${pr.headSha.slice(0, 12)} on ${pr.headRef}`)
      if (pr.changedFiles > 3000) this.refuse({ ...info, check: 'pr-workflow' }, `PR #${n} changes ${pr.changedFiles} files (over 3000): test it by dispatch`, actor)
      if (rc.files === undefined) rc.files = await this.call(info, 'pr-workflow', () => d.api.pullFiles(repo, n, pr.changedFiles, meter), actor)
      if (rc.files.length !== pr.changedFiles) {
        const got = rc.files.length
        delete rc.files // the list may still be filling in (seen in the spike): never cache this refusal
        this.refuse({ ...info, check: 'pr-workflow' }, `GitHub lists ${got} of ${pr.changedFiles} changed files of PR #${n} (not complete yet): re-run the job`, actor)
      }
      const dotGithub = (f: string | null) => f === '.github' || (f ?? '').startsWith('.github/')
      const gh = rc.files.find((f) => dotGithub(f.filename) || dotGithub(f.previousFilename))
      if (gh) this.refuse({ ...info, check: 'pr-workflow' }, `PR #${n} touches ${dotGithub(gh.filename) ? gh.filename : gh.previousFilename} (under .github/): test it by dispatch instead`, actor)
      ok('pr-workflow', `${rc.files.length} file(s), none under .github/`)
    } else {
      // a tag named like the branch has head_branch == the tag name: the ref says which it was
      if (req.ref !== `refs/heads/${defaultBranch}`) this.refuse({ ...info, check: 'dispatch' }, `the run's ref is ${req.ref}, not refs/heads/${defaultBranch}`, actor)
      if (run.headBranch !== defaultBranch || run.headRepo.toLowerCase() !== repo.toLowerCase())
        this.refuse({ ...info, check: 'dispatch' }, `the workflow ran from ${run.headRepo}@${run.headBranch}, not ${repo}@${defaultBranch}`, actor)
      ok('dispatch', `from ${defaultBranch}`)
    }
    // GitHub-door jobs get job secrets (local.env, an ssh resource's) only with root's envForGithubDoor
    const env: EnvClass = rt.envForGithubDoor ? 'env' : 'noenv'
    if (kind !== 'admit' && typeof req.mode === 'string') {
      const cmd = localCommand(profile, req.mode, req.args ?? [])
      if (d.cfg.layout === 'split' && cmd !== null && profile.local?.where === 'host') this.refuse({ ...info, check: 'host-mode' }, `profile ${profile.name} runs ${req.mode} on the host; split has no host mode`, actor)
      if (env === 'env' && cmd !== null) this.needSecrets(profile, info)
    }
    const adm: GithubAdmission = { lane: 'full', env, profile, run, runKey, actor, event: run.event, ghRun: `${req.runId}.${req.runAttempt} ${run.event} ${actor}` }
    if (kind === 'admit' || (kind === 'replay' && req.sha === undefined)) return adm
    // 13. match
    const args = req.args ?? []
    const mode = req.mode!
    if (run.event === 'pull_request') {
      const prMode = profile.github?.prMode
      if (!prMode) this.refuse({ ...info, check: 'pr-mode' }, `profile ${profile.name} has no github.prMode: PR runs are refused (dispatch still works)`, actor)
      if (mode !== prMode) this.refuse({ ...info, check: 'match' }, `a PR run runs mode ${prMode}, not ${mode}`, actor)
      if (args.length) this.refuse({ ...info, check: 'match' }, 'a PR run takes no args', actor)
      if (req.sha !== run.headSha) this.refuse({ ...info, check: 'match' }, `sha ${String(req.sha).slice(0, 12)} is not the PR head ${run.headSha.slice(0, 12)}`, actor)
      ok('match', `mode ${mode}, no args, the PR head`)
    } else {
      const m = DISPATCH_TITLE.exec(run.displayTitle)
      if (!m) this.refuse({ ...info, check: 'match' }, `the run name '${run.displayTitle.slice(0, 120)}' is not 'broker <mode> <sha> <argsHash>'`, actor)
      if (m[1] !== mode || m[2] !== req.sha || m[3] !== argsDigest(args))
        this.refuse({ ...info, check: 'match' }, `the run name says ${m[1]} ${m[2].slice(0, 12)} ${m[3].slice(0, 12)}, the request ${mode} ${String(req.sha).slice(0, 12)} ${argsDigest(args).slice(0, 12)}`, actor)
      ok('match', `the run name binds mode ${mode}, the sha and the args`)
      // 14. sha
      let merged = false
      try {
        merged = await d.isMerged(repo, req.sha!, defaultBranch)
      } catch (e) {
        this.refuse({ ...info, check: 'sha' }, `fetching ${repo} from origin failed: ${(e as Error).message.slice(0, 200)}`, actor)
      }
      if (merged) ok('sha', `merged into ${defaultBranch}`)
      else {
        let pulls = rc.commitPulls.get(req.sha!)
        if (!pulls) {
          pulls = await this.call(info, 'sha', () => d.api.commitPulls(repo, req.sha!, meter), actor)
          rc.commitPulls.set(req.sha!, pulls)
        }
        const pr = pulls.find((p) => p.state === 'open' && p.headSha === req.sha && p.headRepo?.toLowerCase() === repo.toLowerCase() && isApproved(list, p.user))
        if (!pr) {
          rc.commitPulls.delete(req.sha!)
          this.refuse({ ...info, check: 'sha' }, `${req.sha!.slice(0, 12)} is neither merged into ${defaultBranch} nor the head of an open PR by an approved author`, actor)
        }
        ok('sha', `the head of open PR #${pr.number} by ${pr.user.login}`)
      }
    }
    if (kind === 'replay') return adm
    // 15. run-used / jobs-cap
    const used = d.tdb.runUse(runKey)
    if (used || this.pendingRuns.has(runKey)) this.refuse({ ...info, check: 'run-used' }, `run ${run0} already submitted job ${used?.job ?? '(in flight)'}`, actor)
    if (d.activeGithubJobs() >= t.githubDoorMaxJobs) this.refuse({ ...info, check: 'jobs-cap' }, `${t.githubDoorMaxJobs} GitHub-door jobs are active`, actor)
    this.pendingRuns.add(runKey)
    return adm
  }

  /** after the submit: the run's one use (new, joined or reused) */
  recordRunUse(runKey: string, job: string, how: 'new' | 'joined' | 'reused') {
    this.d.tdb.addRunUse(runKey, job, how, this.d.now())
    this.pendingRuns.delete(runKey)
  }
  releaseRun(runKey: string) {
    this.pendingRuns.delete(runKey)
  }

  // ------------------------------------------------------------------ tickets

  private mac(jobId: number, createdAt: number, run: string) {
    return createHmac('sha256', this.d.tdb.hmacKey()).update(`v1|${this.d.cfg.daemonId}|${jobId}|${createdAt}|${run}`).digest('base64url')
  }
  ticket(jobId: number, createdAt: number, runId: string, attempt: string): string {
    return `${runId}.${attempt}.${this.mac(jobId, createdAt, `${runId}.${attempt}`)}`
  }
  /** valid for this job while it is active, and for an hour after it ended or after the ticket was issued (a reuse) */
  ticketOk(ticket: string | null, job: { id: number; createdAt: number; endedAt: number | null; repo: string } | null): boolean {
    if (!ticket || !job) return false
    const m = /^([0-9]{1,20})\.([0-9]{1,20})\.([A-Za-z0-9_-]{43})$/.exec(ticket)
    if (!m) return false
    const want = Buffer.from(this.mac(job.id, job.createdAt, `${m[1]}.${m[2]}`))
    const got = Buffer.from(m[3])
    if (want.length !== got.length || !timingSafeEqual(want, got)) return false
    if (job.endedAt === null) return true
    const issued = this.d.tdb.runUse(`${job.repo.toLowerCase()}#${m[1]}.${m[2]}`)?.t ?? 0
    return this.d.now() - Math.max(job.endedAt, issued) < TICKET_GRACE_MS
  }
}
