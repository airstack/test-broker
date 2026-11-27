// The one scheduler loop. It decides only from DB state; every decision is a job_events row.
//
// Placement mode per job (re-decided on every pass until its first shard starts, then fixed): local whole (the local
// slot is free, load is low, the profile has a local command, local isn't failing) → sharded (a remote resource can
// place a shard now: an ssh slot, then a Boat box) → github whole (a listed mode of a pushed job that has waited
// afterWaitSec with no shard started) → wait. Fair turns: repos round-robin after the last-served repo, a repo's jobs round-robin,
// a job's shards in plan order, at most one placement per repo per round, rounds until one places nothing.
import { publicBoatEnv, publicBoatEnvs, serves, type ResourceCfg } from '../config.ts'
import type { JobRow, ShardRow } from '../db.ts'
import { localCommand, type Profile } from '../profile.ts'
import type { Ctx } from './ctx.ts'
import type { LocalExecutor } from './exec-local.ts'
import type { Placement } from './resources.ts'
import type { BoxFilter } from '../../core/boatpool.ts'

type Item = { job: JobRow; shard: ShardRow | null }
type Tried = { placed: true } | { placed: false; why: string }

const rotateAfter = <T>(list: T[], key: (x: T) => string, last: string | null): T[] => {
  if (last === null) return list
  const i = list.findIndex((x) => key(x) > last)
  return i < 0 ? list : [...list.slice(i), ...list.slice(0, i)]
}

export class Scheduler {
  /** tests: hold passes while setting up several jobs */
  paused = false
  private scheduled = false
  private current: Promise<void> | null = null
  private c: Ctx
  private local: LocalExecutor
  constructor(c: Ctx, local: LocalExecutor) {
    this.c = c
    this.local = local
  }

  /** Ask for a pass soon. Passes never overlap; a wake during a pass runs another after it. */
  wake() {
    this.scheduled = true
    if (this.current) return
    this.current = new Promise<void>((resolve) => setImmediate(resolve)).then(() => this.loop())
    this.c.track(this.current)
  }

  private async loop() {
    try {
      while (this.scheduled) {
        this.scheduled = false
        await this.pass()
      }
    } catch (e) {
      this.c.log(`scheduler: pass failed: ${(e as Error).stack ?? e}`)
    } finally {
      this.current = null
    }
  }

  /** Resolves when no pass is running or due. */
  async idle() {
    while (this.current) await this.current
  }

  /** One pass: rounds until a round places nothing. Exposed for tests. */
  async pass() {
    if (this.c.draining || this.paused || this.c.recovering) return // recovery wakes the scheduler when done
    while (await this.round()) {}
  }

  private queuedItems(): Map<string, Item[]> {
    const { db, held } = this.c
    const byRepo = new Map<string, JobRow[]>()
    for (const j of db.jobsInStates(['queued', 'running'])) {
      if (held.has(j.id)) continue
      const list = byRepo.get(j.repo) ?? []
      list.push(j)
      byRepo.set(j.repo, list)
    }
    const out = new Map<string, Item[]>()
    for (const [repo, jobs] of byRepo) {
      const ordered = rotateAfter(jobs, (j) => String(j.id).padStart(12, '0'), db.meta(`lastJob:${repo}`)?.padStart(12, '0') ?? null)
      const lanes: Item[][] = ordered.map((job) => {
        const queued = db.shards(job.id).filter((s) => s.state === 'queued')
        if (!queued.length) return []
        // a job whose mode isn't fixed yet is one item: local whole, else its first placeable shard
        return job.placement === null ? [{ job, shard: null }] : queued.map((shard) => ({ job, shard }))
      })
      // jobs round-robin: interleave their lanes
      const items: Item[] = []
      for (let i = 0; lanes.some((l) => i < l.length); i++) for (const l of lanes) if (i < l.length) items.push(l[i])
      if (items.length) out.set(repo, items)
    }
    return out
  }

  private async round(): Promise<boolean> {
    const { db } = this.c
    const byRepo = this.queuedItems()
    const repos = rotateAfter([...byRepo.keys()].sort(), (r) => r, db.meta('lastRepo'))
    let placedAny = false
    const whys = new Map<number, string>()
    for (const repo of repos) {
      for (const it of byRepo.get(repo)!) {
        if (this.c.draining || this.c.recovering) return false
        const r = it.shard ? await this.tryShard(it.job, it.shard) : await this.tryJob(it.job)
        if (r.placed) {
          db.setMeta('lastRepo', repo)
          db.setMeta(`lastJob:${repo}`, String(it.job.id))
          placedAny = true
          whys.delete(it.job.id)
          break
        }
        if (!whys.has(it.job.id)) whys.set(it.job.id, r.why)
      }
    }
    for (const [id, why] of whys) {
      const j = db.job(id)
      if (j && j.waitWhy !== why && (j.state === 'queued' || j.state === 'running')) {
        db.updateJob(id, { waitWhy: why })
        this.c.jobs.event(id, null, 'wait', why)
      }
    }
    return placedAny
  }

  private profile(job: JobRow): Profile | null {
    try {
      return this.c.jobProfile(job)
    } catch {
      return null
    }
  }

  private usable(r: ResourceCfg, profile: string): boolean {
    return serves(r, profile) && !this.c.db.health(r.id, profile).failing
  }

  /** The job's mode isn't fixed: local whole if it can, else sharded if any shard places now. */
  private async tryJob(job: JobRow): Promise<Tried> {
    const profile = this.profile(job)
    if (!profile) return { placed: false, why: `profile ${job.profile} is gone` }
    const local = await this.tryLocalWhole(job, profile)
    if (local.placed) return local
    // the public lane: the local container, else Boat when root gave the repo a public environment; never ssh or
    // GitHub-hosted
    if (job.lane === 'public' && !publicBoatEnv(this.c.cfg.trust, job.repo)) return { placed: false, why: `${local.why}; public lane: local only` }
    const whys = [local.why]
    for (const s of this.c.db.shards(job.id).filter((x) => x.state === 'queued')) {
      const r = await this.tryShard(job, s)
      if (r.placed) return r
      whys.push(r.why)
    }
    // last: GitHub-hosted takes the whole mode (it costs money)
    if (job.lane === 'public') return { placed: false, why: [...new Set(whys)].join('; ') }
    for (const r of this.c.resources) {
      if (r.kind !== 'github' || !serves(r, profile.name)) continue
      const t = this.tryGithubWhole(job, profile, r)
      if (t.placed) return t
      whys.push(t.why)
    }
    return { placed: false, why: [...new Set(whys)].join('; ') }
  }

  /**
   * GitHub-hosted: only for modes it lists, pushed jobs only, when no shard of the job has started and the job has
   * waited afterWaitSec. One dispatch runs the whole mode: the job's shards become one `hosted` shard.
   */
  private tryGithubWhole(job: JobRow, profile: Profile, r: ResourceCfg): Tried {
    const { c } = this
    if (c.db.health(r.id, profile.name).failing) return { placed: false, why: `${r.id}: failing` }
    if (!(r.modes ?? []).includes(job.mode)) return { placed: false, why: `${r.id}: mode ${job.mode} not listed` }
    if (job.source !== 'pushed') return { placed: false, why: `${r.id}: pushed jobs only` }
    const fresh = c.db.job(job.id)
    const shards = c.db.shards(job.id)
    if (!fresh || fresh.placement !== null || fresh.state !== 'queued' || shards.some((s) => s.state !== 'queued' || s.startedAt !== null))
      return { placed: false, why: `${r.id}: a shard of the job has started` }
    const waited = c.now() - job.createdAt
    const after = (r.afterWaitSec ?? 900) * 1000
    if (waited < after) return { placed: false, why: `${r.id}: after ${r.afterWaitSec ?? 900}s of waiting (${Math.floor(waited / 1000)}s so far)` }
    c.db.tx(() => {
      c.db.deleteShards(job.id)
      c.db.insertShard({ jobId: job.id, idx: 0, name: 'hosted', size: '-', args: [], state: 'queued', queuedAt: job.createdAt })
      c.db.updateJob(job.id, { placement: 'github' })
    })
    this.start(job, 0, { resource: r.id, kind: 'github', box: null, slot: 0, how: 'dispatch', where: `github:${r.id}` }, `github whole mode after ${Math.floor(waited / 1000)}s waiting (${shards.length} shard(s) taken over)`)
    return { placed: true }
  }

  /** A github job's shard re-queued (infra retry or restart): dispatch again (each run is a fresh runner). */
  private tryGithubAgain(job: JobRow, shard: ShardRow, profile: Profile): Tried {
    const r = this.c.resources.find((x) => x.kind === 'github' && serves(x, profile.name) && !this.c.db.health(x.id, profile.name).failing && (x.modes ?? []).includes(job.mode))
    if (!r) return { placed: false, why: 'github: no usable github resource for this mode' }
    // the pass read the job before earlier awaits: a dispatch costs money, so look again (like trySsh)
    const fresh = this.c.db.job(job.id)
    if (!fresh || (fresh.state !== 'queued' && fresh.state !== 'running') || this.c.db.shard(job.id, shard.idx)?.state !== 'queued') return { placed: false, why: 'job changed' }
    this.start(job, shard.idx, { resource: r.id, kind: 'github', box: null, slot: 0, how: 'dispatch', where: `github:${r.id}` }, 'github (again)')
    return { placed: true }
  }

  /** ssh: the lowest free slot on a host whose sizes include the shard's (no sizes = any), not avoided. */
  private trySsh(job: JobRow, shard: ShardRow, r: ResourceCfg): Tried {
    const { c } = this
    if (r.sizes?.length && !r.sizes.includes(shard.size)) return { placed: false, why: `${r.id}: no ${shard.size} size` }
    if (shard.avoid.includes(r.id)) return { placed: false, why: `${r.id}: avoided after an infra failure` }
    const fresh = c.db.job(job.id)
    if (!fresh || (fresh.state !== 'queued' && fresh.state !== 'running') || c.db.shard(job.id, shard.idx)?.state !== 'queued') return { placed: false, why: 'job changed' }
    const taken = new Set(c.db.slots().filter((s) => s.resource === r.id).map((s) => s.slot))
    for (let slot = 0; slot < (r.slots ?? 1); slot++) {
      if (taken.has(slot)) continue
      if (!c.db.takeSlot({ resource: r.id, slot, jobId: job.id, idx: shard.idx, since: c.now() })) continue
      this.start(job, shard.idx, { resource: r.id, kind: 'ssh', box: null, slot, how: 'slot', where: `ssh:${r.id}/${slot}` }, `ssh ${r.host} slot ${slot}${shard.attempt > 1 ? ` (avoiding ${shard.avoid.join(', ')})` : ''}`)
      return { placed: true }
    }
    return { placed: false, why: `${r.id}: all ${r.slots ?? 1} slot(s) busy` }
  }

  private localResource(profile: string): ResourceCfg | null {
    return this.c.resources.find((r) => r.kind === 'local' && serves(r, profile)) ?? null
  }

  /** Take the local slot (DB row + the flock). null = taken. */
  private async takeLocal(r: ResourceCfg, job: JobRow, idx: number): Promise<{ release(): Promise<void> } | null> {
    if (this.c.db.slots().some((s) => s.resource === r.id)) return null
    const lock = await this.c.localLock()
    if (!lock) return null
    if (!this.c.db.takeSlot({ resource: r.id, slot: 0, jobId: job.id, idx, since: this.c.now() })) {
      await lock.release()
      return null
    }
    return lock
  }

  private async tryLocalWhole(job: JobRow, profile: Profile): Promise<Tried> {
    const { c } = this
    const r = this.localResource(profile.name)
    if (!r) return { placed: false, why: 'local: not set up for this profile' }
    if (localCommand(profile, job.mode, job.args) === null) return { placed: false, why: `local: no local command for ${job.mode}` }
    if (c.db.health(r.id, profile.name).failing) return { placed: false, why: 'local: failing' }
    const { load1, nproc } = c.load()
    if (load1 >= c.cfg.localMaxLoadFactor * nproc) return { placed: false, why: `local: load ${load1.toFixed(1)} ≥ ${c.cfg.localMaxLoadFactor} × ${nproc} cpus` }
    const lock = await this.takeLocal(r, job, 0)
    if (!lock) return { placed: false, why: 'local: slot busy' }
    const fresh = c.db.job(job.id)
    if (!fresh || fresh.state !== job.state || fresh.placement !== null) {
      c.db.freeSlot(r.id, 0)
      await lock.release()
      return { placed: false, why: 'job changed' }
    }
    const where = `local-${profile.local!.where}`
    c.db.tx(() => {
      c.db.deleteShards(job.id)
      c.db.insertShard({ jobId: job.id, idx: 0, name: 'local', size: '-', args: [], state: 'queued', queuedAt: job.createdAt })
      c.db.updateJob(job.id, { placement: 'local' })
    })
    this.local.locks.set(`${job.id}:0`, lock)
    this.start(job, 0, { resource: r.id, kind: 'local', box: null, slot: 0, how: 'local', where }, `local whole (load ${load1.toFixed(1)} / ${nproc} cpus)`)
    return { placed: true }
  }

  private async tryShard(job: JobRow, shard: ShardRow): Promise<Tried> {
    const profile = this.profile(job)
    if (!profile) return { placed: false, why: `profile ${job.profile} is gone` }
    if (job.placement === 'local') return this.tryLocalAgain(job, shard, profile)
    const pub = job.lane === 'public'
    if (pub && !publicBoatEnv(this.c.cfg.trust, job.repo)) return { placed: false, why: 'public lane: local only' }
    if (job.placement === 'github') return this.tryGithubAgain(job, shard, profile)
    const whys: string[] = []
    // fixed order: ssh, boat (github takes whole jobs only: tryJob)
    for (const r of this.c.resources) {
      if (r.kind === 'local' || r.kind === 'github' || !serves(r, profile.name)) continue
      if (pub && r.kind !== 'boat') continue
      if (!this.usable(r, profile.name)) {
        whys.push(`${r.id}: failing`)
        continue
      }
      const t = r.kind === 'ssh' ? this.trySsh(job, shard, r) : await this.tryBoat(job, shard, profile, r)
      if (t.placed) return t
      whys.push(t.why)
    }
    return { placed: false, why: whys.length ? whys.join('; ') : 'no remote resource set up for this profile' }
  }

  /** A local job's shard re-queued (infra retry or restart): it waits for the local slot again. */
  private async tryLocalAgain(job: JobRow, shard: ShardRow, profile: Profile): Promise<Tried> {
    const r = this.localResource(profile.name)
    if (!r) return { placed: false, why: 'local: not set up for this profile' }
    const lock = await this.takeLocal(r, job, shard.idx)
    if (!lock) return { placed: false, why: 'local: slot busy' }
    if (this.c.db.shard(job.id, shard.idx)?.state !== 'queued') {
      this.c.db.freeSlot(r.id, 0)
      await lock.release()
      return { placed: false, why: 'shard changed' }
    }
    this.local.locks.set(`${job.id}:${shard.idx}`, lock)
    this.start(job, shard.idx, { resource: r.id, kind: 'local', box: null, slot: 0, how: 'local', where: `local-${profile.local?.where ?? 'host'}` }, 'local (again)')
    return { placed: true }
  }

  private async tryBoat(job: JobRow, shard: ShardRow, profile: Profile, r: ResourceCfg): Promise<Tried> {
    const pool = this.c.pool
    if (!pool || pool.id !== r.id) return { placed: false, why: `${r.id}: no pool` }
    const trust = this.c.cfg.trust
    let env: string | null | undefined
    let only: BoxFilter | undefined
    if (job.lane === 'public') {
      // root's environment for the repo, never the profile's: the operator's files can't send public code elsewhere
      env = publicBoatEnv(trust, job.repo)
      if (!env) return { placed: false, why: 'public lane: local only' }
      const g = await pool.publicGate(env, job.repo, { envs: publicBoatEnvs(trust), max: trust.publicBoatMaxBoxes })
      if ('none' in g) return { placed: false, why: g.none }
      only = g
    } else {
      env = r.environment ?? profile.boatEnvironment
      if (!env) return { placed: false, why: `${r.id}: no Boat environment for ${profile.name}` }
      if (publicBoatEnvs(trust).has(env)) return { placed: false, why: `${r.id}: ${env} is a public-lane environment (trust.repos.*.publicBoat): never a full-lane job` }
    }
    const got = await pool.place({ env, size: shard.size, repo: job.repo, avoid: shard.avoid, ...(only ? { only } : {}) })
    if ('none' in got) return { placed: false, why: got.none }
    const fresh = this.c.db.job(job.id)
    const s = this.c.db.shard(job.id, shard.idx)
    if (!fresh || (fresh.state !== 'queued' && fresh.state !== 'running') || s?.state !== 'queued') {
      this.unplace(got.box, got.how)
      return { placed: false, why: 'job changed' }
    }
    this.start(job, shard.idx, { resource: r.id, kind: 'boat', box: got.box, slot: 0, how: got.how, where: `boat:${got.box} (${got.how})` }, `boat ${got.how} ${got.box}${shard.attempt > 1 ? ` (avoiding ${shard.avoid.join(', ')})` : ''}`)
    return { placed: true }
  }

  /** Hand back a box picked for a shard that went away during the pick. */
  private unplace(box: string, how: string) {
    const pool = this.c.pool!
    if (how === 'reused') pool.setState(box, 'idle')
    else if (how === 'resumed') pool.setState(box, 'stopped')
    else this.c.db.deleteBox(box)
  }

  private start(job: JobRow, idx: number, p: Placement, reason: string) {
    const { c } = this
    const now = c.now()
    const shard = c.db.shard(job.id, idx)!
    c.db.updateShard(job.id, idx, { state: 'running', resource: p.resource, box: p.box, slot: p.slot, where: p.where, startedAt: now })
    const fresh = c.db.job(job.id)!
    if (fresh.state === 'queued') c.db.updateJob(job.id, { state: 'running', startedAt: now, ...(fresh.placement ? {} : { placement: 'sharded' as const }) })
    else if (!fresh.placement) c.db.updateJob(job.id, { placement: 'sharded' })
    if (fresh.waitWhy) c.db.updateJob(job.id, { waitWhy: null })
    c.jobs.event(job.id, shard.name, 'place', `${p.where}: ${reason}${shard.attempt > 1 ? ` [attempt ${shard.attempt}]` : ''}`)
    c.streams.append(job.id, { t: 'state', state: 'running', shard: shard.name, message: p.where })
    c.shards.start(job.id, idx, p)
  }
}
