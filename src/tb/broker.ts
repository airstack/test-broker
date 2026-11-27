// test-brokerd's core, without the socket: answer asks, keep the leases, hand Boat runs to the Boat side. Every input
// that depends on time or the machine comes in through BrokerDeps so tests drive it.
import { argsKey } from './eta.ts'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { availableParallelism, freemem, loadavg } from 'node:os'
import { admitLocal, freeCpus, leasedCpus, type AskFlags, type Box, type BusyReason, type Lease } from './admit.ts'
import { History } from './history.ts'
import type { RunsDb, UsageSteer } from './runs-db.ts'
import { adviceText, judge, type SteerVerdict } from './steer.ts'
import { buildSnapshot } from '../core/snapshot.ts'
import type { MachineConfig } from './machine-config.ts'
import { loadRepoConfig, RepoConfigError, type RepoConfig, type Suite } from './repo-config.ts'
import type { BoatPeek } from './boat-side.ts'

export type AskReq = { root: string; suite: string; flags: AskFlags; pid: number | null; args?: string[] }

export type BoxView = { nproc: number; load1: number; leasedCpus: number; freeCpus: number; memAvailGb: number }

export type Answer =
  | { decision: 'boat'; boat: { run: string; shards: number; follow: string }; box: BoxView }
  | { decision: 'local'; local: { lease: string; cpus: number; locks: string[] }; box: BoxView; boatWhy?: string; peek?: PeekInfo }
  | { decision: 'busy'; busy: { reasons: BusyReason[]; retryAfterSec: number; boatWhy?: string }; box: BoxView; peek?: PeekInfo }
  | { decision: 'error'; error: string }
  /** steered: not run; `message` is the facts and the repo's advice; rerun with TEST_BROKER_CONFIRM to run it */
  | { decision: 'advise'; advise: { message: string; checks: string[] } }

/** a peek's extra answer (`test-broker ask`): what Boat would give now, and the steering checks as they would judge */
export type PeekInfo = { boat: BoatPeek | null; steer: { check: string; mode: string; message: string }[] }

/** What the Boat side answers for one ask: a started run, or why not (the ask goes on to the local check). */
export type BoatTry = { run: string; shards: number } | { why: string }

export interface BoatSide {
  /** reserve every shard's box now and start the run, or say why not; never waits for a box */
  tryRun(o: { repo: string; cfg: RepoConfig; suite: Suite; args: string[]; owner: string }): Promise<BoatTry>
  /** what a run would get now, with no claim and no start */
  peek?(o: { repo: string; cfg: RepoConfig; suite: Suite; args: string[] }): Promise<BoatPeek | { why: string }>
  /** an agent's hint for the warm pool: tests are likely soon in `root` (or `gone`: the worktree is gone) */
  hint?(o: { root: string; repo?: string; cfg?: RepoConfig; ttlMs?: number; gone?: boolean }): void
}

export type BrokerDeps = {
  cfg: MachineConfig
  stateDir: string
  now?: () => number
  box?: () => Box
  /** owner/name of the repo at a worktree root */
  repoOf?: (root: string) => Promise<string>
  loadConfig?: (root: string) => RepoConfig
  boat?: BoatSide | null
  log?: (msg: string) => void
  /** usage accounting (runs.db); none: nothing recorded */
  usage?: RunsDb | null
}

export function memAvailGb(): number {
  try {
    const m = /^MemAvailable:\s+(\d+) kB/m.exec(readFileSync('/proc/meminfo', 'utf8'))
    if (m) return Number(m[1]) / 1024 / 1024
  } catch {}
  return freemem() / 1024 ** 3
}

export const realBox = (): Box => ({ nproc: availableParallelism(), load1: loadavg()[0], memAvailGb: memAvailGb() })

/** owner/name from a remote URL (https, ssh, scp-like or a local path) */
export function repoFromUrl(url: string): string | null {
  const m = /([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim())
  return m ? `${m[1]}/${m[2]}` : null
}

export const realRepoOf = (root: string): Promise<string> =>
  new Promise((resolve, reject) =>
    execFile('git', ['-C', root, 'remote', 'get-url', 'origin'], { timeout: 10_000 }, (err, out) => {
      const r = !err && repoFromUrl(String(out))
      if (r) resolve(r)
      else reject(new Error(`cannot tell the repo of ${root} from its origin remote`))
    }),
  )

export class Broker {
  readonly cfg: MachineConfig
  readonly history: History
  private leases = new Map<string, Lease & { owner: string }>()
  private n = 0
  private d: Required<Omit<BrokerDeps, 'boat'>> & { boat: BoatSide | null }

  constructor(d: BrokerDeps) {
    this.cfg = d.cfg
    this.d = {
      cfg: d.cfg, stateDir: d.stateDir, now: d.now ?? Date.now, box: d.box ?? realBox, repoOf: d.repoOf ?? realRepoOf,
      loadConfig: d.loadConfig ?? loadRepoConfig, boat: d.boat ?? null, log: d.log ?? ((m) => console.error(m)), usage: d.usage ?? null,
    }
    this.history = new History(`${d.stateDir}/history.json`)
  }

  setBoat(b: BoatSide | null) {
    this.d.boat = b
  }

  activeLeases(): Lease[] {
    return [...this.leases.values()]
  }

  boxView(box = this.d.box()): BoxView {
    const ls = this.activeLeases()
    return {
      nproc: box.nproc, load1: Math.round(box.load1 * 100) / 100, leasedCpus: leasedCpus(ls),
      freeCpus: freeCpus(box, ls, this.cfg.budgetFactor), memAvailGb: Math.round(box.memAvailGb * 10) / 10,
    }
  }

  private eta = (l: Lease): number | null => {
    const m = this.history.median(History.key(l.repo, l.suite, 'local'))
    if (m == null) return null
    return Math.max(5, Math.round(m - (this.d.now() - l.since) / 1000))
  }

  /**
   * Answer an ask. `owner` names the connection: a lease it gets ends with release(owner). `dryRun` (a peek) takes
   * no lease and starts no Boat run: it answers what a real ask would say about the local check now.
   */
  async ask(req: AskReq, owner: string, dryRun = false): Promise<Answer> {
    const t0 = Date.now()
    const a = await this.askInner(req, owner, dryRun)
    const ms = Date.now() - t0
    if (ms >= 3_000) this.d.log(`ask ${req.suite} (${req.root}): answered ${a.decision} after ${ms}ms`)
    return a
  }

  private async askInner(req: AskReq, owner: string, dryRun: boolean): Promise<Answer> {
    let repo: string
    let cfg: RepoConfig
    try {
      cfg = this.d.loadConfig(req.root)
      repo = await this.d.repoOf(req.root)
    } catch (e) {
      return { decision: 'error', error: e instanceof RepoConfigError ? e.message : (e as Error).message }
    }
    const suite = cfg.suites[req.suite]
    if (!suite) return { decision: 'error', error: `no suite "${req.suite}" in ${cfg.root}/.test-broker.json (suites: ${Object.keys(cfg.suites).join(', ')})` }
    // steering: judged before Boat or a lease is taken; `log` mode only records the verdict
    const shape: 'whole' | 'narrowed' = (req.args ?? []).length ? 'narrowed' : 'whole'
    const ak = argsKey(req.args ?? [])
    // the worktree's tree, worked out at most once per ask (about 0.1 s)
    let treeP: Promise<string | null> | null = null
    const tree = () => (treeP ??= worktreeTree(req.root))
    let verdict: SteerVerdict | null = null
    // a peek judges too (nothing is recorded), so the caller sees what a run would be told
    if (this.d.usage && this.cfg.steer.mode !== 'off') {
      try {
        const head = (await gitInfo(req.root)).head
        verdict = await judge(this.d.usage, this.cfg.steer, { repo, root: req.root, suite, shape, argsKey: ak, head, now: this.d.now(), confirm: req.flags.confirm ?? null }, tree)
      } catch (e) {
        this.d.log(`steer: ${(e as Error).message}`)
      }
      if (verdict?.reasons.length && !dryRun) this.d.log(`steer ${repo} ${suite.name}: ${verdict.advised ? 'advised' : verdict.confirm ? 'confirmed' : 'would advise'} (${verdict.reasons.map((r) => `${r.check}:${r.mode}`).join(', ')})`)
      if (verdict?.advised && !dryRun) {
        const v = verdict
        this.record(() => {
          const rid = `A-${++this.n}-${this.d.now().toString(36)}`
          this.d.usage!.startRun({ id: rid, repo, root: req.root, suite: suite.name, shape, argsN: (req.args ?? []).length, argsKey: ak, whereRan: 'advised', boatWhy: null, startedAt: this.d.now(), cpus: 0, shards: null })
          this.d.usage!.endRun(rid, { endedAt: this.d.now(), exitCode: EXIT_ADVISED, endedHow: 'advised', cpuMin: 0, planHours: 0 })
          this.d.usage!.setSteer(rid, v.heavy, strip(v))
          void gitInfo(req.root).then((g) => this.record(() => this.d.usage!.setGit(rid, g)))
        })
        return { decision: 'advise', advise: { message: adviceText(v, cfg.advice, suite.name), checks: v.reasons.filter((r) => r.mode === 'advise').map((r) => r.check) } }
      }
    }
    let boatWhy: string | undefined
    let boatPeek: BoatPeek | null = null
    if (!suite.boat) boatWhy = 'suite runs local only'
    else if (req.flags.noBoat) boatWhy = '--no-boat'
    else if (!this.d.boat) boatWhy = 'Boat is not set up on this machine'
    else if (dryRun) {
      boatPeek = null
      if (this.d.boat.peek)
        try {
          const p = await this.d.boat.peek({ repo, cfg, suite, args: req.args ?? [] })
          if ('why' in p) boatWhy = p.why
          else boatPeek = p
        } catch (e) {
          boatWhy = `Boat error: ${(e as Error).message}`
        }
      else boatWhy = 'peek: Boat not tried'
    }
    else {
      try {
        const t = await this.d.boat.tryRun({ repo, cfg, suite, args: req.args ?? [], owner })
        if ('run' in t) {
          this.d.log(`ask ${repo} ${suite.name}: boat ${t.run}`)
          if (verdict) {
            const v = verdict
            this.record(() => this.d.usage!.setSteer(t.run, v.heavy, strip(v)))
          }
          return { decision: 'boat', boat: { run: t.run, shards: t.shards, follow: `test-broker logs ${t.run} -f` }, box: this.boxView() }
        }
        boatWhy = t.why
      } catch (e) {
        boatWhy = `Boat error: ${(e as Error).message}`
      }
    }
    const peekInfo = (): PeekInfo => ({ boat: boatPeek, steer: (verdict?.reasons ?? []).map((r) => ({ check: r.check, mode: r.mode, message: r.message })) })
    // a heavy local run records its tree as of now, before its command starts: one worked out later could hold edits made
    // while it ran, and a later run of those edits would be told they passed. Light runs: in the background
    const treeNow = !dryRun && verdict?.heavy && this.cfg.steer.mode !== 'off' ? await tree() : null
    // from here on: synchronous, so two asks can't both take the last CPUs or the same lock
    const box = this.d.box()
    const a = admitLocal({ suite, leases: this.activeLeases(), box, budgetFactor: this.cfg.budgetFactor, flags: req.flags, now: this.d.now(), eta: this.eta })
    if (a.decision === 'busy') {
      this.d.log(`ask ${repo} ${suite.name}: busy (${a.reasons.map((r) => r.kind).join(', ')})`)
      return { decision: 'busy', busy: { reasons: a.reasons, retryAfterSec: a.retryAfterSec, ...(boatWhy ? { boatWhy } : {}) }, box: this.boxView(box), ...(dryRun ? { peek: peekInfo() } : {}) }
    }
    let id = 'peek'
    if (!dryRun) {
      id = `L-${++this.n}`
      this.leases.set(id, { id, repo, root: req.root, suite: suite.name, pid: req.pid, cpus: a.cpus, locks: a.locks, since: this.d.now(), owner })
      this.d.log(`lease ${id}: ${repo} ${suite.name} ${a.cpus} cpu(s)${a.locks.length ? ` locks ${a.locks.join(',')}` : ''}`)
      this.record(() => {
        const rid = `${id}-${this.d.now().toString(36)}`
        this.leaseRun.set(id, rid)
        this.d.usage!.startRun({ id: rid, repo, root: req.root, suite: suite.name, shape, argsN: (req.args ?? []).length, argsKey: ak, whereRan: 'local', boatWhy: boatWhy ?? null, startedAt: this.d.now(), cpus: a.cpus, shards: null })
        if (verdict) this.d.usage!.setSteer(rid, verdict.heavy, strip(verdict))
        void gitInfo(req.root).then((g) => this.record(() => this.d.usage!.setGit(rid, g)))
        // the tree it tests, so a later run of the same code can be told (Boat runs get it from their snapshot)
        if (treeNow) this.d.usage!.setGit(rid, { tree: treeNow })
        else if (this.cfg.steer.mode !== 'off') void tree().then((t) => t && this.record(() => this.d.usage!.setGit(rid, { tree: t })))
      })
    }
    return { decision: 'local', local: { lease: id, cpus: a.cpus, locks: a.locks }, box: this.boxView(box), ...(boatWhy ? { boatWhy } : {}), ...(dryRun ? { peek: peekInfo() } : {}) }
  }

  /**
   * `test-broker hint`: an agent works in `root` (tests are likely soon), or the worktree is gone. Optional information
   * for the warm pool: it never fails, and a worktree with no .test-broker.json (or no Boat suites) is ignored.
   */
  async hint(root: string, o: { ttlMs?: number; gone?: boolean }): Promise<void> {
    const boat = this.d.boat
    if (!boat?.hint) return
    if (o.gone) return boat.hint({ root, gone: true })
    try {
      const cfg = this.d.loadConfig(root)
      if (!cfg.boat) return
      const repo = await this.d.repoOf(root)
      boat.hint({ root, repo, cfg, ...(o.ttlMs ? { ttlMs: o.ttlMs } : {}) })
    } catch {}
  }

  /** a lease's command finished: record how long it took (only a clean finish counts toward ETAs) */
  done(lease: string, code: number) {
    const l = this.leases.get(lease)
    if (!l) return
    if (code === 0) this.history.add(History.key(l.repo, l.suite, 'local'), (this.d.now() - l.since) / 1000)
    this.endLease(l, code, 'done')
    this.leases.delete(lease)
    this.d.log(`lease ${lease}: done (exit ${code})`)
  }

  /** the connection `owner` closed: every lease it held ends */
  release(owner: string) {
    for (const [id, l] of this.leases) if (l.owner === owner) {
      this.endLease(l, null, 'released')
      this.leases.delete(id)
      this.d.log(`lease ${id}: released (connection closed)`)
    }
  }

  /** lease id → its runs.db row */
  private leaseRun = new Map<string, string>()
  private endLease(l: Lease, code: number | null, how: string) {
    const rid = this.leaseRun.get(l.id)
    if (!rid) return
    this.leaseRun.delete(l.id)
    const now = this.d.now()
    this.record(() => this.d.usage!.endRun(rid, { endedAt: now, exitCode: code, endedHow: how, cpuMin: (l.cpus * (now - l.since)) / 60_000, planHours: 0 }))
  }
  /** usage accounting is best effort: a runs.db error never fails an ask */
  private record(fn: () => void) {
    if (!this.d.usage) return
    try {
      fn()
    } catch (e) {
      this.d.log(`usage: ${(e as Error).message}`)
    }
  }
}

export const EXIT_ADVISED = 76
const strip = (v: SteerVerdict): UsageSteer => ({ reasons: v.reasons, advised: v.advised, confirm: v.confirm, medianCpuMin: v.medianCpuMin })

/** the tree a snapshot of the worktree would have (tracked + untracked, not ignored), or null */
export async function worktreeTree(root: string): Promise<string | null> {
  try {
    return (await buildSnapshot(root, { maxFileMb: 1_000_000 })).tree
  } catch {
    return null
  }
}

/** branch and HEAD of a worktree, for usage rows (best effort) */
export async function gitInfo(root: string): Promise<{ branch: string | null; head: string | null }> {
  const one = (args: string[]) =>
    new Promise<string | null>((resolve) => execFile('git', ['-C', root, ...args], { timeout: 10_000 }, (e, out) => resolve(e ? null : String(out).trim() || null)))
  const [branch, head] = await Promise.all([one(['rev-parse', '--abbrev-ref', 'HEAD']), one(['rev-parse', 'HEAD'])])
  return { branch, head }
}
