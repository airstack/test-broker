// test-brokerd's unix socket: newline-delimited JSON, one request at a time per connection. A connection that got a
// lease (or started a Boat run) holds it until it closes; that is how a crashed caller frees what it held.
import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import type { Broker } from './broker.ts'

/** Boat runs as the server sees them (Release 2 fills this in). */
export interface Runs {
  /** a run's events: everything so far, synchronously, then live ones; returns an unsubscribe (null: no such run) */
  follow(run: string, fn: (e: RunEvent) => void): (() => void) | null
  cancel(run: string, why: string): boolean
  /** quarantined boxes become usable again (as stopped); returns how many */
  resetQuarantine(): number
  /** the connection that started these runs closed */
  ownerGone(owner: string): void
  status(): unknown
  /** a done run's log from its file (compressed or not), once the run left memory; null: none */
  readLog?(run: string): string | null
  /** the pool's boxes with their speed and drains */
  boxesView?(): unknown
  /** no new shards on a box; deleted once free */
  drainBox?(box: string, reason: string | null): { box: string; state: string; deleted: boolean } | { error: string }
  undrainBox?(box: string): { box: string; was: unknown } | { error: string }
  /** a speed and health probe of an idle running box, now */
  probeBox?(box: string): Promise<object | { error: string }>
}
export type RunEvent = { t: 'log'; shard: string; data: string } | { t: 'state'; shard?: string; state: string; message?: string } | { t: 'done'; code: number; receipt: string; notStarted?: boolean }

export type Req =
  | { op: 'ask'; root: string; suite: string; flags?: { cpus?: number; noBoat?: boolean; forceLoad?: boolean }; pid?: number; args?: string[]; hold?: boolean }
  | { op: 'done'; lease: string; code: number }
  | { op: 'status' }
  | { op: 'logs'; run: string; follow?: boolean }
  | { op: 'cancel'; run: string }
  | { op: 'reset' }
  | { op: 'hint'; root: string; ttlMin?: number; gone?: boolean }
  | { op: 'boxes' }
  | { op: 'drain'; box: string; reason?: string }
  | { op: 'undrain'; box: string }
  | { op: 'probe'; box: string }

const MAX_LINE = 1 << 20

export class BrokerServer {
  private server: Server | null = null
  private n = 0
  private conns = new Set<Socket>()
  private broker: Broker
  private runs: Runs | null
  private log: (m: string) => void
  constructor(broker: Broker, runs: Runs | null, log: (m: string) => void = (m) => console.error(m)) {
    this.broker = broker
    this.runs = runs
    this.log = log
  }

  /** Listen at `path` (0600). A socket file nobody answers on is removed first; one that answers means another daemon. */
  async listen(path: string): Promise<void> {
    mkdirSync(dirname(path), { recursive: true })
    if (existsSync(path)) {
      const alive = await new Promise<boolean>((resolve) => {
        const c = createConnection(path)
        c.once('connect', () => (c.destroy(), resolve(true)))
        c.once('error', () => resolve(false))
      })
      if (alive) throw new Error(`another test-brokerd answers on ${path}`)
      rmSync(path, { force: true })
    }
    const s = createServer((c) => this.onConn(c))
    await new Promise<void>((resolve, reject) => {
      s.once('error', reject)
      s.listen(path, () => resolve())
    })
    chmodSync(path, 0o600)
    this.server = s
  }

  close(): Promise<void> {
    for (const c of this.conns) c.destroy()
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()))
  }

  private onConn(c: Socket) {
    const owner = `c${++this.n}`
    this.conns.add(c)
    let buf = ''
    let busy: Promise<void> = Promise.resolve()
    const unsubs: (() => void)[] = []
    const send = (o: unknown) => {
      if (!c.destroyed) c.write(`${JSON.stringify(o)}\n`)
    }
    c.setEncoding('utf8')
    c.on('data', (d: string) => {
      buf += d
      if (buf.length > MAX_LINE) return void c.destroy()
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (!line.trim()) continue
        busy = busy.then(() => this.handle(line, owner, send, unsubs, c)).catch((e) => send({ t: 'error', error: (e as Error).message }))
      }
    })
    const gone = () => {
      if (!this.conns.delete(c)) return
      for (const u of unsubs) u()
      this.broker.release(owner)
      this.runs?.ownerGone(owner)
    }
    c.on('close', gone)
    c.on('error', gone)
  }

  private async handle(line: string, owner: string, send: (o: unknown) => void, unsubs: (() => void)[], c: Socket) {
    let r: Req
    try {
      r = JSON.parse(line)
    } catch {
      return send({ t: 'error', error: 'not JSON' })
    }
    switch (r.op) {
      case 'ask': {
        if (typeof r.root !== 'string' || typeof r.suite !== 'string') return send({ t: 'error', error: 'ask needs root and suite' })
        const a = await this.broker.ask({ root: r.root, suite: r.suite, flags: r.flags ?? {}, pid: r.pid ?? null, args: r.args ?? [] }, owner, !r.hold)
        if (c.destroyed || !this.conns.has(c)) {
          // the caller went away while the ask ran: what it got (a lease, a Boat run) goes with it
          this.broker.release(owner)
          this.runs?.ownerGone(owner)
          return
        }
        send({ t: 'answer', answer: a })
        if (a.decision === 'boat' && this.runs) {
          const u = this.runs.follow(a.boat.run, (e) => send({ t: 'run', run: a.boat.run, event: e }))
          if (u) unsubs.push(u)
        }
        return
      }
      case 'done':
        this.broker.done(String(r.lease), Number(r.code))
        return send({ t: 'ok' })
      case 'status':
        return send({ t: 'status', box: this.broker.boxView(), leases: this.broker.activeLeases(), boat: this.runs?.status() ?? null })
      case 'logs': {
        if (!this.runs) return send({ t: 'error', error: 'Boat is not set up on this machine' })
        // follow() replays what the run printed so far synchronously, then live events
        let ended = false
        const u = this.runs.follow(String(r.run), (e) => {
          if (ended) return
          send({ t: 'run', run: r.run, event: e })
          if (e.t === 'done') ended = true
        })
        if (!u) {
          // gone from memory (done runs are kept 2 h): its log file, compressed or not
          const text = this.runs.readLog?.(String(r.run)) ?? null
          if (text == null) return send({ t: 'error', error: `no run ${r.run}` })
          for (let i = 0; i < text.length; i += 65536) send({ t: 'run', run: r.run, event: { t: 'log', shard: '', data: text.slice(i, i + 65536) } })
          return send({ t: 'end' })
        }
        if (r.follow) return void unsubs.push(u)
        u()
        if (!ended) send({ t: 'end' })
        return
      }
      case 'cancel':
        if (!this.runs) return send({ t: 'error', error: 'Boat is not set up on this machine' })
        return send(this.runs.cancel(String(r.run), 'cancelled') ? { t: 'ok' } : { t: 'error', error: `no running run ${r.run}` })
      case 'hint': {
        if (typeof r.root !== 'string' || !r.root.startsWith('/')) return send({ t: 'error', error: 'hint needs an absolute root' })
        const ttl = Number(r.ttlMin)
        // answered at once: the hint is worked out after (a hint never holds up the caller)
        void this.broker.hint(r.root, { gone: !!r.gone, ...(ttl > 0 ? { ttlMs: Math.min(ttl, 1440) * 60_000 } : {}) }).catch(() => {})
        return send({ t: 'ok' })
      }
      case 'reset':
        if (!this.runs) return send({ t: 'error', error: 'Boat is not set up on this machine' })
        return send({ t: 'reset', boxes: this.runs.resetQuarantine() })
      case 'boxes':
        if (!this.runs?.boxesView) return send({ t: 'error', error: 'Boat is not set up on this machine' })
        return send({ t: 'boxes', ...(this.runs.boxesView() as object) })
      case 'drain':
      case 'undrain': {
        if (!this.runs?.drainBox || !this.runs.undrainBox) return send({ t: 'error', error: 'Boat is not set up on this machine' })
        if (typeof r.box !== 'string' || !r.box) return send({ t: 'error', error: `${r.op} needs a box` })
        const x = r.op === 'drain' ? this.runs.drainBox(r.box, typeof r.reason === 'string' ? r.reason : null) : this.runs.undrainBox(r.box)
        return send('error' in x ? { t: 'error', error: x.error } : { t: r.op, ...x })
      }
      case 'probe': {
        if (!this.runs?.probeBox) return send({ t: 'error', error: 'Boat is not set up on this machine' })
        if (typeof r.box !== 'string' || !r.box) return send({ t: 'error', error: 'probe needs a box' })
        const x = await this.runs.probeBox(r.box)
        return send('error' in x ? { t: 'error', error: x.error } : { t: 'probe', ...x })
      }
      default:
        return send({ t: 'error', error: `unknown op ${(r as { op?: unknown }).op}` })
    }
  }
}

/** the daemon's own log file (`<state>/test-brokerd.log`): the journal may not keep a user's lines (journald on
 *  volatile storage after a flush failure, or a user who may not read it) */
let logFile: string | null = null
const LOG_MAX_BYTES = 10 * 1024 * 1024
const LOG_KEEP = 3
let logBytes = -1
export function setServerLogFile(f: string | null) {
  logFile = f
  logBytes = -1
}

export function serverLog(m: string) {
  const line = `${new Date().toISOString()} ${m}\n`
  process.stderr.write(line)
  if (!logFile) return
  try {
    if (logBytes < 0) logBytes = existsSync(logFile) ? statSync(logFile).size : 0
    // rotate at 10 MB: test-brokerd.log.1 … .3 (40 MB at most)
    if (logBytes > LOG_MAX_BYTES) {
      for (let i = LOG_KEEP - 1; i >= 1; i--) if (existsSync(`${logFile}.${i}`)) renameSync(`${logFile}.${i}`, `${logFile}.${i + 1}`)
      renameSync(logFile, `${logFile}.1`)
      logBytes = 0
    }
    appendFileSync(logFile, line, { mode: 0o600 })
    logBytes += Buffer.byteLength(line)
  } catch {}
}
