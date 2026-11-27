// test-broker, the client. `run` is the normal path: ask, then run here with the granted CPUs, follow the Boat run,
// or exit 75 with the busy reasons. It never blocks a dev: when the daemon can't be reached (or can't read the
// repo's config) it runs the command directly with a one-line warning.
import type { BoatPeek } from './boat-side.ts'
import type { PeekInfo } from './broker.ts'
import { execFileSync, spawn } from 'node:child_process'
import { createConnection, type Socket } from 'node:net'
import { availableParallelism } from 'node:os'
import { socketPath, stateDir } from './machine-config.ts'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { RunsDb } from './runs-db.ts'
import { formatRuns, formatUsage, usageReport } from './usage.ts'
import type { Answer } from './broker.ts'
import type { BusyReason } from './admit.ts'
import type { RunEvent } from './server.ts'

export const EXIT_BUSY = 75
/** a heavy run steered off: nothing ran; the message says why and how to run it anyway */
export const EXIT_ADVISED = 76
// how long `run` waits for the daemon's answer before it runs the command here. A Boat placement can be slow under load,
// and a run that gives up too soon runs the whole suite here with no lease, so wait well past a normal answer (about
// a second); say so after SLOW_ANSWER_MS.
const ANSWER_TIMEOUT_MS = Number(process.env.TEST_BROKER_ANSWER_MS) || 60_000
const SLOW_ANSWER_MS = Math.min(Number(process.env.TEST_BROKER_SLOW_MS) || 10_000, ANSWER_TIMEOUT_MS)
/** TEST_BROKER_CPUS for a run that goes direct while the daemon is up (slow or erroring): a quarter of the machine,
 *  so a fallback run can't swamp the box the daemon is sharing out */
export const fallbackCpus = (nproc: number) => Math.max(1, Math.floor(nproc / 4))

const USAGE = `test-broker — fast admission for local test runs (never queues)

  test-broker run [--cpus N] [--no-boat] [--force-load] [--json] <suite> [suite args…] -- <command…>
        ask, then: run <command> here with TEST_BROKER_CPUS set (holding the lease until it exits), or follow the
        Boat run (suite args go to its passArgs shards), or exit ${EXIT_BUSY} with why (busy), or exit ${EXIT_ADVISED} with
        the repo's advice (a heavy run steered off; TEST_BROKER_CONFIRM="<why>" runs it anyway). --json prints the answer as one JSON line on stdout first.
        --force-load skips the load check (never a lock). Daemon down: runs <command> directly; daemon up but no answer
        in 60s (or an error): runs it directly with TEST_BROKER_CPUS at a quarter of the machine.
  test-broker ask <suite> [--cpus N] [--no-boat] [--json]
        peek: what a run would get now, here and on Boat (per shard: now, a wait for a busy box, a resume or a
        create, and its usual time), the pool, today's budget and the steering checks. Takes no lease, no claim and
        starts nothing: use it to decide whether to run a heavy suite now or batch more changes first. Exit 0 when
        the run would start now (on Boat, or here), ${EXIT_BUSY} when it would be busy (here, and Boat cannot take it now)
  test-broker hint --worktree <path> [--ttl 60m] [--gone]
        optional information for the warm pool: an agent works in <path> and tests are likely soon (--ttl: how long
        that holds with no test run; 30m, 2h or minutes), or the worktree is gone. Exits 0 (also with the daemon
        down or outside a worktree), so a worktree hook can call it as is; 2 only for bad arguments
  test-broker status [--json]           leases, box load, Boat boxes and runs
  test-broker logs <run> [-f]           a Boat run's output; -f follows
  test-broker cancel <run>
  test-broker boxes [--json]            the Boat pool's boxes: speed score (a shard's time ÷ the same shard's on other
        boxes; 1.0 = as fast as its peers), slow, drained; slowest first
  test-broker box drain <box> [--reason "<why>"]
        no new shards on the box (its name, Boat id, or last 6 characters); it is deleted once free and the pool makes
        a new one when it needs one. For a box you know is bad; slow boxes are found and retired on their own
  test-broker box undrain <box>         undo a drain of a box not deleted yet
  test-broker box probe <box>           a speed and health check of an idle running box now (about 15 s; a stopped
        box is not started for it). test-brokerd probes idle boxes itself after each start and every 30 min
  test-broker reset                     quarantined Boat boxes become usable again (as stopped; their fail counts cleared)
  test-broker usage [--days N] [--repo owner/name] [--runs] [--json]
        Boat and local test use per day and repo (plan hours: 1 = a default box for an hour, large = 2/h), the
        costliest suites, today's box hours against the daily target (the plan's hours left over the days left), and
        steering counts; --runs lists every run (worktree, branch, suite, cost, result, steering)
`

type Msg = { t: 'answer'; answer: Answer } | { t: 'run'; run: string; event: RunEvent } | { t: 'status'; [k: string]: unknown } | { t: 'ok' } | { t: 'reset'; boxes: number } | { t: 'boxes'; [k: string]: unknown } | { t: 'drain'; box: string; state: string; deleted: boolean } | { t: 'undrain'; box: string; was: { by: string; reason: string } } | { t: 'probe'; [k: string]: unknown } | { t: 'end' } | { t: 'error'; error: string }

class Conn {
  private buf = ''
  private waiters: ((m: Msg | null) => void)[] = []
  private queue: (Msg | null)[] = []
  readonly s: Socket
  private constructor(s: Socket) {
    this.s = s
    s.setEncoding('utf8')
    s.on('data', (d: string) => {
      this.buf += d
      let i: number
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i)
        this.buf = this.buf.slice(i + 1)
        try {
          this.push(JSON.parse(line))
        } catch {}
      }
    })
    s.on('close', () => this.push(null))
    s.on('error', () => {})
  }
  private push(m: Msg | null) {
    const w = this.waiters.shift()
    if (w) w(m)
    else this.queue.push(m)
  }
  static open(path = socketPath()): Promise<Conn | null> {
    return new Promise((resolve) => {
      const s = createConnection(path)
      s.once('connect', () => resolve(new Conn(s)))
      s.once('error', () => resolve(null))
    })
  }
  send(o: unknown) {
    this.s.write(`${JSON.stringify(o)}\n`)
  }
  /** the next message; null = the daemon closed the connection */
  next(): Promise<Msg | null> {
    if (this.queue.length) return Promise.resolve(this.queue.shift()!)
    if (this.queue.length === 0 && this.s.destroyed) return Promise.resolve(null)
    return new Promise((resolve) => this.waiters.push(resolve))
  }
  close() {
    this.s.end()
    this.s.destroy()
  }
}

type Flags = { cpus?: number; noBoat?: boolean; forceLoad?: boolean; json?: boolean; follow?: boolean }

function parseFlags(argv: string[]): { flags: Flags; rest: string[]; cmd: string[] } {
  const flags: Flags = {}
  const rest: string[] = []
  let cmd: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') {
      cmd = argv.slice(i + 1)
      break
    }
    if (a === '--cpus') {
      const n = Number(argv[++i])
      if (!Number.isInteger(n) || n < 1) throw new UsageError('--cpus needs a whole number ≥ 1')
      flags.cpus = n
    } else if (a === '--no-boat') flags.noBoat = true
    else if (a === '--force-load') flags.forceLoad = true
    else if (a === '--json') flags.json = true
    else if (a === '-f' || a === '--follow') flags.follow = true
    else if (a.startsWith('-') && !rest.length) throw new UsageError(`unknown option ${a}`)
    // after the suite name, anything that isn't one of our flags is a suite arg (for Boat shards with passArgs)
    else rest.push(a)
  }
  return { flags, rest, cmd }
}

class UsageError extends Error {}

function worktreeRoot(): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    throw new UsageError('not inside a git worktree')
  }
}

const warn = (m: string) => process.stderr.write(`test-broker: ${m}\n`)

export function describeReason(r: BusyReason): string {
  switch (r.kind) {
    case 'lock':
      return `lock ${r.key} held by ${r.holder} since ${r.since}${r.etaSec != null ? ` (about ${r.etaSec}s left)` : ''}`
    case 'load':
      return `load: ${r.freeCpus} CPU(s) free, the suite needs at least ${r.needCpus}`
    case 'memory':
      return `memory: ${r.memAvailGb} GB available, the suite needs ${r.needGb} GB`
  }
}

function boxLine(a: Extract<Answer, { box: unknown }>): string {
  const b = a.box
  return `box: ${b.nproc} CPUs, load ${b.load1}, ${b.leasedCpus} leased, ${b.freeCpus} free, ${b.memAvailGb} GB mem available`
}

/** `p`'s value within `ms`, else undefined (`p` stays pending: wait on it again rather than asking for another) */
async function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let t: NodeJS.Timeout | undefined
  const v = await Promise.race([p, new Promise<undefined>((r) => (t = setTimeout(() => r(undefined), ms)))])
  clearTimeout(t)
  return v
}

/** Run `cmd` here and return its exit code (128+n for a signal). Signals to us go to it; we wait for it. */
function runHere(cmd: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit', env })
    const fwd = (sig: NodeJS.Signals) => () => p.kill(sig)
    const handlers = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((s) => [s, fwd(s)] as const)
    for (const [s, h] of handlers) process.on(s, h)
    p.on('error', (e) => {
      warn(`cannot run ${cmd[0]}: ${e.message}`)
      resolve(127)
    })
    p.on('exit', (code, sig) => {
      for (const [s, h] of handlers) process.off(s, h)
      resolve(code ?? 128 + (sig ? (({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGKILL: 9 }) as Record<string, number>)[sig] ?? 1 : 1))
    })
  })
}

async function followRun(c: Conn, run: string): Promise<{ code: number; notStarted: boolean }> {
  const partial = new Map<string, string>()
  const out = (shard: string, data: string) => {
    const s = (partial.get(shard) ?? '') + data
    const lines = s.split('\n')
    partial.set(shard, lines.pop()!)
    for (const l of lines) process.stdout.write(`[${shard}] ${l}\n`)
  }
  for (;;) {
    const m = await c.next()
    if (!m) {
      warn(`lost the daemon while following ${run}`)
      return { code: 2, notStarted: false }
    }
    if (m.t !== 'run') continue
    const e = m.event
    if (e.t === 'log') out(e.shard, e.data)
    else if (e.t === 'state') process.stderr.write(`test-broker: ${e.shard ? `[${e.shard}] ` : ''}${e.state}${e.message ? `: ${e.message}` : ''}\n`)
    else if (e.t === 'done') {
      for (const [shard, rest] of partial) if (rest) process.stdout.write(`[${shard}] ${rest}\n`)
      if (e.receipt) process.stdout.write(`\n${e.receipt}\n`)
      return { code: e.code, notStarted: !!(e as { notStarted?: boolean }).notStarted }
    }
  }
}

async function cmdRun(argv: string[]): Promise<number> {
  const { flags, rest, cmd } = parseFlags(argv)
  if (!rest.length || !cmd.length) throw new UsageError('usage: test-broker run [flags] <suite> [suite args…] -- <command…>')
  const [suite, ...args] = rest
  const direct = (why: string) => {
    warn(`${why}; running the command directly`)
    return runHere(cmd, process.env)
  }
  // the daemon is up but gave no usable answer: run here, at a capped CPU share (the daemon can't count this run)
  const capped = (why: string) => {
    const cpus = fallbackCpus(availableParallelism())
    warn(`${why}; running the command directly with TEST_BROKER_CPUS=${cpus}`)
    return runHere(cmd, { ...process.env, TEST_BROKER_CPUS: String(cpus) })
  }
  let root: string
  try {
    root = worktreeRoot()
  } catch (e) {
    return direct((e as Error).message)
  }
  const c = await Conn.open()
  if (!c) return direct(`test-brokerd is not running (no answer on ${socketPath()})`)
  let noBoat = !!flags.noBoat
  for (;;) {
    const confirm = process.env.TEST_BROKER_CONFIRM?.trim() || undefined
    c.send({ op: 'ask', root, suite, args, flags: { cpus: flags.cpus, noBoat, forceLoad: flags.forceLoad, ...(confirm ? { confirm } : {}) }, pid: process.pid, hold: true })
    // the daemon answers in about a second; a slow one must not hold the dev up (closing drops what it would grant)
    const answer = c.next()
    let m = await within(answer, SLOW_ANSWER_MS)
    if (m === undefined && ANSWER_TIMEOUT_MS > SLOW_ANSWER_MS) {
      warn(`test-brokerd has not answered in ${SLOW_ANSWER_MS / 1000}s; waiting up to ${ANSWER_TIMEOUT_MS / 1000}s`)
      m = await within(answer, ANSWER_TIMEOUT_MS - SLOW_ANSWER_MS)
    }
    if (!m || m.t !== 'answer') {
      c.close()
      return capped(m?.t === 'error' ? `daemon error: ${m.error}` : m ? 'unexpected reply from the daemon' : m === null ? 'test-brokerd closed the connection' : `no answer from test-brokerd within ${ANSWER_TIMEOUT_MS / 1000}s`)
    }
    const a = m.answer
    if (flags.json) process.stdout.write(`${JSON.stringify(a)}\n`)
    if (a.decision === 'error') {
      c.close()
      return capped(a.error)
    }
    if (a.decision === 'advise') {
      c.close()
      process.stderr.write(`${a.advise.message}\n`)
      return EXIT_ADVISED
    }
    if (a.decision === 'busy') {
      c.close()
      warn(`busy — not started. Retry in about ${a.busy.retryAfterSec}s, ask with fewer --cpus, or run the direct command.`)
      for (const r of a.busy.reasons) warn(`  ${describeReason(r)}`)
      if (a.busy.boatWhy) warn(`  boat: ${a.busy.boatWhy}`)
      warn(`  ${boxLine(a)}`)
      return EXIT_BUSY
    }
    if (a.decision === 'local') {
      warn(`running here with ${a.local.cpus} CPU(s) (lease ${a.local.lease}${a.local.locks.length ? `, locks ${a.local.locks.join(', ')}` : ''})${a.boatWhy ? `; boat: ${a.boatWhy}` : ''}`)
      let lost = false
      c.s.once('close', () => (lost = true))
      const code = await runHere(cmd, { ...process.env, TEST_BROKER_CPUS: String(a.local.cpus), TEST_BROKER_LEASE: a.local.lease })
      if (lost) warn('the daemon went away during the run; the lease was lost')
      else {
        c.send({ op: 'done', lease: a.local.lease, code })
        await c.next()
      }
      c.close()
      return code
    }
    warn(`running on Boat: ${a.boat.run} (${a.boat.shards} shard(s)); Ctrl-C cancels it`)
    const r = await followRun(c, a.boat.run)
    if (r.notStarted && !noBoat) {
      warn('Boat did not start in time; asking again without Boat')
      noBoat = true
      continue
    }
    c.close()
    return r.code
  }
}

async function cmdAsk(argv: string[]): Promise<number> {
  const { flags, rest } = parseFlags(argv)
  if (rest.length !== 1) throw new UsageError('usage: test-broker ask <suite> [flags]')
  const c = await Conn.open()
  if (!c) {
    warn(`test-brokerd is not running (no answer on ${socketPath()})`)
    return 2
  }
  c.send({ op: 'ask', root: worktreeRoot(), suite: rest[0], flags: { cpus: flags.cpus, noBoat: flags.noBoat, forceLoad: flags.forceLoad }, pid: process.pid, hold: false })
  const m = await c.next()
  c.close()
  if (!m || m.t !== 'answer') {
    warn(m?.t === 'error' ? m.error : 'no answer')
    return 2
  }
  const a = m.answer
  if (flags.json) process.stdout.write(`${JSON.stringify(a)}\n`)
  else if (a.decision === 'error') warn(a.error)
  else if (a.decision === 'busy') {
    process.stdout.write(`busy (retry in about ${a.busy.retryAfterSec}s)\n`)
    for (const r of a.busy.reasons) process.stdout.write(`  ${describeReason(r)}\n`)
    process.stdout.write(`  ${boxLine(a)}\n`)
  } else if (a.decision === 'local') process.stdout.write(`local: ${a.local.cpus} CPU(s)${a.boatWhy ? ` (boat: ${a.boatWhy})` : ''}\n  ${boxLine(a)}\n`)
  if (!flags.json && a.decision === 'busy' && askExit(a) === 0) process.stdout.write('  (busy here, but Boat would run it now: a run goes to Boat)\n')
  if (!flags.json && (a.decision === 'local' || a.decision === 'busy') && a.peek) process.stdout.write(peekText(a.peek))
  return askExit(a)
}

/** `ask`'s exit code: a suite Boat would run now is not busy, however busy this machine is */
export function askExit(a: Answer): number {
  if (a.decision === 'error') return 2
  if (a.decision !== 'busy') return 0
  const b = a.peek?.boat
  return b && b.shards.length && b.shards.every((s) => s.how !== 'none') ? 0 : EXIT_BUSY
}

/** '60m', '2h', '90s' or a bare number of minutes → minutes (null: not a duration) */
export function parseTtl(v: string): number | null {
  const m = /^(\d+(?:\.\d+)?)([smh]?)$/.exec(v.trim())
  if (!m) return null
  const n = Number(m[1]) * (m[2] === 's' ? 1 / 60 : m[2] === 'h' ? 60 : 1)
  return n > 0 && n <= 1440 ? n : null
}

/** `hint`: one line to the daemon, no wait for anything but its ok (1 s at most); always exit 0 unless misused */
async function cmdHint(argv: string[]): Promise<number> {
  let worktree: string | null = null
  let ttlMin: number | null = null
  let gone = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--worktree') worktree = argv[++i] ?? null
    else if (a === '--ttl') {
      ttlMin = parseTtl(argv[++i] ?? '')
      if (ttlMin == null) throw new UsageError('--ttl takes a duration up to 24h: 30m, 2h, 90s or minutes')
    } else if (a === '--gone') gone = true
    else throw new UsageError('usage: test-broker hint --worktree <path> [--ttl 60m] [--gone]')
  }
  if (!worktree) throw new UsageError('usage: test-broker hint --worktree <path> [--ttl 60m] [--gone]')
  // the worktree's top level, as a run's ask names it; a gone worktree no longer there: the path as given
  let root = resolve(worktree)
  try {
    root = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim() || root
  } catch {
    if (!gone) return 0
  }
  const c = await Conn.open()
  if (!c) return 0
  c.send({ op: 'hint', root, gone, ...(ttlMin != null ? { ttlMin } : {}) })
  await within(c.next(), 1000)
  c.close()
  return 0
}

/** a peek's Boat part and steering, for people and agents deciding whether to run now */
export function peekText(p: PeekInfo): string {
  const L: string[] = []
  const b = p.boat
  if (b) {
    const what = (s: BoatPeek['shards'][number]) =>
      s.how === 'shared' || s.how === 'reused' ? `now on ${s.box} (${s.how})`
      : s.how === 'wait' ? `waits about ${s.startSec}s for ${s.box}`
      : s.how === 'resume' ? `resumes ${s.box} (about ${s.startSec}s)`
      : s.how === 'create' ? `creates a box (about ${s.startSec}s)`
      : 'no box now (it would run here)'
    L.push(`boat: ${b.shards.length} shard(s)`)
    for (const s of b.shards) L.push(`  ${s.name}: ${what(s)}${s.runSec != null ? `, then about ${s.runSec}s` : ''}`)
    const q = b.pool
    L.push(`  pool: ${q.busy} busy, ${q.idle} idle, ${q.starting} starting, ${q.stopped} stopped${q.quarantined ? `, ${q.quarantined} quarantined` : ''}; ${q.waiting} shard(s) waiting`)
    if (b.budget) {
      const g = b.budget
      L.push(`  budget: ${g.todayHours} of ${g.targetHours} plan hours today (pressure ${Number.isFinite(g.pressure) ? g.pressure : 'over'})${g.walletHours != null ? `; wallet ${Math.round(g.walletHours)} h` : ''}`)
    }
  }
  for (const r of p.steer) L.push(`steer ${r.check} (${r.mode}): ${r.message}`)
  return L.length ? `${L.join('\n')}\n` : ''
}

async function cmdReset(argv: string[]): Promise<number> {
  if (argv.length) throw new UsageError('usage: test-broker reset')
  const c = await Conn.open()
  if (!c) {
    warn(`test-brokerd is not running (no answer on ${socketPath()})`)
    return 2
  }
  c.send({ op: 'reset' })
  const m = await c.next()
  c.close()
  if (m?.t === 'error') warn(m.error)
  if (m?.t !== 'reset') return 1
  process.stdout.write(`${m.boxes} quarantined box(es) back as stopped\n`)
  return 0
}

type BoxesView = {
  speed: { mode: string; slowAt: number; clearAt: number; retireAfterMin: number; maxRetirePerDay: number; minSamples: number }
  retiredToday: number
  boxes: { name: string; size: string; state: string; score: number | null; samples: number; slow: boolean; slowMin: number | null; drain: { by: string; reason: string } | null; infraFails: number; probe?: { score: number; disk: number; probes: number } | null; probedMin?: number | null; probing?: boolean }[]
}

export function boxesText(v: BoxesView): string {
  const s = v.speed
  const L = [`speed: mode ${s.mode}, slow at ${s.slowAt}x (${s.minSamples}+ shards), normal again below ${s.clearAt}x${s.mode === 'retire' ? `, retired after ${s.retireAfterMin} min slow if it ran again (${v.retiredToday} of ${s.maxRetirePerDay} in the last 24 h)` : ''}`]
  const w = Math.max(4, ...v.boxes.map((b) => b.name.length))
  L.push(`${'box'.padEnd(w)}  ${'state'.padEnd(11)}  score  shards  probe  disk  probed  note`)
  for (const b of v.boxes) {
    const note = [
      b.slow ? `slow${b.slowMin != null ? ` for ${b.slowMin} min` : ''}` : '',
      b.drain ? `drained (${b.drain.by}: ${b.drain.reason})` : '',
      b.infraFails ? `${b.infraFails} infra fail(s)` : '',
      b.probing ? 'probing now' : '',
    ].filter(Boolean).join('; ')
    const p = b.probe
    const ago = b.probedMin != null ? `${b.probedMin}m ago` : '-'
    L.push(`${b.name.padEnd(w)}  ${b.state.padEnd(11)}  ${(b.score != null ? b.score.toFixed(2) : '-').padStart(5)}  ${String(b.samples).padStart(6)}  ${(p ? p.score.toFixed(2) : '-').padStart(5)}  ${(p ? p.disk.toFixed(2) : '-').padStart(4)}  ${ago.padStart(6)}  ${note}`)
  }
  return `${L.join('\n')}\n`
}

async function cmdBoxes(argv: string[]): Promise<number> {
  const json = argv.includes('--json')
  if (argv.some((a) => a !== '--json')) throw new UsageError('usage: test-broker boxes [--json]')
  const c = await Conn.open()
  if (!c) {
    warn(`test-brokerd is not running (no answer on ${socketPath()})`)
    return 2
  }
  c.send({ op: 'boxes' })
  const m = await c.next()
  c.close()
  if (m?.t === 'error') warn(m.error)
  if (m?.t !== 'boxes') return 1
  const { t: _t, ...v } = m
  process.stdout.write(json ? `${JSON.stringify(v)}\n` : boxesText(v as unknown as BoxesView))
  return 0
}

async function cmdBox(argv: string[]): Promise<number> {
  const [verb, ...rest] = argv
  const usage = 'usage: test-broker box drain <box> [--reason "<why>"] | test-broker box undrain <box> | test-broker box probe <box>'
  if (verb !== 'drain' && verb !== 'undrain' && verb !== 'probe') throw new UsageError(usage)
  let box: string | null = null
  let reason: string | null = null
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--reason' && verb === 'drain') reason = rest[++i] ?? null
    else if (!box && !rest[i].startsWith('-')) box = rest[i]
    else throw new UsageError(usage)
  }
  if (!box) throw new UsageError(usage)
  const c = await Conn.open()
  if (!c) {
    warn(`test-brokerd is not running (no answer on ${socketPath()})`)
    return 2
  }
  c.send({ op: verb, box, ...(reason ? { reason } : {}) })
  const m = await c.next()
  c.close()
  if (m?.t === 'error') {
    warn(m.error)
    return 1
  }
  if (m?.t === 'probe') {
    const x = m as unknown as { box: string; aborted: boolean; faults: string[]; secs: number; result: Record<string, unknown> | null; score: { score: number; cpu: number; disk: number; probes: number } | null }
    if (x.aborted) process.stdout.write(`${x.box}: probe stopped: a shard took the box\n`)
    else {
      const r = x.result ?? {}
      process.stdout.write(`${x.box}: ${x.faults.length ? `FAULT: ${x.faults.join('; ')}` : 'healthy'} (${x.secs}s)\n`)
      process.stdout.write(`  cpu ${r.cpu1}s one core, ${r.cpuN}s all ${r.nproc}; disk write ${r.write}s, read ${r.read}s; repo ${r.repoMb ?? '-'} MB in ${r.repoSecs ?? '-'}s; ${r.freeGb} GB free, ${r.memMb} MB RAM free, IO pressure ${r.ioSome ?? '-'}\n`)
      process.stdout.write(x.score ? `  probe score ${x.score.score}x the other boxes (disk ${x.score.disk}x) over ${x.score.probes} probe(s)\n` : '  no probe score yet (needs probes of 2 other boxes of its size)\n')
    }
    return x.faults.length ? 1 : 0
  }
  if (m?.t === 'drain') process.stdout.write(`${m.box}: drained; ${m.deleted ? 'it was free: deleted now' : `it is ${m.state}: deleted once free`}\n`)
  else if (m?.t === 'undrain') process.stdout.write(`${m.box}: undrained (was drained by ${m.was.by}: ${m.was.reason})\n`)
  else return 1
  return 0
}

async function cmdSimple(op: 'status' | 'logs' | 'cancel', argv: string[]): Promise<number> {
  const { flags, rest } = parseFlags(argv)
  const c = await Conn.open()
  if (!c) {
    warn(`test-brokerd is not running (no answer on ${socketPath()})`)
    return 2
  }
  if (op === 'status') {
    c.send({ op })
    const m = await c.next()
    c.close()
    if (!m || m.t !== 'status') return 2
    const { t: _t, ...s } = m
    if (flags.json) process.stdout.write(`${JSON.stringify(s)}\n`)
    else process.stdout.write(`${JSON.stringify(s, null, 2)}\n`)
    return 0
  }
  if (rest.length !== 1) throw new UsageError(`usage: test-broker ${op} <run>${op === 'logs' ? ' [-f]' : ''}`)
  if (op === 'cancel') {
    c.send({ op, run: rest[0] })
    const m = await c.next()
    c.close()
    if (m?.t === 'error') warn(m.error)
    return m?.t === 'ok' ? 0 : 1
  }
  c.send({ op, run: rest[0], follow: !!flags.follow })
  for (;;) {
    const m = await c.next()
    if (!m || m.t === 'end') break
    if (m.t === 'error') {
      warn(m.error)
      c.close()
      return 1
    }
    if (m.t !== 'run') continue
    const e = m.event
    if (e.t === 'log') process.stdout.write(e.data)
    else if (e.t === 'state') process.stderr.write(`[${e.shard ?? 'run'}] ${e.state}${e.message ? `: ${e.message}` : ''}\n`)
    else if (e.t === 'done') {
      if (e.receipt) process.stdout.write(`\n${e.receipt}\n`)
      break
    }
  }
  c.close()
  return 0
}

const USAGE_HELP = `test-broker usage [--days N] [--repo owner/name] [--runs] [--json]

What tests cost on this machine and on Boat, from ~/.local/state/test-broker/runs.db (read directly: works with
the daemon down). Times are UTC; days are UTC days.

  --days N     the last N days, today included (default 7, at most 366)
  --repo R     only owner/name R
  --runs       also list every run, newest first
  --json       one JSON object instead of the tables (the interface for agents and scripts)

Plan hours: what Boat bills. 1 = 4 CPUs for an hour (a default box for an hour); a large box costs 2 an hour.
  shard-h  the CPUs each Boat shard held, for its run time
  box-h    each box's up time (creating, resuming, idle, busy), idle tail included, charged to the repo it last
           ran: this is what Boat bills, and what the daily budget counts

JSON (fields are added, never renamed; read this, not runs.db, whose schema may change):
  from, to                 the window (UTC days)
  days[]                   { day, repos: { "<owner/name>": { runs, boat, local, failed, cpuMin, shardHours, boxHours } } }
  suites[]                 { repo, suite, shape, runs, medianCpuMin, shardHours, boat, local, heavy }, costliest first
  today                    { day, boxHours, target, hoursLeft, daysLeft, boatLast24h, at }
                           target: today's plan hours (hours left at the day's first Boat snapshot over the days left)
  steer[]                  { repo, check, advised, wouldAdvise, confirmed } per steering check (sameTree,
                           perWorktree, budget): advised = not run (exit 76); wouldAdvise = log mode, ran;
                           confirmed = ran on a TEST_BROKER_CONFIRM reason
  runs[] (with --runs)     one per run test-broker admitted (or advised):
    id, repo, worktree (the caller's worktree root: match it to an agent's session), branch, head, tree
    suite, shape (whole | narrowed: suite args were given), argsN
    where (boat | local | advised), boatWhy (why a run went local)
    startedAt, endedAt (ISO), secs, exitCode (75 busy and 76 advised never reach here as runs; 3 = Boat did not
      start in time: the caller then usually ran it local, as the next run), endedHow (done | released | not
      started | error | advised)
    cpus, cpuMin (CPUs x minutes), planHours (Boat shards), heavy (the learned class at the ask)
    steer { checks[] { check, mode (log | advise), message }, advised, confirm } or null
    shards[] { name, box, size, units, memMb, secs, code, peakRamMb, cpuMean, cpuP95, how (reused | shared |
      resumed | created), waitSecs (it waited for a busy box), waitGaveUp, log } (Boat runs)
      log: its output in short, kept after the log file is compressed or deleted: { bytes, lines, phases[] { name,
        secs } (the remote script's timed steps), tests { passed, failed, skipped } or null, failing[] (test
        names, at most 20), sources[] { source, bytes } (vitest console blocks by file, biggest first, and "(rest)") }
  pool[]                   per day, the Boat pool: { day, waits, waitMedianSec, startsAvoided, gaveUp,
                           notStartedAfterGiveUp, starts, hours { busy, gap, tail, earlyTail, starting, idleShare },
                           earlyStops, earlyStopsThenStart } (plan hours; earlyTail and earlyStops: the warm pool
                           stopped an idle box past its target early; ThenStart: a box start of that size followed
                           within 10 min)

Not recorded: runs that bypass test-broker (TEST_BROKER_OFF, *-direct recipes, a bare pytest or vitest), and the
client's own direct runs when the daemon is down or does not answer.
`

/** `usage`: read runs.db directly (works with the daemon down; read-only) */
function cmdUsage(argv: string[]): number {
  let days = 7
  let repo: string | undefined
  let json = false
  let runs = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') json = true
    else if (a === '--days') days = Number(argv[++i])
    else if (a === '--repo') repo = argv[++i]
    else if (a === '--runs') runs = true
    else if (a === '-h' || a === '--help') {
      process.stdout.write(USAGE_HELP)
      return 0
    } else throw new UsageError(`usage: test-broker usage [--days N] [--repo owner/name] [--runs] [--json] (--help for more)`)
  }
  if (!Number.isInteger(days) || days < 1 || days > 366) throw new UsageError('--days takes 1 to 366')
  const file = join(stateDir(), 'runs.db')
  if (!existsSync(file)) {
    warn(`no usage recorded yet (${file} does not exist)`)
    return 1
  }
  const db = new RunsDb(file, { readOnly: true })
  try {
    const u = usageReport(db, { days, repo, runs })
    process.stdout.write(json ? `${JSON.stringify(u)}\n` : `${formatUsage(u)}${runs ? `\n\n${formatRuns(u.runs ?? [])}` : ''}\n`)
  } finally {
    db.close()
  }
  return 0
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv
  try {
    switch (cmd) {
      case 'run':
        return await cmdRun(rest)
      case 'ask':
        return await cmdAsk(rest)
      case 'status':
      case 'logs':
      case 'cancel':
        return await cmdSimple(cmd, rest)
      case 'reset':
        return await cmdReset(rest)
      case 'boxes':
        return await cmdBoxes(rest)
      case 'box':
        return await cmdBox(rest)
      case 'hint':
        return await cmdHint(rest)
      case 'usage':
        return cmdUsage(rest)
      case undefined:
      case '-h':
      case '--help':
      case 'help':
        process.stdout.write(USAGE)
        return cmd ? 0 : 2
      default:
        throw new UsageError(`unknown command ${cmd}`)
    }
  } catch (e) {
    if (e instanceof UsageError) {
      warn(e.message)
      return 2
    }
    throw e
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2)).then((c) => {
    // exit only after stdout drains: process.exit() can cut a pending write to a pipe (status was cut at 8 KB)
    process.exitCode = c
    process.stdout.write('', () => process.exit(c))
  })
