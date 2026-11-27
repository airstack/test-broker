// Jobs: submit (dedupe → reuse/join/new), snapshot bundles, interests + pins, cancel, the end of a shard (infra retry
// and attribution), the end of a job (receipt), timeouts and retention.
import { randomBytes } from 'node:crypto'
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Readable } from 'node:stream'
import { publicBoatEnv } from '../config.ts'
import { isTerminal, ACTIVE_JOB_STATES, type Door, type EnvClass, type JobRow, type JobState, type Lane, type ShardRow, type FirstInfra } from '../db.ts'
import { jobKey, NAME_RE, ProfileError, profileHash, shardsFor, type Profile } from '../profile.ts'
import { summarize, type ShardResult } from '../../core/summary.ts'
import type { Ctx } from './ctx.ts'
import type { AbortWhy, Outcome, Placement } from './resources.ts'
import { reusedDescription, type StatusDecision } from './statuses.ts'

export class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export type SubmitReq = {
  repo: string
  profile?: string
  mode: string
  args?: string[]
  commit: string
  tree?: string | null
  headCandidates?: string[]
  /** "local" | "github" (who submitted; for the log) */
  source?: string
  label?: string
  detach?: boolean
  /** the client wants a commit status (not `--no-status`); the daemon adds the pushed/args/profile rules */
  wantStatus?: boolean
  force?: boolean
  /** set by the admission, never by the client: the lane, the env class, the door and the GitHub run */
  lane?: Lane
  env?: EnvClass
  door?: Door
  ghRun?: string | null
  /** admission's note (an offline fallback), logged as a job event */
  note?: string | null
}

export type SubmitRes = { id: string; num: number; key: string; reused?: true; joined?: true; needBundle?: true; base?: string | null; interest?: string; status: StatusDecision; lane?: Lane; note?: string }

const LOG_TAIL = 2 * 1024 * 1024

function readTail(file: string, max = LOG_TAIL): string {
  try {
    return readTailOrThrow(file, max)
  } catch (e) {
    return `(the log could not be read: ${(e as Error).message})\n`
  }
}
function readTailOrThrow(file: string, max: number): string {
  if (!existsSync(file)) return ''
  const size = statSync(file).size
  if (size <= max) return readFileSync(file, 'utf8')
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(max)
    readSync(fd, buf, 0, max, size - max)
    return buf.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

export const EXIT_CODES: Record<string, number> = { passed: 0, failed: 1, error: 2, cancelled: 130 }

export class Jobs {
  /** live streams per interest token */
  private connected = new Map<string, number>()
  /** jobs whose end-of-job statuses are being posted (their `done` follows) */
  private posting = new Set<number>()
  private c: Ctx
  constructor(c: Ctx) {
    this.c = c
  }

  /** One line in job_events (shown by `show`) and the daemon log. */
  event(jobId: number | null, shard: string | null, kind: string, message: string) {
    message = this.c.scrub(message)
    this.c.db.addEvent({ t: this.c.now(), jobId, shard, kind, message })
    this.c.log(`${jobId === null ? '-' : this.c.jobName(jobId)}${shard ? `/${shard}` : ''} ${kind}: ${message}`)
  }

  private stateEvent(jobId: number, state: string, shard?: string, message?: string) {
    this.c.streams.append(jobId, { t: 'state', state, ...(shard ? { shard } : {}), ...(message ? { message: this.c.scrub(message) } : {}) })
  }

  parseId(s: string): number {
    const m = /^(?:([a-z0-9]+)-)?(\d+)$/.exec(s)
    if (!m || (m[1] && m[1] !== this.c.cfg.daemonId)) throw new HttpError(404, `no job ${s}`)
    return Number(m[2])
  }
  get(id: number): JobRow {
    const j = this.c.db.job(id)
    if (!j) throw new HttpError(404, `no job ${this.c.jobName(id)}`)
    return j
  }

  private profile(name: string): Profile {
    try {
      return this.c.profile(name)
    } catch (e) {
      throw new HttpError(400, e instanceof ProfileError ? e.message : `no profile '${name}' in ${this.c.cfg.profilesDir}`)
    }
  }

  private async refreshMirror(repo: string) {
    try {
      await this.c.mirror.ensure(repo)
    } catch (e) {
      this.c.log(`mirror ${repo}: fetch failed, using what it has: ${(e as Error).message}`)
    }
  }

  // ---------------------------------------------------------------- submit

  async submit(r: SubmitReq): Promise<SubmitRes> {
    const { c } = this
    if (!/^[\w.-]+\/[\w.-]+$/.test(r.repo ?? '') || r.repo.split('/').some((x) => x === '.' || x === '..')) throw new HttpError(400, `repo must be owner/name, got '${String(r.repo).slice(0, 80)}'`)
    if (!/^[0-9a-f]{40}$/.test(r.commit ?? '')) throw new HttpError(400, 'commit must be a full sha')
    if (typeof r.mode !== 'string' || !NAME_RE.test(r.mode)) throw new HttpError(400, 'bad mode name')
    if (c.switchDrain) throw new HttpError(503, 'draining for switch: the daemon takes no new jobs while it hands over to the split layout')
    if (c.awaitSeed) throw new HttpError(503, 'draining for switch: the new daemon waits for its job id seed (ci-broker switch-to-split does it; on a new machine: ci-broker admin-seed 1)')
    if (c.draining) throw new HttpError(503, 'the daemon is draining; submit again once it has restarted')
    const args = r.args ?? []
    if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) throw new HttpError(400, 'args must be an array of strings')
    const profile = this.profile(r.profile ?? r.repo.split('/')[1])
    if (profile.repo.toLowerCase() !== r.repo.toLowerCase()) throw new HttpError(400, `profile ${profile.name} is for ${profile.repo}, not ${r.repo}`)
    const lane: Lane = r.lane ?? 'full'
    const env: EnvClass = r.env ?? (lane === 'full' && Object.keys(profile.local?.env ?? {}).length ? 'env' : 'noenv')
    const door: Door = r.door ?? 'local'
    let plan
    try {
      plan = shardsFor(profile, r.mode, args)
    } catch (e) {
      throw new HttpError(400, (e as Error).message)
    }
    const hash = profileHash(profile)
    let tree = r.tree ?? null
    let fetched = false
    if (r.source === 'github') {
      // a GitHub job's source is always a pushed sha: never quietly a snapshot of the runner's checkout
      await this.refreshMirror(r.repo)
      fetched = true
      if (!(await c.mirror.hasOrFetch(r.repo, r.commit)))
        throw new HttpError(400, `${r.commit.slice(0, 12)} is not on origin: --github runs pushed commits only (push it, or submit without --github for a snapshot)`)
    }
    if (!tree) {
      await this.refreshMirror(r.repo)
      fetched = true
      if (!(await c.mirror.hasOrFetch(r.repo, r.commit))) throw new HttpError(400, `${r.commit.slice(0, 12)} is not on origin and no tree was given`)
      tree = await c.mirror.treeOf(r.repo, r.commit)
    } else {
      // the tree is in the job key: for a pushed commit it must be that commit's (a snapshot's is checked when its
      // bundle arrives), never just the client's word
      if (!/^[0-9a-f]{40}$/.test(tree)) throw new HttpError(400, 'tree must be a full sha')
      if (!fetched) await this.refreshMirror(r.repo)
      fetched = true
      if (await c.mirror.hasOrFetch(r.repo, r.commit)) {
        const real = await c.mirror.treeOf(r.repo, r.commit)
        if (real !== tree) throw new HttpError(400, `the claimed tree ${tree.slice(0, 12)} is not the tree of ${r.commit.slice(0, 12)} (${real.slice(0, 12)})`)
      }
    }
    const key = jobKey({ repo: r.repo, profile: profile.name, profileHash: hash, mode: r.mode, tree, args, lane, env })
    if (!r.force) {
      // a GitHub-door request never reuses or joins a snapshot job (its tree came from a local client)
      const done = c.db.passedJobWithKey(key, c.now() - c.cfg.retentionDays * 86400_000, door === 'github')
      if (done) {
        this.event(done.id, null, 'reused', `same key submitted again (${r.source ?? 'local'}${r.label ? `, ${r.label}` : ''})`)
        const status = await this.reuseStatus(done, r, profile, args)
        return { id: c.jobName(done.id), num: done.id, key, reused: true, status, lane }
      }
    }
    const join = () => {
      const j = c.db.joinableJobWithKey(key, door === 'github')
      return j ? this.join(j, r, profile, args) : null
    }
    const early = await join()
    if (early) return early
    if (!fetched) await this.refreshMirror(r.repo)
    const pushed = await c.mirror.hasOrFetch(r.repo, r.commit)
    const base = pushed ? null : await c.mirror.firstPresent(r.repo, r.headCandidates ?? [])
    const late = c.db.joinableJobWithKey(key, door === 'github') // the awaits above let another submit in
    if (late) return this.join(late, r, profile, args)
    const now = c.now()
    const id = c.db.tx(() => {
      const id = c.db.insertJob({
        key, repo: r.repo, profile: profile.name, profileHash: hash, mode: r.mode, args, commit: r.commit, tree, source: pushed ? 'pushed' : 'snapshot',
        base, label: r.label ?? null, state: pushed ? 'queued' : 'waiting-bundle', pinned: !!r.detach, createdAt: now, lane, env, door, ghRun: r.ghRun ?? null, profileDir: profile.dir,
      })
      plan.forEach((s, idx) => c.db.insertShard({ jobId: id, idx, name: s.name, size: s.size, args: s.args, state: 'queued', queuedAt: now }))
      return id
    })
    const status = this.addStatusTarget(id, r, profile, args, pushed)
    const interest = r.detach ? undefined : this.openInterest(id)
    this.event(id, null, 'submit', `${r.repo} ${r.commit.slice(0, 12)} ${profile.name}/${r.mode}${args.length ? ` -- ${args.join(' ')}` : ''} (${pushed ? 'pushed' : `snapshot, base ${base?.slice(0, 12) ?? 'none'}`}; ${r.source ?? 'local'}${r.label ? `, ${r.label}` : ''}${r.detach ? ', detached' : ''})`)
    if (lane === 'public') this.event(id, null, 'trust', `public lane: the local container${publicBoatEnv(this.c.cfg.trust, r.repo) ? ` or Boat (${publicBoatEnv(this.c.cfg.trust, r.repo)})` : ' only'}${Object.keys(profile.local?.env ?? {}).length ? `; local.env not passed (${Object.keys(profile.local!.env!).length} names)` : ''}`)
    if (r.note) this.event(id, null, 'trust', r.note)
    this.stateEvent(id, pushed ? 'queued' : 'waiting-bundle')
    if (pushed) c.scheduler.wake()
    return { id: c.jobName(id), num: id, key, ...(pushed ? {} : { needBundle: true as const, base }), ...(interest ? { interest } : {}), status, lane, ...(r.note ? { note: r.note } : {}) }
  }

  private async join(j: JobRow, r: SubmitReq, profile: Profile, args: string[]): Promise<SubmitRes> {
    // the submitted commit may differ from the job's (same tree): it is pushed if origin has it
    const pushed = this.statusWhyNot(r, profile, args) === null && (j.commit === r.commit ? j.source === 'pushed' : await this.c.mirror.hasOrFetch(r.repo, r.commit))
    const live = this.c.db.job(j.id)
    if (!live || live.state === 'cancelling' || isTerminal(live.state)) return this.submit(r) // it ended while we looked
    if (r.detach && !j.pinned) this.c.db.updateJob(j.id, { pinned: true })
    const status = this.addStatusTarget(j.id, r, profile, args, pushed)
    const interest = r.detach ? undefined : this.openInterest(j.id)
    this.event(j.id, null, 'joined', `same key submitted (${r.source ?? 'local'}${r.label ? `, ${r.label}` : ''}${r.detach ? ', detached' : ''})`)
    return { id: this.c.jobName(j.id), num: j.id, key: j.key, joined: true, ...(interest ? { interest } : {}), status, lane: j.lane }
  }

  /** The rules a submission must meet to ask for a status, apart from being a pushed commit. */
  private statusWhyNot(r: SubmitReq, profile: Profile, args: string[]): 'no-status' | 'args' | 'disabled' | null {
    if (!r.wantStatus) return 'no-status'
    if (args.length) return 'args' // a filtered run must not sign off the mode
    if (profile.status === false) return 'disabled'
    return null
  }

  /** A submission asks for a status only for a pushed commit, an unfiltered run and a profile that allows it. */
  private addStatusTarget(jobId: number, r: SubmitReq, profile: Profile, args: string[], pushed: boolean): StatusDecision {
    const why = this.statusWhyNot(r, profile, args) ?? (pushed ? null : 'snapshot')
    if (why) return { asked: false, why }
    this.c.db.addStatusTarget(jobId, r.commit, `ci-broker/${r.mode}`)
    return { asked: true }
  }

  /** A reused pass: post this submission's status at once (unless that commit already shows this job's success). */
  private async reuseStatus(done: JobRow, r: SubmitReq, profile: Profile, args: string[]): Promise<StatusDecision> {
    const { c } = this
    const why = this.statusWhyNot(r, profile, args)
    if (why) return { asked: false, why }
    const pushed = done.commit === r.commit && done.source === 'pushed' ? true : await c.mirror.hasOrFetch(r.repo, r.commit)
    if (!pushed) return { asked: false, why: 'snapshot' }
    const context = `ci-broker/${r.mode}`
    const had = c.db.statusTargets(done.id).find((t) => t.sha === r.commit && t.context === context)
    if (had?.state === 'success' && had.postedAt !== null) return { asked: true }
    c.db.addStatusTarget(done.id, r.commit, context)
    await c.statuses.postTarget(done.id, r.repo, r.commit, context, 'success', reusedDescription(c.jobName(done.id)))
    return { asked: true }
  }

  /** Snapshot bundle upload: store, fetch into the mirror as refs/cib/snap/<job>, queue. */
  async receiveBundle(id: number, body: Readable): Promise<void> {
    const { c } = this
    const job = this.get(id)
    if (job.state !== 'waiting-bundle') throw new HttpError(409, `job ${c.jobName(id)} is ${job.state}, not waiting for a bundle`)
    const dir = c.streams.dir(id)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'snapshot.bundle')
    await pipeline(body, createWriteStream(file + '.part'))
    renameSync(file + '.part', file)
    let sha: string
    try {
      sha = await c.mirror.fetchBundle(job.repo, file, id)
      if (sha !== job.commit) throw new Error(`bundle holds ${sha.slice(0, 12)}, expected ${job.commit.slice(0, 12)}`)
      // the tree is in the job key: it must be the bundle's, never just the client's word
      const tree = await c.mirror.treeOf(job.repo, sha)
      if (tree !== job.tree) throw new Error(`bundle tree ${tree.slice(0, 12)} is not the claimed tree ${job.tree.slice(0, 12)}`)
    } catch (e) {
      this.fail(id, `bad bundle: ${(e as Error).message}`)
      throw new HttpError(400, c.scrub(`bad bundle: ${(e as Error).message}`))
    }
    if (c.db.job(id)?.state !== 'waiting-bundle') return // cancelled meanwhile
    c.db.updateJob(id, { state: 'queued' })
    // the client attaches its stream after the upload: its grace starts now
    for (const i of c.db.interests(id)) if (!i.withdrawn && i.disconnectedSince !== null) c.db.setInterest(i.token, { disconnectedSince: c.now() })
    this.event(id, null, 'bundle', `snapshot received (${statSync(file).size} bytes)`)
    this.stateEvent(id, 'queued')
    c.scheduler.wake()
  }

  // ---------------------------------------------------------------- interests

  openInterest(jobId: number): string {
    const token = randomBytes(12).toString('hex')
    this.c.db.insertInterest(token, jobId, this.c.now())
    return token
  }

  /** A stream with this interest is attached. Returns false for an unknown or withdrawn token. */
  connect(token: string): boolean {
    const i = this.c.db.interest(token)
    if (!i || i.withdrawn) return false
    this.connected.set(token, (this.connected.get(token) ?? 0) + 1)
    this.c.db.setInterest(token, { disconnectedSince: null })
    if (this.c.held.delete(i.jobId)) this.c.scheduler.wake()
    return true
  }

  /** A stream closed without `done`: the interest lapses after interestGraceSec unless it reconnects. */
  disconnect(token: string) {
    const n = (this.connected.get(token) ?? 1) - 1
    if (n > 0) return void this.connected.set(token, n)
    this.connected.delete(token)
    const i = this.c.db.interest(token)
    if (i && !i.withdrawn) this.c.db.setInterest(token, { disconnectedSince: this.c.now() })
  }

  withdraw(token: string) {
    const i = this.c.db.interest(token)
    if (!i) throw new HttpError(404, 'no such interest')
    this.connected.delete(token)
    this.c.db.setInterest(token, { withdrawn: true })
    this.checkInterest(i.jobId)
  }

  /** The last interest gone and no pin → cancel. */
  private checkInterest(jobId: number) {
    const job = this.c.db.job(jobId)
    if (!job || job.pinned || job.state === 'cancelling' || isTerminal(job.state)) return
    const graceMs = this.c.cfg.interestGraceSec * 1000
    const live = this.c.db.interests(jobId).filter((i) => !i.withdrawn && ((this.connected.get(i.token) ?? 0) > 0 || (i.disconnectedSince !== null && this.c.now() - i.disconnectedSince < graceMs)))
    if (!live.length) this.cancel(jobId, 'nobody is waiting for it any more')
  }

  /** Lapse interests whose stream has been gone longer than the grace; release boot holds after the grace. */
  sweepInterests() {
    const { c } = this
    const graceMs = c.cfg.interestGraceSec * 1000
    // (a job waiting for its bundle has its own timeout: an upload can outlast the grace)
    for (const job of c.db.jobsInStates(['queued', 'running'])) {
      for (const i of c.db.interests(job.id)) {
        if (i.withdrawn || (this.connected.get(i.token) ?? 0) > 0) continue
        if (i.disconnectedSince !== null && c.now() - i.disconnectedSince >= graceMs) c.db.setInterest(i.token, { withdrawn: true })
      }
      this.checkInterest(job.id)
    }
    if (c.held.size && c.now() - c.bootAt >= graceMs) {
      c.held.clear()
      c.scheduler.wake()
    }
  }

  pin(jobId: number) {
    this.c.db.updateJob(jobId, { pinned: true })
    this.c.held.delete(jobId)
  }

  // ---------------------------------------------------------------- cancel / fail

  cancel(jobId: number, why: string) {
    const { c } = this
    why = c.scrub(why)
    const job = this.get(jobId)
    if (job.state === 'cancelling' || isTerminal(job.state)) return
    c.db.updateJob(jobId, { state: 'cancelling' })
    this.event(jobId, null, 'cancel', why)
    this.stateEvent(jobId, 'cancelling', undefined, why)
    for (const s of c.db.shards(jobId)) if (s.state === 'queued') c.db.updateShard(jobId, s.idx, { state: 'cancelled', reason: why, endedAt: c.now() })
    c.shards.abort(jobId, 'cancel')
    this.maybeFinish(jobId)
  }

  /** No result can be produced: queued shards → error, the job ends `error` once nothing runs. */
  fail(jobId: number, why: string) {
    const { c } = this
    why = c.scrub(why) // often a tail of git/boat/ssh/gh stderr
    const job = c.db.job(jobId)
    if (!job || isTerminal(job.state)) return
    c.db.updateJob(jobId, { error: why })
    this.event(jobId, null, 'error', why)
    for (const s of c.db.shards(jobId)) if (s.state === 'queued') c.db.updateShard(jobId, s.idx, { state: 'error', reason: why, endedAt: c.now() })
    c.shards.abort(jobId, 'cancel')
    this.maybeFinish(jobId)
  }

  // ---------------------------------------------------------------- the end of a shard

  private releasePlacement(job: JobRow, p: Placement) {
    if (p.kind === 'boat' && p.box) this.c.pool?.release(p.box, job.repo)
    if (p.kind === 'local' || p.kind === 'ssh') this.c.db.freeSlot(p.resource, p.slot)
  }

  /** Charge one infra failure to a box (Boat) or (resource, profile) health. */
  private charge(job: JobRow, resource: string, box: string | null, why: string) {
    if (box) return this.c.pool?.charge(box, why)
    const h = this.c.db.health(resource, job.profile)
    const n = h.infraFails + 1
    const failing = n >= this.c.cfg.infraFailLimit
    this.c.db.setHealth(resource, job.profile, { infraFails: n, ...(failing ? { failing: true, reason: `${n} infra failures; last: ${why}` } : {}) })
    this.c.log(`health ${resource}/${job.profile}: infra failure ${n}/${this.c.cfg.infraFailLimit}${failing ? ' → failing' : ''} (${why})`)
  }
  private clearFails(job: JobRow, resource: string, box: string | null) {
    if (box) return this.c.pool?.resetFails(box)
    if (this.c.db.health(resource, job.profile).infraFails) this.c.db.setHealth(resource, job.profile, { infraFails: 0 })
  }

  shardEnded(jobId: number, idx: number, p: Placement, out: Outcome, why: AbortWhy | null) {
    const { c } = this
    // a reason is often a tail of boat/ssh/gh stderr: it goes to the shard row, events, the stream and box rows
    if (out.reason) out = { ...out, reason: c.scrub(out.reason) }
    const job = c.db.job(jobId)!
    const shard = c.db.shard(jobId, idx)!
    const now = c.now()
    this.releasePlacement(job, p)
    const end = (state: ShardRow['state'], code: number | null, reason: string | null) => {
      c.db.updateShard(jobId, idx, { state, code, reason, endedAt: now })
      this.event(jobId, shard.name, state, `${code === null ? 'no exit status' : `exit ${code}`}${reason ? ` (${reason})` : ''} on ${p.where}`)
      this.stateEvent(jobId, state, shard.name, reason ?? undefined)
    }
    const requeue = (patch: Partial<ShardRow>, message: string) => {
      c.db.updateShard(jobId, idx, { state: 'queued', queuedAt: now, startedAt: null, resource: null, box: null, slot: null, where: null, ...patch })
      this.event(jobId, shard.name, 'requeue', message)
      this.stateEvent(jobId, 'queued', shard.name, message)
    }

    if (why === 'timeout') end('failed', null, `timeout after ${c.cfg.shardTimeoutSec}s`)
    else if (why === 'cancel' || job.state === 'cancelling' || isTerminal(job.state)) end(job.error ? 'error' : 'cancelled', null, job.error ?? 'cancelled')
    else if (out.notStarted) {
      if (p.box && p.how === 'resumed') c.pool?.charge(p.box, out.reason ?? 'resume failed')
      // the queue clock keeps running: a shard whose box never starts must still reach queueTimeoutSec
      requeue({ queuedAt: shard.queuedAt }, out.reason ?? 'the resource did not start')
    } else {
      const infraCodes = loadProfileSafe(job, c)?.infraExitCodes ?? []
      const kind: FirstInfra['kind'] | null = out.infra ?? (out.code === null ? 'nostatus' : infraCodes.includes(out.code) ? 'exit' : null)
      const where = p.box ?? p.resource
      const atOnce = kind === 'unreachable' || out.code === 96
      const what = kind === 'exit' ? `infra exit ${out.code}` : kind ?? ''
      if (kind && atOnce) this.charge(job, p.resource, p.box, `${what}${out.reason ? `: ${out.reason}` : ''}`)
      const fi = shard.firstInfra
      if (shard.attempt === 1) {
        if (kind) {
          requeue(
            { attempt: 2, avoid: [...shard.avoid, where], firstInfra: { resource: p.resource, box: p.box, code: out.code, kind, charged: atOnce } },
            `${what} on ${p.where}${out.reason ? ` (${out.reason})` : ''}: retrying once elsewhere`,
          )
        } else {
          this.clearFails(job, p.resource, p.box)
          end(out.code === 0 ? 'passed' : 'failed', out.code, null)
        }
      } else if (!kind) {
        // attempt 2 got past that phase elsewhere: the first resource is to blame
        if (fi && !fi.charged) this.charge(job, fi.resource, fi.box, `retry passed the ${fi.kind === 'exit' ? `exit ${fi.code}` : fi.kind} phase elsewhere`)
        this.clearFails(job, p.resource, p.box)
        end(out.code === 0 ? 'passed' : 'failed', out.code, null)
      } else if (kind === 'exit' && fi?.kind === 'exit' && fi.code === out.code) {
        // the same failure on two resources: the commit is at fault, nobody is charged
        end('failed', out.code, `infra exit ${out.code} on two resources: the commit, not the resource`)
      } else {
        if (fi && !fi.charged && !(fi.kind === kind && kind !== 'exit')) this.charge(job, fi.resource, fi.box, `retry failed differently (${what})`)
        end('error', out.code, `second infra failure: ${what}${out.reason ? ` (${out.reason})` : ''}`)
      }
    }
    this.maybeFinish(jobId)
    c.scheduler.wake()
    if (c.draining && c.shards.count() === 0) c.onDrained()
  }

  // ---------------------------------------------------------------- the end of a job

  maybeFinish(jobId: number) {
    const { c } = this
    const job = c.db.job(jobId)
    if (!job || isTerminal(job.state)) return
    const shards = c.db.shards(jobId)
    if (shards.some((s) => s.state === 'queued' || s.state === 'running' || c.shards.isRunning(jobId, s.idx))) return
    if (job.state === 'waiting-bundle' && !job.error) return
    let state: JobState
    if (job.state === 'cancelling' && !job.error) state = 'cancelled'
    else if (job.error) state = 'error'
    else if (shards.some((s) => s.state === 'failed')) state = 'failed'
    else if (shards.some((s) => s.state === 'error' || s.state === 'cancelled') || !shards.length) state = 'error'
    else state = 'passed'
    const dir = c.streams.dir(jobId)
    const results: ShardResult[] = shards.map((s) => ({
      name: s.name, size: s.size, where: s.where ?? '-', code: s.state === 'passed' || s.state === 'failed' ? s.code : null,
      secs: s.startedAt && s.endedAt ? Math.round((s.endedAt - s.startedAt) / 1000) : 0, log: readTail(join(dir, `${s.name}.log`)),
      ...(s.reason ? { reason: s.reason } : {}),
    }))
    const sum = summarize(results)
    const now = c.now()
    const summary = { state, text: sum.text + (job.error ? `\n  error: ${job.error}` : ''), markdown: sum.markdown, json: sum.json, secs: Math.round((now - job.createdAt) / 1000) }
    c.db.updateJob(jobId, { state, endedAt: now, summary })
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'summary.json'), JSON.stringify({ ...sum.json, id: c.jobName(jobId), state, repo: job.repo, commit: job.commit, mode: job.mode, args: job.args, secs: summary.secs }, null, 2))
    } catch (e) {
      c.log(`job ${c.jobName(jobId)}: writing summary.json failed: ${(e as Error).message}`)
    }
    this.event(jobId, null, state, `${shards.filter((s) => s.state === 'passed').length}/${shards.length} shards passed in ${summary.secs}s`)
    c.held.delete(jobId)
    this.postThenDone(jobId)
  }

  /** Statuses go out before `done`, so the receipt a client prints on `done` can say whether they were posted. */
  postThenDone(jobId: number, atBoot = false) {
    const { c } = this
    const done = () => {
      const job = c.db.job(jobId)
      if (!job?.summary || (atBoot && c.streams.lastEvent(jobId)?.t === 'done')) return
      c.streams.append(jobId, { t: 'done', summary: { ...job.summary, id: c.jobName(jobId) } })
    }
    if (!c.statuses.pending(jobId)) return done()
    if (this.posting.has(jobId)) return // its done follows the posts in flight
    this.posting.add(jobId)
    c.track(
      c.statuses
        .postJobEnd(jobId)
        .catch((e) => c.log(`job ${c.jobName(jobId)}: posting statuses failed: ${(e as Error).message}`))
        .finally(() => {
          this.posting.delete(jobId)
          done()
        }),
    )
  }

  /**
   * A terminal job's stream ends with `done` (a crash between the state update and the append leaves it without one,
   * and a reconnecting client would wait forever). At boot for every terminal job, and when one is followed.
   */
  ensureDone(jobId: number) {
    const job = this.c.db.job(jobId)
    if (!job || !isTerminal(job.state) || !job.summary) return
    if (this.posting.has(jobId)) return
    if (this.c.streams.lastEvent(jobId)?.t !== 'done') this.postThenDone(jobId, true)
  }

  // ---------------------------------------------------------------- timers

  /** Bundle waits, queue timeouts and shard timeouts. */
  timeouts() {
    const { c } = this
    const now = c.now()
    for (const job of c.db.jobsInStates(['waiting-bundle', 'queued', 'running'])) {
      if (job.state === 'waiting-bundle') {
        if (now - job.createdAt > c.cfg.bundleWaitSec * 1000) this.fail(job.id, `no snapshot bundle within ${c.cfg.bundleWaitSec}s`)
        continue
      }
      let changed = false
      for (const s of c.db.shards(job.id)) {
        if (s.state === 'queued' && now - s.queuedAt > c.cfg.queueTimeoutSec * 1000) {
          const reason = `no resource within ${c.cfg.queueTimeoutSec}s${job.waitWhy ? `: ${job.waitWhy}` : ''}`
          c.db.updateShard(job.id, s.idx, { state: 'error', reason, endedAt: now })
          this.event(job.id, s.name, 'error', reason)
          this.stateEvent(job.id, 'error', s.name, reason)
          changed = true
        }
        if (s.state === 'running' && s.startedAt && now - s.startedAt > c.cfg.shardTimeoutSec * 1000) c.shards.abort(job.id, 'timeout', s.idx)
      }
      if (changed) this.maybeFinish(job.id)
    }
  }

  /** Drop jobs (rows, dirs, mirror refs) older than retentionDays. */
  async prune(): Promise<{ jobs: number; refs: number }> {
    const { c } = this
    const cutoff = c.now() - c.cfg.retentionDays * 86400_000
    const old = c.db.jobsEndedBefore(cutoff)
    for (const j of old) {
      rmSync(c.streams.dir(j.id), { recursive: true, force: true })
      c.db.deleteJob(j.id)
      c.streams.forget(j.id)
    }
    const repos = new Set(c.db.recentJobs({ limit: 1_000_000 }).map((j) => j.repo).concat(old.map((j) => j.repo)))
    let refs = 0
    for (const repo of repos) {
      refs += await c.mirror.pruneRefs(repo, () => {
        const mine = c.db.recentJobs({ repo, limit: 1_000_000 })
        return { jobs: new Set(mine.filter((j) => j.source === 'snapshot').map((j) => j.id)), shas: new Set(mine.map((j) => j.commit)) }
      })
    }
    // job dirs with no row (a crash between rmSync and the row delete). Ids are read now, after the awaits: a job
    // submitted meanwhile has its row before its dir.
    if (existsSync(c.streams.jobsDir)) {
      const ids = c.db.jobIds()
      for (const d of readdirSync(c.streams.jobsDir)) if (!/^\d+$/.test(d) || !ids.has(Number(d))) rmSync(join(c.streams.jobsDir, d), { recursive: true, force: true })
    }
    // mirror gc: per repo, under its mutex, only while it has no active job (a running clone reads its objects)
    for (const repo of repos) {
      const busy = () => c.db.jobsInStates(ACTIVE_JOB_STATES).some((j) => j.repo === repo)
      await c.mirror.gc(repo, busy).catch((e) => c.log(`mirror ${repo}: gc failed: ${(e as Error).message}`))
    }
    // the public lane's per-repo volumes of repos with no job in retentionDays
    const vols = await c.sys('docker', ['volume', 'ls', '--format', '{{.Name}}', '--filter', 'name=ci-broker-pub-'], 60)
    if (vols.code === 0) {
      const recent = new Set(c.db.recentJobs({ limit: 1_000_000 }).filter((j) => j.createdAt >= cutoff).map((j) => j.repo.replace('/', '__').toLowerCase()))
      for (const v of vols.stdout.split('\n').map((x) => x.trim()).filter(Boolean)) {
        const m = /^ci-broker-pub-(.+)-(pnpm|ms-playwright)$/.exec(v)
        if (m && !recent.has(m[1].toLowerCase())) {
          const r = await c.sys('docker', ['volume', 'rm', v], 120)
          c.log(`gc: public-lane volume ${v}: ${r.code === 0 ? 'removed' : `not removed (${(r.stderr || r.stdout).trim().slice(0, 200)})`}`)
        }
      }
    }
    // profile snapshots (split) no job names, older than an hour (a submit in flight may have just made one)
    const snaps = join(c.cfg.stateDir, 'profiles')
    if (c.cfg.layout === 'split' && existsSync(snaps)) {
      const keep = c.db.profileDirs()
      for (const d of readdirSync(snaps)) {
        const p = join(snaps, d)
        if (keep.has(p)) continue
        try {
          // file times are wall-clock times
          if (Date.now() - statSync(p).mtimeMs > 3600_000) rmSync(p, { recursive: true, force: true })
        } catch {}
      }
    }
    // trust.db: events and run uses older than 90 days
    c.tdb.prune(c.now() - 90 * 86400_000)
    // a DB and jobs/ moved aside on a schema change (`<name>.v<old>-<ms>`): kept for retentionDays
    for (const f of existsSync(c.cfg.stateDir) ? readdirSync(c.cfg.stateDir) : []) {
      const m = /^(?:brokerd\.db|jobs|work)\.v\d+-(\d+)(?:-wal|-shm)?$/.exec(f)
      if (m && Number(m[1]) < cutoff) rmSync(join(c.cfg.stateDir, f), { recursive: true, force: true })
    }
    return { jobs: old.length, refs }
  }

  activeJobs(): JobRow[] {
    return this.c.db.jobsInStates(ACTIVE_JOB_STATES)
  }
}

function loadProfileSafe(job: JobRow, c: Ctx): Profile | null {
  try {
    return c.jobProfile(job)
  } catch {
    return null
  }
}
