// One shard on a Boat box: start the box if the scheduler picked a stopped/new one, upload the wrapper + the profile
// script (+ the snapshot bundle), run the wrapper, kill the slot's process group on cancel/timeout or a dropped
// connection, then bring the profile's artifacts back.
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Boat } from '../../core/boat.ts'
import { publicBoatEnv, publicBoatEnvs, type Config } from '../config.ts'
import type { BoxRow, Db } from '../db.ts'
import type { BoatPool } from '../../core/boatpool.ts'
import type { Mirror } from '../../core/mirror.ts'
import { artifactsCommand, killCommand, remoteCommand } from '../../core/boat-commands.ts'
import type { Executor, Outcome, RunCtx } from './resources.ts'

const exec = promisify(execFile)
/** Boat boxes run as `user`; the wrapper and script live in the slot dir. */
const SLOT_DIR = '/home/user/cib/0'

/** The bundle remote resources get (refs/cib/snap minus the job's base), built once per job and shared by its shards. */
export class RemoteBundles {
  private bundles = new Map<number, Promise<string>>()
  private mirror: Mirror
  constructor(mirror: Mirror) {
    this.mirror = mirror
  }
  get(ctx: Pick<RunCtx, 'job' | 'jobDir'>): Promise<string> {
    let p = this.bundles.get(ctx.job.id)
    if (!p) {
      const out = join(ctx.jobDir, 'remote.bundle')
      p = existsSync(out) ? Promise.resolve(out) : this.mirror.remoteBundle(ctx.job.repo, ctx.job.id, ctx.job.base, out).then(() => out)
      p.catch(() => this.bundles.delete(ctx.job.id))
      this.bundles.set(ctx.job.id, p)
    }
    return p
  }
}

export class BoatExecutor implements Executor {
  private bundles: RemoteBundles
  private cfg: Config
  private db: Db
  private boat: Boat
  private pool: BoatPool
  private wrapScript: string
  constructor(cfg: Config, db: Db, boat: Boat, pool: BoatPool, bundles: RemoteBundles, wrapScript: string) {
    this.cfg = cfg
    this.db = db
    this.boat = boat
    this.pool = pool
    this.bundles = bundles
    this.wrapScript = wrapScript
  }

  async run(ctx: RunCtx): Promise<Outcome> {
    const name = ctx.placement.box!
    const { job, shard, profile } = ctx
    try {
      await this.pool.start(name)
    } catch (e) {
      return { code: null, notStarted: true, reason: `box ${name} did not start: ${(e as Error).message}` }
    }
    const row = this.db.box(name)
    const id = row?.boatId
    if (!row || !id) return { code: null, infra: 'unreachable', reason: `box ${name} has no Boat id` }
    if (ctx.signal.aborted) return { code: null, reason: ctx.why() ?? 'cancel' }
    const refused = await this.laneCheck(job, row)
    if (refused) return refused
    const snapshot = job.source === 'snapshot'
    try {
      // scp doesn't create directories: a fresh (or v0.1) box has no ~/cib/0 yet
      const mk = await this.boat.exec(id, 'mkdir -p "$HOME/cib/0"', { timeoutSec: this.cfg.boatCallTimeoutSec })
      if (mk.code !== 0) throw new Error(`mkdir -p ~/cib/0 exited ${mk.code}: ${mk.out.slice(-300)}`)
      await this.boat.scp(this.wrapScript, id, `${SLOT_DIR}/cib-wrap.sh`)
      await this.boat.scp(join(profile.dir, profile.remoteScript), id, `${SLOT_DIR}/remote.sh`)
      if (snapshot) await this.boat.scp(await this.bundles.get(ctx), id, `${SLOT_DIR}/snapshot.bundle`)
    } catch (e) {
      return { code: null, infra: 'unreachable', reason: `upload failed: ${(e as Error).message}` }
    }
    if (ctx.signal.aborted) return { code: null, reason: ctx.why() ?? 'cancel' }
    const cmd = remoteCommand({ slot: 0, repo: job.repo, sha: job.commit, base: snapshot ? job.base : null, bundle: snapshot, args: shard.args, noFsync: true })
    let code: number | null
    try {
      code = (await this.boat.exec(id, cmd, { onData: ctx.onData, signal: ctx.signal })).code
    } catch (e) {
      await this.kill(id)
      return { code: null, infra: 'unreachable', reason: `exec failed: ${(e as Error).message}` }
    }
    if (ctx.signal.aborted) {
      await this.kill(id)
      return { code: null, reason: ctx.why() ?? 'cancel' }
    }
    if (code === 255) {
      // ssh-style "connection lost": whatever runs there is still ours to stop
      await this.kill(id)
      return { code: null, infra: 'unreachable', reason: 'connection to the box lost (exit 255)' }
    }
    if (code === null) {
      // no exit status came back: whatever runs there is still ours to stop; an infra failure (retried once)
      await this.kill(id)
      return { code: null, infra: 'nostatus', reason: 'no exit status from boat exec (connection lost?)' }
    }
    // a public-lane box runs untrusted code: what it would hand back (sizes, archives) is not taken
    if (job.lane === 'public') {
      if (profile.artifacts?.length) ctx.onData('ci-broker: artifacts: not fetched from a public-lane box\n')
    } else await this.artifacts(ctx, id)
    return { code }
  }

  /**
   * Just before anything goes to the box: a public-lane job runs only in its repo's public environment (root's
   * trust.repos.<repo>.publicBoat), checked now (it injects nothing) on a box pinned to the checked version; a
   * full-lane job never runs in a public-lane environment. null = go on.
   */
  private async laneCheck(job: RunCtx['job'], row: BoxRow): Promise<Outcome | null> {
    // a refusal runs nothing: notStarted puts the shard back on the same attempt (the queue clock keeps running)
    const no = (why: string): Outcome => ({ code: null, notStarted: true, reason: `trust: ${why}` })
    const trust = this.cfg.trust
    const envs = publicBoatEnvs(trust)
    if (job.lane !== 'public') {
      if (row.pubRepo) return no(`box ${row.name} ran ${row.pubRepo}'s public lane: never a full-lane job`)
      return envs.has(row.env) ? no(`box ${row.name} is in public-lane environment ${row.env}: never a full-lane job`) : null
    }
    const want = publicBoatEnv(trust, job.repo)
    if (!want || row.env !== want) return no(`public lane: box ${row.name} is in ${row.env}, not ${job.repo}'s public environment (${want ?? 'none'})`)
    const g = await this.pool.publicGate(want, job.repo, { fresh: true, envs, max: trust.publicBoatMaxBoxes })
    if ('none' in g) return no(g.none)
    // the gate re-read the row's first-seen version; an unfit box is deleted by the next gate once it is idle
    const fresh = this.db.box(row.name)
    if (!fresh || !g.allow(fresh)) return no(`box ${row.name} is not ${job.repo}'s at ${want}'s checked version`)
    return null
  }

  private async kill(id: string) {
    await this.boat.exec(id, killCommand(0), { timeoutSec: this.cfg.boatCallTimeoutSec }).catch(() => {})
  }

  private async artifacts(ctx: RunCtx, id: string) {
    const paths = ctx.profile.artifacts ?? []
    if (!paths.length) return
    const note = (s: string) => ctx.onData(`ci-broker: artifacts: ${s}\n`)
    try {
      // an earlier attempt of this shard (an infra retry) may have left its own
      rmSync(join(ctx.jobDir, 'artifacts', ctx.shard.name), { recursive: true, force: true })
      const r = await this.boat.exec(id, artifactsCommand(0, ctx.job.repo, paths), { timeoutSec: this.cfg.boatCallTimeoutSec })
      if (r.code === 3) return
      const size = Number(r.out.trim().split('\n').pop())
      if (r.code !== 0 || !Number.isFinite(size)) return note(`tar failed (${r.code}): ${r.out.trim().slice(-200)}`)
      if (size > this.cfg.artifactsMaxMb * 1024 * 1024) return note(`skipped: ${(size / 1048576).toFixed(0)} MB is over artifactsMaxMb (${this.cfg.artifactsMaxMb})`)
      const dest = join(ctx.jobDir, 'artifacts', ctx.shard.name)
      mkdirSync(dest, { recursive: true })
      const tgz = join(ctx.jobDir, 'artifacts', `${ctx.shard.name}.tgz`)
      await this.boat.download(id, `${SLOT_DIR}/artifacts.tgz`, tgz)
      if (!existsSync(tgz) || statSync(tgz).size === 0) return note('download produced no file')
      await exec('tar', ['xzf', tgz, '-C', dest], { timeout: this.cfg.boatCallTimeoutSec * 1000 })
      rmSync(tgz, { force: true })
    } catch (e) {
      note(`failed: ${(e as Error).message}`)
    }
  }
}
