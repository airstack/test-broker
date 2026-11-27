// The Boat half against FakeBoat: real bash runs the wrapper and the repo's remote script in each fake box's HOME.
import '../tmp-root.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BoatRuns } from '../../src/tb/boat-side.ts'
import { RunsDb } from '../../src/tb/runs-db.ts'
import { MACHINE_DEFAULTS, type MachineConfig } from '../../src/tb/machine-config.ts'
import { parseRepoConfig } from '../../src/tb/repo-config.ts'
import type { RunEvent } from '../../src/tb/server.ts'
import { boxName } from '../../src/core/boatpool.ts'
import { poolDays } from '../../src/tb/usage.ts'
import { FakeBoat } from '../fake-boat.ts'
import { makeOrigin, pushCommit, tmp, until } from '../harness.ts'

const REMOTE = `#!/usr/bin/env bash
echo "remote sha=$1 mode=$2 rest=\${*:3} bundle=\${CIB_BUNDLE:+yes} base=\${CIB_BASE:+yes}"
[ -n "\${CIB_BUNDLE:-}" ] && git bundle list-heads "\$CIB_BUNDLE" | grep -q " refs/cib/snap\$" && echo "bundle has refs/cib/snap"
case "$2" in
  fail) echo boom; exit 1 ;;
  hang) sleep 30 ;;
  hangfiles) d="$HOME/cib/0/me__app"; mkdir -p "$d/out"; echo "dev log" > "$d/out/dev.log"; sleep 30 ;;
  failfiles) d="$HOME/cib/0/me__app"; mkdir -p "$d/out/sub"; echo "dev log" > "$d/out/dev.log"; echo x > "$d/out/sub/y.txt"; echo boom; exit 1 ;;
  bigfiles) d="$HOME/cib/0/me__app"; mkdir -p "$d/out"; head -c 2000000 /dev/urandom > "$d/out/big.bin"; exit 1 ;;
  okfiles) d="$HOME/cib/0/me__app"; mkdir -p "$d/out"; echo "dev log" > "$d/out/dev.log" ;;
esac
exit 0
`

function setup(o: { shards?: { name: string; size?: string; units?: number; memGb?: number; args: string[] }[]; cfg?: (c: MachineConfig) => void; silentSec?: number; artifacts?: string[]; remote?: string; pool?: string; extraRepos?: unknown[]; extraUrl?: (repo: string) => string; isPrivate?: (repo: string) => Promise<boolean>; usage?: RunsDb; now?: () => number } = {}) {
  const root = tmp('tb-boat-')
  const { work } = makeOrigin(join(root, 'origins'), 'me/app')
  mkdirSync(join(work, '.test-broker'))
  writeFileSync(join(work, '.test-broker', 'remote.sh'), o.remote ?? REMOTE)
  const doc = {
    boat: { ...(o.pool ? { pool: o.pool } : {}), remoteScript: '.test-broker/remote.sh', ...(o.artifacts ? { artifacts: o.artifacts } : {}), ...(o.extraRepos ? { extraRepos: o.extraRepos } : {}) },
    suites: { all: { local: { cpus: 2 }, boat: { shards: o.shards ?? [{ name: 'a', args: ['ok'] }, { name: 'b', args: ['ok'] }], ...(o.silentSec ? { silentSec: 30 } : {}) } } },
  }
  writeFileSync(join(work, '.test-broker.json'), JSON.stringify(doc))
  const cfg = parseRepoConfig(doc, work)
  if (o.silentSec) cfg.suites.all.boat!.silentSec = o.silentSec
  const mc = structuredClone(MACHINE_DEFAULTS)
  mc.boat.owners = ['me']
  mc.boat.hostId = 'h1'
  o.cfg?.(mc)
  const boat = new FakeBoat()
  boat.envs['tbx-h1-shared'] = { version: 1, injects: [] }
  const logs: string[] = []
  const runs = new BoatRuns({ cfg: mc, stateDir: join(root, 'state'), boat, log: (m) => logs.push(m), isPrivate: o.isPrivate ?? (async () => true), ...(o.extraUrl ? { extraUrl: o.extraUrl } : {}), ...(o.usage ? { usage: o.usage } : {}), ...(o.now ? { now: o.now } : {}) })
  const ask = (repo = 'me/app') => runs.tryRun({ repo, cfg, suite: cfg.suites.all, args: [], owner: 'c1' })
  const collect = (id: string) => {
    const ev: RunEvent[] = []
    runs.follow(id, (e) => ev.push(e))
    return ev
  }
  return { root, work, boat, runs, ask, collect, logs, mc }
}

const idleBoxes = (t: ReturnType<typeof setup>, n: number, state = 'ready') => {
  for (let i = 0; i < n; i++) poolBox(t, state)
}
/** a free box of this host's shared pool, at its environment's version */
const poolBox = (t: ReturnType<typeof setup>, state = 'ready') =>
  t.boat.addBox(boxName('tb', 'tbx-h1-shared', 'default', Math.random().toString(36).slice(2, 8), 'h1'), state, 'default', { environment: 'tbx-h1-shared', environmentVersion: 1 })

test('no free box: the run creates its boxes (a create counts as a start, inside the start deadline)', async () => {
  const t = setup()
  const a = await t.ask()
  assert.ok('run' in a, JSON.stringify(a))
  const ev = t.collect(a.run)
  await until(() => ev.some((e) => e.t === 'done'), 'the run to end')
  assert.equal(ev.find((e) => e.t === 'done')!.t === 'done' && (ev.find((e) => e.t === 'done') as { code: number }).code, 0)
  await t.runs.idle()
  assert.deepEqual(t.runs.pool.boxes().map((b) => b.state), ['idle', 'idle'])
})

test('usage: a Boat run is recorded with its shards, its tree and its cost; box state changes are recorded', async () => {
  const usage = new RunsDb(':memory:')
  const t = setup({ usage })
  const a = await t.ask()
  assert.ok('run' in a, JSON.stringify(a))
  await until(() => t.runs.status().runs.every((r) => r.done), 'the run to end')
  await t.runs.idle()
  const [r] = usage.runsSince(0)
  assert.equal(r.id, a.run)
  assert.equal(r.whereRan, 'boat')
  assert.equal(r.shape, 'whole')
  assert.equal(r.exitCode, 0)
  assert.equal(r.endedHow, 'done')
  assert.match(r.tree ?? '', /^[0-9a-f]{40}$/)
  await until(() => usage.runsSince(0)[0].head != null, 'git info')
  assert.deepEqual(r.shards!.map((s) => [s.name, s.started, typeof s.secs]), [['a', true, 'number'], ['b', true, 'number']])
  assert.ok(r.cpuMin! >= 0 && r.planHours! >= 0)
  const states = usage.boxEventsSince(0).map((e) => e.state)
  assert.ok(states.includes('creating') && states.includes('busy') && states.includes('idle'), states.join(','))
})

test('usage: a restart records every box as it is, so a box already up counts from the start', async () => {
  const usage = new RunsDb(':memory:')
  const t = setup()
  idleBoxes(t, 1)
  await t.runs.pool.reconcile()
  const again = new BoatRuns({ cfg: t.mc, stateDir: join(t.root, 'state'), boat: t.boat, log: () => {}, usage })
  assert.deepEqual(usage.boxEventsSince(0).map((e) => e.state), again.pool.boxes().map((b) => b.state))
})

test('no free box and no room (every other box busy): the answer says why at once, nothing is created', async () => {
  const t = setup({ cfg: (c) => { c.boat.maxBoxes = 1 } })
  t.boat.addBox(boxName('tb', 'other', 'default'), 'ready')
  await t.runs.pool.reconcile()
  const [o] = t.runs.pool.boxes()
  t.runs.pool.setState(o.name, 'busy')
  const a = await t.ask()
  assert.ok('why' in a)
  assert.match(a.why, /no free box now for 2 of 2 shard\(s\)/)
  await t.runs.idle()
  assert.deepEqual(t.runs.pool.boxes().map((b) => b.name), [o.name])
})

test('one of two boxes free: the run reuses it and creates only the missing one', async () => {
  const t = setup()
  idleBoxes(t, 1)
  await t.runs.pool.reconcile()
  const a = await t.ask()
  assert.ok('run' in a, JSON.stringify(a))
  assert.match(t.logs.join('\n'), /\(reused\).*\(created\)|\(created\).*\(reused\)/)
  await until(() => t.runs.status().runs.every((r) => r.done), 'the run to end')
  await t.runs.idle()
  assert.equal(t.runs.pool.boxes().length, 2)
})

test('at maxBoxes: the least-recently-used free box of another environment makes room (stopped before idle)', async () => {
  const t = setup({ cfg: (c) => { c.boat.maxBoxes = 3 } })
  t.boat.addBox(boxName('tb', 'other', 'default'), 'ready')
  t.boat.addBox(boxName('tb', 'other', 'default'), 'stopped')
  t.boat.addBox(boxName('tb', 'other', 'default'), 'ready')
  await t.runs.pool.reconcile()
  const others = t.runs.pool.boxes()
  const stopped = others.find((b) => b.state === 'stopped')!.name
  const [idleOld, idleNew] = others.filter((b) => b.state === 'idle').map((b) => b.name)
  t.runs.pool.setState(idleOld, 'idle', { lastUsed: 1 })
  t.runs.pool.setState(idleNew, 'idle', { lastUsed: 2 })
  const a = await t.ask()
  assert.ok('run' in a, JSON.stringify(a))
  await until(() => t.runs.status().runs.every((r) => r.done), 'the run to end')
  await t.runs.idle()
  const names = t.runs.pool.boxes().map((b) => b.name)
  assert.ok(!names.includes(stopped), 'the stopped box goes first')
  assert.ok(!names.includes(idleOld), 'then the least-recently-used idle one')
  assert.ok(names.includes(idleNew))
  assert.equal(t.runs.pool.boxes().filter((b) => b.env === 'tbx-h1-shared').length, 2)
})

test('at maxBoxes with every other box busy: nothing is deleted, and the log says why', async () => {
  const t = setup({ cfg: (c) => { c.boat.maxBoxes = 1 } })
  t.boat.addBox(boxName('tb', 'other', 'default'), 'ready')
  await t.runs.pool.reconcile()
  const [o] = t.runs.pool.boxes()
  t.runs.pool.setState(o.name, 'busy')
  const a = await t.ask()
  assert.ok('why' in a)
  await t.runs.idle()
  assert.deepEqual(t.runs.pool.boxes().map((b) => b.name), [o.name])
  assert.ok(t.logs.some((l) => /at maxBoxes \(1\) and every other box is busy/.test(l)), t.logs.join('\n'))
})

test('quarantined boxes do not count toward maxBoxes: new boxes take their place', async () => {
  const t = setup({ cfg: (c) => { c.boat.maxBoxes = 2 } })
  poolBox(t, 'stopped')
  poolBox(t, 'stopped')
  await t.runs.pool.reconcile()
  const bad = t.runs.pool.boxes().map((b) => b.name)
  for (const n of bad) t.runs.pool.setState(n, 'quarantined', { reason: 'test' })
  const a = await t.ask()
  assert.ok('run' in a, JSON.stringify(a))
  await until(() => t.runs.status().runs.every((r) => r.done), 'the run to end')
  await t.runs.idle()
  const rows = t.runs.pool.boxes()
  assert.deepEqual(rows.filter((b) => b.state === 'quarantined').map((b) => b.name).sort(), [...bad].sort())
  assert.equal(rows.filter((b) => b.state !== 'quarantined').length, 2)
})

test('at 2 × maxBoxes with the quarantined ones, the oldest quarantined boxes are deleted to make room', async () => {
  const t = setup({ cfg: (c) => { c.boat.maxBoxes = 2 } })
  for (let i = 0; i < 4; i++) poolBox(t, 'stopped')
  await t.runs.pool.reconcile()
  const bad = t.runs.pool.boxes().map((b) => b.name)
  bad.forEach((n, i) => {
    t.runs.pool.setState(n, 'quarantined', { reason: 'test' })
    t.runs.pool.d.db.updateBox(n, { since: i + 1 })
  })
  const a = await t.ask()
  assert.ok('run' in a, JSON.stringify(a))
  await until(() => t.runs.status().runs.every((r) => r.done), 'the run to end')
  await t.runs.idle()
  const rows = t.runs.pool.boxes()
  assert.equal(rows.length, 4)
  assert.deepEqual(rows.filter((b) => b.state === 'quarantined').map((b) => b.name).sort(), bad.slice(2).sort(), 'the two oldest go')
  assert.ok(t.logs.some((l) => /over 4 boxes with the quarantined ones/.test(l)), t.logs.join('\n'))
})

test('reset: quarantined boxes come back as stopped, fail counts cleared', async () => {
  const t = setup()
  poolBox(t, 'stopped')
  poolBox(t, 'stopped')
  await t.runs.pool.reconcile()
  const [q, ok] = t.runs.pool.boxes().map((b) => b.name)
  t.runs.pool.setState(q, 'quarantined', { reason: '3 infra failures in a row', infraFails: 3 })
  assert.equal(t.runs.resetQuarantine(), 1)
  assert.equal(t.runs.resetQuarantine(), 0)
  const row = t.runs.pool.boxes().find((b) => b.name === q)!
  assert.deepEqual([row.state, row.infraFails, row.reason], ['stopped', 0, null])
  assert.equal(t.runs.pool.boxes().find((b) => b.name === ok)!.state, 'stopped')
})

test('a run on idle and stopped boxes: snapshot bundle, each shard runs, receipt, boxes back to idle', async () => {
  const t = setup()
  idleBoxes(t, 1)
  idleBoxes(t, 1, 'stopped')
  await t.runs.pool.reconcile()
  writeFileSync(join(t.work, 'dirty.txt'), 'not committed\n')
  const a = await t.ask()
  assert.ok('run' in a, JSON.stringify(a))
  const ev = t.collect(a.run)
  await until(() => ev.some((e) => e.t === 'done'), 'the run to end')
  const done = ev.find((e) => e.t === 'done')!
  assert.equal(done.t === 'done' && done.code, 0, JSON.stringify(ev))
  const out = ev.filter((e) => e.t === 'log').map((e) => (e.t === 'log' ? e.data : '')).join('')
  assert.match(out, /remote sha=[0-9a-f]{40} mode=ok rest= bundle=yes base=yes/)
  assert.match(out, /bundle has refs\/cib\/snap/)
  assert.match(done.t === 'done' ? done.receipt : '', /RESULT: PASS/)
  await t.runs.idle()
  assert.deepEqual(t.runs.pool.boxes().map((b) => b.state).sort(), ['idle', 'idle'])
  assert.ok(t.boat.calls.some((c) => c.startsWith('resume ')))
})

test('a failing shard fails the run with its reason', async () => {
  const t = setup({ shards: [{ name: 'a', args: ['fail'] }] })
  idleBoxes(t, 1)
  await t.runs.pool.reconcile()
  const a = await t.ask()
  assert.ok('run' in a)
  const ev = t.collect(a.run)
  await until(() => ev.some((e) => e.t === 'done'), 'done')
  const done = ev.find((e) => e.t === 'done')!
  assert.equal(done.t === 'done' && done.code, 1)
  assert.match(done.t === 'done' ? done.receipt : '', /FAIL\s+a .*boom/s)
})

test('a shard silent for silentSec is killed', async () => {
  const t = setup({ shards: [{ name: 'a', args: ['hang'] }], silentSec: 0.5 })
  idleBoxes(t, 1)
  await t.runs.pool.reconcile()
  const a = await t.ask()
  assert.ok('run' in a)
  const ev = t.collect(a.run)
  await until(() => ev.some((e) => e.t === 'done'), 'done', 20_000)
  const done = ev.find((e) => e.t === 'done')!
  assert.equal(done.t === 'done' && done.code, 1)
  assert.match(done.t === 'done' ? done.receipt : '', /no output for 0.5s/)
})

test('boxes not running within the start deadline: the run ends as not started', async () => {
  const t = setup({ cfg: (c) => (c.boat.startDeadlineSec = 0.3) })
  idleBoxes(t, 2, 'stopped')
  await t.runs.pool.reconcile()
  let open!: () => void
  t.boat.gate.resume = new Promise((r) => (open = r))
  const a = await t.ask()
  assert.ok('run' in a)
  const ev = t.collect(a.run)
  await until(() => ev.some((e) => e.t === 'state' && e.state === 'start-deadline'), 'the deadline')
  open()
  await until(() => ev.some((e) => e.t === 'done'), 'done')
  const done = ev.find((e) => e.t === 'done')!
  assert.deepEqual(done.t === 'done' && [done.code, done.notStarted], [3, true])
  await t.runs.idle()
  assert.ok(t.runs.pool.boxes().every((b) => b.state === 'idle' || b.state === 'stopped'), JSON.stringify(t.runs.pool.boxes()))
})

test('the caller going away cancels its run', async () => {
  const t = setup({ shards: [{ name: 'a', args: ['hang'] }] })
  idleBoxes(t, 1)
  await t.runs.pool.reconcile()
  const a = await t.ask()
  assert.ok('run' in a)
  const ev = t.collect(a.run)
  await until(() => ev.some((e) => e.t === 'state' && e.state === 'running'), 'running')
  t.runs.ownerGone('c1')
  await until(() => ev.some((e) => e.t === 'done'), 'done')
  const done = ev.find((e) => e.t === 'done')!
  assert.match(done.t === 'done' ? done.receipt : '', /the caller went away/)
})

test('two asks never take the same box', async () => {
  const t = setup({ shards: [{ name: 'a', args: ['hang'] }] })
  idleBoxes(t, 1)
  await t.runs.pool.reconcile()
  const [x, y] = await Promise.all([t.ask(), t.ask()])
  // the second creates its own box; never the first one's
  assert.ok('run' in x && 'run' in y)
  const boxes = t.runs.status().runs.flatMap((r) => r.shards.map((s) => s.box))
  assert.equal(new Set(boxes).size, 2, boxes.join(' '))
  t.runs.ownerGone('c1')
  await t.runs.idle()
})

test('cli run: follows a Boat run to its exit code; a missed start deadline falls back to local', async () => {
  const { spawn } = await import('node:child_process')
  const { Broker } = await import('../../src/tb/broker.ts')
  const { BrokerServer } = await import('../../src/tb/server.ts')
  const t = setup({ shards: [{ name: 'a', args: ['fail'] }], cfg: (c) => (c.boat.startDeadlineSec = 0.5) })
  idleBoxes(t, 1)
  await t.runs.pool.reconcile()
  const broker = new Broker({ cfg: t.mc, stateDir: join(t.root, 'state'), box: () => ({ nproc: 8, load1: 0, memAvailGb: 16 }), repoOf: async () => 'me/app', boat: t.runs, log: () => {} })
  const server = new BrokerServer(broker, t.runs, () => {})
  const sock = join(t.root, 'tb.sock')
  await server.listen(sock)
  const BIN = join(import.meta.dirname, '..', '..', 'bin', 'test-broker')
  const cli = (args: string[]) =>
    new Promise<{ code: number; out: string; err: string }>((resolve) => {
      const p = spawn(BIN, args, { cwd: t.work, env: { ...process.env, TEST_BROKER_SOCKET: sock } })
      let out = ''
      let err = ''
      p.stdout.on('data', (d) => (out += d))
      p.stderr.on('data', (d) => (err += d))
      p.on('close', (code) => resolve({ code: code ?? -1, out, err }))
    })
  try {
    const r = await cli(['run', 'all', '--', 'sh', '-c', 'echo LOCAL'])
    assert.equal(r.code, 1, r.err)
    assert.match(r.out, /\[a\] remote sha=\w+ mode=fail/)
    assert.match(r.out, /RESULT: FAIL/)
    assert.doesNotMatch(r.out, /LOCAL/)
    await t.runs.idle()
    // the box now waits on a gated resume: the deadline passes, the client asks again without Boat
    await t.runs.pool.sweep()
    for (const b of t.runs.pool.boxes()) t.runs.pool.setState(b.name, 'stopped')
    t.boat.gate.resume = new Promise(() => {})
    const r2 = await cli(['run', 'all', '--', 'sh', '-c', 'echo LOCAL cpus=$TEST_BROKER_CPUS'])
    assert.equal(r2.code, 0, r2.err)
    assert.match(r2.err, /Boat did not start in time; asking again without Boat/)
    assert.match(r2.out, /LOCAL cpus=2/)
  } finally {
    await server.close()
  }
})

test('suite args go to passArgs shards only', async () => {
  const t = setup({ shards: [{ name: 'a', args: ['ok'] }] })
  const cfg = parseRepoConfig(
    { boat: { environment: 'acme', remoteScript: '.test-broker/remote.sh' }, suites: { all: { local: { cpus: 1 }, boat: { shards: [{ name: 'p', args: ['ok'], passArgs: true }, { name: 'q', args: ['ok'] }] } } } },
    t.work,
  )
  idleBoxes(t, 2)
  await t.runs.pool.reconcile()
  const a = await t.runs.tryRun({ repo: 'me/app', cfg, suite: cfg.suites.all, args: ['--grep', '@core'], owner: 'c1' })
  assert.ok('run' in a)
  const ev = t.collect(a.run)
  await until(() => ev.some((e) => e.t === 'done'), 'done')
  const log = (shard: string) => ev.filter((e) => e.t === 'log' && e.shard === shard).map((e) => (e.t === 'log' ? e.data : '')).join('')
  assert.match(log('p'), /mode=ok rest=--grep @core /)
  assert.match(log('q'), /mode=ok rest= /)
  await t.runs.idle()
  // this config has the old environment key: it runs on the shared pool's two boxes, no others
  assert.deepEqual(t.runs.pool.boxes().map((b) => b.env), ['tbx-h1-shared', 'tbx-h1-shared'])
})

test('a lost connection runs the shard once more on the same box; a second loss fails it', async () => {
  for (const losses of [1, 2]) {
    const t = setup({ shards: [{ name: 'a', args: ['ok'] }] })
    idleBoxes(t, 1)
    await t.runs.pool.reconcile()
    let left = losses
    t.boat.onCommand = (_id, cmd) => (cmd.includes('cib-wrap.sh" ') && !cmd.includes('--kill') && left-- > 0 ? 255 : undefined)
    const a = await t.ask()
    assert.ok('run' in a)
    const ev = t.collect(a.run)
    await until(() => ev.some((e) => e.t === 'done'), 'done')
    const done = ev.find((e) => e.t === 'done')!
    assert.ok(ev.some((e) => e.t === 'state' && e.state === 'retrying'))
    assert.equal(done.t === 'done' && done.code, losses === 1 ? 0 : 1, done.t === 'done' ? done.receipt : '')
  }
})

test('boxes a dead daemon left busy or resuming are usable again after a restart', async () => {
  const t = setup()
  idleBoxes(t, 1)
  idleBoxes(t, 1, 'stopped')
  await t.runs.pool.reconcile()
  const [x, y] = t.runs.pool.boxes()
  t.runs.pool.setState(x.name, 'busy')
  t.runs.pool.setState(y.name, 'resuming')
  const again = new BoatRuns({ cfg: t.mc, stateDir: join(t.root, 'state'), boat: t.boat, log: () => {} })
  assert.deepEqual(again.pool.boxes().map((b) => b.state).sort(), ['idle', 'stopped'])
})

test('a failed shard brings its artifacts back; the receipt says where', async () => {
  const t = setup({ shards: [{ name: 'a', args: ['failfiles'] }], artifacts: ['out', 'missing'] })
  idleBoxes(t, 1)
  await t.runs.pool.reconcile()
  const a = await t.ask()
  assert.ok('run' in a)
  const ev = t.collect(a.run)
  await until(() => ev.some((e) => e.t === 'done'), 'done')
  const done = ev.find((e) => e.t === 'done')!
  const dir = join(t.root, 'state', 'runs', `${a.run}.artifacts`, 'a')
  assert.equal(done.t === 'done' && done.code, 1)
  assert.match(done.t === 'done' ? done.receipt : '', new RegExp(`artifacts: ${dir}`))
  assert.equal(readFileSync(join(dir, 'out', 'dev.log'), 'utf8'), 'dev log\n')
  assert.ok(existsSync(join(dir, 'out', 'sub', 'y.txt')))
  assert.ok(!existsSync(join(t.root, 'state', 'runs', `${a.run}.artifacts`, 'a.tgz')))
})

test('a passing shard brings nothing back; a repo with no artifacts brings nothing back', async () => {
  const ok = setup({ shards: [{ name: 'a', args: ['okfiles'] }], artifacts: ['out'] })
  idleBoxes(ok, 1)
  await ok.runs.pool.reconcile()
  const a = await ok.ask()
  assert.ok('run' in a)
  const ev = ok.collect(a.run)
  await until(() => ev.some((e) => e.t === 'done'), 'done')
  assert.ok(!existsSync(join(ok.root, 'state', 'runs', `${a.run}.artifacts`)))

  const none = setup({ shards: [{ name: 'a', args: ['failfiles'] }] })
  idleBoxes(none, 1)
  await none.runs.pool.reconcile()
  const b = await none.ask()
  assert.ok('run' in b)
  const ev2 = none.collect(b.run)
  await until(() => ev2.some((e) => e.t === 'done'), 'done')
  const done = ev2.find((e) => e.t === 'done')!
  assert.doesNotMatch(done.t === 'done' ? done.receipt : '', /artifacts:/)
  assert.ok(!existsSync(join(none.root, 'state', 'runs', `${b.run}.artifacts`)))
})

test('artifacts over artifactsMaxMb are not brought back, and the log says so', async () => {
  const t = setup({ shards: [{ name: 'a', args: ['bigfiles'] }], artifacts: ['out'], cfg: (c) => (c.boat.artifactsMaxMb = 1) })
  idleBoxes(t, 1)
  await t.runs.pool.reconcile()
  const a = await t.ask()
  assert.ok('run' in a)
  const ev = t.collect(a.run)
  await until(() => ev.some((e) => e.t === 'done'), 'done')
  const out = ev.filter((e) => e.t === 'log').map((e) => (e.t === 'log' ? e.data : '')).join('')
  assert.match(out, /test-broker: artifacts: skipped: \d+ MB is over artifactsMaxMb \(1\)/)
  assert.ok(!existsSync(join(t.root, 'state', 'runs', `${a.run}.artifacts`, 'a', 'out')))
})

test('run logs and artifacts older than keepDays (14 by default) are deleted at start', async () => {
  const root = tmp('tb-prune-')
  const runs = join(root, 'state', 'runs')
  mkdirSync(join(runs, 'tb-001-old.artifacts', 'a'), { recursive: true })
  writeFileSync(join(runs, 'tb-001-old.log'), 'old\n')
  writeFileSync(join(runs, 'tb-002-new.log'), 'new\n')
  const old = (Date.now() - 15 * 86400_000) / 1000
  utimesSync(join(runs, 'tb-001-old.artifacts'), old, old)
  utimesSync(join(runs, 'tb-001-old.log'), old, old)
  mkdirSync(join(runs, 'tb-003-ro.artifacts', 'a', 'locked'), { recursive: true })
  writeFileSync(join(runs, 'tb-003-ro.artifacts', 'a', 'locked', 'f'), 'x')
  chmodSync(join(runs, 'tb-003-ro.artifacts', 'a', 'locked'), 0o555)
  utimesSync(join(runs, 'tb-003-ro.artifacts'), old, old)
  const r = new BoatRuns({ cfg: structuredClone(MACHINE_DEFAULTS), stateDir: join(root, 'state'), boat: new FakeBoat(), log: () => {} })
  await r.idle()
  assert.ok(!existsSync(join(runs, 'tb-003-ro.artifacts')), 'a read-only dir inside is pruned too')
  assert.ok(!existsSync(join(runs, 'tb-001-old.artifacts')))
  assert.ok(!existsSync(join(runs, 'tb-001-old.log')))
  assert.ok(existsSync(join(runs, 'tb-002-new.log')))
})

test('a shard killed for silence still brings its artifacts back; a cancelled one does not', async () => {
  const t = setup({ shards: [{ name: 'a', args: ['hangfiles'] }], artifacts: ['out'], silentSec: 0.5 })
  idleBoxes(t, 1)
  await t.runs.pool.reconcile()
  const a = await t.ask()
  assert.ok('run' in a)
  const ev = t.collect(a.run)
  await until(() => ev.some((e) => e.t === 'done'), 'done', 20_000)
  const done = ev.find((e) => e.t === 'done')!
  assert.match(done.t === 'done' ? done.receipt : '', /no output for 0.5s/)
  assert.ok(existsSync(join(t.root, 'state', 'runs', `${a.run}.artifacts`, 'a', 'out', 'dev.log')))

  const c = setup({ shards: [{ name: 'a', args: ['hangfiles'] }], artifacts: ['out'] })
  idleBoxes(c, 1)
  await c.runs.pool.reconcile()
  const b = await c.ask()
  assert.ok('run' in b)
  const ev2 = c.collect(b.run)
  await until(() => ev2.some((e) => e.t === 'log' && e.data.includes('remote sha=')), 'the shard to run')
  await new Promise((r) => setTimeout(r, 300))
  c.runs.cancel(b.run, 'cancelled')
  await until(() => ev2.some((e) => e.t === 'done'), 'done', 20_000)
  await c.runs.idle()
  assert.ok(!existsSync(join(c.root, 'state', 'runs', `${b.run}.artifacts`)))
})

test('a size off in boat.sizes: the ask says why at once (the suite runs here); free boxes of that size are deleted', async () => {
  const t = setup({ shards: [{ name: 'a', args: ['ok'] }, { name: 'e2e', size: 'large', args: ['ok'] }], cfg: (c) => { c.boat.sizes = ['default'] } })
  t.boat.addBox(boxName('tb', 'acme', 'large'), 'ready')
  t.boat.addBox(boxName('tb', 'acme', 'large'), 'stopped')
  t.boat.addBox(boxName('tb', 'acme', 'large'), 'ready')
  t.boat.addBox(boxName('tb', 'acme', 'default'), 'ready')
  await t.runs.pool.reconcile()
  const busy = t.runs.pool.boxes().find((b) => b.size === 'large' && b.state === 'idle')!.name
  t.runs.pool.setState(busy, 'busy')
  const a = await t.ask()
  assert.ok('why' in a, JSON.stringify(a))
  assert.match(a.why, /size large is off on this machine \(boat\.sizes\)/)
  assert.equal(t.runs.status().runs.length, 0)
  assert.equal(t.runs.dropOffSizes().length, 2)
  await t.runs.idle()
  assert.deepEqual(t.runs.pool.boxes().map((b) => b.name).sort(), [busy, t.runs.pool.boxes().find((b) => b.size === 'default')!.name].sort(), 'the busy one stays until it is free')
  t.runs.pool.setState(busy, 'idle')
  assert.deepEqual(t.runs.dropOffSizes(), [busy])
})

test('the repo gate: only private repos of an owner in boat.owners go to Boat; answers are cached', async () => {
  const none = setup({ cfg: (c) => { c.boat.owners = [] } })
  const a = await none.ask()
  assert.ok('why' in a && /owner me is not in boat\.owners/.test(a.why), JSON.stringify(a))
  assert.equal(none.runs.pool.boxes().length, 0, 'nothing is created')

  let calls = 0
  const pub = setup({ isPrivate: async () => (calls++, false) })
  const b = await pub.ask()
  assert.ok('why' in b && /me\/app is not private/.test(b.why), JSON.stringify(b))
  await pub.ask()
  assert.equal(calls, 1, 'a "not private" answer is cached')
  assert.equal(pub.runs.pool.boxes().length, 0)

  const err = setup({ isPrivate: async () => { throw new Error('HTTP 502') } })
  const c = await err.ask()
  assert.ok('why' in c && /cannot tell if me\/app is private \(HTTP 502\)/.test(c.why), JSON.stringify(c))

  const ok = setup({ cfg: (c) => { c.boat.owners = ['ME'.toLowerCase()] } })
  const d = await ok.ask()
  assert.ok('run' in d, JSON.stringify(d))
  await until(() => ok.runs.status().runs.every((r) => r.done), 'the run to end')
  await ok.runs.idle()
})

// A remote script shaped like acme's: its clone at ~/cib/repos/<owner__name>, a worktree per slot (`worktree add`
// needs the clone's HEAD to resolve), origin never reachable (no GitHub token on the box), the snapshot from the bundle.
const CLONE_REMOTE = `#!/usr/bin/env bash
N="\${CIB_REPO/\\//__}"; C="$HOME/cib/repos/$N"; WT="$HOME/cib/0/$N"
[ -d "$C/.git" ] || { echo "no clone"; exit 90; }
if [ ! -e "$WT/.git" ]; then
  rm -rf "$WT"; git -C "$C" worktree prune
  git -C "$C" worktree add --quiet --detach --no-checkout "$WT" || { echo "cannot add a worktree"; exit 90; }
fi
if [ -n "$CIB_BUNDLE" ]; then git -C "$C" fetch -q "$CIB_BUNDLE" "+refs/cib/snap:refs/cib/slot-0" || { echo "bundle fetch failed"; exit 91; }; fi
git -C "$C" cat-file -e "$1^{commit}" || { echo "sha missing"; exit 91; }
cd "$WT" && git checkout -q --force --detach "$1" || { echo "checkout failed"; exit 92; }
echo "main=$(git -C "$C" rev-parse -q --verify refs/heads/main) promisor=$(git -C "$C" config --get remote.origin.promisor)"
`

test('code reaches the box by bundle only: a seed for a new or partial clone, a smaller one after, none when the base is there', async () => {
  const t = setup({ remote: CLONE_REMOTE, shards: [{ name: 'a', args: ['ok'] }] })
  const home = poolBox(t).home
  await t.runs.pool.reconcile()
  const run = async () => {
    writeFileSync(join(t.work, 'dirty.txt'), `${Math.random()}\n`)
    const a = await t.ask()
    assert.ok('run' in a, JSON.stringify(a))
    const ev = t.collect(a.run)
    await until(() => ev.some((e) => e.t === 'done'), 'the run to end')
    await t.runs.idle()
    const done = ev.find((e) => e.t === 'done')!
    const out = ev.filter((e) => e.t === 'log').map((e) => (e.t === 'log' ? e.data : '')).join('')
    assert.equal(done.t === 'done' && done.code, 0, out)
    return out
  }
  const base1 = execFileSync('git', ['-C', t.work, 'rev-parse', 'origin/main'], { encoding: 'utf8' }).trim()
  const clone = join(home, 'cib', 'repos', 'me__app')
  // a partial clone from the token era, with a slot checkout of it: both replaced
  execFileSync('git', ['init', '-q', clone])
  execFileSync('git', ['-C', clone, 'config', 'remote.origin.promisor', 'true'])
  mkdirSync(join(home, 'cib', '0', 'me__app', 'node_modules'), { recursive: true })
  writeFileSync(join(home, 'cib', '0', 'me__app', '.git'), `gitdir: ${clone}/.git/worktrees/me__app\n`)
  let out = await run()
  assert.match(out, /replacing the partial clone/)
  assert.match(out, new RegExp(`seeded me/app up to ${base1.slice(0, 12)}`))
  assert.match(out, new RegExp(`main=${base1} promisor=$`, 'm'))
  assert.equal(readdirSync(join(t.root, 'state', 'seeds')).filter((f) => f.endsWith('.bundle')).length, 1, 'a whole-history seed, cached')
  // same base: nothing to seed
  out = await run()
  assert.doesNotMatch(out, /seeded/)
  // main moved on: only the new part goes, and main follows the base
  const base2 = pushCommit(t.work, 'f.txt', 'v2\n')
  out = await run()
  assert.match(out, new RegExp(`seeded me/app up to ${base2.slice(0, 12)}`))
  assert.match(out, new RegExp(`main=${base2} `))
  assert.equal(readdirSync(join(t.root, 'state', 'seeds')).filter((f) => f.endsWith('.bundle')).length, 1, 'the second seed was incremental')
})

test('the commit is the base: no snapshot bundle; the cached seed brings the commit to a new box', async () => {
  const t = setup({ remote: CLONE_REMOTE, shards: [{ name: 'a', args: ['ok'] }, { name: 'b', args: ['ok'] }] })
  const a = await t.ask()
  assert.ok('run' in a, JSON.stringify(a))
  const ev = t.collect(a.run)
  await until(() => ev.some((e) => e.t === 'done'), 'the run to end')
  const out = ev.filter((e) => e.t === 'log').map((e) => (e.t === 'log' ? e.data : '')).join('')
  const done = ev.find((e) => e.t === 'done')!
  assert.equal(done.t === 'done' && done.code, 0, out)
  assert.equal(out.match(/seeded me\/app/g)?.length, 2, 'both new boxes are seeded')
  assert.equal(readdirSync(join(t.root, 'state', 'seeds')).filter((f) => f.endsWith('.bundle')).length, 1, 'one seed file for both')
  await t.runs.idle()
})

const finish = async (t: ReturnType<typeof setup>, a: Awaited<ReturnType<ReturnType<typeof setup>['ask']>>) => {
  assert.ok('run' in a, JSON.stringify(a))
  const ev = t.collect(a.run)
  await until(() => ev.some((e) => e.t === 'done'), 'the run to end')
  await t.runs.idle()
  const done = ev.find((e) => e.t === 'done')!
  assert.equal(done.t === 'done' && done.code, 0, JSON.stringify(ev.slice(-5)))
}

test('a pool: its environment is made to inject nothing, boxes are tbx-<host>-<pool>-…, and every repo of the pool shares them', async () => {
  const t = setup({ shards: [{ name: 'a', args: ['ok'] }] })
  delete t.boat.envs['tbx-h1-shared']
  await finish(t, await t.ask())
  assert.ok(t.boat.calls.includes('env create tbx-h1-shared'), t.boat.calls.join('\n'))
  const [b] = t.runs.pool.boxes()
  assert.match(b.name, /^tbx-h1-shared-default-[a-z0-9]{6}$/)
  assert.equal(b.env, 'tbx-h1-shared')
  // asked again at once (inside the gate's 30 s): the new box is looked at now and reused, not a second one made
  await finish(t, await t.ask('me/other'))
  assert.equal(t.runs.pool.boxes().length, 1, 'no second box')
  assert.equal(t.runs.pool.boxes()[0].lastRepo, 'me/other')
  assert.equal(t.boat.calls.filter((c) => c.startsWith('env create')).length, 1)
})

test('a pool environment that injects: toggles are switched off again (once per 10 min); repos or files refuse the pool', async () => {
  const t = setup({ pool: 'acme', shards: [{ name: 'a', args: ['ok'] }] })
  t.boat.envs['tbx-h1-acme'] = { version: 2, injects: ['safeForThirdParties is not true', 'passGithub'] }
  await finish(t, await t.ask())
  assert.ok(t.boat.calls.includes('env safe tbx-h1-acme'), t.boat.calls.join('\n'))
  assert.ok(!t.boat.calls.some((c) => c.startsWith('env create')), 'an existing environment is never re-made')
  const u = setup({ pool: 'acme', shards: [{ name: 'a', args: ['ok'] }] })
  u.boat.envs['tbx-h1-acme'] = { version: 2, injects: ['secret files'] }
  const a = await u.ask()
  assert.ok('why' in a && /pool environment tbx-h1-acme injects secret files/.test(a.why), JSON.stringify(a))
  assert.match(a.why, /--proxy-ai-credentials false/)
  assert.equal(u.runs.pool.boxes().length, 0)
  await u.ask()
  assert.equal(u.boat.calls.filter((c) => c === 'env safe tbx-h1-acme').length, 1, 'not again inside 10 min')
})

test('a pool box made at an older environment version is deleted, never used', async () => {
  const t = setup({ pool: 'acme', shards: [{ name: 'a', args: ['ok'] }] })
  t.boat.envs['tbx-h1-acme'] = { version: 1, injects: [] }
  await finish(t, await t.ask())
  await finish(t, await t.ask()) // the second ask looks at the new box: Boat lists it at v1
  const [v1] = t.runs.pool.boxes()
  assert.equal(v1.envVersion, 1)
  assert.equal(t.runs.pool.boxes().length, 1)
  t.boat.envs['tbx-h1-acme'] = { version: 2, injects: [] }
  ;(t.runs.pool as unknown as { publicSeen: Map<string, unknown> }).publicSeen.clear()
  await finish(t, await t.ask())
  const names = t.runs.pool.boxes().map((b) => b.name)
  assert.ok(!names.includes(v1.name), 'the v1 box went')
  assert.equal(names.length, 1)
})

test('reconcile adopts this host\'s pool boxes only, and only when Boat puts them in that environment', async () => {
  const t = setup()
  const mine = t.boat.addBox('tbx-h1-shared-default-abc123', 'ready', 'default', { environment: 'tbx-h1-shared' })
  t.boat.addBox('tbx-h1-shared-default-zzz999', 'ready', 'default', { environment: 'someone-else' })
  t.boat.addBox('tbx-h2-shared-default-abc123', 'ready', 'default', { environment: 'tbx-h2-shared' })
  t.boat.addBox('tbx-h10-shared-default-abc123', 'ready', 'default', { environment: 'tbx-h10-shared' })
  t.boat.addBox('llm-wiki-suite', 'ready')
  await t.runs.pool.reconcile()
  assert.deepEqual(t.runs.pool.boxes().map((b) => b.name), [mine.name])
})

test('box names: tbx-style only for this host\'s pool environments; every other daemon and environment keeps cib-…', () => {
  assert.equal(boxName('tb', 'tbx-h1-shared', 'default', 'abc123', 'h1'), 'tbx-h1-shared-default-abc123')
  assert.equal(boxName('tb', 'tbx-h1-shared', 'default', 'abc123'), 'cib-tb-tbx-h1-shared-default-abc123', 'no poolHost (ci-brokerd)')
  assert.equal(boxName('tb', 'tbx-h2-shared', 'default', 'abc123', 'h1'), 'cib-tb-tbx-h2-shared-default-abc123', 'another host\'s')
  assert.equal(boxName('tb', 'acme', 'default', 'abc123', 'h1'), 'cib-tb-acme-default-abc123')
})

const EXTRA_REMOTE = `#!/usr/bin/env bash
echo "gw=\${CIB_EXTRA_GW:-unset}"
[ -f "\${CIB_EXTRA_GW:-/nope}" ] && echo "heads: $(git bundle list-heads "$CIB_EXTRA_GW")"
exit 0
`

test('extra repos: the pinned commit (read from a JSON file in the commit) is fetched here, bundled once, and sent only to a box that lacks it', async () => {
  const gw = makeOrigin(join(tmp('tb-gw-'), 'o'), 'org/gw')
  const pin2 = pushCommit(gw.work, 'g.txt', 'v2\n')
  const fetched: string[] = []
  const t = setup({
    remote: EXTRA_REMOTE, shards: [{ name: 'a', args: ['ok'] }],
    extraRepos: [{ name: 'gw', repo: 'org/gw', ref: 'pins.json#gw.commit' }],
    extraUrl: (r) => (fetched.push(r), gw.bare),
  })
  const sent: string[] = []
  const scp = t.boat.scp.bind(t.boat)
  t.boat.scp = async (l, id, r, o) => (sent.push(r), scp(l, id, r, o))
  poolBox(t)
  await t.runs.pool.reconcile()
  const run = async () => {
    const a = await t.ask()
    assert.ok('run' in a, JSON.stringify(a))
    const ev = t.collect(a.run)
    await until(() => ev.some((e) => e.t === 'done'), 'the run to end')
    await t.runs.idle()
    const done = ev.find((e) => e.t === 'done')!
    const out = ev.filter((e) => e.t === 'log').map((e) => (e.t === 'log' ? e.data : '')).join('')
    assert.equal(done.t === 'done' && done.code, 0, out + (done.t === 'done' ? done.receipt : ''))
    return out
  }
  writeFileSync(join(t.work, 'pins.json'), JSON.stringify({ gw: { commit: gw.sha } }))
  let out = await run()
  assert.match(out, /gw=\/home\/user\/cib\/extra\/gw\.bundle|gw=.*\/cib\/extra\/gw\.bundle/)
  assert.match(out, new RegExp(`heads: ${gw.sha} refs/cib/extra`))
  assert.equal(sent.filter((r) => r.endsWith('/extra/gw.bundle.part0')).length, 1)
  // same pin: the box has it, nothing sent, nothing fetched again
  out = await run()
  assert.equal(sent.filter((r) => r.endsWith('/extra/gw.bundle.part0')).length, 1, 'not sent again')
  assert.equal(fetched.length, 1, 'not fetched again')
  // the commit under test moves the pin: the new commit goes
  writeFileSync(join(t.work, 'pins.json'), JSON.stringify({ gw: { commit: pin2 } }))
  out = await run()
  assert.match(out, new RegExp(`heads: ${pin2} refs/cib/extra`))
  assert.equal(sent.filter((r) => r.endsWith('/extra/gw.bundle.part0')).length, 2)
})

test('extra repos: a public one, a missing file or a bad sha fails the run here with the reason; no box is charged', async () => {
  const gw = makeOrigin(join(tmp('tb-gw-'), 'o'), 'org/gw')
  const go = async (o: { isPrivate?: (r: string) => Promise<boolean>; pins?: string }) => {
    const t = setup({
      remote: EXTRA_REMOTE, shards: [{ name: 'a', args: ['ok'] }],
      extraRepos: [{ name: 'gw', repo: 'org/gw', ref: 'pins.json#gw.commit' }],
      extraUrl: () => gw.bare, ...(o.isPrivate ? { isPrivate: o.isPrivate } : {}),
    })
    if (o.pins !== undefined) writeFileSync(join(t.work, 'pins.json'), o.pins)
    const a = await t.ask()
    assert.ok('run' in a, JSON.stringify(a))
    const ev = t.collect(a.run)
    await until(() => ev.some((e) => e.t === 'done'), 'the run to end')
    await t.runs.idle()
    const done = ev.find((e) => e.t === 'done')!
    assert.equal(done.t === 'done' && done.code, 1)
    assert.ok(t.runs.pool.boxes().every((b) => b.infraFails === 0), 'no box charged')
    return done.t === 'done' ? done.receipt : ''
  }
  const pins = JSON.stringify({ gw: { commit: gw.sha } })
  assert.match(await go({ pins, isPrivate: async (r) => r !== 'org/gw' }), /extra repo org\/gw is not private/)
  assert.match(await go({}), /pins\.json#gw\.commit: cannot read it in the commit/)
  assert.match(await go({ pins: JSON.stringify({ gw: { commit: 'main' } }) }), /not a 40-hex commit sha/)
})

const SLOT_REMOTE = `#!/usr/bin/env bash
echo "shard=$2 slot=$CIB_SLOT units=\${CIB_UNITS:-} cpus=\${CIB_CPUS:-} cpuset=\${CIB_CPUSET:-} mem=\${CIB_MEM_MB:-} attempt=\${CIB_ATTEMPT:-}"
[ "$2" = hold ] && sleep "\${3:-2}"
exit 0
`
const largeBox = (t: ReturnType<typeof setup>, state = 'ready') =>
  t.boat.addBox(boxName('tb', 'tbx-h1-shared', 'large', Math.random().toString(36).slice(2, 8), 'h1'), state, 'large', { environment: 'tbx-h1-shared', environmentVersion: 1 })
const runToEnd = async (t: ReturnType<typeof setup>, id: string, maxMs?: number) => {
  const ev = t.collect(id)
  await until(() => ev.some((e) => e.t === 'done'), 'the run to end', maxMs)
  await t.runs.idle()
  const done = ev.find((e) => e.t === 'done')!
  const out = ev.filter((e) => e.t === 'log').map((e) => (e.t === 'log' ? e.data : '')).join('')
  return { code: done.t === 'done' ? done.code : -1, out, receipt: done.t === 'done' ? done.receipt : '' }
}

test('packing: the 2-unit shards of a run share one new large box, each in its own slot with its own CPUs; the box goes idle after', async () => {
  const t = setup({ remote: SLOT_REMOTE, shards: [{ name: 'a', units: 2, args: ['a'] }, { name: 'b', units: 2, args: ['b'] }], cfg: (c) => { c.boat.packing = true; c.boat.sizes = ['default', 'large'] } })
  const a = await t.ask()
  assert.ok('run' in a, JSON.stringify(a))
  const r = await runToEnd(t, a.run)
  assert.equal(r.code, 0, r.out + r.receipt)
  const boxes = t.runs.pool.boxes()
  assert.deepEqual(boxes.map((b) => [b.size, b.state]), [['large', 'idle']])
  assert.match(r.out, /shard=a slot=0 units=2 cpus=4 cpuset=0-3 mem=8192 attempt=tb-\S+\.a\.1/)
  assert.match(r.out, /shard=b slot=2 units=2 cpus=4 cpuset=4-7 mem=8192/)
  assert.match(r.receipt, /slot 0/)
  const st = t.runs.status()
  assert.equal(st.packing, true)
  assert.equal(st.boxes[0].unitsUsed, 0)
})

test('packing: a second run takes the free units of a box the first still runs; the box is released only when both end', async () => {
  const t = setup({ remote: SLOT_REMOTE, shards: [{ name: 'a', units: 2, args: ['hold', '3'] }], cfg: (c) => { c.boat.packing = true; c.boat.sizes = ['default', 'large'] } })
  largeBox(t)
  await t.runs.pool.reconcile()
  const one = await t.ask()
  assert.ok('run' in one, JSON.stringify(one))
  const ev1 = t.collect(one.run)
  await until(() => ev1.some((e) => e.t === 'state' && e.state === 'running'), 'run 1 running')
  const box = t.runs.pool.boxes()[0].name
  assert.equal(t.runs.status().boxes[0].unitsUsed, 2)
  const two = await t.ask()
  assert.ok('run' in two, JSON.stringify(two))
  assert.ok(t.logs.some((l) => l.includes(`${box} slot 2 (shared)`)), t.logs.join('\n'))
  assert.equal(t.runs.status().boxes[0].unitsUsed, 4)
  // a third has no free units and no other box: it gets a new one (default: 2 units is all it needs)
  const three = await t.ask()
  assert.ok('run' in three, JSON.stringify(three))
  for (const id of [one.run, two.run, three.run]) assert.equal((await runToEnd(t, id)).code, 0)
  assert.deepEqual(t.runs.pool.boxes().map((b) => [b.size, b.state]).sort(), [['default', 'idle'], ['large', 'idle']])
  assert.equal(t.boat.boxes.length, 2)
})

test('packing off: a units-only shard gets the smallest size that holds it, one box per shard, no slot share', async () => {
  const t = setup({ remote: SLOT_REMOTE, shards: [{ name: 'a', units: 3, args: ['a'] }, { name: 'b', units: 1, args: ['b'] }], cfg: (c) => { c.boat.sizes = ['default', 'large'] } })
  const a = await t.ask()
  assert.ok('run' in a, JSON.stringify(a))
  const r = await runToEnd(t, a.run)
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(t.runs.pool.boxes().map((b) => b.size).sort(), ['default', 'large'])
  assert.match(r.out, /shard=a slot=0 units= cpus= cpuset= mem= attempt=tb-/)
  // no size on the machine holds the units: the ask says why
  const t2 = setup({ shards: [{ name: 'a', units: 3, args: ['a'] }], cfg: (c) => { c.boat.sizes = ['default'] } })
  const b = await t2.ask()
  assert.ok('why' in b)
  assert.match(b.why, /no box size on this machine \(boat\.sizes\) holds a \(3 unit\(s\), 12288 MB\)/)
})

test('packing: memGb is a second dimension: an e2e-like shard (2 units, 11 GB) leaves its box to a light shard, not to a full-RAM one', async () => {
  const t = setup({ remote: SLOT_REMOTE, shards: [{ name: 'e2e', units: 2, memGb: 11, args: ['hold', '3'] }], cfg: (c) => { c.boat.packing = true; c.boat.sizes = ['default', 'large'] } })
  largeBox(t)
  await t.runs.pool.reconcile()
  const one = await t.ask()
  assert.ok('run' in one, JSON.stringify(one))
  const ev1 = t.collect(one.run)
  await until(() => ev1.some((e) => e.t === 'state' && e.state === 'running'), 'run 1 running')
  const box = t.runs.pool.boxes()[0]
  assert.equal(box.size, 'large')
  const st = t.runs.status()
  assert.deepEqual([st.boxes[0].unitsUsed, st.boxes[0].memUsedMb, st.boxes[0].memMb], [2, 11264, 16384])
  const ask = async (shard: object) => {
    const c = parseRepoConfig({ boat: { remoteScript: '.test-broker/remote.sh' }, suites: { all: { local: { cpus: 2 }, boat: { shards: [{ name: 'x', args: ['x'], ...shard }] } } } }, t.work)
    return t.runs.tryRun({ repo: 'me/app', cfg: c, suite: c.suites.all, args: [], owner: 'c2' })
  }
  // 2 units at 8 GB: the CPUs are free, the RAM is not (11 + 8 > 16): a box of its own
  const full = await ask({ units: 2 })
  assert.ok('run' in full, JSON.stringify(full))
  assert.ok(!t.logs.some((l) => l.includes(`${box.name} slot 2 (shared)`)), t.logs.join('\n'))
  // 2 units at 4 GB: fits beside it (11 + 4 <= 16), in slot 2, and is told its RAM
  const light = await ask({ units: 2, memGb: 4 })
  assert.ok('run' in light, JSON.stringify(light))
  assert.ok(t.logs.some((l) => l.includes(`${box.name} slot 2 (shared)`)), t.logs.join('\n'))
  assert.equal(t.runs.status().boxes.find((b) => b.name === box.name)?.memUsedMb, 11264 + 4096)
  const r1 = await runToEnd(t, one.run)
  assert.equal(r1.code, 0, r1.out)
  assert.match(r1.out, /shard=hold slot=0 units=2 cpus=4 cpuset=0-3 mem=11264/)
  const rl = await runToEnd(t, light.run)
  assert.match(rl.out, /shard=x slot=2 units=2 cpus=4 cpuset=4-7 mem=4096/)
  assert.equal((await runToEnd(t, full.run)).code, 0)
  // every holder gave its RAM back with its units
  for (const b of t.runs.status().boxes) assert.deepEqual([b.unitsUsed, b.memUsedMb], [0, 0], JSON.stringify(b))
})

test('packing: a run of a CPU-heavy and a RAM-heavy shard is sized by its total CPUs and RAM, not by each shard', async () => {
  const t = setup({ remote: SLOT_REMOTE, shards: [{ name: 'a', units: 3, memGb: 1, args: ['a'] }, { name: 'b', units: 1, memGb: 12, args: ['b'] }], cfg: (c) => { c.boat.packing = true; c.boat.sizes = ['default', 'large', 'xlarge'] } })
  const a = await t.ask()
  assert.ok('run' in a, JSON.stringify(a))
  assert.equal((await runToEnd(t, a.run)).code, 0)
  // 4 units and 13 GB in all: one large box (not an xlarge from 3 + 3 box units)
  assert.deepEqual(t.runs.pool.boxes().map((b) => b.size), ['large'])
})

test('packing off: memGb sizes the box (2 units at 11 GB takes a large one)', async () => {
  const t = setup({ remote: SLOT_REMOTE, shards: [{ name: 'a', units: 2, memGb: 11, args: ['a'] }], cfg: (c) => { c.boat.sizes = ['default', 'large'] } })
  const a = await t.ask()
  assert.ok('run' in a, JSON.stringify(a))
  assert.equal((await runToEnd(t, a.run)).code, 0)
  assert.deepEqual(t.runs.pool.boxes().map((b) => b.size), ['large'])
  const t2 = setup({ shards: [{ name: 'a', units: 1, memGb: 9, args: ['a'] }], cfg: (c) => { c.boat.sizes = ['default'] } })
  const b = await t2.ask()
  assert.ok('why' in b)
  assert.match(b.why, /holds a \(1 unit\(s\), 9216 MB\)/)
})

test('a lost connection: the retry kill fences the lost attempt (it can never start later)', async () => {
  const t = setup({ shards: [{ name: 'a', args: ['ok'] }] })
  idleBoxes(t, 1)
  await t.runs.pool.reconcile()
  let left = 1
  const kills: string[] = []
  const runs: string[] = []
  t.boat.onCommand = (_id, cmd) => {
    if (cmd.includes('--kill')) kills.push(cmd)
    else if (cmd.includes('cib-wrap.sh" ')) runs.push(cmd)
    return cmd.includes('cib-wrap.sh" ') && !cmd.includes('--kill') && left-- > 0 ? 255 : undefined
  }
  const a = await t.ask()
  assert.ok('run' in a)
  assert.equal((await runToEnd(t, a.run)).code, 0)
  assert.ok(kills.some((k) => /--fence 'tb-\S+\.a\.1'/.test(k)), kills.join('\n'))
  // the retry carries the lost attempt in CIB_FENCE (the kill exec may have been lost too)
  assert.ok(runs.some((c) => /CIB_ATTEMPT='tb-\S+\.a\.2' CIB_FENCE='tb-\S+\.a\.1'/.test(c)), runs.join('\n'))
})

test('packing: a run that fails to place after claiming units on a busy box gives that box back when its own run ended meanwhile', async () => {
  const t = setup({ remote: SLOT_REMOTE, shards: [{ name: 'a', units: 2, args: ['hold', '1'] }], cfg: (c) => { c.boat.packing = true; c.boat.sizes = ['default', 'large'] } })
  largeBox(t)
  await t.runs.pool.reconcile()
  const one = await t.ask()
  assert.ok('run' in one, JSON.stringify(one))
  const ev1 = t.collect(one.run)
  await until(() => ev1.some((e) => e.t === 'state' && e.state === 'running'), 'run 1 running')
  const box = t.runs.pool.boxes()[0].name
  // run 2: shard a shares the large box; shard b needs a new box, and the budget read waits for run 1 to end, then says no
  const cfg2 = parseRepoConfig({ boat: { remoteScript: '.test-broker/remote.sh' }, suites: { all: { local: { cpus: 2 }, boat: { shards: [{ name: 'a', units: 2, args: ['a'] }, { name: 'b', units: 2, args: ['b'] }] } } } }, t.work)
  const real = t.boat.starts.bind(t.boat)
  t.boat.starts = async () => {
    await until(() => ev1.some((e) => e.t === 'done'), 'run 1 to end')
    return { ...(await real()), day: 0 }
  }
  const two = await t.runs.tryRun({ repo: 'me/app', cfg: cfg2, suite: cfg2.suites.all, args: [], owner: 'c2' })
  assert.ok('why' in two, JSON.stringify(two))
  await t.runs.idle()
  assert.equal(t.runs.pool.d.db.box(box)?.state, 'idle', 'not left busy with no shard on it')
  assert.equal(t.runs.status().boxes.find((b) => b.name === box)?.unitsUsed, 0)
  // the undone claims gave their RAM back too (no stale pending holder)
  for (const b of t.runs.status().boxes) assert.equal(b.memUsedMb ?? 0, 0, JSON.stringify(b))
})

// the queue
const qsetup = (o: { hold?: number; maxWait?: number; usage?: RunsDb } = {}) => {
  const t = setup({ ...(o.usage ? { usage: o.usage } : {}), remote: SLOT_REMOTE, shards: [{ name: 'a', units: 4, args: ['hold', String(o.hold ?? 2)] }], cfg: (c) => { c.boat.packing = true; c.boat.sizes = ['large']; if (o.maxWait != null) c.boat.maxWaitSec = o.maxWait } })
  const key = { repo: 'me/app', suite: 'all', shape: 'whole', shard: 'a', argsKey: '-' }
  const learn = (secs: number) => { for (let i = 0; i < 6; i++) t.runs.eta.add(key, secs, 'reused') }
  return { t, learn }
}

test('queue: no idle box, a busy one about to free: the shard waits for it, no box is resumed', async () => {
  const { t, learn } = qsetup()
  largeBox(t)
  largeBox(t, 'stopped')
  await t.runs.pool.reconcile()
  learn(3)
  const one = await t.ask()
  assert.ok('run' in one, JSON.stringify(one))
  const busy = t.runs.pool.boxes().find((b) => b.state === 'busy')!.name
  const two = await t.ask()
  assert.ok('run' in two, JSON.stringify(two))
  assert.ok(t.logs.some((l) => l.includes(`${busy} (wait, about`)), t.logs.join('\n'))
  assert.ok((t.runs.status().runs.find((r) => r.id === two.run)!.shards[0] as { waiting?: unknown }).waiting != null)
  const ev2 = t.collect(two.run)
  for (const id of [one.run, two.run]) assert.equal((await runToEnd(t, id)).code, 0)
  assert.ok(ev2.some((e) => e.t === 'state' && e.state === 'waiting for box'))
  assert.ok(t.logs.some((l) => new RegExp(`a on ${busy} slot 0 after a \\d+s wait`).test(l)), t.logs.join('\n'))
  assert.deepEqual(t.runs.pool.boxes().map((b) => b.state).sort(), ['idle', 'stopped'], 'the stopped box was never resumed')
})

test('queue: no history for the holder, or maxWaitSec 0: no wait, the stopped box is resumed', async () => {
  for (const o of [{ learn: false, maxWait: 180 }, { learn: true, maxWait: 0 }]) {
    const { t, learn } = qsetup({ maxWait: o.maxWait })
    largeBox(t)
    largeBox(t, 'stopped')
    await t.runs.pool.reconcile()
    if (o.learn) learn(3)
    const one = await t.ask()
    const two = await t.ask()
    assert.ok('run' in one && 'run' in two)
    assert.ok(t.logs.some((l) => l.includes('(resumed)')), t.logs.join('\n'))
    assert.ok(!t.logs.some((l) => l.includes('(wait,')), t.logs.join('\n'))
    for (const id of [one.run, two.run]) assert.equal((await runToEnd(t, id)).code, 0)
  }
})

test('queue: a holder slower than its estimate: the waiter gives up and is placed again (the stopped box)', async () => {
  // estimate 1 s (5 s left at least), the holder takes 8 s; maxWaitSec 5 bounds the wait
  const usage = new RunsDb(':memory:')
  const { t, learn } = qsetup({ hold: 8, maxWait: 5, usage })
  largeBox(t)
  largeBox(t, 'stopped')
  await t.runs.pool.reconcile()
  learn(1)
  const one = await t.ask()
  const two = await t.ask()
  assert.ok('run' in one && 'run' in two)
  assert.ok(t.logs.some((l) => l.includes('(wait, about')), t.logs.join('\n'))
  const r2 = await runToEnd(t, two.run, 30_000)
  assert.equal(r2.code, 0, r2.out)
  assert.ok(t.logs.some((l) => /gave up \(not free within 5s\)/.test(l)), t.logs.join('\n'))
  assert.ok(t.logs.some((l) => /a on \S+ slot 0 \(resumed\) after a \d+s wait/.test(l)), t.logs.join('\n'))
  assert.equal((await runToEnd(t, one.run)).code, 0)
  const sh = usage.runsSince(0).find((r) => r.id === two.run)!.shards![0]
  assert.equal(sh.waitGaveUp, true, 'runs.db records the give-up')
  assert.equal(sh.how, 'resumed')
})

test('queue: a cancel drops the claim; the box goes back to idle when its holder ends', async () => {
  const { t, learn } = qsetup({ hold: 3 })
  largeBox(t)
  await t.runs.pool.reconcile()
  learn(4)
  const one = await t.ask()
  const two = await t.ask()
  assert.ok('run' in one && 'run' in two, JSON.stringify(two))
  assert.ok(t.logs.some((l) => l.includes('(wait, about')), t.logs.join('\n'))
  assert.equal(t.runs.cancel(two.run, 'cancelled'), true)
  const r2 = await runToEnd(t, two.run)
  assert.notEqual(r2.code, 0)
  assert.equal((await runToEnd(t, one.run)).code, 0)
  assert.deepEqual(t.runs.pool.boxes().map((b) => b.state), ['idle'])
  assert.equal(t.runs.status().boxes[0].unitsUsed, 0)
})

test('peek: reads only; says what each shard would get now (here: a wait), with no claim and no start', async () => {
  const { t, learn } = qsetup({ hold: 3 })
  largeBox(t)
  largeBox(t, 'stopped')
  await t.runs.pool.reconcile()
  const cfg = parseRepoConfig(JSON.parse(readFileSync(join(t.work, '.test-broker.json'), 'utf8')), t.work)
  const peek = () => t.runs.peek({ repo: 'me/app', cfg, suite: cfg.suites.all, args: [] })
  // before any real ask has checked the pool, a peek says so (it never checks it itself: that may write)
  const p0 = await peek()
  assert.ok('why' in p0 && /no run in this pool/.test(p0.why), JSON.stringify(p0))
  assert.ok(!t.boat.calls.some((c) => /env (info|create|safe)/.test(c)), 'a peek made no environment call')
  learn(3)
  const one = await t.ask()
  assert.ok('run' in one)
  const p1 = await peek()
  assert.ok(!('why' in p1))
  assert.equal(p1.shards[0].how, 'wait')
  assert.equal(p1.shards[0].runSec, 3)
  assert.equal(p1.pool.busy, 1)
  assert.equal(p1.pool.waiting, 0, 'a peek takes no claim')
  assert.equal((await runToEnd(t, one.run)).code, 0)
  assert.deepEqual(t.runs.pool.boxes().map((b) => b.state).sort(), ['idle', 'stopped'])
})

test('queue: the start deadline counts from when a waiting shard gets its box, not from the ask', async () => {
  // the holder takes 7 s; the deadline is 5 s: a deadline from the ask would end run 2 as not started
  const { t, learn } = qsetup({ hold: 7 })
  t.mc.boat.startDeadlineSec = 5
  largeBox(t)
  largeBox(t, 'stopped')
  await t.runs.pool.reconcile()
  learn(7)
  const one = await t.ask()
  const two = await t.ask()
  assert.ok('run' in one && 'run' in two)
  assert.ok(t.logs.some((l) => l.includes('(wait, about')), t.logs.join('\n'))
  const r2 = await runToEnd(t, two.run, 30_000)
  assert.equal(r2.code, 0, r2.receipt)
  assert.equal((await runToEnd(t, one.run)).code, 0)
})

test('queue: a waiter that gives up and finds no box ends the run as not started (exit 3); no box is left busy', async () => {
  // one box (maxBoxes 1), a holder slower than its estimate: after the wait there is nothing to place on
  const { t, learn } = qsetup({ hold: 8, maxWait: 5 })
  t.mc.boat.maxBoxes = 1
  largeBox(t)
  await t.runs.pool.reconcile()
  learn(1)
  const one = await t.ask()
  const two = await t.ask()
  assert.ok('run' in one && 'run' in two, JSON.stringify(two))
  const r2 = await runToEnd(t, two.run, 30_000)
  assert.equal(r2.code, 3, r2.receipt)
  assert.match(r2.receipt, /not started: a has no box after its wait/)
  assert.equal((await runToEnd(t, one.run, 30_000)).code, 0)
  assert.deepEqual(t.runs.pool.boxes().map((b) => b.state), ['idle'])
  assert.equal(t.runs.status().boxes[0].unitsUsed, 0)
})

test('infra exit codes: a box whose shards exit with one is charged and quarantined after 3 in a row; a test failure is not charged', async () => {
  const remote = `#!/usr/bin/env bash\n[ "$2" = broken ] && { echo "cannot fetch"; exit 91; }\n[ "$2" = fail ] && exit 1\nexit 0\n`
  for (const mode of ['broken', 'fail']) {
    const t = setup({ remote, shards: [{ name: 'a', args: [mode] }], cfg: (c) => { c.boat.infraExitCodes = { 'me/app': [91] } } })
    poolBox(t)
    await t.runs.pool.reconcile()
    const [box] = t.runs.pool.boxes().map((b) => b.name)
    for (let i = 0; i < 3; i++) {
      const a = await t.ask()
      assert.ok('run' in a, JSON.stringify(a))
      const r = await runToEnd(t, a.run)
      assert.notEqual(r.code, 0)
      if (mode === 'broken') assert.match(r.out, /exit 91 is an infra code of this repo/)
      if (i < 2 || mode === 'fail') assert.equal(t.runs.pool.boxes().find((b) => b.name === box)!.state, 'idle', `after run ${i + 1}`)
    }
    const row = t.runs.pool.boxes().find((b) => b.name === box)!
    if (mode === 'broken') {
      assert.equal(row.state, 'quarantined')
      assert.match(row.reason ?? '', /3 infra failures in a row; last: exit 91 \(an infra code of me\/app\)/)
    } else assert.deepEqual([row.state, row.infraFails], ['idle', 0])
  }
})

test('infra exit codes: the repo key wins over the machine map', () => {
  const doc = { boat: { remoteScript: 'r.sh', infraExitCodes: [89, 91, 91] }, suites: { s: { local: { cpus: 2 } } } }
  assert.deepEqual(parseRepoConfig(doc, '/r').boat!.infraExitCodes, [89, 91])
  assert.equal(parseRepoConfig({ boat: { remoteScript: 'r.sh' }, suites: { s: { local: { cpus: 2 } } } }, '/r').boat!.infraExitCodes, null)
  assert.throws(() => parseRepoConfig({ boat: { remoteScript: 'r.sh', infraExitCodes: [1] }, suites: { s: { local: { cpus: 2 } } } }, '/r'), /infraExitCodes/)
})

// ---- the warm pool (Part B)

const wsetup = (o: { usage?: RunsDb } = {}) => {
  let clock = Date.now()
  const t = setup({ ...(o.usage ? { usage: o.usage } : {}), now: () => clock, remote: SLOT_REMOTE, shards: [{ name: 'a', units: 2, args: ['a'] }], cfg: (c) => { c.boat.packing = true; c.boat.sizes = ['large']; c.boat.idleStopMin = 8 } })
  const sweep = () => (t.runs as unknown as { sweepWarm(): Promise<unknown> }).sweepWarm()
  return { t, sweep, tick: (min: number) => (clock += min * 60_000), now: () => clock }
}
const states = (t: ReturnType<typeof setup>) => t.runs.pool.boxes().map((b) => b.state).sort()

test('warm pool: idle boxes past the warm target stop after shortIdleMin; the target (one box while the pool is active) stays to idleStopMin', async () => {
  const usage = new RunsDb(':memory:')
  const w = wsetup({ usage })
  for (let i = 0; i < 3; i++) largeBox(w.t)
  await w.t.runs.pool.reconcile()
  w.t.runs.activity.run(w.t.work, 'me/app', 'tbx-h1-shared', w.now())
  const [plan] = w.t.runs.warmPlan()
  assert.equal(plan.targetUnits, 4, 'one large box while the pool ran a test in the last 30 min')
  assert.equal(plan.pastTarget.length, 2)
  w.tick(1)
  await w.sweep()
  assert.deepEqual(states(w.t), ['idle', 'idle', 'idle'], 'not before shortIdleMin')
  w.tick(2)
  await w.sweep()
  assert.deepEqual(states(w.t), ['idle', 'stopped', 'stopped'])
  const early = usage.boxEventsSince(0).filter((e) => e.state === 'stopping')
  assert.deepEqual(early.map((e) => e.reason), ['idle (past the warm target)', 'idle (past the warm target)'])
  w.tick(6)
  await w.sweep()
  assert.deepEqual(states(w.t), ['stopped', 'stopped', 'stopped'], 'the warm box stops at idleStopMin')
  assert.equal(usage.boxEventsSince(0).filter((e) => e.state === 'stopping').at(-1)!.reason, 'idle')
  const day = poolDays(usage.runsSince(0), usage.boxEventsSince(0), 0, w.now() + 1)
  assert.equal(day.at(-1)!.earlyStops, 2)
  assert.ok(day.at(-1)!.hours.earlyTail > 0 && day.at(-1)!.hours.tail > 0)
})

test('warm pool: the starts guard keeps every box on idleStopMin; no activity and no load: target 0', async () => {
  const w = wsetup()
  for (let i = 0; i < 2; i++) largeBox(w.t)
  await w.t.runs.pool.reconcile()
  assert.equal(w.t.runs.warmPlan()[0].targetUnits, 0)
  w.t.runs.pool.lastStarts = { day: 30, hour: 50, minute: 12, dayLimit: 200, at: w.now() }
  assert.equal(w.t.runs.warmPlan()[0].startsGuard, true)
  w.tick(3)
  await w.sweep()
  assert.deepEqual(states(w.t), ['idle', 'idle'])
  w.t.runs.pool.lastStarts = { day: 150, hour: 50, minute: 12, dayLimit: 200, at: w.now() }
  await w.sweep()
  assert.deepEqual(states(w.t), ['stopped', 'stopped'])
})

test('warm pool: load in the last 20 min raises the target (D_recent: p90 of the units held, sampled each minute)', async () => {
  const w = wsetup()
  for (let i = 0; i < 3; i++) largeBox(w.t)
  await w.t.runs.pool.reconcile()
  const boxes = w.t.runs.pool.boxes()
  // two boxes full for 10 samples (8 units), as two runs would hold them
  for (const b of boxes.slice(0, 2)) {
    w.t.runs.pool.setState(b.name, 'busy')
    ;(w.t.runs as unknown as { occupy(box: string, slot: number, units: number, who: string | null, mem?: number): void }).occupy(b.name, 0, 4, `tb-x/${b.name}`, 4096)
  }
  for (let i = 0; i < 10; i++) {
    w.t.runs.sampleLoad()
    w.tick(1)
  }
  for (const b of boxes.slice(0, 2)) {
    ;(w.t.runs as unknown as { occupy(box: string, slot: number, units: number, who: string | null): void }).occupy(b.name, 0, 4, null)
    w.t.runs.pool.release(b.name, 'me/app')
  }
  const [plan] = w.t.runs.warmPlan()
  assert.equal(plan.dRecent, 8)
  assert.deepEqual(plan.pastTarget.length, 1, 'two boxes hold the recent load; the third is past it')
})

test('hints: a hinted worktree counts as an agent (status shows it, the target grows); --gone ends it', async () => {
  const w = wsetup()
  for (let i = 0; i < 2; i++) largeBox(w.t)
  await w.t.runs.pool.reconcile()
  const cfg = parseRepoConfig(JSON.parse(readFileSync(join(w.t.work, '.test-broker.json'), 'utf8')), w.t.work)
  w.t.runs.hint({ root: w.t.work, repo: 'me/app', cfg, ttlMs: 30 * 60_000 })
  const st = w.t.runs.status()
  assert.deepEqual(st.agents, [{ repo: 'me/app', worktree: w.t.work, source: 'hint' }])
  const [plan] = st.warm
  assert.equal(plan.agents, 1)
  assert.equal(plan.dAgents, 1, 'no history: 1 unit per agent')
  assert.equal(plan.pastTarget.length, 1, 'one unit wanted: one box kept')
  w.t.runs.hint({ root: w.t.work, gone: true })
  assert.deepEqual(w.t.runs.status().agents, [])
  // a worktree with no Boat config is ignored
  w.t.runs.hint({ root: '/nowhere', repo: 'me/app', cfg: { ...cfg, boat: null } })
  assert.deepEqual(w.t.runs.status().agents, [])
})

test('usage: each shard keeps a summary of its output; a done run\'s log reads back from its file', async () => {
  const usage = new RunsDb(':memory:')
  const t = setup({ usage, remote: '#!/usr/bin/env bash\necho "=== [0s] setup"\necho "=== [2s] tests"\necho "      Tests  2 failed | 5 passed (7)"\necho " FAIL  a.test.ts > b > c"\necho "=== [5s] done: rc=1"\nexit 1\n' })
  const a = await t.ask()
  assert.ok('run' in a, JSON.stringify(a))
  await until(() => t.runs.status().runs.every((r) => r.done), 'the run to end')
  await t.runs.idle()
  const sh = usage.runsSince(0)[0].shards![0]
  assert.ok(sh.log, JSON.stringify(sh))
  assert.deepEqual(sh.log!.phases, [{ name: 'setup', secs: 2 }, { name: 'tests', secs: 3 }])
  assert.deepEqual(sh.log!.tests, { passed: 5, failed: 2, skipped: 0 })
  assert.deepEqual(sh.log!.failing, ['a.test.ts > b > c'])
  assert.ok(sh.log!.bytes > 0)
  assert.match(t.runs.readLog(a.run) ?? '', /\[a\] === \[2s\] tests/)
})

test('peek at the starts reserve: a shard that needs a box start gets none (the ask exit code then says local)', async () => {
  const { t } = qsetup({ hold: 3, maxWait: 0 })
  largeBox(t)
  largeBox(t, 'stopped')
  await t.runs.pool.reconcile()
  const cfg = parseRepoConfig(JSON.parse(readFileSync(join(t.work, '.test-broker.json'), 'utf8')), t.work)
  const peek = () => t.runs.peek({ repo: 'me/app', cfg, suite: cfg.suites.all, args: [] })
  const one = await t.ask()
  assert.ok('run' in one)
  const p1 = await peek()
  assert.ok(!('why' in p1) && p1.shards[0].how === 'resume', JSON.stringify(p1))
  t.runs.pool.lastStarts = { day: 20, hour: 50, minute: 10, at: Date.now() }
  const p2 = await peek()
  assert.ok(!('why' in p2) && p2.shards[0].how === 'none', JSON.stringify(p2))
  t.runs.pool.lastStarts = { day: 21, hour: 50, minute: 10, at: Date.now() }
  const p3 = await peek()
  assert.ok(!('why' in p3) && p3.shards[0].how === 'resume', 'one start left above the reserve')
  assert.equal((await runToEnd(t, one.run)).code, 0)
})

test('a box that fails to resume ends the run as not started (exit 3, the CLI runs it here), counts toward quarantine, and Boat pauses after failures on 2 boxes', async () => {
  const t = setup({ shards: [{ name: 'a', args: ['ok'] }, { name: 'b', args: ['ok'] }] })
  idleBoxes(t, 2, 'stopped')
  await t.runs.pool.reconcile()
  t.boat.failResume = true
  const a = await t.ask()
  assert.ok('run' in a, JSON.stringify(a))
  const ev = t.collect(a.run)
  await until(() => ev.some((e) => e.t === 'done'), 'done')
  const done = ev.find((e) => e.t === 'done')!
  assert.deepEqual(done.t === 'done' && [done.code, done.notStarted], [3, true])
  assert.match(done.t === 'done' ? done.receipt : '', /not started: box .* did not start: boat resume failed/)
  await t.runs.idle()
  // the resume failures were charged to the boxes
  assert.ok(t.runs.pool.boxes().some((b) => b.infraFails >= 1 && /resume failed/.test(b.reason ?? '')), JSON.stringify(t.runs.pool.boxes()))
  // each shard's failed resume counts (2 boxes): a second run passes outageFails (3)
  if (!t.runs.outage.view().paused) {
    const a2 = await t.ask()
    assert.ok('run' in a2, JSON.stringify(a2))
    const ev2 = t.collect(a2.run)
    await until(() => ev2.some((e) => e.t === 'done'), 'done 2')
    await t.runs.idle()
  }
  const a3 = await t.ask()
  assert.ok('why' in a3 && /^Boat paused until/.test(a3.why), JSON.stringify(a3))
  assert.equal(t.runs.status().outage.paused, true)
  assert.ok(t.logs.some((l) => /boat: paused until/.test(l)), t.logs.join('\n'))
})

test('a box that fails to resume 3 times in a row is quarantined', async () => {
  const t = setup({ shards: [{ name: 'a', args: ['ok'] }], cfg: (c) => (c.boat.outageFails = 0) })
  idleBoxes(t, 1, 'stopped')
  await t.runs.pool.reconcile()
  t.boat.failResume = true
  for (let i = 0; i < 3; i++) {
    const a = await t.ask()
    if (!('run' in a)) break
    const ev = t.collect(a.run)
    await until(() => ev.some((e) => e.t === 'done'), `done ${i}`)
    await t.runs.idle()
  }
  const q = t.runs.pool.boxes().filter((b) => b.state === 'quarantined')
  assert.equal(q.length, 1, JSON.stringify(t.runs.pool.boxes()))
  assert.match(q[0].reason ?? '', /3 infra failures in a row; last: resume failed/)
})

// ---- box speed and drains

const setScores = (t: ReturnType<typeof setup>, m: Record<string, number>) => {
  ;(t.runs as unknown as { scores: Map<string, { score: number; samples: number }> }).scores = new Map(Object.entries(m).map(([k, v]) => [k, { score: v, samples: 20, last: 0 }]))
}
const speedSetup = (o: { avoidSlow?: boolean; now?: () => number; usage?: RunsDb; cfg?: (c: MachineConfig) => void } = {}) => {
  const t = setup({ remote: SLOT_REMOTE, shards: [{ name: 'a', units: 2, args: ['a'] }], ...(o.now ? { now: o.now } : {}), ...(o.usage ? { usage: o.usage } : {}), cfg: (c) => { c.boat.packing = true; c.boat.sizes = ['large']; o.cfg?.(c) } })
  const doc = { boat: { remoteScript: '.test-broker/remote.sh' }, suites: { all: { local: { cpus: 2 }, boat: { avoidSlow: !!o.avoidSlow, shards: [{ name: 'a', units: 2, args: ['a'] }] } } } }
  const cfg = parseRepoConfig(doc, t.work)
  const ask = () => t.runs.tryRun({ repo: 'me/app', cfg, suite: cfg.suites.all, args: [], owner: 'c1' })
  return { ...t, ask }
}

test('speed: a slow box goes last: an idle box that is not slow first, then a stopped one (a resume), then the slow one', async () => {
  const t = speedSetup()
  largeBox(t)
  largeBox(t)
  await t.runs.pool.reconcile()
  const [slow, fast] = t.runs.pool.boxes().map((b) => b.name)
  setScores(t, { [slow]: 1.8, [fast]: 1.0 })
  const one = await t.ask()
  assert.ok('run' in one, JSON.stringify(one))
  assert.equal(t.runs.status().runs[0].shards[0].box, fast)
  await runToEnd(t, one.run)
  // the fast box stopped: a resume of it beats the slow idle box
  t.runs.pool.setState(fast, 'stopped')
  const two = await t.ask()
  assert.ok('run' in two, JSON.stringify(two))
  assert.equal(t.runs.status().runs.find((r) => r.id === two.run)!.shards[0].box, fast)
  await runToEnd(t, two.run)
  // the slow box only: it is used (better than no box)
  t.runs.pool.setState(fast, 'quarantined')
  const three = await t.ask()
  assert.ok('run' in three, JSON.stringify(three))
  assert.equal(t.runs.status().runs.find((r) => r.id === three.run)!.shards[0].box, slow)
  assert.equal((await runToEnd(t, three.run)).code, 0)
  const st = t.runs.status().boxes.find((b) => b.name === slow)!
  assert.deepEqual([st.speed, st.slow], [1.8, true])
})

test('speed: an avoidSlow suite never takes a slow box (a new box instead); speed.mode off ignores the scores', async () => {
  const t = speedSetup({ avoidSlow: true })
  largeBox(t)
  await t.runs.pool.reconcile()
  const [slow] = t.runs.pool.boxes().map((b) => b.name)
  setScores(t, { [slow]: 1.6 })
  const a = await t.ask()
  assert.ok('run' in a, JSON.stringify(a))
  const box = t.runs.status().runs[0].shards[0].box
  assert.notEqual(box, slow)
  await runToEnd(t, a.run)
  const off = speedSetup({ avoidSlow: true, cfg: (c) => { c.boat.speed.mode = 'off' } })
  largeBox(off)
  await off.runs.pool.reconcile()
  const [s2] = off.runs.pool.boxes().map((b) => b.name)
  setScores(off, { [s2]: 1.6 })
  const b = await off.ask()
  assert.ok('run' in b, JSON.stringify(b))
  assert.equal(off.runs.status().runs[0].shards[0].box, s2)
  await runToEnd(off, b.run)
})

test('drain: a busy box gets no new shards and is deleted when its run ends; a free one at once; undrain; names by suffix', async () => {
  const t = speedSetup()
  t.mc.boat.sizes = ['large']
  const longDoc = { boat: { remoteScript: '.test-broker/remote.sh' }, suites: { all: { local: { cpus: 2 }, boat: { shards: [{ name: 'a', units: 2, args: ['hold', '2'] }] } } } }
  const long = parseRepoConfig(longDoc, t.work)
  largeBox(t)
  largeBox(t)
  await t.runs.pool.reconcile()
  const one = await t.runs.tryRun({ repo: 'me/app', cfg: long, suite: long.suites.all, args: [], owner: 'c1' })
  assert.ok('run' in one, JSON.stringify(one))
  const busy = t.runs.status().runs[0].shards[0].box
  const other = t.runs.pool.boxes().find((b) => b.name !== busy)!.name
  const d = t.runs.drainBox(busy.slice(-6), 'bad disk')
  assert.deepEqual(d, { box: busy, state: 'busy', deleted: false })
  // a second run would share the busy box's free units: it gets the other box
  const two = await t.ask()
  assert.ok('run' in two, JSON.stringify(two))
  assert.equal(t.runs.status().runs.find((r) => r.id === two.run)!.shards[0].box, other)
  await runToEnd(t, two.run)
  await runToEnd(t, one.run)
  t.runs.dropDrained()
  await t.runs.idle()
  assert.deepEqual(t.runs.pool.boxes().map((b) => b.name), [other])
  assert.ok(t.logs.some((l) => l.includes(`box ${busy}: deleted (drained by the operator: bad disk)`)), t.logs.join('\n'))
  // a free box goes at once; undrain of a gone box, of a box not drained
  assert.match(JSON.stringify(t.runs.undrainBox(busy)), /no box/)
  assert.match(JSON.stringify(t.runs.undrainBox(other)), /is not drained/)
  assert.match(JSON.stringify(t.runs.drainBox('zzzzzz', null)), /no box zzzzzz/)
  assert.deepEqual(t.runs.drainBox(other, null), { box: other, state: 'idle', deleted: true })
  assert.equal(t.runs.pool.boxes().length, 0)
})

test('drain: undrain before the box is free keeps it; boxesView shows the drain', async () => {
  const t = speedSetup()
  largeBox(t, 'stopped')
  await t.runs.pool.reconcile()
  const [b] = t.runs.pool.boxes().map((x) => x.name)
  t.runs.pool.setState(b, 'busy')
  t.runs.drainBox(b, 'look at it')
  assert.deepEqual(t.runs.boxesView().boxes[0].drain?.reason, 'look at it')
  assert.deepEqual((t.runs.undrainBox(b) as { was: { by: string } }).was.by, 'operator')
  t.runs.pool.setState(b, 'idle')
  t.runs.dropDrained()
  assert.equal(t.runs.pool.boxes().length, 1)
})

test('retire: a box slow for retireAfterMin that ran again since (scored from runs.db) is drained and deleted once free; at most maxRetirePerDay', async () => {
  let now = Date.UTC(2026, 10, 27, 12, 0, 0)
  const usage = new RunsDb(':memory:')
  const t = speedSetup({ usage, now: () => now, cfg: (c) => { c.boat.speed.maxRetirePerDay = 1 } })
  for (let i = 0; i < 4; i++) largeBox(t)
  await t.runs.pool.reconcile()
  const names = t.runs.pool.boxes().map((b) => b.name)
  const [slowA, slowB] = names
  // runs round-robin, one every 5 min: two boxes twice as slow
  let n = 0
  const history = (count: number, from: number) => {
    for (let i = 0; i < count; i++) {
      const box = names[n % 4]
      const secs = [slowA, slowB].includes(box) ? 200 : 100
      usage.startRun({ id: `h${n++}`, repo: 'me/app', root: '/w', suite: 'all', shape: 'whole', argsN: 0, whereRan: 'boat', boatWhy: null, startedAt: from + i * 300_000, cpus: 4, shards: [{ name: 'a', box, size: 'large', slot: 0, how: 'reused', units: 2, memMb: 8192, secs, code: 0, started: true, argsKey: '-' } as never] })
    }
  }
  history(120, now - 10 * 3_600_000)
  t.runs.refreshSpeed()
  assert.deepEqual(names.map((n) => t.runs.isSlow(n)), [true, true, false, false])
  assert.equal(t.runs.pool.boxes().length, 4)
  // 2 h later with no new shard: the slow boxes are not judged on the old ones (no drain)
  now += 121 * 60_000
  t.runs.refreshSpeed()
  assert.equal(t.runs.pool.boxes().length, 4)
  assert.equal(t.runs.boxesView().retiredToday, 0)
  // they ran again, still slow: retire
  history(8, now - 40 * 60_000)
  t.runs.refreshSpeed()
  await t.runs.idle()
  // one retire a day: the first slow box goes, the second stays (slow: placement takes it last)
  assert.deepEqual(t.runs.pool.boxes().map((b) => b.name), names.slice(1))
  assert.match(t.runs.boxesView().boxes.find((b) => b.name === slowB)!.slowMin + '', /^12[01]$/)
  assert.ok(t.logs.some((l) => l.includes(`box ${slowA}: drained (slow (runs 2x over`)), t.logs.join('\n'))
  assert.equal(t.runs.boxesView().retiredToday, 1)
})

test('speed: a slow box is normal again only below clearAt (no flip at a score near slowAt)', async () => {
  const t = speedSetup()
  largeBox(t)
  await t.runs.pool.reconcile()
  const [b] = t.runs.pool.boxes().map((x) => x.name)
  setScores(t, { [b]: 1.3 })
  // not slow yet: 1.3 is under slowAt
  assert.equal(t.runs.isSlow(b), false)
  // once slow (its clock started), 1.3 keeps it slow; 1.2 (under clearAt 1.25) clears it
  t.runs.flags.setSlow(b, Date.now())
  assert.equal(t.runs.isSlow(b), true)
  setScores(t, { [b]: 1.2 })
  assert.equal(t.runs.isSlow(b), false)
})

// ---- probes (probe.ts)

const probeSetup = (o: { now: () => number; usage: RunsDb; cfg?: (c: MachineConfig) => void }) =>
  speedSetup({ now: o.now, usage: o.usage, cfg: (c) => { c.boat.speed.probeCpuMb = 1; c.boat.speed.probeDiskMb = 1; o.cfg?.(c) } })

test('probe: an idle running box is probed once it has been idle probeIdleSec, again after probeEveryMin; never a stopped one', async () => {
  let now = Date.UTC(2026, 10, 27, 20, 0, 0)
  const usage = new RunsDb(':memory:')
  const t = probeSetup({ now: () => now, usage })
  largeBox(t)
  largeBox(t, 'stopped')
  await t.runs.pool.reconcile()
  const [idle] = t.runs.pool.boxes().filter((b) => b.state === 'idle').map((b) => b.name)
  // just idle: not yet
  assert.deepEqual(t.runs.probeDue(), [])
  now += 61_000
  assert.deepEqual(t.runs.probeDue(), [idle])
  await t.runs.idle()
  const [p] = usage.boxProbesSince(0)
  assert.equal(p.box, idle)
  assert.equal(p.ok, true, JSON.stringify(p))
  assert.ok(p.cpu1! >= 0 && p.cpuN! >= 0 && p.write! >= 0)
  assert.ok(t.logs.some((l) => l.includes(`box ${idle}: probe ok`)), t.logs.join('\n'))
  // probed: not again within probeEveryMin (30), again after it
  now += 10 * 60_000
  assert.deepEqual(t.runs.probeDue(), [])
  now += 21 * 60_000
  assert.deepEqual(t.runs.probeDue(), [idle])
  await t.runs.idle()
  assert.equal(usage.boxProbesSince(0).length, 2)
  // probes off
  t.mc.boat.speed.probeEveryMin = 0
  now += 60 * 60_000
  assert.deepEqual(t.runs.probeDue(), [])
})

test('probe: a shard that takes the box stops its probe at once; nothing is recorded', async () => {
  let now = Date.UTC(2026, 10, 27, 20, 0, 0)
  const usage = new RunsDb(':memory:')
  const t = probeSetup({ now: () => now, usage })
  largeBox(t)
  await t.runs.pool.reconcile()
  const [b] = t.runs.pool.boxes()
  t.boat.hang.add(b.boatId!)
  now += 61_000
  const pr = t.runs.probe(b.name)
  assert.equal(t.runs.boxesView().boxes[0].probing, true)
  t.runs.pool.setState(b.name, 'busy')
  const r = await pr
  assert.equal(r.aborted, true)
  assert.equal(usage.boxProbesSince(0).length, 0)
  assert.ok(t.logs.some((l) => l.includes(`box ${b.name}: probe stopped (the box left idle)`)))
  // a manual probe of a busy box is refused
  assert.match(JSON.stringify(await t.runs.probeBox(b.name)), /is busy: only an idle running box is probed/)
})

test('probe: faults charge the box; 3 in a row quarantine it', async () => {
  let now = Date.UTC(2026, 10, 27, 20, 0, 0)
  const usage = new RunsDb(':memory:')
  const t = probeSetup({ now: () => now, usage })
  largeBox(t)
  await t.runs.pool.reconcile()
  const [b] = t.runs.pool.boxes()
  // the probe's output: an I/O error reading the clone
  const exec = t.boat.exec.bind(t.boat)
  t.boat.exec = async (id, cmd, o) => (cmd.includes('setsid') ? { code: 0, out: 'probe.cpu1 1\nprobe.cpuN 1\nprobe.write 1\nprobe.read 1\nprobe.git 1\nprobe.freeGb 50\nprobe.error repo read p.pack: cat: Input/output error\n' } : exec(id, cmd, o))
  for (let i = 0; i < 3; i++) {
    const r = await t.runs.probeBox(b.name)
    assert.ok(!('error' in r) && r.faults.length === 1, JSON.stringify(r))
  }
  assert.equal(t.runs.pool.boxes()[0].state, 'quarantined')
  assert.deepEqual(usage.boxProbesSince(0).map((p) => p.ok), [false, false, false])
})

test('probe and runs: either makes a box slow; the newer evidence wins when they disagree', async () => {
  const t = speedSetup()
  largeBox(t)
  await t.runs.pool.reconcile()
  const [b] = t.runs.pool.boxes().map((x) => x.name)
  const set = (run: [number, number] | null, probe: [number, number, number] | null) => {
    const r = t.runs as unknown as { scores: Map<string, unknown>; probeScores: Map<string, unknown> }
    r.scores = new Map(run ? [[b, { score: run[0], samples: 20, last: run[1] }]] : [])
    r.probeScores = new Map(probe ? [[b, { score: probe[0], cpu: probe[0], disk: 1, probes: probe[2], last: probe[1] }]] : [])
  }
  set([1.6, 100], null)
  assert.equal(t.runs.isSlow(b), true)
  // a newer normal probe clears it; an older one does not
  set([1.6, 100], [1.0, 200, 1])
  assert.equal(t.runs.isSlow(b), false)
  set([1.6, 300], [1.0, 200, 1])
  assert.equal(t.runs.isSlow(b), true)
  // probes alone: 2 or more slow probes make it slow; 1 does not
  set(null, [1.7, 200, 1])
  assert.equal(t.runs.isSlow(b), false)
  set(null, [1.7, 200, 2])
  assert.equal(t.runs.isSlow(b), true)
  // newer normal shards clear slow probes
  set([1.0, 300], [1.7, 200, 3])
  assert.equal(t.runs.isSlow(b), false)
})

// ---- box faults in a run

const IO_REMOTE = `#!/usr/bin/env bash
case "$2" in
  iofault) if [ ! -f "$3" ]; then touch "$3"; echo "cat: data/x.db: Input/output error"; exit 1; fi; echo passed ;;
  ioalways) echo "write failed: No space left on device"; exit 1 ;;
  ioprint) echo "a test that prints: Input/output error" ;;
  infra) if [ ! -f "$3" ]; then touch "$3"; exit 91; fi; echo passed ;;
esac
exit 0
`
const faultSetup = (args: string[], cfg?: (c: MachineConfig) => void) =>
  setup({ remote: IO_REMOTE, shards: [{ name: 'a', units: 2, args }], cfg: (c) => { c.boat.packing = true; c.boat.sizes = ['large']; cfg?.(c) } })

test('box fault: an I/O error in a failed shard quarantines the box and runs the shard again on another; the receipt says why', async () => {
  const marker = join(tmp('tb-io-'), 'm')
  const t = faultSetup(['iofault', marker])
  largeBox(t)
  largeBox(t)
  await t.runs.pool.reconcile()
  const a = await t.ask()
  assert.ok('run' in a, JSON.stringify(a))
  const first = t.runs.status().runs[0].shards[0].box
  const r = await runToEnd(t, a.run)
  assert.equal(r.code, 0, r.out + r.receipt)
  const other = t.runs.pool.boxes().find((b) => b.name !== first)!.name
  assert.match(r.receipt, new RegExp(`ran again on ${other} after a box fault on ${first}: I/O fault: cat: data/x.db: Input/output error`))
  assert.match(r.out, /test-broker: box fault on .*running the shard again on/)
  assert.equal(t.runs.pool.boxes().find((b) => b.name === first)!.state, 'quarantined')
})

test('box fault: the same I/O fault on the second box too: it fails, and the receipt says it may be the tests', async () => {
  const t = faultSetup(['ioalways'])
  largeBox(t)
  largeBox(t)
  await t.runs.pool.reconcile()
  const a = await t.ask()
  assert.ok('run' in a, JSON.stringify(a))
  const r = await runToEnd(t, a.run)
  assert.equal(r.code, 1)
  assert.match(r.receipt, /and again on .*\(I\/O fault: write failed: No space left on device\): it may be the tests, not the boxes/)
})

test('box fault: no other box to run it again: the shard fails with the cause', async () => {
  const marker = join(tmp('tb-io-'), 'm')
  const t = faultSetup(['iofault', marker])
  largeBox(t)
  await t.runs.pool.reconcile()
  const a = await t.ask()
  assert.ok('run' in a, JSON.stringify(a))
  // no idle box left, and no box start allowed (Boat's limits cannot be read)
  t.boat.failStarts = 100
  const r = await runToEnd(t, a.run)
  assert.equal(r.code, 1)
  assert.match(r.receipt, /box fault on \S+: I\/O fault: cat: data\/x\.db: Input\/output error; no other box to run it again/)
})

test('box fault: an infra exit code runs the shard again on another box; I/O text in a passing shard is nothing', async () => {
  const marker = join(tmp('tb-io-'), 'm')
  const t = faultSetup(['infra', marker], (c) => { c.boat.infraExitCodes = { 'me/app': [91] } })
  largeBox(t)
  largeBox(t)
  await t.runs.pool.reconcile()
  const a = await t.ask()
  assert.ok('run' in a, JSON.stringify(a))
  const r = await runToEnd(t, a.run)
  assert.equal(r.code, 0, r.receipt)
  assert.match(r.receipt, /after a box fault on \S+: exit 91, an infra code of me\/app/)
  const p = faultSetup(['ioprint'])
  largeBox(p)
  await p.runs.pool.reconcile()
  const b = await p.ask()
  assert.ok('run' in b, JSON.stringify(b))
  const pr = await runToEnd(p, b.run)
  assert.equal(pr.code, 0)
  assert.doesNotMatch(pr.receipt, /box fault/)
  assert.equal(p.runs.pool.boxes()[0].infraFails, 0)
})
