// A thin wrapper over the Boat CLI. Everything the broker does to Boat goes through the `Boat` interface so tests can
// swap in a fake (test/fake-boat.ts).
import { spawn } from 'node:child_process'
import { newFrameState, parseFrames } from './frames.ts'

export type Box = {
  id: string
  name: string
  state: string
  type: string
  environment: string | null
  /** the environment version the box is pinned to */
  environmentVersion?: number
  /** epoch ms, when the box is stopped */
  stoppedAt?: number
}

/** An environment as `boat env info` gives it: its latest version, and what it injects into a box (empty = nothing). */
export type EnvInfo = { name: string; version: number; injects: string[] }

/**
 * What an environment (`boat env info --json`'s `environment`) injects into its boxes, one entry per thing. Empty only
 * when it injects nothing of ours: the master switch on, every toggle off, no AI credentials, no repos, files or
 * variables. Anything unknown counts as injected.
 */
export function envInjects(e: any): string[] {
  const out: string[] = []
  if (!e || typeof e !== 'object') return ['no environment in the answer']
  if (e.safeForThirdParties !== true) out.push('safeForThirdParties is not true')
  const eff = e.effective
  if (!eff || typeof eff !== 'object') out.push('no effective toggles')
  else for (const k of ['passGithub', 'passSecrets', 'passSandboxCredentials', 'passAgentsCredentials']) if (eff[k] !== false) out.push(`${k}`)
  if (e.proxyAiCredentials !== false) out.push('proxyAiCredentials')
  if (e.credentialProfileId != null) out.push('a credential profile')
  if (!Array.isArray(e.selectedRepositories) || e.selectedRepositories.length) out.push('repos')
  if (!Array.isArray(e.secretFiles) || e.secretFiles.length) out.push('secret files')
  // Boat answers the variables' text (envContents) and/or, since 2026-11, their count (variables): each one present
  // must say none, and at least one must be there
  const hasText = e.envContents !== undefined, hasCount = e.variables !== undefined
  const noVars = (hasText || hasCount) && (!hasText || (typeof e.envContents === 'string' && !e.envContents.trim())) && (!hasCount || e.variables === 0)
  if (!noVars) out.push('variables')
  return out
}

/** Boat states that mean "has a machine right now". */
export const RUNNING_STATES = ['provisioned', 'cloning', 'ready', 'idle', 'running']

/** starts left now; dayLimit: the day's limit, when Boat says it (the warm pool's starts guard) */
export type Starts = { day: number; hour: number; minute: number; dayLimit?: number }
/** hoursLeft: the plan's included hours left; walletHours: what the wallet buys once they are used up */
export type PlanInfo = { hoursLeft: number; periodEnd: number | null; last24hHours: number | null; startsUsed: number | null; active: number | null; walletHours?: number | null }

/** timeoutSec: give up after this long and report exit code 124. */
export type ExecOpts = { onData?: (s: string) => void; signal?: AbortSignal; timeoutSec?: number }

export interface Boat {
  list(): Promise<Box[]>
  envInfo(name: string): Promise<EnvInfo>
  /** a new environment that injects nothing (`env new`, then envMakeSafe) */
  envCreate(name: string): Promise<void>
  /** `env set <name> --safe-for-third-parties true --proxy-ai-credentials false` */
  envMakeSafe(name: string): Promise<void>
  starts(): Promise<Starts>
  /** the plan's hours and use (`boat limits`), for usage accounting; optional */
  plan?(): Promise<PlanInfo>
  create(o: { name: string; size: string; environment: string; ttlSec: number }): Promise<string>
  resume(id: string): Promise<void>
  /** Boat's `hydrated` flag: false while a created or resumed box still loads its disk; null when Boat says nothing. */
  hydrated(id: string): Promise<boolean | null>
  stop(id: string): Promise<void>
  delete(id: string): Promise<void>
  extend(id: string, ttlSec: number): Promise<void>
  /** timeoutSec: the call's limit (default: the short-call timeout); signal: kill the copy */
  scp(local: string, id: string, remote: string, o?: { timeoutSec?: number; signal?: AbortSignal }): Promise<void>
  /** Copy a file from the box (`boat scp <id>:<remote> <local>`). */
  download(id: string, remote: string, local: string): Promise<void>
  rename(id: string, name: string): Promise<void>
  /** Run `bash -lc <cmd>` on the box. `code: null` = no exit status came back (never reported as 0 or a test code). */
  exec(id: string, cmd: string, o?: ExecOpts): Promise<{ code: number | null; out: string }>
}

type Proc = { code: number; out: string }

/** What a call keeps of its output: the tail. A shard's whole log streams through onData and goes to disk there; the
 *  callers that read `out` (list, limits, new, an exec's last line) need only a small output or its tail. */
export const KEEP_OUT = 1 << 20
/** out + s, cut back to the last KEEP_OUT chars once it is twice that (so a long stream is not copied every chunk) */
const keep = (out: string, s: string) => {
  const n = out + s
  return n.length > 2 * KEEP_OUT ? n.slice(-KEEP_OUT) : n
}
const tail = (s: string) => (s.length > KEEP_OUT ? s.slice(-KEEP_OUT) : s)

/** Boat's CLI colours its messages; reasons and receipts want plain text. */
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')

export class CliBoat implements Boat {
  readonly bin: string
  /** every call but `exec` gives up after this long (create gets 3×) */
  readonly callTimeoutSec: number
  /** the env of every boat call (the daemon's own XDG_CONFIG_HOME in split) */
  private env: () => NodeJS.ProcessEnv
  constructor(bin: string, callTimeoutSec = 120, env: () => NodeJS.ProcessEnv = () => ({ ...process.env, BOAT_NO_UPDATE: '1' })) {
    this.bin = bin
    this.callTimeoutSec = callTimeoutSec
    this.env = env
  }

  private run(args: string[], o: { onChunk?: (s: string) => void; signal?: AbortSignal; timeoutSec?: number } = {}): Promise<Proc & { timedOut: boolean }> {
    return new Promise((resolve, reject) => {
      const p = spawn(this.bin, args, { env: this.env(), stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      const onChunk = (b: Buffer) => {
        const s = b.toString()
        // exec keeps its own (decoded) copy: don't hold the raw frames as well
        if (!o.onChunk) out = keep(out, s)
        else o.onChunk(s)
      }
      p.stdout.on('data', onChunk)
      p.stderr.on('data', onChunk)
      const abort = () => p.kill('SIGTERM')
      if (o.signal?.aborted) abort() // an 'abort' listener added after the fact never fires
      o.signal?.addEventListener('abort', abort, { once: true })
      let settled = false
      // On timeout, resolve at once: a grandchild still holding the pipe would otherwise delay 'close'.
      const timer =
        o.timeoutSec === undefined
          ? null
          : setTimeout(() => {
              p.kill('SIGKILL')
              settled = true
              o.signal?.removeEventListener('abort', abort)
              resolve({ code: 124, out: tail(out), timedOut: true })
            }, o.timeoutSec * 1000)
      p.on('error', (e) => !settled && ((settled = true), reject(e)))
      p.on('close', (code) => {
        if (timer) clearTimeout(timer)
        o.signal?.removeEventListener('abort', abort)
        if (!settled) resolve({ code: code ?? 1, out: tail(out), timedOut: false })
        settled = true
      })
    })
  }

  private async ok(args: string[], timeoutSec = this.callTimeoutSec, signal?: AbortSignal): Promise<string> {
    const r = await this.run(args, { timeoutSec, ...(signal ? { signal } : {}) })
    if (signal?.aborted) throw new Error(`boat ${args[0]} aborted`)
    if (r.timedOut) throw new Error(`boat ${args[0]} timed out after ${timeoutSec}s`)
    if (r.code !== 0) throw new Error(`boat ${args[0]} failed (${r.code}): ${plain(r.out).trim().slice(-500)}`)
    return r.out
  }

  private static json(out: string): Record<string, any>[] {
    const objs: Record<string, any>[] = []
    for (const l of out.split('\n')) {
      try {
        const v = JSON.parse(l)
        if (v && typeof v === 'object') objs.push(v)
      } catch {}
    }
    return objs
  }

  async list(): Promise<Box[]> {
    const out = await this.ok(['list', '--all', '--json'])
    const doc = CliBoat.json(out).find((o) => Array.isArray(o.sandboxes))
    if (!doc) throw new Error(`boat list: no sandboxes in output: ${out.slice(0, 300)}`)
    return doc.sandboxes.map((b: any) => {
      const box: Box = { id: b.id, name: b.name ?? '', state: b.state, type: b.type, environment: b.environment ?? null }
      if (typeof b.environmentVersion === 'number') box.environmentVersion = b.environmentVersion
      if (b.stoppedAt) box.stoppedAt = Date.parse(b.stoppedAt)
      return box
    })
  }

  async envCreate(name: string): Promise<void> {
    await this.ok(['env', 'new', name, '--json'])
    await this.envMakeSafe(name)
  }
  async envMakeSafe(name: string): Promise<void> {
    await this.ok(['env', 'set', name, '--safe-for-third-parties', 'true', '--proxy-ai-credentials', 'false', '--json'])
  }
  async envInfo(name: string): Promise<EnvInfo> {
    const out = await this.ok(['env', 'info', name, '--json'])
    const doc = CliBoat.json(out).find((o) => o.environment && typeof o.environment === 'object')
    if (!doc) throw new Error(`boat env info ${name}: no environment in output: ${out.slice(0, 300)}`)
    const e = doc.environment
    if (e.name !== name) throw new Error(`boat env info ${name}: the answer is for ${String(e.name).slice(0, 64)}`)
    if (typeof e.latestVersionNumber !== 'number') throw new Error(`boat env info ${name}: no latestVersionNumber`)
    return { name, version: e.latestVersionNumber, injects: envInjects(e) }
  }

  async starts(): Promise<Starts> {
    const out = await this.ok(['limits', '--json'])
    const doc = CliBoat.json(out).find((o) => o.starts)
    if (!doc) throw new Error(`boat limits: no starts in output: ${out.slice(0, 300)}`)
    const s = doc.starts
    return { day: s.day?.remaining ?? 0, hour: s.hour?.remaining ?? 0, minute: s.minute?.remaining ?? 0, ...(typeof s.day?.limit === 'number' ? { dayLimit: s.day.limit } : {}) }
  }

  async plan(): Promise<PlanInfo> {
    const out = await this.ok(['limits', '--json'])
    const d = CliBoat.json(out).find((o) => o.planIncluded || o.starts)
    if (!d || typeof d.planIncluded?.vmHoursRemaining !== 'number') throw new Error(`boat limits: no plan hours in output: ${out.slice(0, 300)}`)
    const end = Date.parse(d.planIncluded.periodEnd ?? d.subscriptionCurrentPeriodEnd ?? '')
    return {
      hoursLeft: d.planIncluded.vmHoursRemaining,
      periodEnd: Number.isFinite(end) ? end : null,
      last24hHours: typeof d.last24hUsageSeconds === 'number' ? d.last24hUsageSeconds / 3600 : null,
      startsUsed: typeof d.starts?.day?.used === 'number' ? d.starts.day.used : null,
      active: typeof d.activeSandboxes === 'number' ? d.activeSandboxes : null,
      walletHours: typeof d.packBalanceHours === 'number' ? d.packBalanceHours : typeof d.creditBalanceHours === 'number' ? d.creditBalanceHours : null,
    }
  }

  async create(o: { name: string; size: string; environment: string; ttlSec: number }): Promise<string> {
    const r = await this.run(['new', '--environment', o.environment, '--type', o.size, '--name', o.name, '--ttl', String(o.ttlSec), '--json'], { timeoutSec: this.callTimeoutSec * 3 })
    const id = CliBoat.json(r.out).find((x) => typeof x.id === 'string')?.id
    if (!id) throw new Error(`boat new failed (${r.code}): ${plain(r.out).trim().slice(-500)}`)
    return id
  }

  async resume(id: string): Promise<void> {
    await this.ok(['resume', id, '--json'])
  }
  async hydrated(id: string): Promise<boolean | null> {
    const out = await this.ok(['info', id, '--json'])
    const s = CliBoat.json(out).find((o) => o.sandbox && typeof o.sandbox === 'object')?.sandbox
    return typeof s?.hydrated === 'boolean' ? s.hydrated : null
  }
  async stop(id: string): Promise<void> {
    await this.ok(['stop', id, '--json'])
  }
  async delete(id: string): Promise<void> {
    await this.ok(['delete', id, '--yes', '--json'])
  }
  async extend(id: string, ttlSec: number): Promise<void> {
    await this.ok(['extend', id, '--ttl', String(ttlSec), '--json'])
  }
  async scp(local: string, id: string, remote: string, o: { timeoutSec?: number; signal?: AbortSignal } = {}): Promise<void> {
    await this.ok(['scp', local, `${id}:${remote}`], o.timeoutSec, o.signal)
  }
  async download(id: string, remote: string, local: string): Promise<void> {
    await this.ok(['scp', `${id}:${remote}`, local])
  }
  async rename(id: string, name: string): Promise<void> {
    await this.ok(['rename', id, name, '--json'])
  }

  async exec(id: string, cmd: string, o: ExecOpts = {}): Promise<{ code: number | null; out: string }> {
    const st = newFrameState()
    let out = ''
    const emit = (s: string) => {
      if (!s) return
      out = keep(out, s)
      o.onData?.(s)
    }
    const r = await this.run(['exec', id, '--timeout', '0', '--', 'bash', '-lc', cmd], {
      onChunk: (c) => emit(parseFrames(c, st).out),
      signal: o.signal,
      timeoutSec: o.timeoutSec,
    })
    emit(parseFrames('', st, true).out)
    if (r.timedOut) return { code: 124, out: tail(out) }
    // no exit frame = the command's status never came back (a lost connection): no exit status, an infra failure
    return { code: st.exitCode ?? null, out: tail(out) }
  }
}
