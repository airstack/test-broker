// One shard on an ssh host slot: upload the wrapper + the profile script (+ the snapshot bundle) to ~/cib/<slot>/ with
// scp, run the wrapper over `ssh -o BatchMode=yes -o ServerAliveInterval=15 <host>`, kill the slot's process group on
// cancel/timeout or a lost connection, then bring the profile's artifacts back. With `githubTokenCmd` the token is the
// first line of the ssh process's stdin (CIB_TOKEN_LINE=1): never in argv, never stored.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Config, ResourceCfg } from '../config.ts'
import type { JobRow } from '../db.ts'
import { artifactsCommand, killCommand, remoteCommand } from '../../core/boat-commands.ts'
import type { RemoteBundles } from './exec-boat.ts'
import type { Executor, Outcome, RunCtx } from './resources.ts'

export type RunResult = { code: number; out: string }

/**
 * Run a command; resolves with its exit code (null exit → 255 for ssh-like "no status", 124 on timeout). Output goes to
 * `onData` and is kept (capped) in `out`. `stdin` is written then closed; without it stdin is closed at once.
 */
export function spawnRun(bin: string, args: string[], o: { stdin?: string; onData?: (s: string) => void; signal?: AbortSignal; timeoutSec?: number; keep?: number } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let out = ''
    const keep = o.keep ?? 1 << 20
    let p: ReturnType<typeof spawn>
    try {
      p = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) {
      return resolve({ code: 127, out: (e as Error).message })
    }
    const on = (d: Buffer) => {
      const s = d.toString()
      if (out.length < keep) out += s
      o.onData?.(s)
    }
    p.stdout!.on('data', on)
    p.stderr!.on('data', on)
    p.stdin!.on('error', () => {})
    p.stdin!.end(o.stdin ?? '')
    let timedOut = false
    const t = o.timeoutSec ? setTimeout(() => ((timedOut = true), p.kill('SIGKILL')), o.timeoutSec * 1000) : null
    const abort = () => p.kill('SIGTERM')
    if (o.signal?.aborted) abort()
    o.signal?.addEventListener('abort', abort, { once: true })
    p.on('error', (e) => on(Buffer.from(`${bin}: ${e.message}\n`)))
    p.on('close', (code) => {
      if (t) clearTimeout(t)
      o.signal?.removeEventListener('abort', abort)
      resolve({ code: timedOut ? 124 : (code ?? 255), out })
    })
  })
}

const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15']

/** One line per fact: disk_free_gb, sudo (yes|no), mem_kb, nproc. */
export const REPORT_SCRIPT = [
  `df -Pk "$HOME" | awk 'NR==2 { print "disk_free_gb=" int($4 / 1048576) }'`,
  'if sudo -n true >/dev/null 2>&1; then echo sudo=yes; else echo sudo=no; fi',
  `awk '/^MemTotal:/ { print "mem_kb=" $2 }' /proc/meminfo 2>/dev/null`,
  'echo "nproc=$(nproc 2>/dev/null || echo 0)"',
].join('\n')

export type HostReport = { diskFreeGb: number | null; sudo: boolean | null; memGb: number | null; memPerSlotGb: number | null; nproc: number | null }

export function parseReport(out: string, slots: number): HostReport {
  const kv = new Map<string, string>()
  for (const l of out.split('\n')) {
    const m = /^(\w+)=(.*)$/.exec(l.trim())
    if (m) kv.set(m[1], m[2])
  }
  const num = (k: string) => (kv.has(k) && Number.isFinite(Number(kv.get(k))) ? Number(kv.get(k)) : null)
  const memKb = num('mem_kb')
  const memGb = memKb === null ? null : Math.round((memKb / 1048576) * 10) / 10
  return {
    diskFreeGb: num('disk_free_gb'),
    sudo: kv.has('sudo') ? kv.get('sudo') === 'yes' : null,
    memGb,
    memPerSlotGb: memGb === null ? null : Math.round((memGb / slots) * 10) / 10,
    nproc: num('nproc'),
  }
}

export class SshExecutor implements Executor {
  private cfg: Config
  private resources: ResourceCfg[]
  private bundles: RemoteBundles
  private wrapScript: string
  private secret: (name: string) => string | null | Promise<string | null>
  constructor(cfg: Config, resources: ResourceCfg[], bundles: RemoteBundles, wrapScript: string, secret: (name: string) => string | null | Promise<string | null> = () => null) {
    this.cfg = cfg
    this.resources = resources
    this.bundles = bundles
    this.wrapScript = wrapScript
    this.secret = secret
  }

  private res(id: string): ResourceCfg {
    const r = this.resources.find((x) => x.id === id && x.kind === 'ssh')
    if (!r) throw new Error(`no ssh resource ${id}`)
    return r
  }

  /** `ssh <host> <cmd>`; short calls by default (sshCallTimeoutSec; `timeoutSec: 0` = none). */
  ssh(host: string, cmd: string, o: { stdin?: string; onData?: (s: string) => void; signal?: AbortSignal; timeoutSec?: number; keep?: number } = {}): Promise<RunResult> {
    return spawnRun(this.cfg.sshBin, [...SSH_OPTS, host, cmd], { timeoutSec: this.cfg.sshCallTimeoutSec, ...o })
  }
  private scp(from: string, to: string): Promise<RunResult> {
    return spawnRun(this.cfg.scpBin, ['-q', '-o', 'BatchMode=yes', from, to], { timeoutSec: Math.max(this.cfg.sshCallTimeoutSec, 600) })
  }

  /** The token for the remote script: the `secret` (a job secret), or `githubTokenCmd` (single). null with neither. Throws when it can't be had. */
  async token(r: ResourceCfg, job?: Pick<JobRow, 'door' | 'lane' | 'env'>): Promise<string | null> {
    // a job secret: never to a GitHub-door job without root's envForGithubDoor (its env class says), never the public lane
    if (job && (job.lane === 'public' || (job.door === 'github' && job.env !== 'env'))) return null
    if (r.secret) {
      const v = await this.secret(r.secret)
      if (v === null) throw new Error(`secret ${r.secret} is not set`)
      return v.split('\n')[0].trim()
    }
    if (!r.githubTokenCmd || this.cfg.layout === 'split') return null
    const t = await spawnRun('bash', ['-c', r.githubTokenCmd], { timeoutSec: 30, keep: 64 * 1024 })
    const v = t.out.trim()
    if (t.code !== 0 || !v) throw new Error(`githubTokenCmd failed (exit ${t.code})`)
    return v.split('\n')[0].trim()
  }

  async killSlot(resourceId: string, slot: number): Promise<number> {
    return (await this.ssh(this.res(resourceId).host!, killCommand(slot))).code
  }

  /** Free disk, passwordless sudo, RAM (and per slot), CPUs. */
  async report(resourceId: string): Promise<{ code: number; report: HostReport; out: string }> {
    const r = this.res(resourceId)
    const x = await this.ssh(r.host!, REPORT_SCRIPT)
    return { code: x.code, report: parseReport(x.out, r.slots ?? 1), out: x.out }
  }

  async run(ctx: RunCtx): Promise<Outcome> {
    const { job, shard, profile, placement } = ctx
    const r = this.res(placement.resource)
    const host = r.host!
    const slot = placement.slot
    const stop = (): Outcome => ({ code: null, reason: ctx.why() ?? 'cancel' })
    let token: string | null
    try {
      token = await this.token(r, job)
    } catch (e) {
      return { code: null, infra: 'nostatus', reason: (e as Error).message }
    }
    if (token) ctx.addSecret(token)
    const snapshot = job.source === 'snapshot'
    const dir = `cib/${slot}`
    const mk = await this.ssh(host, `mkdir -p "$HOME/${dir}"`, { signal: ctx.signal })
    if (ctx.signal.aborted) return stop()
    if (mk.code !== 0) return { code: null, infra: 'unreachable', reason: `ssh ${host} failed (exit ${mk.code}): ${mk.out.trim().slice(-300)}` }
    const uploads: [string, string][] = [
      [this.wrapScript, 'cib-wrap.sh'],
      [join(profile.dir, profile.remoteScript), 'remote.sh'],
    ]
    try {
      if (snapshot) uploads.push([await this.bundles.get(ctx), 'snapshot.bundle'])
    } catch (e) {
      return { code: null, infra: 'nostatus', reason: `building the snapshot bundle failed: ${(e as Error).message}` }
    }
    for (const [from, name] of uploads) {
      const u = await this.scp(from, `${host}:${dir}/${name}`)
      if (ctx.signal.aborted) return stop()
      if (u.code !== 0) return { code: null, infra: 'unreachable', reason: `upload of ${name} failed (exit ${u.code}): ${u.out.trim().slice(-300)}` }
    }
    const cmd = remoteCommand({ slot, repo: job.repo, sha: job.commit, base: snapshot ? job.base : null, bundle: snapshot, args: shard.args, tokenLine: !!token })
    const ac = new AbortController()
    let killed: Promise<unknown> | null = null
    const onAbort = () => {
      // one call kills the slot's group; then the local ssh goes
      killed = this.killSlot(r.id, slot).finally(() => ac.abort())
    }
    if (ctx.signal.aborted) onAbort()
    ctx.signal.addEventListener('abort', onAbort, { once: true })
    const res = await this.ssh(host, cmd, { stdin: token ? `${token}\n` : '', onData: ctx.onData, signal: ac.signal, timeoutSec: 0, keep: 0 })
    ctx.signal.removeEventListener('abort', onAbort)
    if (killed) await killed
    if (ctx.signal.aborted) return stop()
    if (res.code === 255) {
      // the connection went: whatever runs there is still ours to stop
      await this.killSlot(r.id, slot)
      return { code: null, infra: 'unreachable', reason: `connection to ${host} lost or refused (ssh exit 255)` }
    }
    await this.artifacts(ctx, host, slot)
    return { code: res.code }
  }

  private async artifacts(ctx: RunCtx, host: string, slot: number) {
    const paths = ctx.profile.artifacts ?? []
    if (!paths.length) return
    const note = (s: string) => ctx.onData(`ci-broker: artifacts: ${s}\n`)
    try {
      // an earlier attempt of this shard (an infra retry) may have left its own
      rmSync(join(ctx.jobDir, 'artifacts', ctx.shard.name), { recursive: true, force: true })
      const r = await this.ssh(host, artifactsCommand(slot, ctx.job.repo, paths))
      if (r.code === 3) return
      const size = Number(r.out.trim().split('\n').pop())
      if (r.code !== 0 || !Number.isFinite(size)) return note(`tar failed (${r.code}): ${r.out.trim().slice(-200)}`)
      if (size > this.cfg.artifactsMaxMb * 1024 * 1024) return note(`skipped: ${(size / 1048576).toFixed(0)} MB is over artifactsMaxMb (${this.cfg.artifactsMaxMb})`)
      const dest = join(ctx.jobDir, 'artifacts', ctx.shard.name)
      mkdirSync(dest, { recursive: true })
      const tgz = join(ctx.jobDir, 'artifacts', `${ctx.shard.name}.tgz`)
      const d = await this.scp(`${host}:cib/${slot}/artifacts.tgz`, tgz)
      if (d.code !== 0 || !existsSync(tgz) || statSync(tgz).size === 0) return note(`download failed (${d.code}): ${d.out.trim().slice(-200)}`)
      const x = await spawnRun('tar', ['xzf', tgz, '-C', dest], { timeoutSec: this.cfg.sshCallTimeoutSec })
      if (x.code !== 0) note(`unpacking failed: ${x.out.trim().slice(-200)}`)
      rmSync(tgz, { force: true })
    } catch (e) {
      note(`failed: ${(e as Error).message}`)
    }
  }
}
