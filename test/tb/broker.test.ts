// test-brokerd in-process on a temp socket; the real CLI (bin/test-broker) as a subprocess in a temp git repo.
import '../tmp-root.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { availableParallelism } from 'node:os'
import { createConnection } from 'node:net'
import { Broker } from '../../src/tb/broker.ts'
import { BrokerServer } from '../../src/tb/server.ts'
import { askExit, EXIT_BUSY, parseTtl } from '../../src/tb/cli.ts'
import type { Answer } from '../../src/tb/broker.ts'
import { MACHINE_DEFAULTS } from '../../src/tb/machine-config.ts'
import { makeOrigin, tmp, until } from '../harness.ts'

const BIN = join(import.meta.dirname, '..', '..', 'bin', 'test-broker')

function setup(o: { load1?: number; nproc?: number; suites?: Record<string, unknown> } = {}) {
  const root = tmp('tb-')
  const { work } = makeOrigin(join(root, 'origins'), 'me/app')
  writeFileSync(join(work, '.test-broker.json'), JSON.stringify({ suites: o.suites ?? { unit: { local: { cpus: 4, minCpus: 2, locks: ['db'] } }, lint: { local: { cpus: 1 } } } }))
  const box = { nproc: o.nproc ?? 8, load1: o.load1 ?? 0, memAvailGb: 16 }
  const logs: string[] = []
  const broker = new Broker({ cfg: structuredClone(MACHINE_DEFAULTS), stateDir: join(root, 'state'), box: () => box, repoOf: async () => 'me/app', log: (m) => logs.push(m) })
  const server = new BrokerServer(broker, null, (m) => logs.push(m))
  const sock = join(root, 'tb.sock')
  return { root, work, box, broker, server, sock, logs }
}

function cli(cwd: string, sock: string, args: string[]): { done: Promise<{ code: number; out: string; err: string }>; pid: number } {
  const p = spawn(BIN, args, { cwd, env: { ...process.env, TEST_BROKER_SOCKET: sock } })
  let out = ''
  let err = ''
  p.stdout.on('data', (d) => (out += d))
  p.stderr.on('data', (d) => (err += d))
  return { pid: p.pid!, done: new Promise((resolve) => p.on('close', (code) => resolve({ code: code ?? -1, out, err }))) }
}

test('run: local answer runs the command with TEST_BROKER_CPUS and ends the lease', async () => {
  const t = setup()
  await t.server.listen(t.sock)
  try {
    const r = await cli(t.work, t.sock, ['run', 'unit', '--', 'sh', '-c', 'echo cpus=$TEST_BROKER_CPUS; exit 3']).done
    assert.equal(r.code, 3)
    assert.match(r.out, /cpus=4/)
    assert.match(r.err, /running here with 4 CPU\(s\)/)
    assert.equal(t.broker.activeLeases().length, 0)
  } finally {
    await t.server.close()
  }
})

test('run: a lock held by another run is busy (exit 75, the holder named); it frees when that run ends', async () => {
  const t = setup()
  await t.server.listen(t.sock)
  try {
    const marker = join(t.root, 'go')
    const first = cli(t.work, t.sock, ['run', 'unit', '--', 'sh', '-c', `while [ ! -e ${marker} ]; do sleep 0.05; done`])
    await until(() => t.broker.activeLeases().length === 1, 'the first lease')
    const second = await cli(t.work, t.sock, ['run', 'unit', '--json', '--', 'true']).done
    assert.equal(second.code, 75)
    const a = JSON.parse(second.out.split('\n')[0])
    assert.equal(a.decision, 'busy')
    assert.equal(a.busy.reasons[0].kind, 'lock')
    assert.match(a.busy.reasons[0].holder, /^me\/app .* \(unit, pid \d+\)$/)
    assert.match(second.err, /busy — not started/)
    // another suite without the lock still runs
    assert.equal((await cli(t.work, t.sock, ['run', 'lint', '--', 'true']).done).code, 0)
    writeFileSync(marker, '')
    assert.equal((await first.done).code, 0)
    assert.equal(t.broker.activeLeases().length, 0)
    assert.equal((await cli(t.work, t.sock, ['run', 'unit', '--', 'true']).done).code, 0)
  } finally {
    await t.server.close()
  }
})

test('run: a killed caller frees its lease (the connection closes)', async () => {
  const t = setup()
  await t.server.listen(t.sock)
  try {
    const first = cli(t.work, t.sock, ['run', 'unit', '--', 'sleep', '30'])
    await until(() => t.broker.activeLeases().length === 1, 'the lease')
    process.kill(first.pid, 'SIGKILL')
    await first.done
    await until(() => t.broker.activeLeases().length === 0, 'the lease to end')
  } finally {
    await t.server.close()
  }
})

test('run: load below minCpus is busy; --force-load runs anyway', async () => {
  const t = setup({ load1: 7.5 })
  await t.server.listen(t.sock)
  try {
    const r = await cli(t.work, t.sock, ['run', 'unit', '--', 'true']).done
    assert.equal(r.code, 75)
    assert.match(r.err, /load: 0 CPU\(s\) free, the suite needs at least 2/)
    assert.equal((await cli(t.work, t.sock, ['run', 'unit', '--force-load', '--', 'true']).done).code, 0)
  } finally {
    await t.server.close()
  }
})

test('run: two runs share the CPU budget before load1 shows them', async () => {
  const t = setup({ nproc: 6 })
  await t.server.listen(t.sock)
  try {
    const marker = join(t.root, 'go')
    const wait = ['sh', '-c', `echo cpus=$TEST_BROKER_CPUS; while [ ! -e ${marker} ]; do sleep 0.05; done`]
    // unit: 4 CPUs of 6; a second unit run (minCpus 2) gets the last 2 — if not for the lock; use lint-like suites
    t.broker.cfg.budgetFactor = 1
    const a = cli(t.work, t.sock, ['run', 'lint', '--', ...wait])
    await until(() => t.broker.activeLeases().length === 1, 'lease 1')
    const b = cli(t.work, t.sock, ['run', 'unit', '--', ...wait])
    await until(() => t.broker.activeLeases().length === 2, 'lease 2')
    assert.deepEqual(t.broker.activeLeases().map((l) => l.cpus), [1, 4])
    const c = await cli(t.work, t.sock, ['run', 'lint', '--', 'true']).done
    assert.equal(c.code, 0) // 1 CPU left
    writeFileSync(marker, '')
    await Promise.all([a.done, b.done])
  } finally {
    await t.server.close()
  }
})

test('run fails open: no daemon, or no config → the command runs directly', async () => {
  const t = setup()
  const r = await cli(t.work, t.sock, ['run', 'unit', '--', 'sh', '-c', 'echo direct; echo "[$TEST_BROKER_CPUS]"']).done
  assert.equal(r.code, 0)
  assert.match(r.out, /direct\n\[\]/)
  assert.match(r.err, /test-brokerd is not running .* running the command directly/)
  await t.server.listen(t.sock)
  try {
    const other = tmp('tb-norepo-')
    const { work } = makeOrigin(join(other, 'o'), 'me/other')
    const r2 = await cli(work, t.sock, ['run', 'unit', '--', 'true']).done
    assert.equal(r2.code, 0)
    assert.match(r2.err, /\.test-broker\.json: not found .* running the command directly/)
    const r3 = await cli(t.work, t.sock, ['run', 'nope', '--', 'true']).done
    assert.equal(r3.code, 0)
    assert.match(r3.err, /no suite "nope"/)
  } finally {
    await t.server.close()
  }
})

test('ask is a peek: no lease; status lists leases', async () => {
  const t = setup()
  await t.server.listen(t.sock)
  try {
    const r = await cli(t.work, t.sock, ['ask', 'unit', '--json']).done
    assert.equal(r.code, 0)
    assert.equal(JSON.parse(r.out).decision, 'local')
    assert.equal(t.broker.activeLeases().length, 0)
    const s = await cli(t.work, t.sock, ['status', '--json']).done
    assert.equal(JSON.parse(s.out).box.nproc, 8)
  } finally {
    await t.server.close()
  }
})

test('listen refuses a socket another daemon answers on, and replaces a dead one', async () => {
  const t = setup()
  await t.server.listen(t.sock)
  const other = new BrokerServer(t.broker, null, () => {})
  await assert.rejects(other.listen(t.sock), /another test-brokerd/)
  await t.server.close()
  mkdirSync(join(t.root, 'x'), { recursive: true })
  await other.listen(t.sock)
  await new Promise<void>((resolve, reject) => createConnection(t.sock).once('connect', function (this: import('node:net').Socket) {
    this.destroy()
    resolve()
  }).once('error', reject))
  await other.close()
})

test('a caller that goes away during the ask leaves no lease; a slow daemon makes run fail open', async () => {
  const root = tmp('tb-slow-')
  const { work } = makeOrigin(join(root, 'origins'), 'me/app')
  writeFileSync(join(work, '.test-broker.json'), JSON.stringify({ suites: { unit: { local: { cpus: 1, locks: ['db'] } } } }))
  let open!: () => void
  let gate = new Promise<void>((r) => (open = r))
  const broker = new Broker({ cfg: structuredClone(MACHINE_DEFAULTS), stateDir: join(root, 'state'), box: () => ({ nproc: 8, load1: 0, memAvailGb: 16 }), repoOf: async () => (await gate, 'me/app'), log: () => {} })
  const server = new BrokerServer(broker, null, () => {})
  const sock = join(root, 'tb.sock')
  await server.listen(sock)
  try {
    const p = spawn(BIN, ['run', 'unit', '--', 'sh', '-c', 'echo direct=$TEST_BROKER_CPUS'], { cwd: work, env: { ...process.env, TEST_BROKER_SOCKET: sock, TEST_BROKER_ANSWER_MS: '300' } })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    const code = await new Promise((r) => p.on('close', r))
    assert.equal(code, 0)
    // the daemon is up, so the direct run gets a capped share, not the whole machine
    const cpus = Math.max(1, Math.floor(availableParallelism() / 4))
    assert.match(err, new RegExp(`no answer from test-brokerd within 0.3s; running the command directly with TEST_BROKER_CPUS=${cpus}`))
    assert.match(out, new RegExp(`direct=${cpus}\\n`))
    open()
    gate = Promise.resolve()
    // the ask finishes after the caller left: its lease must not stay
    await until(() => broker.activeLeases().length === 0, 'no lease')
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(broker.activeLeases().length, 0)
  } finally {
    await server.close()
  }
})

test('a slow answer: run says it is waiting, then takes the answer (no direct run)', async () => {
  const root = tmp('tb-slowok-')
  const { work } = makeOrigin(join(root, 'origins'), 'me/app')
  writeFileSync(join(work, '.test-broker.json'), JSON.stringify({ suites: { unit: { local: { cpus: 1 } } } }))
  const broker = new Broker({ cfg: structuredClone(MACHINE_DEFAULTS), stateDir: join(root, 'state'), box: () => ({ nproc: 8, load1: 0, memAvailGb: 16 }), repoOf: async () => (await new Promise((r) => setTimeout(r, 600)), 'me/app'), log: () => {} })
  const server = new BrokerServer(broker, null, () => {})
  const sock = join(root, 'tb.sock')
  await server.listen(sock)
  try {
    const p = spawn(BIN, ['run', 'unit', '--', 'sh', '-c', 'echo cpus=$TEST_BROKER_CPUS lease=$TEST_BROKER_LEASE'], { cwd: work, env: { ...process.env, TEST_BROKER_SOCKET: sock, TEST_BROKER_ANSWER_MS: '5000', TEST_BROKER_SLOW_MS: '200' } })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    const code = await new Promise((r) => p.on('close', r))
    assert.equal(code, 0)
    assert.match(err, /has not answered in 0.2s; waiting up to 5s/)
    assert.doesNotMatch(err, /running the command directly/)
    assert.match(out, /cpus=1 lease=L-/)
  } finally {
    await server.close()
  }
})

test('hint: the daemon takes it and hands it to the Boat side; no daemon or no repo: exit 0, nothing said', async () => {
  const t = setup()
  writeFileSync(join(t.work, '.test-broker.json'), JSON.stringify({ boat: { remoteScript: 'r.sh' }, suites: { unit: { local: { cpus: 1 }, boat: { shards: [{ name: 'u', args: [] }] } } } }))
  const got: unknown[] = []
  t.broker.setBoat({ tryRun: async () => ({ why: 'no' }), hint: (o) => got.push({ root: o.root, repo: o.repo, ttlMs: o.ttlMs, gone: o.gone }) })
  // no daemon yet: still 0
  const none = await cli(t.work, t.sock, ['hint', '--worktree', t.work]).done
  assert.deepEqual([none.code, none.out, none.err], [0, '', ''])
  await t.server.listen(t.sock)
  const r = await cli(t.root, t.sock, ['hint', '--worktree', join(t.work, '.'), '--ttl', '2h']).done
  assert.equal(r.code, 0, r.err)
  await until(() => got.length === 1, 'the hint')
  assert.deepEqual(got[0], { root: t.work, repo: 'me/app', ttlMs: 120 * 60_000, gone: undefined })
  assert.equal((await cli(t.root, t.sock, ['hint', '--worktree', '/no/such/tree', '--gone']).done).code, 0)
  await until(() => got.length === 2, 'the gone hint')
  assert.deepEqual(got[1], { root: '/no/such/tree', repo: undefined, ttlMs: undefined, gone: true })
  // not a git worktree: nothing sent
  assert.equal((await cli(t.root, t.sock, ['hint', '--worktree', t.root]).done).code, 0)
  assert.equal((await cli(t.root, t.sock, ['hint', '--ttl', 'soon']).done).code, 2)
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(got.length, 2)
  await t.server.close()
})

test('ask exit code: busy here but Boat would run every shard now is 0; Boat cannot (or no peek): 75', () => {
  const box = { nproc: 8, load1: 8, leasedCpus: 0, freeCpus: 0, memAvailGb: 1 }
  const busy = (shards: { how: string }[] | null) => ({ decision: 'busy', busy: { reasons: [], retryAfterSec: 30 }, box, peek: { boat: shards ? { shards, pool: {}, budget: null } : null, steer: [] } }) as unknown as Answer
  assert.equal(askExit(busy([{ how: 'shared' }, { how: 'resume' }])), 0)
  assert.equal(askExit(busy([{ how: 'wait' }, { how: 'none' }])), EXIT_BUSY)
  assert.equal(askExit(busy(null)), EXIT_BUSY)
  assert.equal(askExit({ decision: 'local', local: { lease: 'peek', cpus: 2, locks: [] }, box }), 0)
  assert.equal(askExit({ decision: 'error', error: 'x' }), 2)
  assert.equal(parseTtl('90s'), 1.5)
  assert.equal(parseTtl('45'), 45)
  assert.equal(parseTtl('25h'), null)
})

test('daemon log file: every line also goes to the file; it rotates at 10 MB, 3 kept', async () => {
  const { serverLog, setServerLogFile } = await import('../../src/tb/server.ts')
  const { mkdtempSync, readFileSync, writeFileSync, existsSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'tb-log-'))
  const f = join(dir, 'test-brokerd.log')
  const err = process.stderr.write
  process.stderr.write = (() => true) as typeof process.stderr.write
  try {
    setServerLogFile(f)
    serverLog('one')
    assert.match(readFileSync(f, 'utf8'), /Z one\n$/)
    writeFileSync(f, 'x'.repeat(10 * 1024 * 1024 + 1))
    setServerLogFile(f)
    serverLog('two')
    assert.ok(existsSync(`${f}.1`))
    assert.match(readFileSync(f, 'utf8'), /^\S+ two\n$/)
  } finally {
    setServerLogFile(null)
    process.stderr.write = err
  }
})
