// A broker's own Boat pool. One DB row per box (name chosen up front: cib-<daemonId>-<env>-<size>-<rand6>). Every
// state change goes through setState(), which writes the DB synchronously before any await, so two scheduler steps
// can never both pick a box and pending starts are always counted.
import { randomBytes } from 'node:crypto'
import { RUNNING_STATES, type Boat, type Box, type Starts } from './boat.ts'
import { TRANSITIONAL, type BoxRow, type BoxState, type BoxStore } from './boxes-db.ts'

export const SIZES = ['small', 'default', 'large', 'xlarge']
const TRANSITIONAL_STALE_MS = 10 * 60_000

const rand6 = () => Array.from(randomBytes(6), (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('')

/** A test-broker pool's environment (`tbx-<host>-<pool>`) names its boxes itself: `tbx-<host>-<pool>-<size>-<rand6>`.
 *  Every other environment's boxes are `cib-<daemonId>-<env>-<size>-<rand6>`. */
export const boxName = (daemonId: string, env: string, size: string, rand = rand6(), poolHost?: string) =>
  isPoolEnv(env, poolHost) ? `${env}-${size}-${rand}` : `cib-${daemonId}-${env}-${size}-${rand}`

/** `tbx-<poolHost>-<pool>`: a pool environment of THIS host (a daemon with no poolHost has none) */
export function isPoolEnv(env: string, poolHost?: string): boolean {
  const m = /^tbx-([a-z0-9]{1,16})-[a-z0-9]{1,16}$/.exec(env)
  return !!m && !!poolHost && m[1] === poolHost
}

/** A pool box of this host: `tbx-<host>-<pool>-<size>-<rand6>`, or null. */
export function parsePoolBoxName(host: string, name: string): { env: string; size: string; rand: string } | null {
  const m = /^(tbx-([a-z0-9]{1,16})-[a-z0-9]{1,16})-([a-z]+)-([a-z0-9]{6})$/.exec(name)
  if (!m || m[2] !== host || !SIZES.includes(m[3])) return null
  return { env: m[1], size: m[3], rand: m[4] }
}

export function parseBoxName(daemonId: string, name: string): { env: string; size: string; rand: string } | null {
  const pre = `cib-${daemonId}-`
  if (!name.startsWith(pre)) return null
  const m = /^(.+)-([a-z]+)-([a-z0-9]{6})$/.exec(name.slice(pre.length))
  if (!m || !SIZES.includes(m[2])) return null
  return { env: m[1], size: m[2], rand: m[3] }
}

/** v0.1 pool names: cib-<profile>-<size>-<rand6>, for a profile we know. */
export function parseLegacyName(name: string, isProfile: (p: string) => boolean): { profile: string; size: string; rand: string } | null {
  const m = /^cib-(.+)-([a-z]+)-([a-z0-9]{6})$/.exec(name)
  if (!m || !SIZES.includes(m[2]) || !isProfile(m[1])) return null
  return { profile: m[1], size: m[2], rand: m[3] }
}

export function inWarmHours(spec: string | null, now: number): boolean {
  if (!spec) return false
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(spec.trim())
  if (!m) return false
  const d = new Date(now)
  const t = d.getHours() * 60 + d.getMinutes()
  const a = +m[1] * 60 + +m[2]
  const b = +m[3] * 60 + +m[4]
  return a <= b ? t >= a && t <= b : t >= a || t <= b
}

const isRunning = (b: Box) => RUNNING_STATES.includes(b.state)

export type PlaceReq = { env: string; size: string; repo: string; avoid: string[]; only?: BoxFilter }
/** The public lane's limits on a pick: boxes it may use (`allow`), new boxes marked for `repo`, none past `max` over `envs`. */
export type BoxFilter = { repo: string; allow: (b: BoxRow) => boolean; envs: Set<string>; max: number }

/** One check of a public-lane environment (`boat env info` + `boat list`). */
type PublicSeen = { at: number; version: number; injects: string[]; versions: Map<string, number> }
const PUBLIC_RECHECK_MS = 30_000

/** A box the public lane of `repo` may use, by the check `s`: marked for it, first listed at the checked version, and
 *  listed there still (a box not in the check's list is judged by its first-seen version: the executor checks again). */
function publicFit(b: BoxRow, repo: string, s: PublicSeen): boolean {
  if (!b.pubRepo || b.pubRepo !== repo || b.envVersion !== s.version) return false
  const now = b.boatId ? s.versions.get(b.boatId) : undefined
  return (now ?? b.envVersion) === s.version
}
/** The settings the pool reads. ci-brokerd passes its whole Config; test-broker maps its machine config. */
export type PoolCfg = {
  /** names this broker's boxes (cib-<daemonId>-…) */
  daemonId: string
  /** adopt this host's pool boxes (tbx-<poolHost>-…) too; none = no pool environments */
  poolHost?: string
  /** Boat box starts kept back from the plan's budget */
  startsReserve: number
  /** infra failures in a row that quarantine a box */
  infraFailLimit: number
  pool: { idleStopSec: number; warmHours: string | null; deleteAfterDays: number; ttlSec: number }
}
/** The Boat resource: its id (for logs and slots) and the box cap. */
export type PoolResource = { id: string; maxBoxes?: number }

export type Placed = { box: string; how: 'reused' | 'resumed' | 'created' }

export type PoolDeps = {
  db: BoxStore
  boat: Boat
  cfg: PoolCfg
  resource: PoolResource
  now: () => number
  log: (msg: string) => void
  /** scrubs text stored on a row (box reasons carry Boat CLI output) */
  scrub?: (s: string) => string
  /** env for a v0.1 box of this profile, or null when the profile is unknown */
  legacyEnv: (profile: string) => string | null
  /** track a background promise (so tests and drain can wait for it) */
  track: (p: Promise<unknown>) => void
  /** told of every box state change, after the write (usage accounting: Boat bills a box while it is up) */
  onState?: (box: BoxRow) => void
}

export class BoatPool {
  /** the last `boat limits` read, for status */
  lastStarts: (Starts & { at: number }) | null = null
  /** per environment, after failed `boat new`s: no create until `until` (a broken environment must not be hammered);
   * the wait doubles with each failure in a row (1 min, 2, 4 … capped at 10 min) and resets on a create that works */
  private createBackoff = new Map<string, { fails: number; until: number }>()
  /** per public-lane environment: the last check (at most one per PUBLIC_RECHECK_MS, unless `fresh`) */
  private publicSeen = new Map<string, PublicSeen>()
  readonly d: PoolDeps
  /** how often a start polls Boat's `hydrated` flag, and for how long at most */
  hydratePollMs = 2000
  hydrateMaxMs = 120_000
  constructor(d: PoolDeps) {
    this.d = d
  }

  get id() {
    return this.d.resource.id
  }
  /** test-broker's host id: names and adopts its pool boxes (`tbx-<host>-…`); ci-brokerd has none */
  private get poolHost(): string | undefined {
    return this.d.cfg.poolHost || undefined
  }
  private get maxBoxes() {
    return this.d.resource.maxBoxes ?? 10
  }

  /** THE state transition: synchronous DB write, then a log line. */
  setState(name: string, state: BoxState, patch: Partial<Omit<BoxRow, 'name' | 'env' | 'size' | 'createdAt' | 'state' | 'since'>> = {}) {
    const prev = this.d.db.box(name)
    if (patch.reason && this.d.scrub) patch = { ...patch, reason: this.d.scrub(patch.reason) }
    this.d.db.updateBox(name, { ...patch, state, since: this.d.now() })
    if (prev?.state !== state) {
      this.d.log(`box ${name}: ${prev?.state ?? '-'} → ${state}${patch.reason ? ` (${patch.reason})` : ''}`)
      this.told(name)
    }
  }

  /** onState for a row about to be deleted: state `deleted` (Boat bills it no more) */
  private gone(name: string) {
    const row = this.d.db.box(name)
    if (row && this.d.onState) try {
      this.d.onState({ ...row, state: 'deleted' as BoxState })
    } catch {}
  }
  /** onState for a row just inserted (a new or adopted box) */
  private told(name: string) {
    const row = this.d.db.box(name)
    if (row && this.d.onState) try {
      this.d.onState(row)
    } catch {}
  }

  boxes(): BoxRow[] {
    return this.d.db.boxes()
  }
  /** The boxes `maxBoxes` counts: every box but a quarantined one. A quarantined box is stopped and out of use, so a
   *  new box takes its place (the pool keeps up to maxBoxes usable boxes). */
  liveCount(): number {
    return this.boxes().filter((b) => b.state !== 'quarantined').length
  }
  /** Before `adding` new boxes: keep all boxes, quarantined ones too, under 2 × maxBoxes, by deleting the oldest
   *  quarantined ones. So a run of bad boxes cannot grow the pool without end. */
  trimQuarantined(adding = 1) {
    const q = this.boxes()
      .filter((b) => b.state === 'quarantined')
      .sort((x, y) => x.since - y.since)
    while (q.length && this.boxes().length + adding > 2 * this.maxBoxes) this.deleteBox(q.shift()!, `make room: over ${2 * this.maxBoxes} boxes with the quarantined ones`)
  }
  pendingStarts(): number {
    return this.boxes().filter((b) => b.state === 'creating' || b.state === 'resuming').length
  }

  /** the last `boat limits` read is reused this long (one read per pass, not per placement attempt) */
  static readonly LIMITS_TTL_MS = 5_000
  /** false after a start is placed: its effect on `boat limits` is unknown until the next read */
  private limitsFresh = false

  /** null = a start is allowed now; else why not. Reads `boat limits` (a failed read = no start), reusing a read
   * younger than LIMITS_TTL_MS when no start was placed since; pending starts are always subtracted. */
  private async budget(reserve = this.d.cfg.startsReserve): Promise<string | null> {
    let s: Starts
    const cached = this.lastStarts
    if (this.limitsFresh && cached && this.d.now() - cached.at < BoatPool.LIMITS_TTL_MS) s = cached
    else {
      try {
        s = await this.d.boat.starts()
      } catch (e) {
        this.limitsFresh = false
        return `cannot read Boat limits: ${(e as Error).message}`
      }
      this.lastStarts = { ...s, at: this.d.now() }
      this.limitsFresh = true
    }
    const pending = this.pendingStarts()
    if (s.day - pending <= reserve) return `Boat starts left today (${s.day}, ${pending} pending) at the reserve (${reserve})`
    if (s.minute - pending <= 0) return 'Boat start rate limit (per minute) reached'
    return null
  }

  /**
   * Pick a box for a shard: an idle running box of the size (preferring one that last ran this repo), else a stopped
   * one (resume), else a new one. The pick is written before the call returns; the start itself happens in start().
   */
  async place(r: PlaceReq): Promise<Placed | { none: string }> {
    // a full-lane pick never takes a box marked public; a public pick only what its gate allows
    const fits = (b: BoxRow) => b.env === r.env && b.size === r.size && !r.avoid.includes(b.name) && (r.only ? r.only.allow(b) : !b.pubRepo)
    const idle = this.boxes().filter((b) => b.state === 'idle' && fits(b))
    if (idle.length) {
      const b = idle.find((x) => x.lastRepo === r.repo) ?? idle.sort((x, y) => y.lastUsed - x.lastUsed)[0]
      this.setState(b.name, 'busy')
      return { box: b.name, how: 'reused' }
    }
    const hasStopped = this.boxes().some((b) => b.state === 'stopped' && fits(b))
    const atCap = this.liveCount() >= this.maxBoxes
    if (!hasStopped && atCap && !this.boxes().some((b) => b.state === 'stopped' && !(b.env === r.env && b.size === r.size)))
      return { none: `boat: at maxBoxes (${this.maxBoxes}) with no stopped box of another size to delete` }
    const why = await this.budget()
    if (why) return { none: why }
    // the read awaited: look again
    const stopped = this.boxes()
      .filter((b) => b.state === 'stopped' && fits(b))
      .sort((x, y) => (x.lastRepo === r.repo ? 0 : 1) - (y.lastRepo === r.repo ? 0 : 1) || y.lastUsed - x.lastUsed)
    if (stopped.length) {
      this.setState(stopped[0].name, 'resuming')
      this.limitsFresh = false
      return { box: stopped[0].name, how: 'resumed' }
    }
    const bo = this.createBackoff.get(r.env)
    if (bo && this.d.now() < bo.until) return { none: `boat: ${bo.fails} create(s) in a row failed in ${r.env}; next try in ${Math.ceil((bo.until - this.d.now()) / 1000)}s` }
    const capped = this.overPublicCap(r.only)
    if (capped) return { none: capped }
    this.trimQuarantined()
    if (this.liveCount() >= this.maxBoxes) {
      const victim = this.boxes()
        .filter((b) => b.state === 'stopped' && !(b.env === r.env && b.size === r.size))
        .sort((x, y) => x.lastUsed - y.lastUsed)[0]
      if (!victim) return { none: `boat: at maxBoxes (${this.maxBoxes})` }
      this.deleteBox(victim, `make room for a ${r.size} box`)
    }
    const now = this.d.now()
    const name = boxName(this.d.cfg.daemonId, r.env, r.size, undefined, this.poolHost)
    this.d.db.insertBox({ name, boatId: null, env: r.env, size: r.size, state: 'creating', since: now, lastRepo: r.repo, lastUsed: now, infraFails: 0, reason: null, createdAt: now, pubRepo: r.only ? r.only.repo : null })
    this.told(name)
    this.d.log(`box ${name}: - → creating`)
    this.limitsFresh = false
    return { box: name, how: 'created' }
  }

  /**
   * A box for a health check: an idle running box of the environment (any size, preferring this repo's), else — only
   * if the budget allows (down to 0 left with `useReserve`) — a stopped one (resume) or a new `default` one.
   * `noBudget` = it would need a start the budget doesn't allow (the check changes nothing then).
   */
  async placeForCheck(env: string, repo: string, useReserve: boolean, only?: BoxFilter): Promise<Placed | { none: string; noBudget?: true }> {
    const ok = (b: BoxRow) => b.env === env && (only ? only.allow(b) : !b.pubRepo)
    const idle = this.boxes().filter((b) => b.state === 'idle' && ok(b))
    if (idle.length) {
      const b = idle.find((x) => x.lastRepo === repo) ?? idle.sort((x, y) => y.lastUsed - x.lastUsed)[0]
      this.setState(b.name, 'busy')
      return { box: b.name, how: 'reused' }
    }
    const why = await this.budget(useReserve ? 0 : undefined)
    if (why) return { none: why, noBudget: true }
    const stopped = this.boxes()
      .filter((b) => b.state === 'stopped' && ok(b))
      .sort((x, y) => y.lastUsed - x.lastUsed)
    if (stopped.length) {
      this.setState(stopped[0].name, 'resuming')
      this.limitsFresh = false
      return { box: stopped[0].name, how: 'resumed' }
    }
    const bo = this.createBackoff.get(env)
    if (bo && this.d.now() < bo.until) return { none: `boat: ${bo.fails} create(s) in a row failed in ${env}; next try in ${Math.ceil((bo.until - this.d.now()) / 1000)}s` }
    const capped = this.overPublicCap(only)
    if (capped) return { none: capped }
    this.trimQuarantined()
    if (this.liveCount() >= this.maxBoxes) {
      const victim = this.boxes()
        .filter((b) => b.state === 'stopped')
        .sort((x, y) => x.lastUsed - y.lastUsed)[0]
      if (!victim) return { none: `boat: at maxBoxes (${this.maxBoxes}) with no stopped box to delete` }
      this.deleteBox(victim, 'make room for a check box')
    }
    const now = this.d.now()
    const name = boxName(this.d.cfg.daemonId, env, 'default', undefined, this.poolHost)
    this.d.db.insertBox({ name, boatId: null, env, size: 'default', state: 'creating', since: now, lastRepo: repo, lastUsed: now, infraFails: 0, reason: null, createdAt: now, pubRepo: only ? only.repo : null })
    this.told(name)
    this.d.log(`box ${name}: - → creating (check)`)
    this.limitsFresh = false
    return { box: name, how: 'created' }
  }

  private overPublicCap(only?: BoxFilter): string | null {
    if (!only) return null
    // a quarantined box does not count, as for maxBoxes (trimQuarantined bounds them)
    const n = this.boxes().filter((b) => only.envs.has(b.env) && b.state !== 'quarantined').length
    return n >= only.max ? `boat: the public lane has ${n} box(es), its cap (trust.publicBoatMaxBoxes ${only.max})` : null
  }

  /**
   * The public lane's gate for one environment (root's trust.repos.<repo>.publicBoat) and repo. The environment must
   * inject nothing (envInjects). A box is fit only when it is marked for this repo (made by this gate's picks) and
   * Boat lists it at the version it was first listed at, which is the version just checked: a box made from another
   * version, or re-pinned since (`boat env upgrade`), may hold what that version injected. Idle, stopped and
   * quarantined boxes of the environment that are not fit are deleted. One check per PUBLIC_RECHECK_MS; `fresh`
   * checks now (the executor, just before a run).
   */
  async publicGate(env: string, repo: string, o: { fresh?: boolean; envs: Set<string>; max: number }): Promise<BoxFilter | { none: string }> {
    const now = this.d.now()
    const want = repo.toLowerCase()
    let s = this.publicSeen.get(env)
    if (o.fresh || !s || now - s.at >= PUBLIC_RECHECK_MS) {
      try {
        const [info, boxes] = await Promise.all([this.d.boat.envInfo(env), this.d.boat.list()])
        const versions = new Map<string, number>()
        for (const b of boxes) if (b.environment === env && typeof b.environmentVersion === 'number') versions.set(b.id, b.environmentVersion)
        s = { at: now, version: info.version, injects: info.injects, versions }
      } catch (e) {
        this.publicSeen.delete(env)
        return { none: `boat: public environment ${env} could not be checked: ${(e as Error).message.slice(0, 200)}` }
      }
      this.publicSeen.set(env, s)
      // the first version Boat lists a box at is its own for good
      for (const b of this.boxes()) {
        const v = b.env === env && b.boatId ? s.versions.get(b.boatId) : undefined
        if (v !== undefined && b.envVersion == null) this.d.db.updateBox(b.name, { envVersion: v })
      }
      if (s.injects.length) this.d.log(`TRUST public environment ${env} injects ${s.injects.join(', ')}: public-lane jobs stay off Boat`)
      else
        for (const b of this.boxes()) {
          // judged for the repo that holds the environment now: a box another repo's lane ran goes too
          if (b.env !== env || !['idle', 'stopped', 'quarantined'].includes(b.state) || publicFit(b, want, s)) continue
          const v = b.boatId ? s.versions.get(b.boatId) : undefined
          this.deleteBox(b, !b.pubRepo ? `in public environment ${env} but not made by its public lane` : b.pubRepo !== want ? `ran ${b.pubRepo}'s public lane; ${env} is ${want}'s now` : v === undefined ? `Boat lists no ${env} version for it` : `at ${env} v${v} (first v${b.envVersion}), not the checked v${s.version}`)
        }
    }
    if (s.injects.length)
      return { none: `boat: public environment ${env} injects ${s.injects.join(', ')} (it must inject nothing: boat env set ${env} --safe-for-third-parties true)` }
    const seen = s
    return { repo: want, allow: (b) => b.env === env && publicFit(b, want, seen), envs: o.envs, max: o.max }
  }

  /** Delete a box: the row goes at once, the Boat call in the background (reconcile re-adopts it if that fails). */
  /** Delete a free (idle or stopped) box to make room for another environment or size. */
  evict(name: string, why: string): boolean {
    const b = this.boxes().find((x) => x.name === name)
    if (!b || (b.state !== 'idle' && b.state !== 'stopped')) return false
    this.deleteBox(b, why)
    this.limitsFresh = false
    return true
  }

  private deleteBox(b: BoxRow, why: string) {
    this.gone(b.name)
    this.d.db.deleteBox(b.name)
    this.d.log(`box ${b.name}: deleted (${why})`)
    if (b.boatId) {
      const id = b.boatId
      this.d.track(this.d.boat.delete(id).catch((e) => this.d.log(`box ${b.name}: delete failed: ${(e as Error).message}`)))
    }
  }

  /** Make a placed box usable: create or resume it as its row says, then extend its TTL. Throws on failure. */
  async start(name: string): Promise<void> {
    const b = this.d.db.box(name)
    if (!b) throw new Error(`box ${name} is gone`)
    // a cached `boat limits` read taken while this start was pending would miss it once it is no longer pending
    try {
      await this.startNow(name, b)
    } finally {
      this.limitsFresh = false
    }
  }
  private async startNow(name: string, b: BoxRow): Promise<void> {
    if (b.state === 'creating') {
      try {
        const id = await this.d.boat.create({ name, size: b.size, environment: b.env, ttlSec: this.d.cfg.pool.ttlSec })
        this.setState(name, 'busy', { boatId: id })
        this.createBackoff.delete(b.env)
        await this.waitHydrated(name, id)
      } catch (e) {
        this.gone(name)
        this.d.db.deleteBox(name)
        const fails = (this.createBackoff.get(b.env)?.fails ?? 0) + 1
        this.createBackoff.set(b.env, { fails, until: this.d.now() + Math.min(60_000 * 2 ** (fails - 1), 600_000) })
        this.d.log(`box ${name}: create failed: ${(e as Error).message}`)
        throw e
      }
      return
    }
    if (b.state === 'resuming') {
      try {
        await this.d.boat.resume(b.boatId!)
        this.setState(name, 'busy')
      } catch (e) {
        this.setState(name, 'stopped', { reason: `resume failed: ${(e as Error).message}` })
        // a box Boat cannot resume counts as an infra failure: infraFailLimit in a row → quarantined, so the next shard
        // gets another box (a 500 fails in seconds: without this the same box was picked again and again)
        this.charge(name, `resume failed: ${(e as Error).message.split('\n')[0].slice(0, 200)}`)
        throw e
      }
      await this.waitHydrated(name, b.boatId!)
    }
    if (b.boatId) await this.d.boat.extend(b.boatId, this.d.cfg.pool.ttlSec).catch(() => {})
  }

  /**
   * Wait until Boat says the box has loaded its disk. Until then Boat serves the home dir through a lazy-loading layer
   * and swaps the real disk in when it is done: a process started before the swap keeps its working directory in the
   * old copy (/var/lib/ascii-lazy/retired/…), so a run's setup and its dev stack see different files (an e2e run's
   * migrations went to the old copy, every sign-up then found no tables). On timeout or a failed read,
   * go on and say so.
   */
  private async waitHydrated(name: string, id: string): Promise<void> {
    const until = Date.now() + this.hydrateMaxMs
    for (;;) {
      let h: boolean | null
      try {
        h = await this.d.boat.hydrated(id)
      } catch (e) {
        this.d.log(`box ${name}: hydrated check failed (${(e as Error).message}); not waiting`)
        return
      }
      if (h !== false) return
      if (Date.now() >= until) {
        this.d.log(`box ${name}: still not hydrated after ${Math.round(this.hydrateMaxMs / 1000)}s; going on`)
        return
      }
      await new Promise((r) => setTimeout(r, this.hydratePollMs))
    }
  }

  /** A shard is done with the box. */
  release(name: string, repo: string) {
    const b = this.d.db.box(name)
    if (b?.state !== 'busy') return
    // charged to the limit while this shard ran on it (see charge): quarantine now that nothing runs there
    if (b.infraFails >= this.d.cfg.infraFailLimit) return this.quarantine(name, b.reason ? `${b.infraFails} infra failures in a row; last: ${b.reason}` : 'infra failures')
    this.setState(name, 'idle', { lastUsed: this.d.now(), lastRepo: repo })
  }

  /** One attributed infra failure; infraFailLimit in a row → quarantined. */
  charge(name: string, why: string) {
    const b = this.d.db.box(name)
    if (!b) return
    const n = b.infraFails + 1
    if (this.d.scrub) why = this.d.scrub(why)
    this.d.db.updateBox(name, { infraFails: n, reason: why })
    this.d.log(`box ${name}: infra failure ${n}/${this.d.cfg.infraFailLimit} (${why})`)
    if (n < this.d.cfg.infraFailLimit) return
    // a charge can land late (attempt 2 ended elsewhere) while another shard runs on the box: never stop it under
    // that shard; release() quarantines it once the shard is done
    if (b.state === 'busy' || b.state === 'creating' || b.state === 'resuming') this.d.log(`box ${name}: quarantined once its running shard ends`)
    else this.quarantine(name, `${n} infra failures in a row; last: ${why}`)
  }
  /** A fault that is the box's for sure (an I/O error): one is enough, the box is quarantined (once its shards end). */
  chargeHard(name: string, why: string) {
    const b = this.d.db.box(name)
    if (!b) return
    const lim = this.d.cfg.infraFailLimit
    if (b.infraFails < lim - 1) this.d.db.updateBox(name, { infraFails: lim - 1 })
    this.charge(name, why)
  }
  resetFails(name: string) {
    const b = this.d.db.box(name)
    if (b && b.infraFails) this.d.db.updateBox(name, { infraFails: 0 })
  }

  quarantine(name: string, why: string) {
    const b = this.d.db.box(name)
    if (!b) return
    this.setState(name, 'quarantined', { reason: why })
    if (b.boatId && b.state !== 'stopped') {
      const id = b.boatId
      this.d.track(this.d.boat.stop(id).catch((e) => this.d.log(`box ${name}: stop failed: ${(e as Error).message}`)))
    }
  }

  /** `resources reset boat`: quarantined boxes become usable again (as stopped; reconcile fixes a running one). */
  reset(): number {
    let n = 0
    for (const b of this.boxes()) {
      if (b.state === 'quarantined') {
        this.setState(b.name, 'stopped', { infraFails: 0, reason: null })
        n++
      } else if (b.infraFails) this.d.db.updateBox(b.name, { infraFails: 0 })
    }
    return n
  }

  /** Bring the rows in line with `boat list`; adopt our unknown boxes and rename + adopt v0.1 ones. */
  async reconcile(): Promise<{ adopted: string[]; dropped: string[]; renamed: string[] }> {
    const rep = { adopted: [] as string[], dropped: [] as string[], renamed: [] as string[] }
    // the rows as they were when Boat was asked: a row that changed (or appeared) while `boat list` ran is newer than
    // the list's answer (e.g. a resume finished and a shard started on it) and is left for the next reconcile
    const before = new Map(this.boxes().map((r) => [r.name, `${r.state}@${r.since}`]))
    const list = await this.d.boat.list()
    const now = this.d.now()
    const byName = new Map(list.map((b) => [b.name, b]))
    const byId = new Map(list.map((b) => [b.id, b]))
    for (const row of this.boxes()) {
      if (before.get(row.name) !== `${row.state}@${row.since}`) continue
      const b = (row.boatId ? byId.get(row.boatId) : undefined) ?? byName.get(row.name)
      if (TRANSITIONAL.includes(row.state)) {
        if (now - row.since < TRANSITIONAL_STALE_MS) continue
        if (!b) {
          this.gone(row.name)
          this.d.db.deleteBox(row.name)
          rep.dropped.push(row.name)
          this.d.log(`box ${row.name}: dropped (stuck ${row.state}, not in boat list)`)
        } else this.setState(row.name, isRunning(b) ? 'idle' : 'stopped', { boatId: b.id, reason: `was stuck ${row.state}` })
        continue
      }
      if (!b) {
        this.gone(row.name)
        this.d.db.deleteBox(row.name)
        rep.dropped.push(row.name)
        this.d.log(`box ${row.name}: dropped (gone from boat list)`)
        continue
      }
      if (!row.boatId) this.d.db.updateBox(row.name, { boatId: b.id })
      if (row.state === 'quarantined') {
        if (isRunning(b)) this.d.track(this.d.boat.stop(b.id).catch(() => {}))
        continue
      }
      if (b.state === 'stopped' && row.state !== 'stopped') this.setState(row.name, 'stopped', { reason: row.state === 'busy' ? 'stopped under a running shard' : null })
      else if (isRunning(b) && row.state === 'stopped') this.setState(row.name, 'idle', { lastUsed: now })
    }
    const known = new Set([...this.boxes().map((r) => r.name), ...before.keys()])
    for (const b of list) {
      if (known.has(b.name) || b.state === 'deleted') continue
      const host = this.poolHost
      let pp = host ? parsePoolBoxName(host, b.name) : null
      // a pool box's name is only a claim: its environment must say the same (another sandbox may borrow the name)
      if (pp && b.environment !== pp.env) pp = null
      let p = parseBoxName(this.d.cfg.daemonId, b.name) ?? pp
      let name = b.name
      if (!p) {
        const legacy = parseLegacyName(b.name, (x) => this.d.legacyEnv(x) !== null)
        if (!legacy) continue
        const env = this.d.legacyEnv(legacy.profile)!
        name = boxName(this.d.cfg.daemonId, env, legacy.size, legacy.rand)
        try {
          await this.d.boat.rename(b.id, name)
        } catch (e) {
          this.d.log(`box ${b.name}: rename to ${name} failed: ${(e as Error).message}`)
          continue
        }
        rep.renamed.push(`${b.name} → ${name}`)
        p = { env, size: legacy.size, rand: legacy.rand }
      }
      if (!isRunning(b) && b.state !== 'stopped') continue // Boat is still moving it; next time
      const st: BoxState = isRunning(b) ? 'idle' : 'stopped'
      const since = st === 'stopped' && b.stoppedAt ? b.stoppedAt : now
      // this host's pool box, in that environment: the pool's again (the gate still checks its environment version)
      const pubRepo = p === pp ? `pool:${pp.env}` : null
      this.d.db.insertBox({ name, boatId: b.id, env: p.env, size: p.size, state: st, since, lastRepo: null, lastUsed: now, infraFails: 0, reason: null, createdAt: now, pubRepo })
      this.told(name)
      rep.adopted.push(name)
      this.d.log(`box ${name}: adopted as ${st}`)
    }
    return rep
  }

  /** Stop boxes idle past idleStopSec (keeping the last running one of a size in warm hours); delete long-stopped and
   *  long-quarantined ones. `idle` may give a box its own idle limit and stop reason (test-broker's warm pool stops
   *  the idle boxes past its warm target sooner). */
  async sweep(idle?: (b: BoxRow) => { sec: number; reason: string } | null): Promise<{ stopped: string[]; deleted: string[]; kept: string[] }> {
    const rep = { stopped: [] as string[], deleted: [] as string[], kept: [] as string[] }
    const now = this.d.now()
    const warm = inWarmHours(this.d.cfg.pool.warmHours, now)
    const stops: Promise<void>[] = []
    const limit = (b: BoxRow) => idle?.(b) ?? { sec: this.d.cfg.pool.idleStopSec, reason: 'idle' }
    for (const b of this.boxes().filter((x) => x.state === 'idle' && now - x.lastUsed > limit(x).sec * 1000)) {
      const running = this.boxes().filter((x) => x.env === b.env && x.size === b.size && (x.state === 'idle' || x.state === 'busy'))
      if (warm && running.length === 1) {
        rep.kept.push(b.name)
        continue
      }
      this.setState(b.name, 'stopping', { reason: limit(b).reason })
      rep.stopped.push(b.name)
      stops.push(
        this.d.boat.stop(b.boatId!).then(
          () => this.setState(b.name, 'stopped', { reason: null }),
          (e) => this.setState(b.name, 'idle', { reason: `stop failed: ${(e as Error).message}` }),
        ),
      )
    }
    await Promise.all(stops)
    for (const b of this.boxes().filter((x) => x.state === 'stopped' && now - x.since > this.d.cfg.pool.deleteAfterDays * 86400_000)) {
      this.deleteBox(b, `stopped for ${this.d.cfg.pool.deleteAfterDays} days`)
      rep.deleted.push(b.name)
    }
    for (const b of this.boxes().filter((x) => x.state === 'quarantined' && now - x.since > this.d.cfg.pool.deleteAfterDays * 86400_000)) {
      this.deleteBox(b, `quarantined for ${this.d.cfg.pool.deleteAfterDays} days`)
      rep.deleted.push(b.name)
    }
    return rep
  }
}
