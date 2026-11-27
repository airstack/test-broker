// A whole mode on this machine: a fresh --shared clone of the mirror (the job's own .git; the mirror's objects read
// through alternates, mounted read-only into a container), the profile's local command in a container (labelled
// with this daemon and job) or on the host (single only), artifacts copied out (regular files inside the checkout
// only), then `chmod -R u+rwX` + `rm -rf`. The daemon never runs git in a dir a job had. The local slot (flock) is
// taken by the scheduler and released here.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import type { Config } from '../config.ts'
import { runLocal, type Slot } from '../local.ts'
import { localCommand } from '../profile.ts'
import { repoDir, type Mirror } from '../../core/mirror.ts'
import type { Executor, Outcome, RunCtx } from './resources.ts'

export type LocalRunFn = typeof runLocal

/** `chmod -R u+rwX` (a job may leave read-only dirs) then `rm -rf`. No git. Never throws. */
export async function removeTree(dir: string): Promise<void> {
  if (!existsSync(dir)) return
  await new Promise<void>((resolve) => spawn('/usr/bin/chmod', ['-R', 'u+rwX', '--', dir], { stdio: 'ignore' }).on('close', () => resolve()).on('error', () => resolve()))
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
}

/**
 * Copy the profile's artifact paths from the checkout `dir` into `dest`: each path must resolve (realpath) inside the
 * checkout; then our own walk copies regular files and directories only. A symlink, FIFO, socket or device (at any
 * depth) is skipped and listed in `<dest>/SKIPPED.txt`.
 */
export function copyArtifacts(o: { dir: string; dest: string; paths: string[]; note: (s: string) => void }) {
  const root = realpathSync(o.dir)
  const skipped: string[] = []
  const skip = (rel: string, why: string) => skipped.push(`${rel}: ${why}`)
  const walk = (src: string, rel: string) => {
    const st = lstatSync(src)
    if (st.isSymbolicLink()) return skip(rel, 'a symlink')
    if (st.isDirectory()) {
      mkdirSync(join(o.dest, rel), { recursive: true })
      for (const e of readdirSync(src)) walk(join(src, e), join(rel, e))
      return
    }
    if (!st.isFile()) return skip(rel, st.isFIFO() ? 'a FIFO' : st.isSocket() ? 'a socket' : 'a device or other special file')
    mkdirSync(dirname(join(o.dest, rel)), { recursive: true })
    copyFileSync(src, join(o.dest, rel))
  }
  for (const p of o.paths) {
    const src = join(o.dir, p)
    let st
    try {
      st = lstatSync(src)
    } catch {
      continue // not made by this run
    }
    let real: string
    try {
      real = realpathSync(src)
    } catch {
      skip(p, 'cannot be resolved')
      continue
    }
    if (real !== root && !real.startsWith(root + sep)) {
      skip(p, `resolves outside the checkout (${relative(root, real).startsWith('..') ? 'a link out' : real})`)
      continue
    }
    if (st.isSymbolicLink()) {
      skip(p, 'a symlink')
      continue
    }
    try {
      walk(src, p)
    } catch (e) {
      o.note(`ci-broker: artifacts: copying ${p} failed: ${(e as Error).message}\n`)
    }
  }
  if (skipped.length) {
    mkdirSync(o.dest, { recursive: true })
    appendFileSync(join(o.dest, 'SKIPPED.txt'), skipped.map((l) => `${l}\n`).join(''))
    o.note(`ci-broker: artifacts: skipped ${skipped.length} entr${skipped.length === 1 ? 'y' : 'ies'} (links, special files, outside the checkout): see SKIPPED.txt\n`)
  }
}

export class LocalExecutor implements Executor {
  /** slot locks the scheduler took, by `<job>:<idx>` */
  readonly locks = new Map<string, Slot>()
  private cfg: Config
  private mirror: Mirror
  private runFn: LocalRunFn
  /** a job secret's value at run time (null: not set) */
  private secret: (name: string) => string | null | Promise<string | null>
  constructor(cfg: Config, mirror: Mirror, runFn: LocalRunFn = runLocal, secret: (name: string) => string | null | Promise<string | null> = () => null) {
    this.cfg = cfg
    this.mirror = mirror
    this.runFn = runFn
    this.secret = secret
  }

  async run(ctx: RunCtx): Promise<Outcome> {
    const { job, profile } = ctx
    const key = `${job.id}:${ctx.shard.idx}`
    let dir: string | null = null
    try {
      const l = profile.local
      const cmd = localCommand(profile, job.mode, job.args)
      if (!l || cmd === null) return { code: null, infra: 'nostatus', reason: `profile ${profile.name} has no local command for ${job.mode}` }
      // admission refuses these; the executor holds the line too
      if (l.where === 'host' && (this.cfg.layout === 'split' || job.lane === 'public')) return { code: null, infra: 'nostatus', reason: `no host mode ${job.lane === 'public' ? 'in the public lane' : 'in split'}` }
      mkdirSync(join(this.mirror.workRoot, repoDir(job.repo)), { recursive: true })
      dir = join(this.mirror.workRoot, repoDir(job.repo), `${job.id}-${randomBytes(3).toString('hex')}`)
      await this.mirror.cloneForRun(job.repo, job.commit, dir)
      if (ctx.signal.aborted) return { code: null, reason: ctx.why() ?? 'cancel' }
      // job secrets: by name, read now, only for an env-class full-lane job (the public lane and a GitHub-door
      // job without root's envForGithubDoor never get them)
      const env: Record<string, string> = {}
      const names = Object.entries(l.env ?? {})
      if (job.env === 'env' && job.lane === 'full') {
        for (const [k, s] of names) {
          const v = await this.secret(s)
          if (v === null) return { code: null, infra: 'nostatus', reason: `secret ${s} is not set (local.env.${k})` }
          env[k] = v
          ctx.addSecret(v)
        }
      } else if (names.length) ctx.onData(`ci-broker: ${job.lane === 'public' ? 'public lane' : 'this job'}: local.env not passed (${names.length} names)\n`)
      if (job.lane === 'public' && l.dockerRelax?.length) ctx.onData('ci-broker: public lane: dockerRelax ignored (always --cap-drop ALL)\n')
      ctx.onData(`ci-broker: local ${l.where} run (${job.lane} lane) in ${dir}\n`)
      const full = [l.setup, cmd].filter(Boolean).join(' && ')
      const code = await this.runFn({
        dir, mirrorObjects: join(this.mirror.path(job.repo), 'objects'), where: l.where, image: l.image, nono: l.nono, nonoProfile: this.cfg.layout === 'single' ? l.nonoProfile : undefined,
        lane: job.lane, repo: job.repo, relax: job.lane === 'full' ? l.dockerRelax : undefined, cmd: full, cfg: this.cfg,
        onData: ctx.onData, signal: ctx.signal, env, tmpfs: l.tmpfs,
        labels: { 'ci-broker.daemon': this.cfg.daemonId, 'ci-broker.job': String(job.id) },
      })
      // a cancelled run's container may outlive the docker client: never walk a tree it can still change
      if (ctx.signal.aborted) {
        if (ctx.profile.artifacts?.length) ctx.onData('ci-broker: cancelled: artifacts not copied\n')
        return { code: null, reason: ctx.why() ?? 'cancel' }
      }
      const dest = join(ctx.jobDir, 'artifacts', ctx.shard.name)
      // an earlier attempt of this shard (an infra retry) may have left its own
      try {
        rmSync(dest, { recursive: true, force: true })
      } catch (e) {
        ctx.onData(`ci-broker: artifacts: clearing an earlier attempt's failed: ${(e as Error).message}\n`)
      }
      copyArtifacts({ dir, dest, paths: ctx.profile.artifacts ?? [], note: ctx.onData })
      return { code }
    } catch (e) {
      ctx.onData(`ci-broker: ${(e as Error).message}\n`)
      return { code: null, infra: 'nostatus', reason: (e as Error).message }
    } finally {
      if (dir) await removeTree(dir)
      const slot = this.locks.get(key)
      this.locks.delete(key)
      await slot?.release()
    }
  }
}
