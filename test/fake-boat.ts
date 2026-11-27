// In-memory Boat for tests. Each box gets its own temp HOME; `exec` runs the command with real bash there (so the
// wrapper and its process-group kill are tested for real), unless `onCommand` takes it. Starts are counted against a
// budget like the real account. `gate` holds create/resume/stop until the test resolves it (transitional states).
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Boat, Box, EnvInfo, ExecOpts, Starts } from '../src/core/boat.ts'

type FakeBox = Box & { home: string }

// A fake box shares the host's CPUs. A packed large box pins slots to CPUs 4-7, which a smaller host (a 4-CPU CI
// runner) does not have: there the shim runs the command unpinned. Pinning itself is tested in test/ci/wrap.test.ts.
const SHIM_PATH = ((): string | null => {
  const real = spawnSync('bash', ['-c', 'command -v taskset'], { encoding: 'utf8' }).stdout.trim()
  if (!real) return null
  const dir = mkdtempSync(join(tmpdir(), 'fake-boat-bin-'))
  const f = join(dir, 'taskset')
  writeFileSync(f, `#!/bin/bash\nif [ "$1" = -c ] && ! ${real} -c "$2" true 2>/dev/null; then shift 2; exec "$@"; fi\nexec ${real} "$@"\n`)
  chmodSync(f, 0o755)
  return dir
})()
type Op = 'create' | 'resume' | 'stop' | 'delete' | 'list'

export class FakeBoat implements Boat {
  boxes: FakeBox[] = []
  budget: Starts = { day: 100, hour: 50, minute: 12 }
  startsUsed = 0
  calls: string[] = []
  failCreate = false
  failResume = false
  /** Make the next N list() calls throw. */
  failList = 0
  /** Make the next N starts() calls throw. */
  failStarts = 0
  /** Boxes whose every exec fails like an unreachable box. */
  unreachable = new Set<string>()
  /** Boxes whose every exec hangs until its timeout or signal. */
  hang = new Set<string>()
  /** A pending promise per op: the op waits for it (the test resolves it to let the op finish). */
  gate: Partial<Record<Op, Promise<void>>> = {}
  /**
   * Replace what a command does: return its exit code, or undefined to run it with real bash. Output goes through
   * `o.onData`.
   */
  onCommand?: (id: string, cmd: string, o: ExecOpts) => Promise<number | undefined> | number | undefined
  /** environments `envInfo` knows: a new box is pinned to its environment's version */
  envs: Record<string, { version: number; injects: string[] }> = {}
  failEnvInfo = false
  private n = 0

  addBox(name: string, state: string, type = 'default', extra: Partial<Box> = {}): FakeBox {
    const b: FakeBox = { id: `bx_${++this.n}`, name, state, type, environment: 'acme', home: mkdtempSync(join(tmpdir(), 'cib-box-')), ...extra }
    this.boxes.push(b)
    return b
  }
  get(id: string): FakeBox {
    const b = this.boxes.find((x) => x.id === id)
    if (!b) throw new Error(`no box ${id}`)
    return b
  }
  byName(name: string): FakeBox | undefined {
    return this.boxes.find((x) => x.name === name)
  }
  private spend() {
    if (this.budget.day <= 0 || this.budget.minute <= 0) throw new Error('start limit reached')
    this.budget.day--
    this.budget.minute--
    this.startsUsed++
  }
  private async wait(op: Op) {
    if (this.gate[op]) await this.gate[op]
  }

  async list() {
    this.calls.push('list')
    if (this.failList > 0) {
      this.failList--
      throw new Error('boat list failed (1): simulated outage')
    }
    // the answer is what Boat saw when asked; a gated list returns that snapshot later
    const snap = this.boxes.map(({ home: _h, ...b }) => ({ ...b }))
    await this.wait('list')
    return snap
  }
  async envInfo(name: string): Promise<EnvInfo> {
    this.calls.push(`env info ${name}`)
    if (this.failEnvInfo) throw new Error('boat env info failed (1): simulated outage')
    const e = this.envs[name]
    if (!e) throw new Error(`boat env info ${name}: no environment in output: {"error":"no environment named \"${name}\""}`)
    return { name, version: e.version, injects: [...e.injects] }
  }
  async envCreate(name: string) {
    this.calls.push(`env create ${name}`)
    this.envs[name] ??= { version: 1, injects: [] }
  }
  async envMakeSafe(name: string) {
    this.calls.push(`env safe ${name}`)
    const e = this.envs[name]
    // the master switch turns every toggle off; repos, files and variables stay
    if (e) this.envs[name] = { version: e.version + 1, injects: e.injects.filter((x) => ['repos', 'secret files', 'variables'].includes(x)) }
  }
  async starts() {
    this.calls.push('limits')
    if (this.failStarts > 0) {
      this.failStarts--
      throw new Error('boat limits failed')
    }
    return { ...this.budget }
  }
  async create(o: { name: string; size: string; environment: string; ttlSec: number }) {
    this.calls.push(`create ${o.name}`)
    await this.wait('create')
    if (this.failCreate) throw new Error('boat new failed: no_ready_machine')
    this.spend()
    const v = this.envs[o.environment]?.version
    return this.addBox(o.name, 'ready', o.size, { environment: o.environment, ...(v !== undefined ? { environmentVersion: v } : {}) }).id
  }
  async resume(id: string) {
    this.calls.push(`resume ${id}`)
    await this.wait('resume')
    if (this.failResume) throw new Error('boat resume failed')
    this.spend()
    const b = this.get(id)
    b.state = 'ready'
    delete b.stoppedAt
  }
  /** per box id: how many `hydrated` reads answer false before true (a just-started box loading its disk) */
  unhydrated = new Map<string, number>()
  async hydrated(id: string) {
    this.calls.push(`hydrated ${id}`)
    const n = this.unhydrated.get(id) ?? 0
    if (n > 0) {
      this.unhydrated.set(id, n - 1)
      return false
    }
    return true
  }
  async stop(id: string) {
    this.calls.push(`stop ${id}`)
    await this.wait('stop')
    const b = this.get(id)
    b.state = 'stopped'
    b.stoppedAt = Date.now()
  }
  async delete(id: string) {
    this.calls.push(`delete ${id}`)
    await this.wait('delete')
    this.boxes = this.boxes.filter((b) => b.id !== id)
  }
  async extend(id: string, ttlSec: number) {
    this.calls.push(`extend ${id} ${ttlSec}`)
  }
  async rename(id: string, name: string) {
    this.calls.push(`rename ${id} ${name}`)
    this.get(id).name = name
  }
  private path(id: string, remote: string) {
    return remote.replace(/^\/home\/user/, this.get(id).home)
  }
  async scp(local: string, id: string, remote: string, _o?: { timeoutSec?: number; signal?: AbortSignal }) {
    const dest = this.path(id, remote)
    // like real `boat scp`: the destination directory must already exist
    if (!existsSync(dirname(dest))) throw new Error(`boat scp failed (1): scp: dest open "${remote}": No such file or directory`)
    copyFileSync(local, dest)
  }
  async download(id: string, remote: string, local: string) {
    mkdirSync(dirname(local), { recursive: true })
    copyFileSync(this.path(id, remote), local)
  }

  async exec(id: string, cmd: string, o: ExecOpts = {}) {
    const b = this.get(id)
    if (b.state === 'stopped') return { code: 1, out: 'sandbox is stopped\n' }
    if (this.unreachable.has(id)) return { code: 255, out: 'connection refused\n' }
    if (this.hang.has(id))
      return new Promise<{ code: number; out: string }>((resolve) => {
        const t = o.timeoutSec === undefined ? null : setTimeout(() => resolve({ code: 124, out: '' }), o.timeoutSec * 1000)
        o.signal?.addEventListener('abort', () => (t && clearTimeout(t), resolve({ code: 143, out: '' })), { once: true })
      })
    this.calls.push(`exec ${id}`)
    if (this.onCommand) {
      const code = await this.onCommand(id, cmd, o)
      if (code !== undefined) return { code, out: '' }
    }
    return new Promise<{ code: number; out: string }>((resolve) => {
      const p = spawn('bash', ['-c', cmd], { env: { ...process.env, HOME: b.home, ...(SHIM_PATH ? { PATH: `${SHIM_PATH}:${process.env.PATH}` } : {}) }, cwd: b.home })
      let out = ''
      const on = (d: Buffer) => {
        out += d.toString()
        o.onData?.(d.toString())
      }
      p.stdout.on('data', on)
      p.stderr.on('data', on)
      const abort = () => p.kill('SIGTERM')
      if (o.signal?.aborted) abort()
      o.signal?.addEventListener('abort', abort, { once: true })
      p.on('close', (code) => {
        o.signal?.removeEventListener('abort', abort)
        resolve({ code: code ?? 1, out })
      })
    })
  }
}

/** Shard runs held by the test: each `cib-wrap.sh` run waits until finished (or its signal fires → 143). */
export class ShardControl {
  /** runs keep going when their signal fires (to see a job sit in `cancelling`) */
  ignoreAbort = false
  pending: { id: string; cmd: string; onData?: (s: string) => void; done: (code: number) => void }[] = []
  /** wire into FakeBoat.onCommand */
  handle = (id: string, cmd: string, o: ExecOpts): Promise<number> | undefined => {
    if (!cmd.includes('cib-wrap.sh" ') || cmd.includes('--kill')) return undefined
    return new Promise<number>((resolve) => {
      const entry = {
        id, cmd, onData: o.onData,
        done: (code: number) => {
          this.pending = this.pending.filter((x) => x !== entry)
          resolve(code)
        },
      }
      this.pending.push(entry)
      o.signal?.addEventListener('abort', () => !this.ignoreAbort && entry.done(143), { once: true })
    })
  }
  /** finish the pending run whose command mentions `match` (or the first) */
  finish(code: number, match?: string, out = '') {
    const e = this.pending.find((x) => !match || x.cmd.includes(match))
    if (!e) throw new Error(`no pending shard run${match ? ` matching ${match}` : ''}; pending: ${this.pending.map((x) => x.cmd).join(' | ')}`)
    if (out) e.onData?.(out)
    e.done(code)
  }
}
