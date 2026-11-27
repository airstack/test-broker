// Local execution: one heavy run per machine (a flock), in a container (default) or on the host.
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import type { Config } from './config.ts'

export type Slot = { release(): Promise<void> }

// The lock is held by `flock` running `cat` on our stdin: when we release (end stdin) or die (pipe closes), cat exits
// and the lock goes with it. No orphan can keep it.
function spawnLock(lockFile: string, wait: boolean): ChildProcess {
  if (!existsSync(dirname(lockFile))) mkdirSync(dirname(lockFile), { recursive: true })
  const args = [...(wait ? [] : ['-n']), lockFile, 'sh', '-c', 'echo locked; exec cat >/dev/null']
  return spawn('/usr/bin/flock', args, { stdio: ['pipe', 'pipe', 'ignore'] })
}

function slotFrom(p: ChildProcess, signal?: AbortSignal): Promise<Slot | null> {
  return new Promise((resolve, reject) => {
    let settled = false
    const onAbort = () => {
      p.kill('SIGTERM')
      if (!settled) {
        settled = true
        reject(new Error('aborted while waiting for the local slot'))
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    p.stdout!.once('data', () => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      const exited = new Promise<void>((r) => p.once('close', () => r()))
      resolve({ release: () => (p.stdin!.end(), exited) })
    })
    p.on('close', () => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      resolve(null)
    })
  })
}

/** Take a flock on `lockFile` (the local slot's, or the one-daemon lock) now; null = someone holds it. */
export const tryLock = (lockFile: string) => slotFrom(spawnLock(lockFile, false))
/** the local slot: `<lockFile>` is cfg.localLockPath (split: shared with the operator's `local-lock`, mode 0660) */
export async function tryLocalSlot(lockFile: string, shared = false): Promise<Slot | null> {
  const s = await tryLock(lockFile)
  if (s && shared) {
    try {
      chmodSync(lockFile, 0o660)
    } catch {}
  }
  return s
}

export async function waitLocalSlot(lockFile: string, signal?: AbortSignal): Promise<Slot> {
  const s = await slotFrom(spawnLock(lockFile, true), signal)
  if (!s) throw new Error('could not take the local slot')
  return s
}

/** mkdir -p `rel` under `base`, refusing when any existing part of the path is a symlink or not a dir. */
export function mkdirUnder(base: string, rel: string) {
  let p = base
  for (const part of rel.split('/').filter(Boolean)) {
    p = join(p, part)
    let st
    try {
      st = lstatSync(p)
    } catch {
      mkdirSync(p)
      continue
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`tmpfs ${rel}: ${relative(base, p)} is a symlink or not a dir (refused)`)
  }
}

export type DockerLane = 'full' | 'public'

/**
 * `docker run` for a local run. Mounted: the run's own clone (rw, at its host path, the workdir) and its mirror's
 * objects (ro, at their host path, so the clone's alternates resolve). Nothing else of the work root: a job can never
 * write a mirror (whose hooks and config the daemon's git would run). Both lanes: --cap-drop ALL (full lane:
 * dockerRelax ["caps"] drops it), no-new-privileges, a pids limit. The public lane: the ci-broker-pub network (the
 * internet, not this machine or private ranges), per-repo pnpm and Playwright volumes, no job secrets ever.
 */
export function dockerArgs(o: {
  name: string; dir: string; mirrorObjects: string; image: string; cmd: string; cfg: Config; uid: number; gid: number; lane: DockerLane; repo: string
  envNames?: string[]; tmpfs?: string[]; labels?: Record<string, string>; relax?: string[]
}): string[] {
  const pub = o.lane === 'public'
  const rd = o.repo.replace('/', '__')
  const caps = pub || !(o.relax ?? []).includes('caps')
  // split's full lane has its own shared volumes: single's are owned by the operator's uid
  const full = o.cfg.layout === 'split' ? 'ci-broker-full' : 'ci-broker'
  return [
    // --init: tini as PID 1 reaps the command's orphans and passes signals on (a test runner as PID 1 does neither)
    'run', '--rm', '--init', '--name', o.name,
    // so a restarted daemon can find and remove what it left behind
    ...Object.entries(o.labels ?? {}).flatMap(([k, v]) => ['--label', `${k}=${v}`]),
    '--cpus', String(o.cfg.local.cpus), '--memory', o.cfg.local.memory, '--shm-size', '2g',
    ...(caps ? ['--cap-drop', 'ALL'] : []), '--security-opt', 'no-new-privileges', '--pids-limit', pub ? '4096' : '8192',
    // docker's own default lets any user bind a port under 1024; a host doesn't, and tests count on that (port 1 as
    // "surely taken")
    '--sysctl', 'net.ipv4.ip_unprivileged_port_start=1024',
    ...(pub ? ['--network', o.cfg.trust.publicNetwork] : []),
    '--user', `${o.uid}:${o.gid}`, '-e', 'HOME=/tmp/home', '-e', 'CI=1',
    '--tmpfs', '/tmp:exec,size=8g',
    '-v', `${o.dir}:${o.dir}`, '-v', `${o.mirrorObjects}:${o.mirrorObjects}:ro`, '-w', o.dir,
    ...(o.tmpfs ?? []).flatMap((d) => ['--tmpfs', `${join(o.dir, d)}:exec,size=6g,uid=${o.uid},gid=${o.gid}`]),
    '-v', `${pub ? `ci-broker-pub-${rd}-pnpm` : `${full}-pnpm-store`}:/pnpm-store`, '-e', 'npm_config_store_dir=/pnpm-store',
    // Playwright browsers, shared across runs (the image seeds the volume; `playwright install` tops up a new version)
    '-v', `${pub ? `ci-broker-pub-${rd}-ms-playwright` : `${full}-ms-playwright`}:/ms-playwright`, '-e', 'PLAYWRIGHT_BROWSERS_PATH=/ms-playwright',
    // by name only: docker reads the value from its own env, so it never shows in a process list
    ...(pub ? [] : (o.envNames ?? []).flatMap((n) => ['-e', n])),
    o.image, 'bash', '-lc', o.cmd,
  ]
}

/**
 * single, host mode: the command under nono. With `nonoProfile`: `nono run -s --profile <p> --allow <dir> --read
 * <objects> [nono…] -- bash -lc <cmd>` (a convenience for projects that keep a nono jail, not a trust boundary).
 * null: no nono (`nono: false` and no profile).
 */
export function nonoArgv(o: { dir: string; mirrorObjects: string; cmd: string; nono?: string[] | false; nonoProfile?: string }): string[] | null {
  if (o.nonoProfile) return ['nono', 'run', '-s', '--profile', o.nonoProfile, '--allow', o.dir, '--read', o.mirrorObjects, ...(o.nono || []), '--', 'bash', '-lc', o.cmd]
  if (o.nono) return ['nono', 'run', '--allow', o.dir, ...o.nono, '--', 'bash', '-lc', o.cmd]
  return null
}

export type LocalRun = {
  dir: string
  /** the run's mirror's objects (the clone's alternates; mounted read-only into a container) */
  mirrorObjects: string
  where: 'container' | 'host'
  image?: string
  /** host only: run under nono with these extra args (the checkout is always allowed) */
  nono?: string[] | false
  /** single, host only: a nono profile (`nono run -s --profile`) */
  nonoProfile?: string
  /** container: the lane (the public lane's network, volumes and limits) */
  lane?: DockerLane
  /** container: owner/name (the public lane's per-repo volumes) */
  repo?: string
  /** container, full lane: dockerRelax */
  relax?: string[]
  /** extra env for the command (container: passed by name) */
  env?: Record<string, string>
  /** container only: worktree-relative tmpfs dirs */
  tmpfs?: string[]
  /** container only: docker labels */
  labels?: Record<string, string>
  cmd: string
  cfg: Config
  onData: (s: string) => void
  signal?: AbortSignal
  /** after a cancel's SIGTERM, SIGKILL the process group this much later (default 10 s) */
  killGraceMs?: number
  /** after the process exits, wait this long for its output pipes to close (default 5 s), then destroy them */
  closeWaitMs?: number
}

/** Run the command; resolves with its exit code (non-zero when aborted). */
export function runLocal(o: LocalRun): Promise<number> {
  let argv: string[]
  let killContainer: string | null = null
  if (o.where === 'container') {
    if (!o.image) return Promise.reject(new Error('container run needs an image'))
    killContainer = `cib-${randomBytes(4).toString('hex')}`
    // created by us first, so docker doesn't make the mount points as root inside the checkout; never through a
    // committed symlink (that would make dirs outside the checkout)
    try {
      for (const d of o.tmpfs ?? []) mkdirUnder(o.dir, d)
    } catch (e) {
      return Promise.reject(e)
    }
    argv = ['docker', ...dockerArgs({
      name: killContainer, dir: o.dir, mirrorObjects: o.mirrorObjects, image: o.image, cmd: o.cmd, cfg: o.cfg, uid: process.getuid!(), gid: process.getgid!(),
      lane: o.lane ?? 'full', repo: o.repo ?? 'local/run', envNames: Object.keys(o.env ?? {}), tmpfs: o.tmpfs, labels: o.labels, relax: o.relax,
    })]
  } else argv = nonoArgv(o) ?? ['bash', '-lc', o.cmd]
  return new Promise((resolve) => {
    const p = spawn(argv[0], argv.slice(1), { cwd: o.dir, env: { ...process.env, ...o.env, CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'], detached: o.where === 'host' })
    p.stdout.on('data', (d: Buffer) => o.onData(d.toString()))
    p.stderr.on('data', (d: Buffer) => o.onData(d.toString()))
    let aborted = false
    let settled = false
    const timers: NodeJS.Timeout[] = []
    const signalGroup = (sig: NodeJS.Signals) => {
      try {
        if (o.where === 'host' && p.pid) process.kill(-p.pid, sig) // the whole process group
        else p.kill(sig)
      } catch {}
    }
    const finish = (code: number) => {
      if (settled) return
      settled = true
      for (const t of timers) clearTimeout(t)
      o.signal?.removeEventListener('abort', abort)
      resolve(code)
    }
    const abort = () => {
      aborted = true
      if (killContainer) spawn('docker', ['kill', killContainer], { stdio: 'ignore' }).on('error', () => {})
      signalGroup('SIGTERM')
      // a group that ignores SIGTERM must not hold the local slot forever
      timers.push(setTimeout(() => signalGroup('SIGKILL'), o.killGraceMs ?? 10_000))
    }
    if (o.signal?.aborted) abort()
    o.signal?.addEventListener('abort', abort, { once: true })
    p.on('error', (e) => {
      o.onData(`ci-broker: ${e.message}\n`)
      finish(127)
    })
    // 'close' waits for every holder of the pipes (an escaped grandchild may never let go): after 'exit', wait a
    // bounded time, then destroy the pipes and resolve
    p.on('exit', (code) => {
      const result = aborted ? (code || 130) : (code ?? 1)
      timers.push(
        setTimeout(() => {
          p.stdout.destroy()
          p.stderr.destroy()
          finish(result)
        }, o.closeWaitMs ?? 5_000),
      )
    })
    p.on('close', (code) => finish(aborted ? (code || 130) : (code ?? 1)))
  })
}
