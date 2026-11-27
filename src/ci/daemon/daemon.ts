// ci-brokerd's parts wired together. Everything time- or process-dependent comes in through DaemonDeps.
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { cpus, loadavg, networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Boat } from '../../core/boat.ts'
import { applyLiveCaps, ConfigError, reloadLive, resolveResources, serves, type Config, type ResourceKind } from '../config.ts'
import { Credentials } from '../credentials.ts'
import { ACTIVE_JOB_STATES, Db, TrustDb } from '../db.ts'
import { tryLocalSlot, runLocal, type Slot } from '../local.ts'
import { loadProfile, loadProfileDir, ProfileError, type Profile } from '../profile.ts'
import { GithubApi, type GhRun } from './github-api.ts'
import { Trust } from './trust.ts'
import { BoatPool } from '../../core/boatpool.ts'
import type { Ctx, Sys } from './ctx.ts'
import { Checks } from './checks.ts'
import { BoatExecutor, RemoteBundles } from './exec-boat.ts'
import { GithubExecutor } from './exec-github.ts'
import { SshExecutor } from './exec-ssh.ts'
import { LocalExecutor } from './exec-local.ts'
import { Jobs } from './jobs.ts'
import { Mirror, realGit, type GitRunner } from '../../core/mirror.ts'
import { recover } from './recovery.ts'
import { KIND_ORDER, type Executor } from './resources.ts'
import { Scheduler } from './scheduler.ts'
import { ShardRunner } from './shard.ts'
import { Statuses } from './statuses.ts'
import { JobStreams } from './stream.ts'
import { Timers } from './timers.ts'
import { Watchdog } from './watchdog.ts'
import { scrubText } from './scrub.ts'

/** This machine's addresses: not loopback, not link-local. */
const hostAddrs = (): string[] =>
  Object.values(networkInterfaces()).flat().filter((a) => a && !a.internal && !/^(fe80:|169\.254\.)/i.test(a.address)).map((a) => a!.address)

export const WRAP_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'core', 'wrap', 'cib-wrap.sh')

export type DaemonDeps = {
  cfg: Config
  boat: Boat
  now?: () => number
  log?: (msg: string) => void
  load?: () => { load1: number; nproc: number }
  localLock?: () => Promise<Slot | null>
  git?: GitRunner
  sys?: Sys
  /** runs `gh <args>` (default: `gh` on PATH) */
  gh?: Ctx['gh']
  /** token values to scrub (the daemon's own `gh auth token`) */
  secrets?: string[]
  /** a drain finished */
  onDrained?: () => void
  wrapScript?: string
  runLocal?: typeof runLocal
  /** github resources: the wait between polls (tests make it immediate) */
  githubWait?: (ms: number, signal: AbortSignal) => Promise<void>
  /** `gh api -i` for the trust layer (default: cfg.ghBin with the daemon's GH_TOKEN) */
  ghApi?: GhRun
  /** the waits between 5xx retries of GitHub calls (tests: immediate) */
  apiSleep?: (ms: number) => Promise<void>
  /** the daemon log is also appended here (10 MB × 3; GET /daemon-log reads it) */
  logFile?: string
  /** the release of this code (default: the RELEASE file beside src/, if any) */
  ownRelease?: string | null
  /** default /etc/systemd/system */
  systemdDir?: string
  /** default: the addresses of this machine's interfaces (not loopback, not link-local) */
  hostAddrs?: () => string[]
  /** split: the owner checks of root's and the operator's files (tests: their own uid) */
  splitDeps?: import('../config.ts').SplitDeps
}

/** Append one log line to the daemon's own log, rotating at 10 MB (keeps 3). Never throws. */
export function appendLog(file: string, line: string) {
  try {
    if (existsSync(file) && statSync(file).size > 10 * 1024 * 1024) {
      for (let i = 2; i >= 1; i--) if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`)
      renameSync(file, `${file}.1`)
    }
    appendFileSync(file, line.endsWith('\n') ? line : `${line}\n`, { mode: 0o640 })
  } catch {}
}

/** `gh api -i` with a timeout; `timedOut` when gh was killed for it. */
export const realGhApi = (bin: string, env: () => NodeJS.ProcessEnv): GhRun => (args, o) => {
  // tests never call real GitHub: under `node --test` this is a bug in the test (inject DaemonDeps.ghApi)
  if (process.env.NODE_TEST_CONTEXT) return Promise.resolve({ code: 1, stdout: '', stderr: 'real gh api called from a test (inject ghApi)' })
  return new Promise((resolve) =>
    execFile(bin, args, { timeout: o.timeoutSec * 1000, maxBuffer: 1 << 26, env: env() }, (err, stdout, stderr) => {
      const e = err as (Error & { code?: unknown; killed?: boolean }) | null
      resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout: String(stdout), stderr: String(stderr), timedOut: !!e?.killed })
    }),
  )
}

/** the first line of a RELEASE file (a sha), or null */
export function ownReleaseOf(file: string): string | null {
  try {
    const l = readFileSync(file, 'utf8').split('\n')[0].trim()
    return /^[0-9a-f]{40}$/.test(l) ? l : null
  } catch {
    return null
  }
}

/** runners.json (split): `[{ id, repo, name, labels, version, addedAt }]`; [] when missing or unreadable */
export function readRunners(path: string | null): { id: string; repo: string; name: string }[] {
  if (!path) return []
  try {
    const rows = JSON.parse(readFileSync(path, 'utf8'))
    return Array.isArray(rows) ? rows.filter((r) => r && typeof r.repo === 'string' && typeof r.name === 'string') : []
  } catch {
    return []
  }
}

export const realSys = (cmd: string, args: string[], timeoutSec = 60, env?: NodeJS.ProcessEnv): ReturnType<Sys> =>
  new Promise((resolve) =>
    execFile(cmd, args, { timeout: timeoutSec * 1000, maxBuffer: 1 << 24, env: env ?? process.env }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof (err as any).code === 'number' ? (err as any).code : 127) : 0, stdout: String(stdout), stderr: String(stderr) }),
    ),
  )

export class Daemon {
  readonly c: Ctx
  readonly timers: Timers
  readonly watchdog: Watchdog
  private splitDeps: import('../config.ts').SplitDeps
  private pending = new Set<Promise<unknown>>()

  constructor(d: DaemonDeps) {
    const cfg = d.cfg
    const now = d.now ?? Date.now
    const resources = resolveResources(cfg).sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))
    const db = new Db(join(cfg.stateDir, 'brokerd.db'), now())
    // job ids restart at 1 with a fresh DB: the old jobs/<id>/ dirs (streams, bundles) must not meet the new ids
    if (db.movedAside && existsSync(join(cfg.stateDir, 'jobs'))) renameSync(join(cfg.stateDir, 'jobs'), join(cfg.stateDir, `jobs.${db.movedAside}`))
    // v3: every mirror from before may have been written by a container job (the whole work root was mounted): re-clone
    if (db.movedAside && Number(/^v(\d+)-/.exec(db.movedAside)?.[1]) < 3 && existsSync(join(cfg.stateDir, 'work')))
      renameSync(join(cfg.stateDir, 'work'), join(cfg.stateDir, `work.${db.movedAside}`))
    const secrets = new Set((d.secrets ?? []).filter(Boolean))
    const creds = new Credentials(cfg, { addSecret: (v) => void secrets.add(v) })
    const mirror = new Mirror(join(cfg.stateDir, 'work'), (repo) => cfg.gitUrl.replaceAll('{repo}', repo), d.git ?? realGit(cfg.gitTimeoutSec, () => creds.gitEnv()))
    const logFile = d.logFile ?? null
    const toStdout = (m: string) => process.stdout.write(`${new Date(now()).toISOString()} ${m}\n`)
    const rawLog = (m: string) => {
      ;(d.log ?? toStdout)(m)
      if (logFile) appendLog(logFile, `${new Date(now()).toISOString()} ${m}`)
    }
    // every log line may carry a tail of boat/ssh/gh/git output: scrub it like shard output
    const scrub = (m: string) => scrubText(m, secrets)
    const log = (m: string) => rawLog(scrub(m))
    const c = {
      cfg, resources, db, boat: d.boat, mirror, now, log,
      streams: new JobStreams(join(cfg.stateDir, 'jobs'), log),
      pool: null,
      load: d.load ?? (() => ({ load1: loadavg()[0], nproc: cpus().length })),
      localLock: d.localLock ?? (() => tryLocalSlot(cfg.localLockPath || join(cfg.stateDir, 'local.lock'), cfg.layout === 'split')),
      sys: d.sys ?? realSys,
      gh: d.gh ?? ((args: string[], timeoutSec?: number) => realSys(cfg.ghBin, args, timeoutSec ?? 30, creds.ghEnv())),
      secrets,
      scrub,
      track: (p: Promise<unknown>) => {
        this.pending.add(p)
        void p.finally(() => this.pending.delete(p)).catch(() => {})
      },
      held: new Set<number>(),
      bootAt: now(),
      recovering: false,
      draining: false,
      onDrained: d.onDrained ?? (() => {}),
      jobName: (id: number) => `${cfg.daemonId}-${id}`,
      creds, logFile, netCheck: null, systemdDir: d.systemdDir ?? '/etc/systemd/system', hostAddrs: d.hostAddrs ?? hostAddrs,
      ownRelease: d.ownRelease !== undefined ? d.ownRelease : ownReleaseOf(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'RELEASE')), switchDrain: false, awaitSeed: existsSync(join(cfg.stateDir, 'await-seed')),
      githubDoor: cfg.layout === 'split' ? 'closed: not opened yet' : 'none (single)',
      localDoor: 'open',
    } as unknown as Ctx
    this.c = c
    this.splitDeps = d.splitDeps ?? {}
    c.tdb = new TrustDb(join(cfg.stateDir, 'trust.db'))
    const opts = cfg.layout === 'split' ? { layout: 'split' as const, ownerUid: cfg.operatorUid, snapshotDir: join(cfg.stateDir, 'profiles') } : { layout: cfg.layout }
    c.profile = (name: string): Profile => loadProfile(name, cfg.profilesDir, opts)
    c.jobProfile = (job) => {
      if (job.profileDir && existsSync(join(job.profileDir, 'profile.json'))) return loadProfileDir(job.profileDir, cfg.layout)
      // split: the admitted snapshot or nothing (never quietly the profile as it is now)
      if (job.profileDir && cfg.layout === 'split') throw new ProfileError(`the job's profile snapshot ${job.profileDir} is gone`)
      return c.profile(job.profile)
    }
    c.api = new GithubApi({ run: d.ghApi ?? realGhApi(cfg.ghBin, () => creds.ghEnv()), now, sleep: d.apiSleep, onUnauthorized: creds.reload })
    c.trust = new Trust({
      cfg, tdb: c.tdb, api: c.api, now, log,
      profile: c.profile,
      secretState: (n) => (creds.secret(n) === null ? 'unset' : creds.secretsEqualToCredential().includes(n) ? 'credential' : 'set'),
      sshSecret: (p) => resources.some((r) => r.kind === 'ssh' && !!r.secret && serves(r, p.name)),
      isMerged: (repo, sha, branch) => mirror.isMerged(repo, sha, branch),
      runnerNames: (repo) => readRunners(cfg.runnersJson).filter((r) => r.repo.toLowerCase() === repo.toLowerCase()).map((r) => r.name),
      activeGithubJobs: () => db.jobsInStates(ACTIVE_JOB_STATES).filter((j) => j.door === 'github').length,
      publicNet: () => c.netCheck,
      probeNet: () => this.watchdog.probe(true),
    })
    const boatRes = resources.find((r) => r.kind === 'boat')
    if (resources.filter((r) => r.kind === 'boat').length > 1) log('config: more than one boat resource; only the first is used')
    if (boatRes) {
      c.pool = new BoatPool({
        db, boat: d.boat, cfg, resource: boatRes, now, log, scrub, track: c.track,
        legacyEnv: (profile) => {
          try {
            const p = c.profile(profile)
            return boatRes.environment ?? p.boatEnvironment ?? null
          } catch {
            return null
          }
        },
      })
    }
    const local = new LocalExecutor(cfg, mirror, d.runLocal, (n) => creds.readSecret(n))
    const bundles = new RemoteBundles(mirror)
    const wrap = d.wrapScript ?? WRAP_SCRIPT
    const executors: Partial<Record<ResourceKind, Executor>> = { local }
    if (c.pool) executors.boat = new BoatExecutor(cfg, db, d.boat, c.pool, bundles, wrap)
    c.sshExec = resources.some((r) => r.kind === 'ssh') ? new SshExecutor(cfg, resources, bundles, wrap, (n) => creds.readSecret(n)) : null
    if (c.sshExec) executors.ssh = c.sshExec
    c.githubExec = resources.some((r) => r.kind === 'github') ? new GithubExecutor({ cfg, db, resources, gh: c.gh, now, jobName: c.jobName, wait: d.githubWait }) : null
    if (c.githubExec) executors.github = c.githubExec
    c.checks = new Checks(c, executors, local)
    c.jobs = new Jobs(c)
    c.statuses = new Statuses(c)
    c.shards = new ShardRunner(c, executors)
    c.scheduler = new Scheduler(c, local)
    this.watchdog = new Watchdog(c)
    this.timers = new Timers(c, this.watchdog)
  }

  /** Put the previous process's state right (see recovery.ts), then adopt boxes from `boat list`. */
  async recover() {
    this.c.recovering = true // set before the first await: no pass may place work on what recovery cleans up
    try {
      await recover(this.c)
    } finally {
      this.c.recovering = false
    }
    await this.timers.boat()
    // once at start, after recovery: tiers, blocks, the door, the public network
    await this.watchdog.tick().catch((e) => this.c.log(`watchdog: ${(e as Error).message}`))
  }

  /** Wait until nothing runs in the background (passes, shards, Boat calls). For tests and drain. */
  async idle() {
    while (this.pending.size) await Promise.allSettled([...this.pending])
  }

  drain(): { running: number } {
    const c = this.c
    if (!c.draining) c.log('drain: placing nothing more; exiting once no shard runs')
    c.draining = true
    const running = c.shards.count()
    if (!running) queueMicrotask(() => c.onDrained())
    return { running }
  }

  /**
   * split: root's config (trust, secrets) and the operator's tuning apply at the next request. A bad root file
   * refuses (naming it). A bad tuning.json refuses a local submit but never stops root's file from applying, and the
   * GitHub door ignores it (the operator can't hold back root's revocations).
   */
  reloadConfig(door: 'local' | 'github', o: { report?: boolean } = {}) {
    try {
      reloadLive(this.c.cfg, this.splitDeps, { tuning: door === 'github' ? 'ignore' : 'throw', log: this.c.log })
      applyLiveCaps(this.c.cfg, this.c.resources)
    } catch (e) {
      // report: false (doctor) → the ConfigError itself, no refusal in the trust log
      if (!(e instanceof ConfigError) || o.report === false) throw e
      this.c.trust.refuse({ check: 'profile', door, repo: null, run: null }, e.message)
    }
  }

  /** `trust unblock` (the watchdog's mutex: a tick and an unblock never interleave) */
  unblock(repo: string) {
    return this.watchdog.unblock(repo)
  }

  resetResource(id: string): { health: number; boxes: number } {
    const c = this.c
    const r = c.resources.find((x) => x.id === id)
    if (!r) throw new Error(`no resource ${id}`)
    const health = c.db.allHealth().filter((h) => h.resource === id).length
    c.db.resetHealth(id)
    const boxes = r.kind === 'boat' && c.pool ? c.pool.reset() : 0
    c.log(`resource ${id}: reset (${health} health rows, ${boxes} boxes out of quarantine)`)
    c.scheduler.wake()
    return { health, boxes }
  }

  status() {
    const c = this.c
    const jobs = c.jobs.activeJobs().map((j) => ({ ...this.jobView(j.id), shards: c.db.shards(j.id) }))
    return {
      daemonId: c.cfg.daemonId,
      draining: c.draining,
      bootAt: c.bootAt,
      jobs,
      resources: c.resources.map((r) => {
        const { githubTokenCmd, ...shown } = r
        return {
          ...shown,
          ...(githubTokenCmd ? { githubTokenCmd: '(set)' } : {}),
          health: c.db.allHealth().filter((h) => h.resource === r.id),
          ...(r.kind === 'ssh' || r.kind === 'local'
            ? { slotsBusy: c.db.slots().filter((s) => s.resource === r.id).map((s) => ({ ...s, job: s.jobId ? c.jobName(s.jobId) : 'check' })) }
            : {}),
        }
      }),
      githubRuns: c.db.ghRunsInFlight().map((g) => ({ ...g, job: c.jobName(g.jobId) })),
      slots: c.db.slots(),
      boxes: c.pool?.boxes() ?? [],
      starts: c.pool?.lastStarts ?? null,
      pendingStarts: c.pool?.pendingStarts() ?? 0,
      startsReserve: c.cfg.startsReserve,
      held: [...c.held].map(c.jobName),
    }
  }

  jobView(id: number) {
    const c = this.c
    const j = c.jobs.get(id)
    const dir = c.streams.dir(id)
    const artifacts = join(dir, 'artifacts')
    return {
      ...j,
      id: c.jobName(j.id),
      num: j.id,
      dir,
      artifacts: existsSync(artifacts) ? readdirSync(artifacts) : [],
      statusTargets: c.db.statusTargets(id),
    }
  }

  jobDetail(id: number) {
    return { ...this.jobView(id), shards: this.c.db.shards(id), events: this.c.db.events(id) }
  }
}
