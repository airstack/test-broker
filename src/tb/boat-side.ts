// The Boat half of test-brokerd: reserve a box for every shard now (idle or stopped boxes only: a create is too slow
// to count as "now"), or say why not and create the missing boxes in the background for the next ask. A run snapshots
// the caller's working tree, starts the boxes, and runs each shard through ci-broker's wrapper and the repo's remote
// script. Kills: the start deadline, the suite's maxSec, a shard silent for silentSec, the caller's connection closing.
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { CliBoat, type Boat } from '../core/boat.ts'
import { BoxesDb } from '../core/boxes-db.ts'
import { BoatPool, type BoxFilter, type Placed, type PoolCfg, type PoolResource } from '../core/boatpool.ts'
import type { BoxRow } from '../core/boxes-db.ts'
import { artifactsCommand, killCommand, remoteCommand, seedProbeCommand, type SlotShare } from '../core/boat-commands.ts'
import { repoDir } from '../core/mirror.ts'
import { summarize, type ShardResult } from '../core/summary.ts'
import type { RunsDb, UsageShard } from './runs-db.ts'
import { parseResources, shardPlanHours } from './usage.ts'
import { gitInfo } from './broker.ts'
import { WRAP_SCRIPT_PATH } from './paths.ts'
import { buildSnapshot, git } from '../core/snapshot.ts'
import type { BoatSide, BoatTry } from './broker.ts'
import type { MachineConfig } from './machine-config.ts'
import { SIZE_UNITS, UNIT_MEM_MB, boxUnits, loadRepoConfig, type BoatShard, type ExtraRepo, type RepoConfig, type Suite } from './repo-config.ts'
import { argsKey, EtaModel, type EtaKey } from './eta.ts'
import { dayTarget, repoBoxHours } from './usage.ts'
import type { RunEvent, Runs } from './server.ts'
import { Activity, EARLY_STOP_REASON, RECENT_MS, p90, pastTarget, startsGuard, unitsPerAgent, warmUnits } from './warm.ts'
import { LogSummer } from './logsum.ts'
import { pruneSeeds, readRunLog, tidyRuns } from './housekeep.ts'
import { OutagePause } from './outage.ts'
import { BoxFlags, boxScores, type BoxScore, type Drain } from './boxspeed.ts'
import { parseProbe, probeCommand, probeFaults, probeKillCommand, probeScores, type ProbeResult, type ProbeScore } from './probe.ts'

const slotDir = (slot: number) => `/home/user/cib/${slot}`
/** one unit of a box: 2 CPUs + 4 GB (small = 1 unit, default 2, large 4) */
const UNIT_CPUS = 2
/** a seed bundle (a repo's whole history) may be 100 MB or more */
const SEED_UPLOAD_SEC = 600

/** a seed bundle could not be built on this machine (not the box's fault) */
class LocalSeedError extends Error {}
const execFileP = promisify(execFile)
/** what a run keeps of each shard's output for the receipt (the full output is in the run's log file) */
const LOG_TAIL = 2_000_000
/** done runs are forgotten (their events, not their log files) after this long */
const KEEP_DONE_MS = 2 * 3600_000
const MAX_SNAPSHOT_FILE_MB = 50
const MAX_REPLAY = 8_000_000

/** The few settings BoatPool reads, mapped from test-broker's machine config. */
export function poolConfig(cfg: MachineConfig): { cfg: PoolCfg; resource: PoolResource } {
  const c: PoolCfg = {
    daemonId: 'tb',
    // adopt this host's pool boxes (tbx-<host>-…) too
    poolHost: cfg.boat.hostId,
    infraFailLimit: 3,
    startsReserve: cfg.boat.startsReserve,
    pool: { ttlSec: cfg.boat.ttlSec, idleStopSec: cfg.boat.idleStopMin * 60, warmHours: null, deleteAfterDays: cfg.boat.stoppedDeleteHours / 24 },
  }
  return { cfg: c, resource: { id: 'boat', maxBoxes: cfg.boat.maxBoxes } }
}

/**
 * fetch: aborted by a cancel, which must not wait on an artifacts fetch (a kill by deadline or silence does).
 * size: the box's size; slot: the shard's slot on it (0 unless boat.packing), its first unit; how 'shared': the box was
 * already running another shard. left: the shard gave its units back.
 */
type ShardRun = {
  shard: BoatShard; box: string; size: string; slot: number; how: Placed['how'] | 'shared' | 'wait'; ac: AbortController; fetch: AbortController; why: string | null; ready: boolean; started: boolean; t0: number; log: string; artifacts: string | null; left: boolean
  /** its time estimate's key */
  etaKey: EtaKey
  /** the queue: its claim on a busy box while it waits (slot -1 until the claim is served) */
  wait: Waiter | null
  /** seconds it waited, once it has a box (null: it never waited) */
  waitedSecs: number | null
  /** its wait gave up: it was placed again, with no wait */
  waitGaveUp: boolean
  /** its output in short, built as it streams in (runs.db keeps it) */
  sum: LogSummer
  /** the box failed under it (an I/O error in its output, or an infra exit code): it runs again on another box */
  boxFault: string | null
}

/** what in a failed shard's output means the box's disk or filesystem failed, not the code under test */
export const IO_FAULT_RE = /Input\/output error|\bEIO\b|Read-only file system|\bEROFS\b|No space left on device|\bENOSPC\b/

/**
 * The queue: a shard's claim on a busy box whose holders
 * are about to be done. One claim per box. leave() serves it (the units go to it before the box can go back to the
 * pool); its timer gives it up (resolve null: the shard is placed again, with no wait).
 */
type Waiter = {
  box: string; units: number; memMb: number; holder: string; etaSec: number; startCost: number; limitSec: number
  /** the pool's box filter when the claim was made: the box must still pass it to be served */
  only: BoxFilter
  slot: number | null; done: boolean; timer: NodeJS.Timeout | null
  promise: Promise<number | null>; resolve: (slot: number | null) => void
}
/** what a run's placement may wait on: null = no shard waits */
type WaitCtx = { maxWait: (s: BoatShard) => number; key: (s: BoatShard) => EtaKey; pressure: boolean }

/** a shard's log summary; a parser error leaves it out (bookkeeping never fails a run) */
function summary(s: LogSummer): ReturnType<LogSummer['result']> | undefined {
  try {
    return s.result()
  } catch {
    return undefined
  }
}

/** The smallest size on this machine whose box holds `units`, or null. */
export function sizeFor(units: number, sizes: readonly string[]): string | null {
  return [...sizes].filter((z) => (SIZE_UNITS[z] ?? 0) >= units).sort((a, b) => SIZE_UNITS[a] - SIZE_UNITS[b])[0] ?? null
}

/** The first slot (unit index) with `units` free units in a row, or -1. */
export function freeSlot(units: (string | null)[], want: number): number {
  for (let i = 0; i + want <= units.length; i++) if (units.slice(i, i + want).every((u) => u === null)) return i
  return -1
}

/** A slot's share: its CPUs (`2*slot`…), memory (the shard's memMb, else 4 GB a unit) and units. */
export function shareOf(slot: number, units: number, memMb = units * UNIT_MEM_MB): SlotShare {
  return { units, cpus: units * UNIT_CPUS, cpuset: `${slot * UNIT_CPUS}-${(slot + units) * UNIT_CPUS - 1}`, memMb }
}
type Run = {
  id: string
  repo: string
  suite: string
  owner: string
  events: RunEvent[]
  subs: Set<(e: RunEvent) => void>
  shards: ShardRun[]
  done: boolean
  doneAt: number
  logFile: string
  timers: NodeJS.Timeout[]
  logBytes: number
  /** end the run as not started (exit 3: the caller runs here); set while it runs */
  notStart: ((why: string) => void) | null
}

export type BoatDeps = {
  cfg: MachineConfig
  stateDir: string
  boat: Boat
  log: (m: string) => void
  now?: () => number
  /** the repo's base commit for a bundle (default: merge-base HEAD with origin's default branch) */
  baseOf?: (root: string) => Promise<string | null>
  wrapScript?: string
  /** does GitHub say this repo is private? (default: `gh api repos/<repo>` with the dev user's own login) */
  isPrivate?: (repo: string) => Promise<boolean>
  /** where an extra repo is fetched from on this dev box (default: GitHub over https, with gh's login) */
  extraUrl?: (repo: string) => string
  /** usage accounting (runs.db); none: nothing recorded */
  usage?: RunsDb | null
}

/** An extra repo resolved for one run: its commit and the bundle that holds it. */
type Extra = { name: string; repo: string; sha: string; file: string }
const EXTRA_DIR = '/home/user/cib/extra'

/** `gh api repos/<repo> --jq .private`: true only on a clear "true". No token reaches argv: gh reads its own login. */
export function ghIsPrivate(repo: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    execFile('gh', ['api', `repos/${repo}`, '--jq', '.private'], { encoding: 'utf8', timeout: 20_000 }, (e, out) => {
      if (e) return reject(new Error(`gh api repos/${repo}: ${String(e.message).split('\n')[0]}`))
      resolve(String(out).trim() === 'true')
    })
  })
}

export type BudgetView = { todayHours: number; targetHours: number; pressure: number; walletHours: number | null }
/** `test-broker ask` on Boat: per shard what it would get now (startSec: until it runs; runSec: its usual time, p75) */
export type BoatPeek = {
  shards: { name: string; how: 'shared' | 'reused' | 'wait' | 'resume' | 'create' | 'none'; box: string | null; startSec: number | null; runSec: number | null }[]
  pool: { busy: number; idle: number; starting: number; stopped: number; quarantined: number; waiting: number }
  budget: BudgetView | null
}

/** a shard's placement: its box, the box's size, its slot there */
type Pick = { shard: BoatShard; box: string; size: string; slot: number; how: Placed['how'] | 'shared' | 'wait'; wait?: Waiter }

/** an ask's Boat part this slow is logged with where the time went */
const SLOW_ASK_MS = 3_000
const GATE_OK_MS = 30 * 60_000
const GATE_NO_MS = 5 * 60_000
/** the state dir's housekeeping (compress and prune run logs, prune seeds): at most this often */
const TIDY_EVERY_MS = 10 * 60_000
/** a repo's units per agent is learned again from runs.db this often */
const UPA_TTL_MS = 3600_000

/** the warm pool's view of one pool (`status --json`) */
export type WarmView = { env: string; targetUnits: number; dRecent: number | null; dAgents: number; agents: number; startsGuard: boolean; pastTarget: string[] }

/**
 * The bundle the remote script fetches: `refs/cib/snap` = the snapshot commit, minus `base`. Built in a throwaway bare
 * repo that borrows the worktree's objects (alternates), so the caller's repo gets no ref and two runs never clash.
 */
export async function snapshotBundle(root: string, commit: string, base: string | null, file: string, tmpRepo: string): Promise<void> {
  await refBundle(root, 'refs/cib/snap', commit, base ? [base] : [], file, tmpRepo)
}

/** A bundle of `ref` = `commit`, minus `not` (none: the whole history), in a throwaway bare repo (alternates). */
export async function refBundle(root: string, ref: string, commit: string, not: string[], file: string, tmpRepo: string): Promise<void> {
  const objects = (await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim() + '/objects'
  mkdirSync(tmpRepo, { recursive: true })
  try {
    await git(tmpRepo, ['init', '-q', '--bare'])
    writeFileSync(join(tmpRepo, 'objects', 'info', 'alternates'), `${objects}\n`)
    await git(tmpRepo, ['update-ref', ref, commit])
    await git(tmpRepo, ['bundle', 'create', '--quiet', file, ref, ...(not.length ? ['--not', ...not] : [])])
  } finally {
    rmSync(tmpRepo, { recursive: true, force: true })
  }
}

/** The origin default branch's name (`main`), or null. */
export async function defaultBranch(root: string): Promise<string | null> {
  const def = await defaultRef(root)
  return def ? def.replace(/^refs\/remotes\/origin\//, '') : null
}

async function defaultRef(root: string): Promise<string | null> {
  let def = (await git(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']).catch(() => '')).trim()
  if (!def) for (const b of ['refs/remotes/origin/main', 'refs/remotes/origin/master']) if (await git(root, ['rev-parse', '--verify', '--quiet', b]).then(() => true, () => false)) {
    def = b
    break
  }
  return def || null
}

export async function defaultBase(root: string): Promise<string | null> {
  const def = await defaultRef(root)
  if (!def) return null
  return (await git(root, ['merge-base', 'HEAD', def]).catch(() => '')).trim() || null
}

/** Of `tips`, the commits the dev box's repo has. */
async function knownCommits(root: string, tips: string[]): Promise<string[]> {
  const out: string[] = []
  for (const t of tips) if (/^[0-9a-f]{40}$/.test(t) && (await git(root, ['cat-file', '-e', `${t}^{commit}`]).then(() => true, () => false))) out.push(t)
  return out
}

export class BoatRuns implements BoatSide, Runs {
  readonly pool: BoatPool
  private d: Required<BoatDeps>
  private runs = new Map<string, Run>()
  private lock: Promise<unknown> = Promise.resolve()
  private n = 0
  private packs = 0
  private pending = new Set<Promise<unknown>>()
  /** box starts failing on several boxes: skip Boat for a while (outage.ts) */
  readonly outage: OutagePause
  /** drains and slow clocks, in <state>/box-flags.json */
  readonly flags: BoxFlags
  /** box name → its speed score, from runs.db (refreshSpeed) */
  private scores = new Map<string, BoxScore>()
  /** box name → its probe score, from runs.db's box_probes (refreshSpeed) */
  private probeScores = new Map<string, ProbeScore>()
  /** the probes running now: box → its abort */
  private probing = new Map<string, AbortController>()
  /** box → when it was last probed, and when it last started (a resume or a create): a start earns a new probe */
  private probedAt = new Map<string, number>()
  private startedAt = new Map<string, number>()

  constructor(d: BoatDeps) {
    this.d = { now: Date.now, baseOf: defaultBase, wrapScript: WRAP_SCRIPT_PATH, isPrivate: ghIsPrivate, extraUrl: (r) => `https://github.com/${r}.git`, usage: null, ...d }
    this.outage = new OutagePause(() => this.d.cfg.boat, this.d.now, d.log)
    const db = new BoxesDb(join(d.stateDir, 'boxes.db'))
    const pc = poolConfig(d.cfg)
    this.pool = new BoatPool({
      db, boat: d.boat, cfg: pc.cfg, resource: pc.resource, now: this.d.now, log: d.log, legacyEnv: () => null, track: (p) => this.track(p),
      onState: (b) => {
        // a box leaving idle (placed, stopped, quarantined, deleted) stops its probe at once
        if (b.state !== 'idle') this.probing.get(b.name)?.abort()
        if (b.state === 'resuming' || b.state === 'creating') this.startedAt.set(b.name, this.d.now())
        this.record(() => this.d.usage!.boxEvent({ t: this.d.now(), box: b.name, size: b.size, state: b.state, repo: b.lastRepo ?? null, reason: b.state === 'stopping' ? b.reason : null }))
      },
    })
    mkdirSync(join(d.stateDir, 'runs'), { recursive: true, mode: 0o700 })
    this.flags = new BoxFlags(join(d.stateDir, 'box-flags.json'), d.log)
    if (this.d.usage)
      try {
        this.eta.load(this.d.usage, this.d.now() - 48 * 3_600_000)
      } catch (e) {
        d.log(`eta: could not read runs.db: ${(e as Error).message}`)
      }
    this.track(this.tidy())
    this.seedActivity()
    if (this.d.usage)
      try {
        for (const p of this.d.usage.boxProbesSince(this.d.now() - 24 * 3_600_000)) this.probedAt.set(p.box, Math.max(p.t, this.probedAt.get(p.box) ?? 0))
      } catch {}
    this.refreshSpeed()
    // a daemon that died mid-run left its boxes busy (or mid-resume): no run of this process uses them. The next run's
    // wrapper kills whatever the old one left on a box; reconcile corrects the states against `boat list`.
    for (const b of this.pool.boxes()) {
      if (b.state === 'busy') this.pool.setState(b.name, 'idle', { reason: 'busy when test-brokerd started' })
      else if (b.state === 'resuming') this.pool.setState(b.name, 'stopped', { reason: 'resuming when test-brokerd started' })
    }
    // usage: every box's state as of now, so a box already up at start counts from here (its next change ends it)
    for (const b of this.pool.boxes()) this.record(() => this.d.usage!.boxEvent({ t: this.d.now(), box: b.name, size: b.size, state: b.state, repo: b.lastRepo ?? null }))
  }

  private track(p: Promise<unknown>) {
    this.pending.add(p)
    p.finally(() => this.pending.delete(p)).catch(() => {})
  }
  /** wait for background work (tests) */
  async idle() {
    while (this.pending.size) await Promise.allSettled([...this.pending])
  }

  /** one ask at a time through the reservation, so two asks never count the same box */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.lock.then(fn, fn)
    this.lock = p.catch(() => {})
    return p
  }

  async tryRun(o: { repo: string; cfg: RepoConfig; suite: Suite; args: string[]; owner: string }): Promise<BoatTry> {
    // an agent tests in this worktree: the warm pool counts it (and refreshes its hint)
    this.activity.run(o.cfg.root, o.repo, this.envOf(o.cfg), this.d.now())
    // a slow ask makes the caller wait (and, past its timeout, run here with no lease): log where the time went
    const t0 = Date.now()
    const why = await this.gate(o.repo)
    if (why) {
      this.slowAsk(o, t0, `gate ${Date.now() - t0}ms`)
      return { why }
    }
    const paused = this.outage.check()
    if (paused) return { why: paused }
    const t1 = Date.now()
    let t2 = t1
    try {
      return await this.serial(() => {
        t2 = Date.now()
        return this.reserve(o)
      })
    } finally {
      this.slowAsk(o, t0, `gate ${t1 - t0}ms, queue ${t2 - t1}ms, reserve ${Date.now() - t2}ms`)
    }
  }

  private slowAsk(o: { repo: string; suite: Suite }, t0: number, parts: string) {
    if (Date.now() - t0 >= SLOW_ASK_MS) this.d.log(`ask ${o.repo} ${o.suite.name}: Boat took ${Date.now() - t0}ms (${parts})`)
  }

  private gateCache = new Map<string, { ok: boolean; why: string; at: number }>()

  /** Only private repos of an owner in `boat.owners` may run on Boat. Null = allowed; else why not. */
  async gate(repo: string): Promise<string | null> {
    const owner = repo.split('/')[0].toLowerCase()
    if (!this.d.cfg.boat.owners.includes(owner)) return `Boat: owner ${owner} is not in boat.owners on this machine`
    const now = this.d.now()
    const c = this.gateCache.get(repo)
    if (c && now - c.at < (c.ok ? GATE_OK_MS : GATE_NO_MS)) return c.ok ? null : c.why
    let ok = false
    let why = `Boat: ${repo} is not private`
    try {
      ok = await this.d.isPrivate(repo)
    } catch (e) {
      why = `Boat: cannot tell if ${repo} is private (${(e as Error).message})`
    }
    this.gateCache.set(repo, { ok, why, at: now })
    if (!ok) this.d.log(why)
    return ok ? null : why
  }

  /** The Boat environment a repo runs in: its pool's, `tbx-<host>-<pool>`. */
  envOf(cfg: RepoConfig): string {
    return `tbx-${this.d.cfg.boat.hostId}-${cfg.boat!.pool}`
  }

  private envReady = new Set<string>()

  /**
   * A pool's environment: made on first use to inject nothing, then checked on every ask (Boat's answer is reused for
   * 30 s) with the public lane's gate. Boxes are fit when made by the pool at the checked environment version; others
   * are deleted when free. Returns the box filter, or why the pool can't be used now.
   */
  private repaired = new Map<string, number>()
  /** the last filter poolGate gave per environment (what a peek uses) */
  private lastGate = new Map<string, BoxFilter>()

  private async poolGate(env: string): Promise<BoxFilter | { none: string }> {
    if (!this.d.cfg.boat.hostId) return { none: 'Boat: pools need boat.hostId (no hostname or machine id here): set it in the machine config' }
    if (!this.envReady.has(env)) {
      try {
        await this.d.boat.envInfo(env)
      } catch (e) {
        if (!/no environment named/.test((e as Error).message)) return { none: `Boat: pool environment ${env} could not be read: ${(e as Error).message.slice(0, 200)}` }
        try {
          await this.d.boat.envCreate(env)
          this.d.log(`pool environment ${env}: created (injects nothing)`)
        } catch (e2) {
          return { none: `Boat: pool environment ${env} could not be created: ${(e2 as Error).message.slice(0, 200)}` }
        }
      }
      this.envReady.add(env)
    }
    const max = poolConfig(this.d.cfg).resource.maxBoxes ?? 0
    // a box made since the last check has no version yet: look now, so it can be reused at once (else each ask in
    // the next 30 s would make another box)
    const unversioned = this.pool.boxes().some((b) => b.env === env && b.boatId && b.envVersion == null && (b.state === 'idle' || b.state === 'stopped'))
    let g = await this.pool.publicGate(env, `pool:${env}`, { envs: new Set([env]), max, fresh: unversioned })
    // our own pool environment, not marked safe (a create that stopped half way, or a hand edit): mark it again, at
    // most once per 10 min, and look again
    if ('none' in g && / injects /.test(g.none) && this.d.now() - (this.repaired.get(env) ?? 0) > 600_000) {
      this.repaired.set(env, this.d.now())
      try {
        await this.d.boat.envMakeSafe(env)
        this.d.log(`pool environment ${env}: marked safe again (it injected something)`)
        g = await this.pool.publicGate(env, `pool:${env}`, { envs: new Set([env]), max, fresh: true })
      } catch (e) {
        this.d.log(`pool environment ${env}: env set failed: ${(e as Error).message.slice(0, 200)}`)
      }
    }
    if (!('none' in g)) this.lastGate.set(env, g)
    return 'none' in g
      ? { none: g.none.replace(/^boat: public environment/, 'Boat: pool environment').replace('--safe-for-third-parties true', '--safe-for-third-parties true --proxy-ai-credentials false') }
      : g
  }

  private async reserve(o: { repo: string; cfg: RepoConfig; suite: Suite; args: string[]; owner: string }): Promise<BoatTry> {
    const env = this.envOf(o.cfg)
    const sizes = this.d.cfg.boat.sizes as string[]
    const packing = this.d.cfg.boat.packing
    // the box size per shard: packing goes by units (CPUs and RAM) only; else the shard's size, or the smallest one
    // holding its units
    const sized = o.suite.boat!.shards.map((s) => ({ shard: s, size: packing ? sizeFor(boxUnits(s), sizes) : (s.size ?? sizeFor(boxUnits(s), sizes)) }))
    const noFit = sized.filter((x) => !x.size).map((x) => `${x.shard.name} (${x.shard.units} unit(s), ${x.shard.memMb} MB)`)
    if (noFit.length) return { why: `Boat: no box size on this machine (boat.sizes) holds ${noFit.join(', ')}` }
    const off = [...new Set(sized.map((x) => x.size!).filter((z) => !sizes.includes(z)))]
    if (off.length) return { why: `Boat: size ${off.join(', ')} is off on this machine (boat.sizes)` }
    const gate = await this.poolGate(env)
    if ('none' in gate) return { why: gate.none }
    const only = this.boxRules(gate, o.suite)
    const shape = o.args.length ? 'narrowed' : 'whole'
    const key = (s: BoatShard): EtaKey => ({ repo: o.repo, suite: o.suite.name, shape, shard: s.name, argsKey: s.passArgs ? argsKey(o.args) : '-' })
    const wait: WaitCtx = { maxWait: () => Math.min(this.d.cfg.boat.maxWaitSec, o.suite.boat!.maxWaitSec ?? o.cfg.boat!.maxWaitSec), key, pressure: this.pressure() }
    const placed = packing ? await this.pack(env, o.repo, sized.map((x) => x.shard), only, wait) : await this.placeEach(env, o.repo, sized as { shard: BoatShard; size: string }[], only)
    if ('why' in placed) return placed
    const shards = placed.picks
    const id = `tb-${(++this.n).toString().padStart(3, '0')}-${this.d.now().toString(36).slice(-5)}`
    const run: Run = {
      id, repo: o.repo, suite: o.suite.name, owner: o.owner, events: [], subs: new Set(), done: false, doneAt: 0,
      logFile: join(this.d.stateDir, 'runs', `${id}.log`), timers: [], logBytes: 0,
      notStart: null,
      shards: shards.map((x) => ({
        shard: x.shard, box: x.box, size: x.size, slot: x.slot, how: x.how, ac: new AbortController(), fetch: new AbortController(), why: null, ready: false, started: false, t0: this.d.now(), log: '', artifacts: null, left: false,
        etaKey: key(x.shard), wait: x.wait ?? null, waitedSecs: null, waitGaveUp: false, sum: new LogSummer(), boxFault: null,
      })),
    }
    // the units are the run's from now on (a claim served while the run was placed holds its units under the pending name)
    if (packing)
      for (const s of run.shards) {
        if (s.wait) {
          s.wait.holder = `${id}/${s.shard.name}`
          if (s.wait.slot != null) this.occupy(s.box, s.wait.slot, s.shard.units, s.wait.holder, s.shard.memMb)
        } else this.occupy(s.box, s.slot, s.shard.units, `${id}/${s.shard.name}`, s.shard.memMb)
      }
    this.runs.set(id, run)
    this.d.log(`run ${id}: ${o.repo} ${o.suite.name} on ${shards.map((x) => (x.wait ? `${x.box} (wait, about ${Math.round(x.wait.etaSec)}s)` : `${x.box}${packing ? ` slot ${x.slot}` : ''} (${x.how})`)).join(', ')}`)
    this.record(() =>
      this.d.usage!.startRun({
        id, repo: o.repo, root: o.cfg.root, suite: o.suite.name, shape: o.args.length ? 'narrowed' : 'whole', argsN: o.args.length, argsKey: argsKey(o.args), whereRan: 'boat', boatWhy: null, startedAt: this.d.now(),
        cpus: run.shards.reduce((n, s) => n + s.shard.units * 2, 0), shards: run.shards.map((s) => this.usageShard(s, null)),
      }),
    )
    void gitInfo(o.cfg.root).then((g) => this.record(() => this.d.usage!.setGit(id, g)))
    this.track(this.execute(run, o))
    return { run: id, shards: shards.length }
  }

  /** units in use per busy box (boat.packing): one entry per unit, the run/shard holding it or null */
  private occ = new Map<string, (string | null)[]>()
  /** per box slot (`<box>#<slot>`): attempts whose exec ended with no status (or was killed), fenced by the next */
  private lost = new Map<string, string[]>()
  /** box starts in flight: shards that share a box wait on one start */
  private starting = new Map<string, Promise<void>>()

  /** RAM held per busy box (boat.packing): per holder in `occ`, its memMb */
  private mem = new Map<string, Map<string, number>>()

  /** Set units slot…slot+units to `who` (null frees them), with `who`'s RAM; a holder left with no unit drops its RAM. */
  private occupy(box: string, slot: number, units: number, who: string | null, memMb = 0) {
    const cap = SIZE_UNITS[this.pool.d.db.box(box)?.size ?? ''] ?? 1
    const u = this.occ.get(box) ?? new Array<string | null>(cap).fill(null)
    const was = new Set(u.slice(slot, slot + units).filter((x): x is string => x !== null && x !== who))
    for (let i = slot; i < slot + units; i++) u[i] = who
    const m = this.mem.get(box) ?? new Map<string, number>()
    for (const w of was) if (!u.includes(w)) m.delete(w)
    if (who !== null) m.set(who, memMb)
    if (u.every((x) => x === null)) {
      this.occ.delete(box)
      this.mem.delete(box)
    } else {
      this.occ.set(box, u)
      this.mem.set(box, m)
    }
  }

  /** RAM free on a box: its size's (4 GB a unit) less what its holders need */
  private memFree(box: string): number {
    const cap = (SIZE_UNITS[this.pool.d.db.box(box)?.size ?? ''] ?? 1) * UNIT_MEM_MB
    let used = 0
    for (const v of this.mem.get(box)?.values() ?? []) used += v
    return cap - used
  }

  /** the queue: the claim on each busy box (one per box) */
  private claims = new Map<string, Waiter>()
  /** shard times, from runs.db and from each shard that passes */
  readonly eta = new EtaModel()

  /** Seconds until a holder (`<run>/<shard>`) in `occ` is done; null: unknown (a pending pick, or no history). */
  private holderRemaining(holder: string): number | null {
    const i = holder.indexOf('/')
    const run = this.runs.get(holder.slice(0, i))
    const s = run?.shards.find((x) => x.shard.name === holder.slice(i + 1))
    if (!s || s.left) return null
    return this.eta.remaining(s.etaKey, (this.d.now() - s.t0) / 1000)
  }

  /**
   * Seconds until `box` has room for `s` (its units in a row and its RAM), its holders leaving soonest first; null:
   * it never does by a holder with a known time.
   */
  freeAt(box: string, s: { units: number; memMb: number }): number | null {
    const cap = SIZE_UNITS[this.pool.d.db.box(box)?.size ?? ''] ?? 1
    if (s.units > cap || s.memMb > cap * UNIT_MEM_MB) return null
    const units = [...(this.occ.get(box) ?? new Array<string | null>(cap).fill(null))]
    const mem = new Map(this.mem.get(box) ?? [])
    const memFree = () => cap * UNIT_MEM_MB - [...mem.values()].reduce((a, b) => a + b, 0)
    const fits = () => freeSlot(units, s.units) >= 0 && memFree() >= s.memMb
    if (fits()) return 0
    const holders = [...new Set(units.filter((x): x is string => x !== null))].map((h) => ({ h, t: this.holderRemaining(h) }))
    holders.sort((a, b) => (a.t ?? Infinity) - (b.t ?? Infinity))
    for (const { h, t } of holders) {
      if (t == null) return null
      for (let i = 0; i < units.length; i++) if (units[i] === h) units[i] = null
      mem.delete(h)
      if (fits()) return t
    }
    return null
  }

  /** The busy box `s` would wait on (no claim taken): the one free soonest, within the bound; null: none. */
  private bestWait(env: string, s: BoatShard, only: BoxFilter, sizes: string[], w: WaitCtx): { box: string; t: number; startCost: number; max: number } | null {
    const max = w.maxWait(s)
    if (max <= 0) return null
    const startCost = this.eta.startCost(w.key(s))
    // with budget pressure a wait up to maxWaitSec is cheaper than a box start; else only one no slower than a start
    const bound = w.pressure ? max : Math.min(max, startCost)
    const failLimit = poolConfig(this.d.cfg).cfg.infraFailLimit
    let best: { box: string; t: number } | null = null
    for (const b of this.pool.boxes()) {
      if (b.env !== env || b.state !== 'busy' || !this.occ.has(b.name) || this.claims.has(b.name)) continue
      if (!only.allow(b) || !sizes.includes(b.size) || b.infraFails >= Math.max(1, failLimit - 1)) continue
      // a slow box is no box to wait for: a start (or a slow idle box) is placed instead
      if (this.isSlow(b.name)) continue
      const t = this.freeAt(b.name, s)
      if (t != null && t <= bound && (!best || t < best.t)) best = { box: b.name, t }
    }
    return best && { ...best, startCost, max }
  }

  /** The busy box to wait on for `s`, with a claim on it, or null (no wait: the caller starts a box). */
  private waitPlan(env: string, s: BoatShard, only: BoxFilter, sizes: string[], w: WaitCtx): Waiter | null {
    const best = this.bestWait(env, s, only, sizes, w)
    if (!best) return null
    const { startCost, max } = best
    let resolve!: (slot: number | null) => void
    const promise = new Promise<number | null>((r) => (resolve = r))
    const limitSec = Math.min(max, best.t + Math.max(15, best.t * 0.5))
    const wt: Waiter = { only, box: best.box, units: s.units, memMb: s.memMb, holder: `pending-wait-${++this.packs}/${s.name}`, etaSec: best.t, startCost, limitSec, slot: null, done: false, timer: null, promise, resolve }
    wt.timer = setTimeout(() => this.giveUp(wt, `not free within ${Math.round(limitSec)}s`), limitSec * 1000)
    wt.timer.unref?.()
    this.claims.set(best.box, wt)
    return wt
  }

  /** a claim ends unserved: the shard is placed again (no wait) */
  private giveUp(w: Waiter, why: string) {
    if (w.done) return
    w.done = true
    if (w.timer) clearTimeout(w.timer)
    if (this.claims.get(w.box) === w) this.claims.delete(w.box)
    this.d.log(`wait ${w.holder} on ${w.box}: gave up (${why})`)
    w.resolve(null)
  }

  /** Drop a claim (a cancel, or the run's placement failed): served units go back, and the box if nothing else holds it. */
  private dropWait(w: Waiter, repo: string) {
    const served = w.slot
    this.giveUp(w, 'dropped')
    if (served == null) return
    this.occupy(w.box, served, w.units, null)
    w.slot = null
    if (!this.occ.has(w.box) && this.pool.d.db.box(w.box)?.state === 'busy') this.pool.release(w.box, repo)
  }

  /** A holder left `box`: its claim takes the units it needs, if they are free now (before the box can go back). */
  private serveClaim(box: string) {
    const w = this.claims.get(box)
    if (!w || w.done) return
    const b = this.pool.d.db.box(box)
    const failLimit = poolConfig(this.d.cfg).cfg.infraFailLimit
    if (!b || b.state !== 'busy' || b.infraFails >= Math.max(1, failLimit - 1) || !w.only.allow(b)) return this.giveUp(w, `box ${box} is ${b ? (b.state !== 'busy' ? b.state : !w.only.allow(b) ? 'no longer fit for the pool' : 'failing') : 'gone'}`)
    const cap = SIZE_UNITS[b.size] ?? 1
    const slot = freeSlot(this.occ.get(box) ?? new Array<string | null>(cap).fill(null), w.units)
    if (slot < 0 || this.memFree(box) < w.memMb) return
    this.occupy(box, slot, w.units, w.holder, w.memMb)
    w.slot = slot
    w.done = true
    if (w.timer) clearTimeout(w.timer)
    this.claims.delete(box)
    w.resolve(slot)
  }

  private pressureAt = 0
  private pressureNow = false
  /** budget pressure (steer.softAt or more of today's target used); read at most once a minute */
  private pressure(): boolean {
    const now = this.d.now()
    if (now - this.pressureAt < 60_000) return this.pressureNow
    this.pressureAt = now
    const b = this.budgetView()
    this.pressureNow = !!b && b.pressure >= this.d.cfg.steer.softAt
    return this.pressureNow
  }

  /** today's plan hours against the daily target (plan and wallet hours left over the days left); null: not known */
  budgetView(): BudgetView | null {
    const db = this.d.usage
    if (!db) return null
    try {
      const now = this.d.now()
      const target = dayTarget(db, now, this.d.cfg.steer.reserveHours)
      if (target == null) return null
      const dayStart = Math.floor(now / 86_400_000) * 86_400_000
      const today = [...repoBoxHours(db, dayStart, now).values()].reduce((a, b) => a + b, 0)
      const r2 = (x: number) => Math.round(x * 100) / 100
      return { todayHours: r2(today), targetHours: r2(target), pressure: target > 0 ? r2(today / target) : today > 0 ? Infinity : 0, walletHours: db.lastPlan()?.walletHours ?? null }
    } catch (e) {
      this.d.log(`budget: ${(e as Error).message}`)
      return null
    }
  }

  /**
   * What a run of this suite would get on Boat now, with no claim and no start (`test-broker ask`). Each shard is
   * judged on its own: two shards may name the same box.
   */
  async peek(o: { repo: string; cfg: RepoConfig; suite: Suite; args: string[] }): Promise<BoatPeek | { why: string }> {
    const why = await this.gate(o.repo)
    if (why) return { why }
    // read only: a peek never ends the pause (check() would, once it ran out)
    const out = this.outage.view()
    if (out.paused) return { why: `Boat paused until ${new Date(out.until!).toISOString().slice(11, 16)} UTC: box starts kept failing (last: ${out.last})` }
    const env = this.envOf(o.cfg)
    // read only: the pool's filter as the last real ask got it (poolGate may create or mark the environment and
    // delete unfit boxes, so a peek never calls it)
    const gate = this.lastGate.get(env)
    if (!gate) return { why: 'Boat: no run in this pool since test-brokerd started (a peek does not check the pool environment)' }
    const only = this.boxRules(gate, o.suite)
    const sizes = (this.d.cfg.boat.sizes as string[]).filter((z) => SIZE_UNITS[z])
    const shape = o.args.length ? 'narrowed' : 'whole'
    const w: WaitCtx = {
      maxWait: () => (this.d.cfg.boat.packing ? Math.min(this.d.cfg.boat.maxWaitSec, o.suite.boat!.maxWaitSec ?? o.cfg.boat!.maxWaitSec) : 0),
      key: (s) => ({ repo: o.repo, suite: o.suite.name, shape, shard: s.name, argsKey: s.passArgs ? argsKey(o.args) : '-' }),
      pressure: this.pressure(),
    }
    // slow boxes last, as placement takes them
    const boxes = this.pool.boxes().filter((b) => b.env === env && only.allow(b)).sort((x, y) => +this.isSlow(x.name) - +this.isSlow(y.name))
    const taken = new Set<string>()
    const shards: BoatPeek['shards'] = []
    // the units and RAM this peek gives its own shards, so two shards are not both told the same free units
    const units = new Map([...this.occ].map(([k, v]) => [k, [...v]]))
    const memUsed = new Map<string, number>()
    // a box start the pool would refuse (today's starts left, less the pending ones and this peek's, at the reserve);
    // the minute's limit passes in a minute, so it is not a refusal
    const st = this.pool.lastStarts
    const pending = this.pool.pendingStarts()
    let newStarts = 0
    // a stopped box already counts toward maxBoxes; a new one adds to it
    let creates = 0
    const noStart = () => !!st && this.d.now() - st.at < 15 * 60_000 && st.day - pending - newStarts <= this.d.cfg.boat.startsReserve
    for (const s of o.suite.boat!.shards) {
      const need = boxUnits(s)
      const fit = sizes.filter((z) => SIZE_UNITS[z] >= need)
      const est = this.eta.estimate(w.key(s))
      const runSec = est ? Math.round(est.p75) : null
      const shared = this.d.cfg.boat.packing && boxes.find((b) => b.state === 'busy' && !this.isSlow(b.name) && units.has(b.name) && !this.claims.has(b.name) && fit.includes(b.size) && freeSlot(units.get(b.name)!, s.units) >= 0 && this.memFree(b.name) - (memUsed.get(b.name) ?? 0) >= s.memMb)
      if (shared) {
        const u = units.get(shared.name)!
        const at = freeSlot(u, s.units)
        for (let i = at; i < at + s.units; i++) u[i] = `peek/${s.name}`
        memUsed.set(shared.name, (memUsed.get(shared.name) ?? 0) + s.memMb)
        shards.push({ name: s.name, how: 'shared', box: shared.name, startSec: 0, runSec })
        continue
      }
      const idle = boxes.find((b) => b.state === 'idle' && fit.includes(b.size) && !taken.has(b.name))
      if (idle) {
        taken.add(idle.name)
        shards.push({ name: s.name, how: 'reused', box: idle.name, startSec: 0, runSec })
        continue
      }
      const bw = this.bestWait(env, s, only, fit, w)
      if (bw) {
        shards.push({ name: s.name, how: 'wait', box: bw.box, startSec: Math.round(bw.t), runSec })
        continue
      }
      const cost = Math.round(this.eta.startCost(w.key(s)))
      const stopped = boxes.find((b) => b.state === 'stopped' && fit.includes(b.size) && !taken.has(b.name))
      if (noStart()) shards.push({ name: s.name, how: 'none', box: null, startSec: null, runSec })
      else if (stopped) {
        taken.add(stopped.name)
        newStarts++
        shards.push({ name: s.name, how: 'resume', box: stopped.name, startSec: cost, runSec })
      } else if (this.pool.liveCount() + creates < (poolConfig(this.d.cfg).resource.maxBoxes ?? 0)) {
        newStarts++
        creates++
        shards.push({ name: s.name, how: 'create', box: null, startSec: cost, runSec })
      } else shards.push({ name: s.name, how: 'none', box: null, startSec: null, runSec })
    }
    const n = (st: string) => boxes.filter((b) => b.state === st).length
    return {
      shards,
      pool: { busy: n('busy'), idle: n('idle'), starting: n('resuming') + n('creating'), stopped: n('stopped'), quarantined: n('quarantined'), waiting: this.claims.size },
      budget: this.budgetView(),
    }
  }

  /** Undo picks no shard has started on: units back, boxes back to the state they were taken from. */
  private undoPicks(picks: { box: string; how: Pick['how'] }[]) {
    for (const x of picks) {
      if (x.how === 'shared' || x.how === 'wait') continue
      if (x.how === 'created') this.pool.d.db.deleteBox(x.box)
      else this.pool.setState(x.box, x.how === 'resumed' ? 'stopped' : 'idle')
    }
  }

  /** One box per shard (boat.packing off). */
  private async placeEach(env: string, repo: string, shards: { shard: BoatShard; size: string }[], only: BoxFilter): Promise<{ picks: Pick[] } | { why: string }> {
    const fit = (b: BoxRow) => only.allow(b)
    // enough idle + stopped boxes of each size? (counted before any start is placed)
    const want = new Map<string, number>()
    for (const s of shards) want.set(s.size, (want.get(s.size) ?? 0) + 1)
    const missing: string[] = []
    for (const [size, n] of want) {
      const have = this.pool.boxes().filter((b) => b.env === env && b.size === size && fit(b) && (b.state === 'idle' || b.state === 'stopped')).length
      for (let i = have; i < n; i++) missing.push(size)
    }
    // a missing box is created as part of the run (a create takes about 10 s); the start deadline still holds, so a
    // slow create ends the run as not started and the caller runs here
    if (missing.length) this.makeRoom(env, missing)
    const picks: Pick[] = []
    for (const s of shards) {
      const p = await this.pool.place({ env, size: s.size, repo, avoid: this.slowAvoid(env, s.size, only), only })
      if ('none' in p) {
        // undo every pick: nothing was started yet
        this.undoPicks(picks)
        if (missing.length) this.replenish(env, repo, want, only)
        return { why: missing.length ? `Boat: no free box now for ${missing.length} of ${shards.length} shard(s) (${p.none}); creating them for the next ask` : p.none }
      }
      picks.push({ shard: s.shard, box: p.box, size: s.size, slot: 0, how: p.how })
    }
    return { picks }
  }

  /**
   * boat.packing: place shards by units, biggest first. Each takes, in order: free units on a box already running
   * shards (the best fit: the fewest units left over) that has RAM left for it, an idle box, a stopped box (resumed),
   * a new box. A box taken from the pool is the size closest to what the run still has to place (so the rest of the
   * run can share it). A shard's CPUs are its units; its RAM is its memMb, and a box size must hold both (boxUnits).
   */
  private async pack(env: string, repo: string, shards: BoatShard[], only: BoxFilter, wait: WaitCtx | null = null): Promise<{ picks: Pick[] } | { why: string }> {
    const sizes = (this.d.cfg.boat.sizes as string[]).filter((z) => SIZE_UNITS[z]).sort((a, b) => SIZE_UNITS[a] - SIZE_UNITS[b])
    const maxCap = SIZE_UNITS[sizes[sizes.length - 1]]
    // units are claimed in this.occ as each pick is made (a pending holder), so no other run's leave() can hand a box
    // back to the pool while place() awaits; the undo frees them
    const pending = `pending-${++this.packs}`
    const claimed: { box: string; slot: number; units: number }[] = []
    const claim = (box: string, slot: number, units: number, name: string, memMb: number) => {
      this.occupy(box, slot, units, `${pending}/${name}`, memMb)
      claimed.push({ box, slot, units })
    }
    const unitsOf = (box: string) => this.occ.get(box) ?? new Array<string | null>(SIZE_UNITS[this.pool.d.db.box(box)!.size] ?? 1).fill(null)
    const failLimit = poolConfig(this.d.cfg).cfg.infraFailLimit
    const picks: Pick[] = []
    // what the run still has to place, in units of box: its CPU units or its RAM (4 GB a unit), whichever is more
    let cpuLeft = shards.reduce((n, s) => n + s.units, 0)
    let memLeft = shards.reduce((n, s) => n + s.memMb, 0)
    const left = () => Math.max(cpuLeft, Math.ceil(memLeft / UNIT_MEM_MB))
    for (const s of [...shards].sort((a, b) => boxUnits(b) - boxUnits(a) || b.units - a.units)) {
      const u = s.units
      const need = boxUnits(s)
      // 1. units free on a box in use (other runs' boxes, or one this run took already)
      let best: { box: string; slot: number; spare: number; spareMem: number } | null = null
      for (const b of this.pool.boxes()) {
        if (b.env !== env || !this.occ.has(b.name)) continue
        if (!only.allow(b) && !picks.some((x) => x.box === b.name)) continue
        if (!['busy', 'resuming', 'creating'].includes(b.state)) continue
        // a box with a claim on it: its next free units are the claim's
        if (this.claims.has(b.name)) continue
        // a box failing for one shard gets no new ones (it is quarantined when its last shard ends)
        if (b.infraFails >= Math.max(1, failLimit - 1)) continue
        // a slow box gets new shards only as the last choice (step 2)
        if (this.isSlow(b.name)) continue
        const units = unitsOf(b.name)
        const slot = freeSlot(units, u)
        if (slot < 0 || this.memFree(b.name) < s.memMb) continue
        // best fit: the fewest units left over, then the least RAM left over
        const spare = units.filter((x) => x === null).length - u
        const spareMem = this.memFree(b.name) - s.memMb
        if (!best || spare < best.spare || (spare === best.spare && spareMem < best.spareMem)) best = { box: b.name, slot, spare, spareMem }
      }
      if (best) {
        claim(best.box, best.slot, u, s.name, s.memMb)
        const taken = picks.find((x) => x.box === best!.box)
        picks.push({ shard: s, box: best.box, size: this.pool.d.db.box(best.box)!.size, slot: best.slot, how: taken && taken.how !== 'wait' ? taken.how : 'shared' })
        cpuLeft -= u
        memLeft -= s.memMb
        continue
      }
      // 2. a box from the pool: idle, else stopped, else new; sizes nearest the units still to place come first
      const target = Math.max(need, Math.min(left(), maxCap))
      const pref = sizes.filter((z) => SIZE_UNITS[z] >= need).sort((a, b) => {
        const ka = SIZE_UNITS[a] >= target ? SIZE_UNITS[a] - target : 100 + target - SIZE_UNITS[a]
        const kb = SIZE_UNITS[b] >= target ? SIZE_UNITS[b] - target : 100 + target - SIZE_UNITS[b]
        return ka - kb
      })
      const free = (size: string, state: string) => this.pool.boxes().filter((b) => b.env === env && b.size === size && b.state === state && only.allow(b) && !this.occ.has(b.name))
      let size = pref[0]
      let avoid: string[] = []
      // a box that is not slow first (idle, then stopped: a resume beats a slow box), then a slow one
      const hide = (z: string, ok: BoxRow[]) => {
        const keep = new Set(ok.map((b) => b.name))
        return this.pool.boxes().filter((b) => b.size === z && !keep.has(b.name)).map((b) => b.name)
      }
      // when the pick is a resume the budget may refuse: the slow idle box to take then
      let slowIdle: { size: string; avoid: string[] } | null = null
      found: for (const tier of ['normal', 'any'])
        for (const state of ['idle', 'stopped'])
          for (const z of pref) {
            const ok = free(z, state).filter((b) => tier === 'any' || !this.isSlow(b.name))
            if (!ok.length) continue
            size = z
            // steer place() to those boxes: hide the others of the size
            avoid = hide(z, ok)
            if (tier === 'normal' && state === 'stopped') {
              const zi = pref.find((x) => free(x, 'idle').length)
              if (zi) slowIdle = { size: zi, avoid: hide(zi, free(zi, 'idle')) }
            }
            break found
          }
      // 3. no idle box (that is not slow): wait for a busy one about to free, when that is no slower than a box start
      if (wait && !pref.some((z) => free(z, 'idle').some((b) => !this.isSlow(b.name)))) {
        const w = this.waitPlan(env, s, only, pref, wait)
        if (w) {
          picks.push({ shard: s, box: w.box, size: this.pool.d.db.box(w.box)!.size, slot: -1, how: 'wait', wait: w })
          cpuLeft -= u
          memLeft -= s.memMb
          continue
        }
      }
      if (!avoid.length && !free(size, 'idle').length && !free(size, 'stopped').length) {
        avoid = this.pool.boxes().filter((b) => b.size === size).map((b) => b.name)
        this.makeRoom(env, [size])
      }
      let p = await this.pool.place({ env, size, repo, avoid, only })
      if ('none' in p && slowIdle) {
        // no start for the resume: the slow idle box is better than no box
        size = slowIdle.size
        p = await this.pool.place({ env, size, repo, avoid: slowIdle.avoid, only })
      }
      if ('none' in p) {
        for (const x of picks) if (x.wait) this.dropWait(x.wait, repo)
        for (const c of claimed) this.occupy(c.box, c.slot, c.units, null)
        this.undoPicks(picks.filter((x, i) => picks.findIndex((y) => y.box === x.box) === i))
        // a shared box whose own shards all left while place() awaited (our claim kept leave() from releasing it):
        // nothing holds it now, so it goes back to the pool here
        for (const x of picks) if (x.how === 'shared' && !this.occ.has(x.box) && this.pool.d.db.box(x.box)?.state === 'busy') this.pool.release(x.box, repo)
        return { why: `Boat: no box now for shard ${s.name} (${u} unit(s)): ${p.none}` }
      }
      claim(p.box, 0, u, s.name, s.memMb)
      picks.push({ shard: s, box: p.box, size, slot: 0, how: p.how })
      cpuLeft -= u
      memLeft -= s.memMb
    }
    // back in the shards' own order
    return { picks: shards.map((s) => picks.find((x) => x.shard === s)!) }
  }

  /**
   * Create the boxes an ask missed, so each size has as many free (idle, stopped or creating) boxes as the suite
   * wants; they wait idle for the next ask. At maxBoxes it deletes the least-recently-used free box of another
   * environment or size (stopped before idle) to make room.
   */
  private replenish(env: string, repo: string, want: Map<string, number>, only?: BoxFilter) {
    // a pool box made in the last half minute is not fit until the next gate check lists its version: count it free
    const fit = (b: BoxRow) => (only ? only.allow(b) || (b.pubRepo === only.repo && b.envVersion == null) : !b.pubRepo)
    const free = (size: string, states: string[]) => this.pool.boxes().filter((b) => b.env === env && b.size === size && fit(b) && states.includes(b.state)).length
    for (const [size, n] of want) {
      for (let i = free(size, ['idle', 'stopped', 'creating']); i < n; i++) {
        this.track(
          this.serial(async () => {
            // another ask may have queued the same creates, or boxes freed up: only fill what is still missing
            if (free(size, ['idle', 'stopped', 'creating']) >= n) return
            if (!this.makeRoom(env, [size])) return void this.d.log(`replenish ${env} ${size}: at maxBoxes (${poolConfig(this.d.cfg).resource.maxBoxes ?? 0}) and every other box is busy`)
            // skip the free boxes it has, so place() creates a new one
            const avoid = this.pool.boxes().filter((b) => b.env === env && b.size === size).map((b) => b.name)
            const p = await this.pool.place({ env, size, repo, avoid, ...(only ? { only } : {}) })
            if ('none' in p) return void this.d.log(`replenish ${env} ${size}: ${p.none}`)
            if (p.how !== 'created') {
              this.pool.setState(p.box, p.how === 'resumed' ? 'stopped' : 'idle')
              return
            }
            this.track(this.pool.start(p.box).then(() => this.pool.release(p.box, repo), (e) => this.d.log(`replenish ${p.box}: ${(e as Error).message}`)))
          }),
        )
      }
    }
  }

  /** Room for `sizes.length` new boxes of `env`: at maxBoxes, delete the least-recently-used free boxes of another
   *  env or size (stopped before idle). False when there is still not enough room (every other box is busy). */
  private makeRoom(env: string, sizes: string[]): boolean {
    const max = poolConfig(this.d.cfg).resource.maxBoxes ?? 0
    const rank = (s: string) => (s === 'stopped' ? 0 : 1)
    this.pool.trimQuarantined(sizes.length)
    // quarantined boxes do not count (BoatPool.liveCount): another box takes the place of one
    while (this.pool.liveCount() + sizes.length > max) {
      const victim = this.pool
        .boxes()
        .filter((b) => (b.state === 'idle' || b.state === 'stopped') && !(b.env === env && sizes.includes(b.size)))
        .sort((x, y) => rank(x.state) - rank(y.state) || x.lastUsed - y.lastUsed)[0]
      if (!victim || !this.pool.evict(victim.name, `make room for ${env} ${sizes.join(', ')} box(es)`)) return false
    }
    return true
  }

  private emit(run: Run, e: RunEvent) {
    if (run.done) return
    run.events.push(e)
    if (e.t === 'log') {
      // replay keeps the newest ~MAX_REPLAY bytes of output (the run's log file has all of it)
      run.logBytes += e.data.length
      while (run.logBytes > MAX_REPLAY) {
        const i = run.events.findIndex((x) => x.t === 'log')
        if (i < 0) break
        run.logBytes -= (run.events[i] as { data: string }).data.length
        run.events.splice(i, 1)
      }
    }
    if (e.t === 'log') {
      try {
        appendFileSync(run.logFile, e.data.replace(/^/gm, `[${e.shard}] `).replace(/\[[^\]]+\] $/, ''))
      } catch {}
    }
    for (const fn of run.subs) fn(e)
  }

  private async execute(run: Run, o: { repo: string; cfg: RepoConfig; suite: Suite; args: string[] }) {
    try {
      await this.executeRun(run, o)
    } catch (e) {
      // a bug or a disk error: the run must still end and its boxes go back
      this.d.log(`run ${run.id}: ${(e as Error).stack ?? e}`)
      for (const s of run.shards) {
        if (!s.ac.signal.aborted) s.ac.abort()
        this.leave(s, o.repo, false)
      }
      if (!run.done) {
        this.finish(run, 2, `  test-broker error: ${(e as Error).message}\n\nRESULT: FAIL`, false)
        this.endUsage(run, 2, 'error', null)
      }
    }
  }

  private async executeRun(run: Run, o: { repo: string; cfg: RepoConfig; suite: Suite; args: string[] }) {
    const cfg = this.d.cfg.boat
    const sb = o.suite.boat!
    const dir = join(this.d.stateDir, 'runs', run.id)
    mkdirSync(dir, { recursive: true })
    const abortAll = (why: string) => {
      for (const s of run.shards) if (!s.ac.signal.aborted) {
        s.why = why
        s.ac.abort()
      }
    }
    let notStarted = false
    let deadline!: () => void
    const missed = new Promise<'missed'>((resolve) => (deadline = () => resolve('missed')))
    let notStartWhy = `not every shard was running within ${cfg.startDeadlineSec}s`
    run.notStart = (why: string) => {
      if (notStarted || run.done) return
      notStarted = true
      notStartWhy = why
      this.emit(run, { t: 'state', state: 'start-deadline', message: why })
      abortAll(why)
      deadline()
    }
    run.timers.push(setTimeout(() => {
      // the deadline covers placing, starting and hydrating the boxes; uploads (a seed can be 100 MB) have their own limit.
      // A shard that waited for a box has its own, from when it got the box (waitForBox)
      if (run.shards.every((s) => s.ready || s.wait || s.waitedSecs != null)) return
      run.notStart!(`not every shard was running within ${cfg.startDeadlineSec}s`)
    }, cfg.startDeadlineSec * 1000))
    // a shard's wait for a box does not come out of the suite's maxSec
    const waitMax = Math.max(0, ...run.shards.map((s) => (s.wait ? s.wait.limitSec + cfg.startDeadlineSec : 0)))
    run.timers.push(setTimeout(() => abortAll(`over the suite's maxSec (${sb.maxSec}s)`), (sb.maxSec + waitMax) * 1000))
    for (const t of run.timers) t.unref?.()
    // the snapshot and the box starts go on together
    const snap = (async () => {
      const s = await buildSnapshot(o.cfg.root, { maxFileMb: MAX_SNAPSHOT_FILE_MB })
      this.record(() => this.d.usage!.setGit(run.id, { tree: s.tree }))
      const base = await this.d.baseOf(o.cfg.root)
      const branch = await defaultBranch(o.cfg.root).catch(() => null)
      const extras = await this.extras(o.cfg.root, s.commit, o.cfg.boat!.extraRepos)
      // the commit is the base: the seed brings it (cached), and no snapshot bundle is needed
      if (base === s.commit) return { sha: s.commit, base, bundle: null as string | null, branch, extras }
      // no base at all: the bundle holds the commit's whole history, so the box still needs no GitHub
      const file = join(dir, 'snapshot.bundle')
      await snapshotBundle(o.cfg.root, s.commit, base, file, join(dir, 'bundle-repo'))
      return { sha: s.commit, base, bundle: file as string | null, branch, extras }
    })()
    snap.catch(() => {})
    const all = Promise.all(run.shards.map((s) => this.shard(run, s, { ...o, maxSec: sb.maxSec }, snap, sb.silentSec ?? cfg.silentSec)))
    // a missed start deadline answers the caller now: a box start (resume) can't be interrupted and may take minutes
    // to fail; the shards clean up (release their boxes) in the background
    const first = await Promise.race([all, missed])
    for (const t of run.timers) clearTimeout(t)
    if (first === 'missed') {
      this.finish(run, 3, `  not started: ${notStartWhy}\n\nRESULT: FAIL`, true)
      this.endUsage(run, 3, 'not started', null)
      // the answer is out: no shard waits on an artifacts fetch no one will see
      for (const s of run.shards) s.fetch.abort()
      await all
      rmSync(dir, { recursive: true, force: true })
      return
    }
    const sum = summarize(first)
    this.finish(run, notStarted ? 3 : sum.pass ? 0 : 1, sum.text, notStarted)
    this.endUsage(run, notStarted ? 3 : sum.pass ? 0 : 1, notStarted ? 'not started' : 'done', first)
    rmSync(dir, { recursive: true, force: true })
  }

  /** a shard as runs.db stores it; `r` (its result) once it ended */
  private usageShard(s: ShardRun, r: ShardResult | null): UsageShard {
    return {
      name: s.shard.name, box: s.box, size: s.size, slot: s.slot, how: s.how, units: s.shard.units, memMb: s.shard.memMb,
      secs: r ? r.secs : null, code: r ? r.code : null, started: s.started, ...(r ? parseResources(r.log) : {}),
      argsKey: s.etaKey.argsKey, ...(s.waitedSecs != null ? { waitSecs: s.waitedSecs } : {}), ...(s.waitGaveUp ? { waitGaveUp: true } : {}),
      ...(r && s.started ? { log: summary(s.sum) } : {}),
    }
  }
  /** the run's cost: each shard that started, its CPUs for its seconds (a shard that never started costs its box's up
   *  time only, which the box events record) */
  private endUsage(run: Run, code: number, how: string, results: ShardResult[] | null) {
    // the time estimates learn from every shard that passed (runs.db or not)
    run.shards.forEach((s, i) => {
      const r = results?.[i]
      if (r?.code === 0 && s.started) this.eta.add(s.etaKey, r.secs, s.how)
    })
    this.record(() => {
      const now = this.d.now()
      const shards = run.shards.map((s, i) => this.usageShard(s, results?.[i] ?? (s.started ? ({ secs: Math.round((now - s.t0) / 1000), code: null, log: s.log } as ShardResult) : null)))
      const ran = shards.filter((x) => x.started && x.secs != null)
      this.d.usage!.endRun(run.id, {
        endedAt: now, exitCode: code, endedHow: this.stopping ? 'daemon restart' : how, shards,
        cpuMin: ran.reduce((n, x) => n + (x.units * 2 * x.secs!) / 60, 0),
        planHours: ran.reduce((n, x) => n + shardPlanHours(x.units, x.secs!), 0),
      })
    })
  }
  /** usage accounting is best effort: a runs.db error never fails a run */
  private record(fn: () => void) {
    if (!this.d.usage) return
    try {
      fn()
    } catch (e) {
      this.d.log(`usage: ${(e as Error).message}`)
    }
  }
  /** a `boat limits` snapshot into runs.db (the plan's hours left: the daily target and a check on our accounting) */
  private async snapPlan() {
    if (!this.d.usage || !this.d.boat.plan) return
    try {
      const p = await this.d.boat.plan()
      this.record(() => this.d.usage!.plan({ t: this.d.now(), ...p }))
    } catch (e) {
      this.d.log(`usage: plan snapshot: ${(e as Error).message.slice(0, 200)}`)
    }
  }

  private finish(run: Run, code: number, receipt: string, notStarted: boolean) {
    this.emit(run, { t: 'done', code, receipt, ...(notStarted ? { notStarted: true } : {}) })
    run.done = true
    run.doneAt = this.d.now()
    run.subs.clear()
    this.d.log(`run ${run.id}: done, exit ${code}${notStarted ? ' (not started in time)' : ''}`)
    this.prune()
  }

  private tidyAt = 0
  /** a pass is running: the next one waits for its turn (two passes would compress one file twice) */
  private tidying = false
  /** files a seed upload reads now (pruneSeeds keeps them) */
  private seedUse = new Map<string, number>()

  /**
   * The state dir's disk use (at most every TIDY_EVERY_MS): run logs and artifacts compressed after
   * compressAfterHours and deleted after keepDays; seeds cut to the newest few per repo. Async, in small steps.
   */
  private async tidy(force = false) {
    const now = this.d.now()
    if (this.tidying || (!force && now - this.tidyAt < TIDY_EVERY_MS)) return
    this.tidying = true
    this.tidyAt = now
    try {
      await this.tidyPass(now)
    } finally {
      this.tidying = false
    }
  }
  private async tidyPass(now: number) {
    const live = new Set([...this.runs.values()].filter((r) => !r.done).map((r) => r.id))
    const r = await tidyRuns(join(this.d.stateDir, 'runs'), { now, keepDays: this.d.cfg.keepDays, compressAfterMs: this.d.cfg.compressAfterHours * 3_600_000, live })
    for (const e of r.errors.slice(0, 3)) this.d.log(`tidy: ${e}`)
    const seeds = await pruneSeeds(join(this.d.stateDir, 'seeds'), { now, inUse: (f) => this.seedUse.has(f) })
    if (r.compressed || r.deleted || seeds.length) this.d.log(`tidy: ${r.compressed} compressed, ${r.deleted} deleted in runs/; ${seeds.length} seed file(s) removed`)
  }

  /** a done run's log, from its file (compressed or not): `test-broker logs` after the run left memory */
  readLog(id: string): string | null {
    try {
      return readRunLog(join(this.d.stateDir, 'runs'), id)
    } catch (e) {
      this.d.log(`logs ${id}: ${(e as Error).message}`)
      return null
    }
  }

  /**
   * A failed shard: bring the repo's artifacts back from the box into runs/<run>.artifacts/<shard>/ (the next run on the
   * box would wipe them). Best effort: a failure here is a note in the shard's log, never a different result.
   */
  private async fetchArtifacts(run: Run, s: ShardRun, id: string, cfg: RepoConfig) {
    const paths = cfg.boat?.artifacts ?? []
    // a run that already answered (start deadline) has no one to tell; a cancel does not wait
    if (!paths.length || run.done || s.fetch.signal.aborted) return
    const signal = s.fetch.signal
    const note = (m: string) => {
      const line = `test-broker: artifacts: ${m}\n`
      s.log = (s.log + line).slice(-LOG_TAIL)
      this.emit(run, { t: 'log', shard: s.shard.name, data: line })
    }
    const top = join(this.d.stateDir, 'runs', `${run.id}.artifacts`)
    const dest = join(top, s.shard.name)
    const tgz = join(top, `${s.shard.name}.tgz`)
    try {
      const r = await this.d.boat.exec(id, artifactsCommand(s.slot, run.repo, paths), { timeoutSec: 60, signal })
      if (r.code === 3) return note(`none of ${paths.join(', ')} exist on the box`)
      const size = Number(r.out.trim().split('\n').pop())
      if (r.code !== 0 || !Number.isFinite(size)) return note(`tar failed (${r.code}): ${r.out.trim().slice(-200)}`)
      const max = this.d.cfg.boat.artifactsMaxMb
      if (size > max * 1048576) return note(`skipped: ${(size / 1048576).toFixed(0)} MB is over artifactsMaxMb (${max})`)
      if (signal.aborted) return
      mkdirSync(top, { recursive: true, mode: 0o700 })
      await this.d.boat.download(id, `${slotDir(s.slot)}/artifacts.tgz`, tgz)
      if (!existsSync(tgz) || statSync(tgz).size === 0) return note('download produced no file')
      // the compressed cap says little about a log of repeated lines: check what it unpacks to first
      const list = await execFileP('tar', ['tzvf', tgz], { timeout: 120_000, signal, maxBuffer: 256 << 20 })
      const bytes = list.stdout.split('\n').reduce((n, l) => n + (Number(l.trim().split(/\s+/)[2]) || 0), 0)
      const maxUnpacked = max * 10 * 1048576
      if (bytes > maxUnpacked) return note(`skipped: it unpacks to ${(bytes / 1048576).toFixed(0)} MB, over 10 × artifactsMaxMb`)
      mkdirSync(dest, { recursive: true, mode: 0o700 })
      await execFileP('tar', ['xzf', tgz, '-C', dest, '--no-same-owner'], { timeout: 120_000, signal })
      // a read-only dir from the archive would block the prune later
      await execFileP('chmod', ['-R', 'u+rwX', dest], { timeout: 60_000 }).catch(() => {})
      s.artifacts = dest
      note(dest)
    } catch (e) {
      if (!signal.aborted) note(`failed: ${(e as Error).message}`)
    } finally {
      rmSync(tgz, { force: true })
    }
  }

  private seeds = new Map<string, Promise<string>>()

  /**
   * Give the box's clone the run's base: probe it, then upload a seed bundle (`refs/cib/seed` = base) of what it lacks.
   * The whole history when the box has no (full) clone or none of its tips is known here; else the part after them.
   * A whole-history seed is cached in the state dir per base. True when a seed was uploaded.
   */
  private async seed(run: Run, id: string, slot: number, o: { repo: string; cfg: RepoConfig }, base: string, signal: AbortSignal): Promise<boolean> {
    const pr = await this.d.boat.exec(id, seedProbeCommand(o.repo, base), { timeoutSec: 60 })
    const line = pr.out.trim().split('\n').pop() ?? ''
    if (pr.code !== 0) throw new Error(`seed probe exited ${pr.code}: ${line.slice(-200)}`)
    if (line === 'has') return false
    let file: string
    let tips: string[] = []
    try {
      tips = line.startsWith('need ') ? await knownCommits(o.cfg.root, line.slice(5).trim().split(/\s+/)) : []
      if (tips.length) {
        file = join(this.d.stateDir, 'runs', run.id, `seed-${id}-${slot}.bundle`)
        await refBundle(o.cfg.root, 'refs/cib/seed', base, tips, file, join(this.d.stateDir, 'runs', run.id, `seed-${id}-${slot}-repo`))
      } else {
        // shards of one run share a build in flight; the file itself is the cache (fullSeed checks it is there)
        const key = `${o.repo}@${base}`
        let p = this.seeds.get(key)
        if (!p) {
          p = this.fullSeed(o.repo, o.cfg.root, base)
          this.seeds.set(key, p)
          p.finally(() => this.seeds.delete(key)).catch(() => {})
        }
        file = await p
      }
    } catch (e) {
      throw new LocalSeedError((e as Error).message)
    }
    this.seedUse.set(file, (this.seedUse.get(file) ?? 0) + 1)
    try {
      await this.d.boat.scp(file, id, `${slotDir(slot)}/seed.bundle`, { timeoutSec: SEED_UPLOAD_SEC, signal })
    } finally {
      const n = (this.seedUse.get(file) ?? 1) - 1
      if (n > 0) this.seedUse.set(file, n)
      else this.seedUse.delete(file)
    }
    if (tips.length) rmSync(file, { force: true })
    return true
  }

  /** Each extra repo's commit for this run (a sha, or read from a JSON file in the commit under test) and its bundle. */
  private async extras(root: string, commit: string, list: ExtraRepo[]): Promise<Extra[]> {
    const out: Extra[] = []
    for (const x of list) {
      let sha: unknown
      if ('sha' in x.ref) sha = x.ref.sha
      else {
        const where = `extra repo ${x.name}: ${x.ref.file}#${x.ref.key.join('.')}`
        let doc: unknown
        try {
          doc = JSON.parse(await git(root, ['show', `${commit}:${x.ref.file}`]))
        } catch (e) {
          throw new Error(`${where}: cannot read it in the commit (${(e as Error).message.split('\n')[0]})`)
        }
        sha = x.ref.key.reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), doc)
        if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) throw new Error(`${where}: not a 40-hex commit sha`)
      }
      const key = `${x.repo}@${sha}`
      let p = this.extraBuilds.get(key)
      if (!p) {
        p = this.extraBundle(x.repo, sha as string)
        this.extraBuilds.set(key, p)
        p.finally(() => this.extraBuilds.delete(key)).catch(() => {})
      }
      out.push({ name: x.name, repo: x.repo, sha: sha as string, file: await p })
    }
    return out
  }

  private extraBuilds = new Map<string, Promise<string>>()

  /**
   * `state/extra/<owner__name>-<sha12>.bundle`: the commit's whole history (`refs/cib/extra`). The commit is fetched
   * once into a bare cache repo here, over gh's own login (a credential helper: no token in argv or on disk). Only a
   * private repo is shipped. Bundles unused for 7 days are removed when a new one is built.
   */
  private async extraBundle(repo: string, sha: string): Promise<string> {
    const dir = join(this.d.stateDir, 'extra')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = join(dir, `${repoDir(repo)}-${sha.slice(0, 12)}.bundle`)
    if (existsSync(file)) {
      utimesSync(file, new Date(), new Date())
      return file
    }
    let priv: boolean
    try {
      priv = await this.d.isPrivate(repo)
    } catch (e) {
      throw new Error(`extra repo ${repo}: cannot tell if it is private (${(e as Error).message})`)
    }
    if (!priv) throw new Error(`extra repo ${repo} is not private: test-broker ships only private repos to Boat`)
    const bare = join(dir, `${repoDir(repo)}.git`)
    if (!existsSync(join(bare, 'HEAD'))) {
      mkdirSync(bare, { recursive: true })
      await git(bare, ['init', '-q', '--bare'])
    }
    if (!(await git(bare, ['cat-file', '-e', `${sha}^{commit}`]).then(() => true, () => false))) {
      await execFileP('git', ['-C', bare, '-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', 'fetch', '--quiet', '--no-tags', this.d.extraUrl(repo), `${sha}:refs/cib/extra`], {
        timeout: 600_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      }).catch((e) => {
        throw new Error(`extra repo ${repo}: fetch of ${sha.slice(0, 12)} failed: ${String((e as Error).message).split('\n').slice(-2).join(' ').slice(0, 300)}`)
      })
    }
    await git(bare, ['update-ref', 'refs/cib/extra', sha])
    const tmp = `${file}.tmp`
    await git(bare, ['bundle', 'create', '--quiet', tmp, 'refs/cib/extra'])
    renameSync(tmp, file)
    const now = this.d.now()
    for (const f of readdirSync(dir)) {
      const p = join(dir, f)
      if (p !== file && f.endsWith('.bundle') && now - statSync(p).mtimeMs > 7 * 86_400_000) rmSync(p, { force: true })
    }
    return file
  }

  /** Send an extra repo's bundle unless the box already holds that commit's (`~/cib/extra/<name>.sha`). */
  private async shipExtra(id: string, x: Extra, slot: number, signal: AbortSignal) {
    const at = `"$HOME/cib/extra/${x.name}`
    const pr = await this.d.boat.exec(id, `cat ${at}.sha" 2>/dev/null; true`, { timeoutSec: 60 })
    if (pr.out.trim() === x.sha) return
    // a part file per slot: two slots of one box may ship the same repo at once; each mv is whole
    await this.d.boat.scp(x.file, id, `${EXTRA_DIR}/${x.name}.bundle.part${slot}`, { timeoutSec: SEED_UPLOAD_SEC, signal })
    const mv = await this.d.boat.exec(id, `mv -f ${at}.bundle.part${slot}" ${at}.bundle" && echo ${x.sha} > ${at}.sha"`, { timeoutSec: 60 })
    if (mv.code !== 0) throw new Error(`extra repo ${x.name}: moving its bundle in place exited ${mv.code}`)
  }

  /** `state/seeds/<owner__name>-<base12>.bundle`: the base's whole history, one file per base. Only the newest few per
   *  repo are kept (pruneSeeds, when a new one is built and in tidy). */
  private async fullSeed(repo: string, root: string, base: string): Promise<string> {
    const dir = join(this.d.stateDir, 'seeds')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = join(dir, `${repoDir(repo)}-${base.slice(0, 12)}.bundle`)
    if (existsSync(file)) {
      utimesSync(file, new Date(), new Date())
      return file
    }
    const tmp = `${file}.tmp`
    await refBundle(root, 'refs/cib/seed', base, [], tmp, `${file}.repo`)
    renameSync(tmp, file)
    this.track(pruneSeeds(dir, { now: this.d.now(), inUse: (f) => f === file || this.seedUse.has(f) }).catch((e) => this.d.log(`seeds: ${(e as Error).message}`)))
    return file
  }

  /**
   * A shard on its box; when the box fails under it (s.boxFault: an I/O error in its output, or an infra exit code of
   * the repo), once more on another box. The receipt says why.
   */
  private async shard(run: Run, s: ShardRun, o: { repo: string; cfg: RepoConfig; args: string[]; maxSec: number }, snap: Promise<{ sha: string; base: string | null; bundle: string | null; branch: string | null; extras: Extra[] }>, silentSec: number): Promise<ShardResult> {
    const first = await this.shardOn(run, s, o, snap, silentSec)
    const fault = s.boxFault
    if (!fault || s.ac.signal.aborted) return first
    const from = s.box
    const name = s.shard.name
    const why = await this.moveShard(run, s, o, from)
    if (why) return { ...first, reason: `box fault on ${from}: ${fault}; no other box to run it again (${why}): run it again` }
    const say = `box fault on ${from} (${fault}); running the shard again on ${s.box}`
    this.d.log(`run ${run.id}: ${name}: ${say}`)
    this.emit(run, { t: 'state', shard: name, state: 'retrying', message: say })
    s.log += `\ntest-broker: ${say}\n`
    this.emit(run, { t: 'log', shard: name, data: `test-broker: ${say}\n` })
    s.boxFault = null
    const second = await this.shardOn(run, s, o, snap, silentSec)
    if (s.boxFault) return { ...second, reason: `box fault on ${from} (${fault}), and again on ${s.box} (${s.boxFault}): it may be the tests, not the boxes` }
    return second.code === 0 ? { ...second, reason: `ran again on ${s.box} after a box fault on ${from}: ${fault}` } : second
  }

  /** Place a shard again (no wait) on a box other than `from`; null when it has one, else why not. */
  private async moveShard(run: Run, s: ShardRun, o: { repo: string; cfg: RepoConfig }, from: string): Promise<string | null> {
    const env = this.envOf(o.cfg)
    const gate = await this.poolGate(env)
    if ('none' in gate) return gate.none
    const suite = o.cfg.suites[run.suite]
    const rules = suite ? this.boxRules(gate, suite) : gate
    const only: BoxFilter = { ...rules, allow: (b) => b.name !== from && rules.allow(b) }
    const sizes = this.d.cfg.boat.sizes as string[]
    const r = await this.serial(() => (this.d.cfg.boat.packing ? this.pack(env, o.repo, [s.shard], only) : this.placeEach(env, o.repo, [{ shard: s.shard, size: s.size ?? sizeFor(boxUnits(s.shard), sizes)! }], only)))
    if ('why' in r) return r.why
    const p = r.picks[0]
    if (s.ac.signal.aborted) {
      if (this.d.cfg.boat.packing) this.occupy(p.box, p.slot, s.shard.units, null)
      if (p.how !== 'shared' && !this.occ.has(p.box)) this.undoPicks([p])
      else if (p.how === 'shared' && !this.occ.has(p.box) && this.pool.d.db.box(p.box)?.state === 'busy') this.pool.release(p.box, o.repo)
      return s.why ?? 'cancelled'
    }
    // its time counts from the new box (the failed try is not this box's, nor the shard's estimate's)
    Object.assign(s, { box: p.box, size: p.size, slot: p.slot, how: p.how, left: false, t0: this.d.now() })
    if (this.d.cfg.boat.packing) this.occupy(p.box, p.slot, s.shard.units, `${run.id}/${s.shard.name}`, s.shard.memMb)
    return null
  }

  private async shardOn(run: Run, s: ShardRun, o: { repo: string; cfg: RepoConfig; args: string[]; maxSec: number }, snap: Promise<{ sha: string; base: string | null; bundle: string | null; branch: string | null; extras: Extra[] }>, silentSec: number): Promise<ShardResult> {
    const name = s.shard.name
    const result = (code: number | null, reason?: string): ShardResult => ({
      name, size: s.size, where: `boat:${s.box}${this.d.cfg.boat.packing ? ` slot ${s.slot}` : ''} (${s.how})`, code, secs: Math.round((this.d.now() - s.t0) / 1000), log: s.log, ...(reason ? { reason } : {}),
      ...(s.artifacts ? { artifacts: s.artifacts } : {}),
    })
    const state = (st: string, message?: string) => this.emit(run, { t: 'state', shard: name, state: st, ...(message ? { message } : {}) })
    const sig = s.ac.signal
    let id: string | null = null
    let ran = false
    let seeded = false
    try {
      if (s.wait) {
        const got = await this.waitForBox(run, s, o)
        if (got) return result(null, got)
      }
      state(s.how === 'resumed' ? 'resuming box' : s.how === 'created' ? 'creating box' : 'box ready', s.box)
      try {
        await this.startBox(s.box)
      } catch (e) {
        return this.startFailed(run, s, `box ${s.box} did not start: ${(e as Error).message}`, result)
      }
      id = this.pool.d.db.box(s.box)?.boatId ?? null
      if (!id) return this.startFailed(run, s, `box ${s.box} has no Boat id`, result)
      if (sig.aborted) return result(null, s.why ?? 'cancelled')
      let sn: Awaited<typeof snap>
      try {
        sn = await snap
      } catch (e) {
        return result(null, `snapshot failed: ${(e as Error).message}`)
      }
      // the box is up and the snapshot made: the start deadline is met; uploads have their own limits
      s.ready = true
      try {
        const dir = slotDir(s.slot)
        const mk = await this.d.boat.exec(id, `mkdir -p "$HOME/cib/${s.slot}" "$HOME/cib/extra"`, { timeoutSec: 60 })
        if (mk.code !== 0) throw new Error(`mkdir exited ${mk.code}`)
        await this.d.boat.scp(this.d.wrapScript, id, `${dir}/cib-wrap.sh`)
        await this.d.boat.scp(join(o.cfg.root, o.cfg.boat!.remoteScript), id, `${dir}/remote.sh`)
        if (sn.bundle) await this.d.boat.scp(sn.bundle, id, `${dir}/snapshot.bundle`, { timeoutSec: SEED_UPLOAD_SEC, signal: sig })
        if (sn.base && !sig.aborted) seeded = await this.seed(run, id, s.slot, o, sn.base, sig)
        for (const x of sn.extras) if (!sig.aborted) await this.shipExtra(id, x, s.slot, sig)
      } catch (e) {
        if (sig.aborted) return result(null, s.why ?? 'cancelled')
        // a seed that could not be built here is this machine's fault, not the box's
        if (e instanceof LocalSeedError) return result(null, `seed bundle failed: ${e.message}`)
        this.pool.charge(s.box, `upload failed: ${(e as Error).message}`)
        return this.startFailed(run, s, `upload to ${s.box} failed: ${(e as Error).message}`, result)
      }
      if (sig.aborted) return result(null, s.why ?? 'cancelled')
      this.outage.ok()
      s.started = true
      ran = true
      state('running')
      for (let attempt = 1; ; attempt++) {
        let silent: NodeJS.Timeout | null = null
        const arm = () => {
          if (silent) clearTimeout(silent)
          silent = setTimeout(() => {
            s.why = `no output for ${silentSec}s`
            s.ac.abort()
          }, silentSec * 1000)
          silent.unref?.()
        }
        arm()
        const args = s.shard.passArgs ? [...s.shard.args, ...o.args] : s.shard.args
        // fenced by every kill of this attempt: an exec that reaches the box after the broker gave up never runs
        const attemptId = `${run.id}.${name}.${attempt}`
        const share = this.d.cfg.boat.packing ? shareOf(s.slot, s.shard.units, s.shard.memMb) : undefined
        const slotKey = `${s.box}#${s.slot}`
        const fence = this.lost.get(slotKey) ?? []
        const cmd = remoteCommand({ slot: s.slot, repo: o.repo, sha: sn.sha, base: sn.base, bundle: !!sn.bundle, args, noFsync: true, seed: seeded, extras: sn.extras.map((x) => x.name), attempt: attemptId, fence, ...(share ? { share } : {}), ...(sn.branch ? { defaultBranch: sn.branch } : {}) })
        // on any kill (deadline, maxSec, silence, cancel) stop the remote process group now, not after exec returns
        const boxId = id
        const kill = killCommand(s.slot, attemptId)
        const onAbort = () => void this.d.boat.exec(boxId, kill, { timeoutSec: 60 }).catch(() => {})
        sig.addEventListener('abort', onAbort, { once: true })
        let code: number | null
        // an I/O fault in this attempt's output (the line it was on); a 200-char carry joins a phrase split across chunks
        let ioLine: string | null = null
        let carry = ''
        try {
          code = (
            await this.d.boat.exec(id, cmd, {
              signal: sig,
              // a backstop past maxSec: the CLI is killed for good even if a kill signal did not end it
              timeoutSec: o.maxSec + 120,
              onData: (d) => {
                arm()
                // bookkeeping: it never fails the shard
                try {
                  s.sum.feed(d)
                } catch {}
                s.log = (s.log + d).slice(-LOG_TAIL)
                this.emit(run, { t: 'log', shard: name, data: d })
                if (!ioLine) {
                  const t = carry + d
                  const m = IO_FAULT_RE.exec(t)
                  if (m) ioLine = t.slice(t.lastIndexOf('\n', m.index) + 1, (t.indexOf('\n', m.index) + 1 || t.length + 1) - 1).trim().slice(0, 300)
                  carry = t.slice(-200)
                }
              },
            })
          ).code
        } catch (e) {
          code = null
          s.why ??= `exec failed: ${(e as Error).message}`
        } finally {
          if (silent) clearTimeout(silent)
          sig.removeEventListener('abort', onAbort)
        }
        if (sig.aborted || code === null || code === 255) {
          // its exec may still reach the box: every later attempt on this slot fences it first (the kill below may be
          // lost too)
          this.lost.set(slotKey, [...fence, attemptId].slice(-20))
          await this.d.boat.exec(id, kill, { timeoutSec: 60 }).catch(() => {})
          if (!sig.aborted) this.pool.charge(s.box, code === 255 ? 'connection lost (exit 255)' : 'no exit status')
          // a lost connection (Boat drops an exec now and then): once more on the same box; the wrapper kills what is left
          if (!sig.aborted && attempt === 1) {
            const why = (code === 255 ? 'connection to the box lost (exit 255)' : 'no exit status from boat exec')
            state('retrying', `${why}; running the shard again on the same box`)
            s.log += `\ntest-broker: ${why}; running the shard again\n`
            continue
          }
          // a killed shard (deadline, silence, maxSec) still left its files; a lost box answers nothing, so don't wait on it
          // (a cancel aborts s.fetch: no one is left to read them)
          if (sig.aborted && code !== 255) await this.fetchArtifacts(run, s, id, o.cfg)
          return result(null, s.why ?? (code === 255 ? 'connection to the box lost (exit 255)' : 'no exit status from boat exec'))
        }
        // an infra code of the repo's remote script: the box failed, not the code under test. Charge it, so a broken
        // box (git gone, a full disk) is quarantined after infraFailLimit in a row and gets no more shards
        const infra = o.cfg.boat!.infraExitCodes ?? this.d.cfg.boat.infraExitCodes[o.repo.toLowerCase()] ?? []
        const boxFailed = code !== 0 && infra.includes(code)
        const ioFault = code !== 0 && !boxFailed ? ioLine : null
        // a run that got through the remote script's setup (pass or test failure) clears the box's failures, only when
        // no other shard shares it (theirs may be failing there)
        if (!boxFailed && !ioFault && (!this.d.cfg.boat.packing || (this.occ.get(s.box) ?? []).every((x) => x === null || x === `${run.id}/${name}`))) this.pool.resetFails(s.box)
        if (boxFailed) {
          this.pool.charge(s.box, `exit ${code} (an infra code of ${o.repo})`)
          s.boxFault = `exit ${code}, an infra code of ${o.repo}`
          s.log += `\ntest-broker: exit ${code} is an infra code of this repo: the box failed, not the code under test\n`
          this.emit(run, { t: 'log', shard: name, data: `test-broker: exit ${code} is an infra code of this repo: the box failed, not the code under test\n` })
        }
        if (ioFault) {
          // the box's disk or filesystem failed: one is enough to quarantine it (once its other shards end)
          this.pool.chargeHard(s.box, `I/O fault in a shard's output: ${ioFault}`)
          s.boxFault = `I/O fault: ${ioFault}`
          s.log += `\ntest-broker: an I/O fault on box ${s.box} (${ioFault}): the box failed, not the code under test\n`
          this.emit(run, { t: 'log', shard: name, data: `test-broker: an I/O fault on box ${s.box} (${ioFault}): the box failed, not the code under test\n` })
        }
        if (code !== 0 && !s.boxFault) await this.fetchArtifacts(run, s, id, o.cfg)
        return result(code)
      }
    } finally {
      state('ended')
      this.leave(s, o.repo, ran)
    }
  }

  /**
   * The queue: wait for the claim, then the shard has its units on that box; or, given up, place it again with no wait.
   * Its own start deadline counts from then. Returns why it has no box (the run then ends as not started), or null.
   */
  private async waitForBox(run: Run, s: ShardRun, o: { repo: string; cfg: RepoConfig }): Promise<string | null> {
    const w = s.wait!
    const sig = s.ac.signal
    this.emit(run, { t: 'state', shard: s.shard.name, state: 'waiting for box', message: `${w.box} (about ${Math.round(w.etaSec)}s; a box start would take about ${Math.round(w.startCost)}s)` })
    const aborted = new Promise<'aborted'>((r) => (sig.aborted ? r('aborted') : sig.addEventListener('abort', () => r('aborted'), { once: true })))
    const slot = await Promise.race([w.promise, aborted])
    if (slot === 'aborted') return s.why ?? 'cancelled'
    s.waitedSecs = Math.round((this.d.now() - s.t0) / 1000)
    s.wait = null
    // its own start deadline, from now (it covers a placing again too)
    const t = setTimeout(() => {
      if (!s.ready && !s.left) run.notStart?.(`${s.shard.name} was not running within ${this.d.cfg.boat.startDeadlineSec}s of the end of its wait`)
    }, this.d.cfg.boat.startDeadlineSec * 1000)
    t.unref?.()
    run.timers.push(t)
    if (slot != null) {
      s.slot = slot
      s.how = 'shared'
      this.d.log(`run ${run.id}: ${s.shard.name} on ${s.box} slot ${slot} after a ${s.waitedSecs}s wait`)
    } else {
      s.waitGaveUp = true
      // placed again as any shard is, with no wait: idle, stopped, new
      const only = await this.poolGate(this.envOf(o.cfg))
      if ('none' in only) {
        run.notStart?.(`${s.shard.name} has no box after its wait`)
        return `no box after the wait: ${only.none}`
      }
      const r = await this.serial(() => this.pack(this.envOf(o.cfg), o.repo, [s.shard], only))
      if ('why' in r) {
        run.notStart?.(`${s.shard.name} has no box after its wait`)
        return `no box after the wait: ${r.why}`
      }
      const p = r.picks[0]
      if (sig.aborted) {
        // nothing will start the box: give the pick back as reserve's failure path does
        this.occupy(p.box, p.slot, s.shard.units, null)
        if (p.how !== 'shared' && !this.occ.has(p.box)) this.undoPicks([p])
        else if (p.how === 'shared' && !this.occ.has(p.box) && this.pool.d.db.box(p.box)?.state === 'busy') this.pool.release(p.box, o.repo)
        return s.why ?? 'cancelled'
      }
      Object.assign(s, { box: p.box, size: p.size, slot: p.slot, how: p.how })
      this.occupy(p.box, p.slot, s.shard.units, `${run.id}/${s.shard.name}`, s.shard.memMb)
      this.d.log(`run ${run.id}: ${s.shard.name} on ${p.box} slot ${p.slot} (${p.how}) after a ${s.waitedSecs}s wait`)
    }
    s.t0 = this.d.now()
    if (sig.aborted) return s.why ?? 'cancelled'
    return null
  }

  /**
   * A shard's box did not start, or the upload to it failed, before any test ran there: the code under test is not at
   * fault. The run ends as not started (exit 3), so the CLI runs it here at once, as for a missed start deadline;
   * before, it ended as a failure (exit 1) and the caller saw failing tests. It counts toward the outage pause.
   */
  private startFailed(run: Run, s: ShardRun, why: string, result: (code: number | null, reason?: string) => ShardResult): ShardResult {
    // a box start can't be interrupted: one that fails after the run was stopped (another shard's start failed first)
    // still failed, so it counts toward the outage pause
    this.outage.failed(s.box, why)
    if (s.ac.signal.aborted) return result(null, s.why ?? 'cancelled')
    run.notStart?.(why)
    return result(null, why)
  }

  /** Start a placed box once, however many of its shards ask (they share the start). */
  private startBox(name: string): Promise<void> {
    let p = this.starting.get(name)
    if (!p) {
      p = this.pool.start(name)
      this.starting.set(name, p)
      p.finally(() => this.starting.delete(name)).catch(() => {})
    }
    return p
  }

  /** A shard gives its units back; the last shard on a box gives the box back to the pool. */
  private leave(s: ShardRun, repo: string, ran: boolean) {
    if (s.left) return
    s.left = true
    // a shard still waiting holds no units: only its claim goes
    if (s.wait) {
      this.dropWait(s.wait, repo)
      s.wait = null
    }
    // no slot: it waited and never got a box (it holds nothing)
    if (s.slot < 0) return
    if (this.d.cfg.boat.packing) {
      this.occupy(s.box, s.slot, s.shard.units, null)
      // a claim on the box takes the units first: the box stays busy for it
      this.serveClaim(s.box)
      if (this.occ.has(s.box)) return
    }
    const st = this.pool.d.db.box(s.box)?.state
    if (st === 'busy') this.pool.release(s.box, repo)
    else if (st === 'resuming' && !ran) this.pool.setState(s.box, 'stopped')
  }

  follow(id: string, fn: (e: RunEvent) => void): (() => void) | null {
    const run = this.runs.get(id)
    if (!run) return null
    for (const e of run.events) fn(e)
    if (run.done) return () => {}
    run.subs.add(fn)
    return () => run.subs.delete(fn)
  }

  cancel(id: string, why: string): boolean {
    const run = this.runs.get(id)
    if (!run || run.done) return false
    this.d.log(`run ${id}: ${why}`)
    for (const s of run.shards) {
      s.fetch.abort()
      if (!s.ac.signal.aborted) {
        s.why = why
        s.ac.abort()
      }
    }
    return true
  }

  resetQuarantine(): number {
    const n = this.pool.reset()
    if (n) this.d.log(`reset: ${n} quarantined box(es) back as stopped`)
    return n
  }

  // ---- box speed and drains (boxspeed.ts)

  /** a box placement takes last (and an avoidSlow suite never): its score is at or above speed.slowAt, or (once slow)
   *  at or above speed.clearAt */
  isSlow(name: string): boolean {
    return this.slowJudge(name).slow
  }

  /**
   * The two signals: the run score (its shards against the same shards on other boxes) and the probe score (fixed
   * work, 2 probes or more to call a box slow). Either can make a box slow; the newer one wins when they disagree, so a
   * fresh normal probe clears a box judged on old shards, and fresh normal shards clear a stale slow probe.
   */
  private slowJudge(name: string): { slow: boolean; runSlow: boolean; probeSlow: boolean } {
    const c = this.d.cfg.boat.speed
    if (c.mode === 'off') return { slow: false, runSlow: false, probeSlow: false }
    const thr = this.flags.slowSince(name) != null ? c.clearAt : c.slowAt
    const run = this.scores.get(name)
    const pr = this.probeScores.get(name)
    const runSlow = !!run && run.score >= thr
    const probeSlow = !!pr && pr.probes >= 2 && pr.score >= thr
    const probeClears = !!pr && pr.score < thr && pr.last > (run?.last ?? 0)
    const runClears = !!run && run.score < thr && run.last > (pr?.last ?? 0)
    return { slow: (runSlow && !probeClears) || (probeSlow && !runClears), runSlow, probeSlow }
  }

  /** the pool's filter for a suite: no drained box, and no slow box for an avoidSlow suite */
  private boxRules(g: BoxFilter, suite: Suite): BoxFilter {
    const strict = !!suite.boat?.avoidSlow
    return { ...g, allow: (b) => g.allow(b) && !this.flags.drain(b.name) && !(strict && this.isSlow(b.name)) }
  }

  /** packing off: the slow free boxes of a size to hide from place(), when one that is not slow is free */
  private slowAvoid(env: string, size: string, only: BoxFilter): string[] {
    const fit = this.pool.boxes().filter((b) => b.env === env && b.size === size && (b.state === 'idle' || b.state === 'stopped') && only.allow(b))
    return fit.some((b) => !this.isSlow(b.name)) ? fit.filter((b) => this.isSlow(b.name)).map((b) => b.name) : []
  }

  /**
   * Score every box from runs.db, start or stop each box's slow clock, and (speed.mode retire) drain a box slow for
   * retireAfterMin, at most maxRetirePerDay a day. Then delete the drained boxes that are free.
   */
  refreshSpeed() {
    const c = this.d.cfg.boat.speed
    const now = this.d.now()
    let scores = new Map<string, BoxScore>()
    if (this.d.usage && c.mode !== 'off')
      try {
        scores = boxScores(this.d.usage.runsSince(now - (c.ageHours + c.nearHours) * 3_600_000), now, c)
      } catch (e) {
        this.d.log(`speed: could not read runs.db: ${(e as Error).message}`)
        scores = this.scores
      }
    this.scores = scores
    let pscores = new Map<string, ProbeScore>()
    if (this.d.usage && c.mode !== 'off')
      try {
        pscores = probeScores(this.d.usage.boxProbesSince(now - c.ageHours * 3_600_000), now, c.ageHours)
      } catch (e) {
        this.d.log(`speed: could not read the probes in runs.db: ${(e as Error).message}`)
        pscores = this.probeScores
      }
    this.probeScores = pscores
    const alive = new Set<string>()
    for (const b of this.pool.boxes()) {
      alive.add(b.name)
      const sc = this.scores.get(b.name)
      const ps = this.probeScores.get(b.name)
      const j = this.slowJudge(b.name)
      const slow = j.slow
      const was = this.flags.slowSince(b.name)
      const said = `runs ${sc ? `${sc.score}x over ${sc.samples} shards` : '-'}, probes ${ps ? `${ps.score}x over ${ps.probes}` : '-'}`
      if (slow && was == null) {
        this.flags.setSlow(b.name, now)
        this.d.log(`box ${b.name}: slow (${said}); placement takes it last`)
      } else if (!slow && was != null) {
        this.flags.setSlow(b.name, null)
        this.d.log(`box ${b.name}: no longer slow (${said})`)
      }
      const since = this.flags.slowSince(b.name)
      if (c.mode !== 'retire' || !slow || since == null || this.flags.drain(b.name) || now - since < c.retireAfterMin * 60_000) continue
      // judged on evidence from after it turned slow (a shard it ran, or a probe), not only on what made it slow
      const fresh = (j.runSlow && !!sc && sc.last > since) || (j.probeSlow && !!ps && ps.last > since)
      if (!fresh) continue
      if (this.flags.retiredSince(now - 86_400_000) >= c.maxRetirePerDay) continue
      const reason = `slow (${said}) for ${Math.round((now - since) / 60_000)} min`
      this.flags.setDrain(b.name, { at: now, by: 'retire', reason })
      this.d.log(`box ${b.name}: drained (${reason}); it is deleted once free`)
    }
    this.flags.prune(alive, now)
    this.dropDrained()
  }

  /** delete the drained boxes that are free (idle or stopped, no shard on them and none waiting for them) */
  dropDrained(): string[] {
    const out: string[] = []
    for (const b of this.pool.boxes()) {
      const d = this.flags.drain(b.name)
      if (!d || this.occ.has(b.name) || this.claims.has(b.name)) continue
      if (this.pool.evict(b.name, `drained by ${d.by === 'operator' ? 'the operator' : 'retire'}: ${d.reason}`)) out.push(b.name)
    }
    return out
  }

  /** a box by its name, its Boat id, or the last 6 characters of its name */
  private findBox(q: string): BoxRow | { error: string } {
    const all = this.pool.boxes()
    const hit = all.find((b) => b.name === q || b.boatId === q)
    if (hit) return hit
    const m = all.filter((b) => b.name.endsWith(`-${q}`))
    if (m.length === 1) return m[0]
    return { error: m.length ? `${q} matches ${m.length} boxes: ${m.map((b) => b.name).join(', ')}` : `no box ${q} in the pool (test-broker boxes lists them)` }
  }

  /** the operator drains a box: no new shards; it is deleted once free (now, when it is free already) */
  drainBox(q: string, reason: string | null): { box: string; state: string; deleted: boolean } | { error: string } {
    const b = this.findBox(q)
    if ('error' in b) return b
    const why = reason?.trim().slice(0, 300) || 'no reason given'
    this.flags.setDrain(b.name, { at: this.d.now(), by: 'operator', reason: why })
    this.d.log(`box ${b.name}: drained by the operator (${why}); it is deleted once free`)
    return { box: b.name, state: b.state, deleted: this.dropDrained().includes(b.name) }
  }

  /** undo a drain (the operator's or retire's) of a box not deleted yet */
  undrainBox(q: string): { box: string; was: Drain } | { error: string } {
    const b = this.findBox(q)
    if ('error' in b) return b
    const was = this.flags.drain(b.name)
    if (!was || !this.flags.undrain(b.name)) return { error: `box ${b.name} is not drained` }
    this.d.log(`box ${b.name}: undrained by the operator (was: ${was.by}: ${was.reason})`)
    return { box: b.name, was }
  }

  /** every box with its speed and drain, slowest first (test-broker boxes) */
  boxesView() {
    const c = this.d.cfg.boat.speed
    const now = this.d.now()
    const boxes = this.pool.boxes().map((b) => {
      const sc = this.scores.get(b.name)
      const since = this.flags.slowSince(b.name)
      return {
        name: b.name, env: b.env, size: b.size, state: b.state, lastRepo: b.lastRepo,
        score: sc?.score ?? null, samples: sc?.samples ?? 0, slow: this.isSlow(b.name),
        probe: this.probeScores.get(b.name) ?? null, probedMin: this.probedAt.has(b.name) ? Math.round((now - this.probedAt.get(b.name)!) / 60_000) : null, probing: this.probing.has(b.name),
        slowMin: since != null ? Math.round((now - since) / 60_000) : null, drain: this.flags.drain(b.name), infraFails: b.infraFails,
      }
    })
    boxes.sort((x, y) => Math.max(y.score ?? 0, y.probe?.score ?? 0) - Math.max(x.score ?? 0, x.probe?.score ?? 0) || x.name.localeCompare(y.name))
    return { speed: c, retiredToday: this.flags.retiredSince(now - 86_400_000), boxes }
  }

  // ---- probes (probe.ts): a fixed speed and health check on idle running boxes

  /** probes at most this many boxes at once */
  static readonly PROBES_AT_ONCE = 2

  /** start the probes due now (the sweep, every minute): idle running boxes, after each start, then every probeEveryMin */
  probeDue(): string[] {
    const c = this.d.cfg.boat.speed
    if (c.mode === 'off' || c.probeEveryMin <= 0) return []
    const now = this.d.now()
    const out: string[] = []
    for (const b of this.pool.boxes()) {
      if (this.probing.size >= BoatRuns.PROBES_AT_ONCE) break
      if (!this.probeable(b) || now - b.lastUsed < c.probeIdleSec * 1000 || now - b.since < c.probeIdleSec * 1000) continue
      const last = this.probedAt.get(b.name) ?? 0
      if (now - last < c.probeEveryMin * 60_000 && (this.startedAt.get(b.name) ?? 0) <= last) continue
      out.push(b.name)
      this.track(this.probe(b.name))
    }
    return out
  }

  /** a box a probe may run on now: idle and running, no shard on it or waiting for it, not drained, not probing */
  private probeable(b: BoxRow): boolean {
    return b.state === 'idle' && !!b.boatId && !this.occ.has(b.name) && !this.claims.has(b.name) && !this.flags.drain(b.name) && !this.probing.has(b.name)
  }

  /**
   * Probe one box. A fault (an I/O error, a full disk, git gone, an exec that failed or timed out) charges the box
   * (infraFailLimit in a row quarantines it). Aborted when the box leaves idle (a shard took it): then nothing is
   * recorded and the probe is killed on the box.
   */
  async probe(name: string): Promise<{ box: string; aborted: boolean; result: ProbeResult | null; faults: string[]; secs: number }> {
    const b = this.pool.d.db.box(name)
    if (!b || !this.probeable(b)) return { box: name, aborted: true, result: null, faults: [], secs: 0 }
    const c = this.d.cfg.boat.speed
    const ac = new AbortController()
    this.probing.set(name, ac)
    const t0 = this.d.now()
    const w0 = Date.now()
    this.probedAt.set(name, t0)
    try {
      const r = await this.d.boat.exec(b.boatId!, probeCommand(c.probeCpuMb, c.probeDiskMb), { timeoutSec: c.probeTimeoutSec, signal: ac.signal })
      const secs = Math.round((Date.now() - w0) / 100) / 10
      if (ac.signal.aborted) {
        const id = b.boatId!
        this.track(this.d.boat.exec(id, probeKillCommand(), { timeoutSec: 30 }).catch(() => {}))
        this.d.log(`box ${name}: probe stopped (the box left idle)`)
        return { box: name, aborted: true, result: null, faults: [], secs }
      }
      const res = parseProbe(r.out)
      const faults = r.code === 124 ? [`the probe timed out after ${c.probeTimeoutSec}s`] : r.code !== 0 ? [`the probe exec failed (${r.code == null ? 'no exit status' : `exit ${r.code}`})`] : probeFaults(res, c.probeMinFreeGb)
      this.record(() => this.d.usage!.boxProbe({ t: t0, box: name, size: b.size, secs, cpu1: res.cpu1, cpuN: res.cpuN, write: res.write, read: res.read, repoSecs: res.repoSecs, repoMb: res.repoMb, freeGb: res.freeGb, memMb: res.memMb, ioSome: res.ioSome, load1: res.load1, ok: !faults.length, faults }))
      this.d.log(`box ${name}: probe ${faults.length ? `FAULT (${faults.join('; ')})` : 'ok'} in ${secs}s: cpu ${res.cpu1}s/${res.cpuN}s, disk ${res.write}s/${res.read}s${res.repoMb != null ? `, repo ${res.repoMb} MB in ${res.repoSecs}s` : ''}, ${res.freeGb} GB free`)
      if (faults.length) this.pool.charge(name, `probe: ${faults.join('; ')}`.slice(0, 400))
      this.refreshSpeed()
      return { box: name, aborted: false, result: res, faults, secs }
    } finally {
      this.probing.delete(name)
    }
  }

  /** `test-broker box probe <box>`: probe an idle running box now (a stopped box is not started for it) */
  async probeBox(q: string): Promise<{ box: string; aborted: boolean; faults: string[]; secs: number; result: ProbeResult | null; score: ProbeScore | null } | { error: string }> {
    const b = this.findBox(q)
    if ('error' in b) return b
    if (!this.probeable(b)) return { error: `box ${b.name} is ${this.probing.has(b.name) ? 'being probed now' : this.flags.drain(b.name) ? 'drained' : b.state === 'idle' ? 'held for a shard' : b.state}: only an idle running box is probed (a stopped one would cost a start)` }
    const r = await this.probe(b.name)
    return { ...r, score: this.probeScores.get(b.name) ?? null }
  }

  ownerGone(owner: string) {
    for (const r of this.runs.values()) if (r.owner === owner && !r.done) this.cancel(r.id, 'cancelled: the caller went away')
  }

  // ---- the warm pool (Part B of the spec): keep warm only what the load needs

  /** who tests where: runs and hints (`test-broker hint`) */
  readonly activity = new Activity()
  /** per pool: the units busy or claimed, once a minute over the last RECENT_MS */
  private load = new Map<string, { t: number; units: number }[]>()
  /** per repo: units per active agent, learned from runs.db */
  private upa = new Map<string, { v: number | null; at: number }>()

  /** an agent's hint: it works in `root`, tests are likely soon; `gone`: the worktree is gone. Never fails. */
  hint(o: { root: string; repo?: string; cfg?: RepoConfig; ttlMs?: number; gone?: boolean }) {
    if (o.gone) {
      if (this.activity.gone(o.root)) this.d.log(`hint: ${o.root} is gone`)
      return
    }
    if (!o.repo || !o.cfg?.boat) return
    this.activity.hint(o.root, o.repo, this.envOf(o.cfg), o.ttlMs ?? this.d.cfg.boat.hintTtlMin * 60_000, this.d.now())
  }

  /** after a restart: the worktrees that ran a test in the last 30 min count as active again (their config names the pool) */
  private seedActivity() {
    if (!this.d.usage) return
    try {
      const now = this.d.now()
      const seen = new Set<string>()
      for (const r of this.d.usage.runsSince(now - 30 * 60_000).reverse()) {
        if (seen.has(r.root)) continue
        seen.add(r.root)
        try {
          const cfg = loadRepoConfig(r.root)
          if (cfg.boat) this.activity.run(r.root, r.repo, this.envOf(cfg), r.startedAt)
        } catch {}
      }
    } catch (e) {
      this.d.log(`warm: could not read runs.db: ${(e as Error).message}`)
    }
  }

  /** one sample per pool: the units its shards hold or wait for now */
  sampleLoad() {
    const now = this.d.now()
    const per = new Map<string, number>()
    for (const b of this.pool.boxes()) {
      if (!per.has(b.env)) per.set(b.env, 0)
      const used = this.d.cfg.boat.packing ? (this.occ.get(b.name) ?? []).filter((x) => x !== null).length : ['busy', 'resuming', 'creating'].includes(b.state) ? (SIZE_UNITS[b.size] ?? 1) : 0
      per.set(b.env, per.get(b.env)! + used)
    }
    for (const w of this.claims.values()) {
      const env = this.pool.d.db.box(w.box)?.env
      if (env) per.set(env, (per.get(env) ?? 0) + w.units)
    }
    for (const [env, units] of per) {
      const a = (this.load.get(env) ?? []).filter((x) => now - x.t < RECENT_MS)
      a.push({ t: now, units })
      this.load.set(env, a)
    }
  }

  private unitsPerAgent(repo: string): number {
    const now = this.d.now()
    let c = this.upa.get(repo)
    if (!c || now - c.at > UPA_TTL_MS) {
      let v: number | null = null
      if (this.d.usage)
        try {
          v = unitsPerAgent(this.d.usage, repo, now)
        } catch (e) {
          this.d.log(`warm: units per agent of ${repo}: ${(e as Error).message}`)
        }
      c = { v, at: now }
      this.upa.set(repo, c)
    }
    return c.v ?? 1
  }

  /** The warm target of every pool now, and the idle boxes past it (they stop after shortIdleMin). */
  warmPlan(): WarmView[] {
    const now = this.d.now()
    const boxes = this.pool.boxes().filter((b) => b.state !== 'quarantined')
    const agents = this.activity.active(now)
    const envs = new Set([...boxes.map((b) => b.env), ...agents.map((a) => a.env)])
    const s = this.pool.lastStarts
    const guard = startsGuard(s && Math.floor(s.at / 86_400_000) === Math.floor(now / 86_400_000) ? s : null, this.d.cfg.boat.startsReserve)
    const out: WarmView[] = []
    for (const env of envs) {
      const mine = boxes.filter((b) => b.env === env)
      const dRecent = p90((this.load.get(env) ?? []).filter((x) => now - x.t < RECENT_MS).map((x) => x.units))
      const byRepo = new Map<string, number>()
      for (const a of agents) if (a.env === env) byRepo.set(a.repo, (byRepo.get(a.repo) ?? 0) + 1)
      let dAgents = 0
      for (const [repo, n] of byRepo) dAgents += n * this.unitsPerAgent(repo)
      dAgents = Math.round(dAgents * 100) / 100
      const boxUnits = Math.max(1, ...mine.map((b) => SIZE_UNITS[b.size] ?? 1))
      const targetUnits = warmUnits({ dRecent, dAgents, active: this.activity.ranRecently(env, now), boxUnits })
      const past = guard ? [] : pastTarget(mine, targetUnits, (z) => SIZE_UNITS[z] ?? 1)
      out.push({ env, targetUnits, dRecent, dAgents, agents: [...byRepo.values()].reduce((a, b) => a + b, 0), startsGuard: guard, pastTarget: past })
    }
    return out
  }

  /** the sweep with the warm pool: an idle box past its pool's warm target stops after shortIdleMin, not idleStopMin */
  private async sweepWarm() {
    this.sampleLoad()
    const past = new Set(this.warmPlan().flatMap((w) => w.pastTarget))
    const short = Math.min(this.d.cfg.boat.shortIdleMin, this.d.cfg.boat.idleStopMin) * 60
    return this.pool.sweep((b) => (past.has(b.name) ? { sec: short, reason: EARLY_STOP_REASON } : null))
  }

  status() {
    const now = this.d.now()
    return {
      agents: this.activity.active(now).map((a) => ({ repo: a.repo, worktree: a.root, source: a.source })),
      warm: this.warmPlan(),
      boxes: this.pool.boxes().map((b) => ({ name: b.name, env: b.env, size: b.size, state: b.state, lastRepo: b.lastRepo, reason: b.reason, speed: this.scores.get(b.name)?.score ?? null, slow: this.isSlow(b.name), drained: this.flags.drain(b.name)?.by ?? null, ...(this.d.cfg.boat.packing ? { units: SIZE_UNITS[b.size] ?? 1, unitsUsed: (this.occ.get(b.name) ?? []).filter((x) => x !== null).length, memMb: (SIZE_UNITS[b.size] ?? 1) * UNIT_MEM_MB, memUsedMb: (SIZE_UNITS[b.size] ?? 1) * UNIT_MEM_MB - this.memFree(b.name) } : {}) })),
      runs: [...this.runs.values()].map((r) => ({ id: r.id, repo: r.repo, suite: r.suite, done: r.done, shards: r.shards.map((s) => ({ name: s.shard.name, box: s.box, slot: s.slot, units: s.shard.units, memMb: s.shard.memMb, started: s.started, ...(s.wait ? { waiting: { etaSec: Math.round(s.wait.etaSec), limitSec: Math.round(s.wait.limitSec) } } : s.waitedSecs != null ? { waitedSecs: s.waitedSecs } : {}) })) })),
      packing: this.d.cfg.boat.packing,
      starts: this.pool.lastStarts,
      outage: this.outage.view(),
    }
  }

  private prune() {
    const now = this.d.now()
    for (const [id, r] of this.runs) if (r.done && now - r.doneAt > KEEP_DONE_MS) this.runs.delete(id)
  }

  /** Delete free (idle or stopped) boxes of a size this machine no longer uses. A busy one goes at its next sweep. */
  dropOffSizes(): string[] {
    const on = this.d.cfg.boat.sizes as string[]
    return this.pool.boxes().filter((b) => !on.includes(b.size) && this.pool.evict(b.name, `size ${b.size} is off (boat.sizes)`)).map((b) => b.name)
  }

  /** reconcile with `boat list` now and every 5 min; sweep idle and old boxes every minute */
  startTimers(): () => void {
    const rec = () => {
      this.track(this.pool.reconcile().catch((e) => this.d.log(`reconcile: ${(e as Error).message}`)))
      this.refreshSpeed()
    }
    const sw = () => {
      this.dropOffSizes()
      this.dropDrained()
      this.probeDue()
      this.track(this.sweepWarm().catch((e) => this.d.log(`sweep: ${(e as Error).message}`)))
      this.track(this.tidy().catch((e) => this.d.log(`tidy: ${(e as Error).message}`)))
    }
    const plan = () => {
      this.track(this.snapPlan())
      // runs.db keeps a year
      this.record(() => this.d.usage!.prune(this.d.now() - 365 * 86_400_000))
    }
    rec()
    plan()
    const a = setInterval(rec, 5 * 60_000)
    const b = setInterval(sw, 60_000)
    const c = setInterval(plan, 15 * 60_000)
    return () => {
      clearInterval(a)
      clearInterval(b)
      clearInterval(c)
    }
  }

  /** cancel every run and wait (at most 30 s: systemd's stop timeout is 90 s) for the boxes to go back */
  /** the daemon is stopping: runs it cancels end as 'daemon restart' (steering does not count them) */
  private stopping = false
  async stop() {
    this.stopping = true
    for (const r of this.runs.values()) if (!r.done) this.cancel(r.id, 'cancelled: test-brokerd is stopping')
    await Promise.race([this.idle(), new Promise((r) => setTimeout(r, 30_000).unref())])
  }
}

/** Boat on, when the `boat` CLI answers; null (Boat off) otherwise. */
export async function startBoat(cfg: MachineConfig, stateDir: string, log: (m: string) => void, usage: RunsDb | null = null): Promise<{ side: BoatSide; runs: Runs; stop: () => Promise<void> } | null> {
  if (cfg.boat.maxBoxes === 0) return null
  const boat = new CliBoat(cfg.boatBin)
  try {
    await boat.starts()
  } catch (e) {
    log(`boat off: ${(e as Error).message}`)
    return null
  }
  const r = new BoatRuns({ cfg, stateDir, boat, log, usage })
  const stopTimers = r.startTimers()
  return { side: r, runs: r, stop: async () => (stopTimers(), await r.stop()) }
}
