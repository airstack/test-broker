import '../tmp-root.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { RunsDb } from '../../src/tb/runs-db.ts'
import { boxHours, formatUsage, parseResources, poolDays, shardPlanHours, usageReport } from '../../src/tb/usage.ts'
import { Broker } from '../../src/tb/broker.ts'
import { MACHINE_DEFAULTS } from '../../src/tb/machine-config.ts'
import { parseRepoConfig } from '../../src/tb/repo-config.ts'
import { tmp } from '../harness.ts'

const H = 3_600_000
const T0 = Date.UTC(2026, 10, 18, 0, 0, 0)

test('a shard costs its CPUs for its time: 2 units for an hour is 1 plan hour (4 CPUs)', () => {
  assert.equal(shardPlanHours(2, 3600), 1)
  assert.equal(shardPlanHours(4, 1800), 1)
})

test('the resources line parses; the last one wins; none is empty', () => {
  const log = 'x\nresources: peak RAM 100 MB of 200 MB (box), CPU busy mean 10% p95 20% of 2 CPU(s), 3 samples\n' +
    'resources: peak RAM 8408 MB of 15991 MB (box), CPU busy mean 94% p95 100% of 4 CPU(s), 41 samples\n'
  assert.deepEqual(parseResources(log), { peakRamMb: 8408, cpuMean: 94, cpuP95: 100, cpus: 4 })
  assert.deepEqual(parseResources('nothing'), {})
})

test('box hours: a box costs its size rate while up, the idle tail goes to the repo it last ran, days split at UTC midnight', () => {
  const ev = [
    { id: 1, t: T0 - H, box: 'b1', size: 'large', state: 'resuming', repo: 'o/a' },
    { id: 2, t: T0 + H, box: 'b1', size: 'large', state: 'stopped', repo: 'o/a' },
    { id: 3, t: T0 + 2 * H, box: 'b2', size: 'default', state: 'busy', repo: 'o/b' },
    { id: 4, t: T0 + 3 * H, box: 'b2', size: 'default', state: 'idle', repo: 'o/b' },
    { id: 5, t: T0 + 3.5 * H, box: 'b2', size: 'default', state: 'quarantined', repo: 'o/b' },
  ]
  const m = boxHours(ev, T0 - 24 * H, T0 + 24 * H)
  assert.deepEqual(Object.fromEntries(m.get('2026-11-17')!), { 'o/a': 2 })
  assert.deepEqual(Object.fromEntries(m.get('2026-11-18')!), { 'o/a': 2, 'o/b': 1.5 })
  // a box still up runs to the end of the window
  const open = boxHours([{ id: 1, t: T0, box: 'b', size: 'default', state: 'idle', repo: 'o/a' }], T0, T0 + 2 * H)
  assert.equal(open.get('2026-11-18')!.get('o/a'), 2)
})

test('usage report: per day and repo, the costliest suites, and the day target from the first plan snapshot', () => {
  const db = new RunsDb(':memory:')
  const now = T0 + 10 * H
  db.plan({ t: T0 + H, hoursLeft: 100, periodEnd: T0 + H + 10 * 24 * H, last24hHours: 50, startsUsed: 3, active: 2 })
  db.plan({ t: T0 + 9 * H, hoursLeft: 90, periodEnd: T0 + H + 10 * 24 * H, last24hHours: 60, startsUsed: 9, active: 1 })
  db.startRun({ id: 'r1', repo: 'o/a', root: '/w', suite: 'test-all', shape: 'whole', argsN: 0, whereRan: 'boat', boatWhy: null, startedAt: T0 + 2 * H, cpus: 8, shards: null })
  db.endRun('r1', { endedAt: T0 + 2.5 * H, exitCode: 0, endedHow: 'done', cpuMin: 240, planHours: 1 })
  db.startRun({ id: 'r2', repo: 'o/a', root: '/w', suite: 'test-all', shape: 'whole', argsN: 0, whereRan: 'local', boatWhy: 'Boat: busy', startedAt: T0 + 3 * H, cpus: 12, shards: null })
  db.endRun('r2', { endedAt: T0 + 3.1 * H, exitCode: 1, endedHow: 'done', cpuMin: 72, planHours: 0 })
  db.startRun({ id: 'r3', repo: 'o/b', root: '/v', suite: 'test', shape: 'narrowed', argsN: 2, whereRan: 'boat', boatWhy: null, startedAt: T0 + 4 * H, cpus: 4, shards: null })
  db.boxEvent({ t: T0 + 2 * H, box: 'b1', size: 'large', state: 'busy', repo: 'o/a' })
  db.boxEvent({ t: T0 + 3 * H, box: 'b1', size: 'large', state: 'stopped', repo: 'o/a' })
  const u = usageReport(db, { days: 1, now })
  assert.equal(u.days.length, 1)
  assert.deepEqual(u.days[0].repos['o/a'], { runs: 2, boat: 1, local: 1, failed: 1, cpuMin: 312, shardHours: 1, boxHours: 2 })
  assert.equal(u.days[0].repos['o/b'].runs, 1)
  assert.deepEqual(u.suites[0], { repo: 'o/a', suite: 'test-all', shape: 'whole', runs: 2, medianCpuMin: 240, shardHours: 1, boat: 1, local: 1, heavy: null })
  // the day's target: 100 h left at the first snapshot over the 10 days left then
  assert.equal(u.today.target, 10)
  assert.equal(u.today.hoursLeft, 90)
  assert.equal(u.today.boxHours, 2)
  assert.match(formatUsage(u), /o\/a .* 2 .* 1 .* 1 .* 1/)
  assert.equal(usageReport(db, { days: 1, now, repo: 'o/b' }).days[0].repos['o/a'], undefined)
})

test('usage: a local lease is recorded (whole/narrowed, its CPUs × time), and a released one too', async () => {
  const root = tmp('tb-usage-')
  const usage = new RunsDb(':memory:')
  let t = T0
  const cfg = parseRepoConfig({ suites: { unit: { local: { cpus: 2 } } } }, root)
  const broker = new Broker({ cfg: structuredClone(MACHINE_DEFAULTS), stateDir: join(root, 'state'), now: () => t, box: () => ({ nproc: 8, load1: 0, memAvailGb: 16 }), repoOf: async () => 'me/app', loadConfig: () => cfg, log: () => {}, usage })
  const a = await broker.ask({ root, suite: 'unit', flags: {}, pid: 1, args: [] }, 'c1')
  assert.equal(a.decision, 'local')
  t += 60_000
  broker.done(a.decision === 'local' ? a.local.lease : '', 0)
  const b = await broker.ask({ root, suite: 'unit', flags: {}, pid: 2, args: ['x.test.ts'] }, 'c2')
  assert.equal(b.decision, 'local')
  t += 30_000
  broker.release('c2')
  const [r1, r2] = usage.runsSince(0)
  assert.equal(r1.whereRan, 'local')
  assert.equal(r1.shape, 'whole')
  assert.equal(r1.exitCode, 0)
  assert.equal(r1.cpuMin, 2)
  assert.equal(r2.shape, 'narrowed')
  assert.equal(r2.endedHow, 'released')
  assert.equal(r2.exitCode, null)
  assert.equal(r2.cpuMin, 1)
})

test('test-broker usage reads runs.db with the daemon down; --json is the report', async () => {
  const root = tmp('tb-usagecli-')
  const db = new RunsDb(join(root, 'runs.db'))
  db.startRun({ id: 'r1', repo: 'o/a', root: '/w', suite: 'test-all', shape: 'whole', argsN: 0, whereRan: 'boat', boatWhy: null, startedAt: Date.now(), cpus: 8, shards: null })
  db.close()
  const BIN = join(import.meta.dirname, '..', '..', 'bin', 'test-broker')
  const run = (args: string[]) =>
    new Promise<{ code: number; out: string }>((resolve) => {
      const p = spawn(BIN, args, { env: { ...process.env, TEST_BROKER_STATE: root } })
      let out = ''
      p.stdout.on('data', (d) => (out += d))
      p.on('close', (code) => resolve({ code: code ?? -1, out }))
    })
  const j = await run(['usage', '--json', '--days', '1'])
  assert.equal(j.code, 0)
  const u = JSON.parse(j.out)
  assert.equal(u.days[0].repos['o/a'].runs, 1)
  const txt = await run(['usage'])
  assert.match(txt.out, /costliest suites/)
  const help = await run(['usage', '--help'])
  assert.equal(help.code, 0)
  assert.match(help.out, /runs\[\] \(with --runs\)/)
})

test('the day target counts the wallet: plan hours used up, the wallet still pays (and the report shows both)', () => {
  const db = new RunsDb(':memory:')
  db.plan({ t: T0 + H, hoursLeft: 0, periodEnd: T0 + H + 10 * 24 * H, last24hHours: 50, startsUsed: 3, active: 2, walletHours: 200 })
  const u = usageReport(db, { now: T0 + 2 * H, days: 1 })
  assert.equal(u.today.target, 20)
  assert.equal(u.today.walletHours, 200)
  assert.match(formatUsage(u), /0 plan h \+ 200 wallet h left over/)
  // an old snapshot (no wallet column read): the plan alone
  db.plan({ t: T0 + 3 * H, hoursLeft: 100, periodEnd: T0 + 3 * H + 10 * 24 * H, last24hHours: 50, startsUsed: 3, active: 2 })
  assert.equal(usageReport(db, { now: T0 + 2 * H, days: 1 }).today.target, 20, 'the day goes by its first snapshot')
})

test('runs.db v2 → v4: the plan table gains wallet_hours (old rows read with none), box_events a reason', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const file = join(tmp('tb-runsdb-'), 'runs.db')
  const raw = new DatabaseSync(file)
  raw.exec(`CREATE TABLE plan (t INTEGER PRIMARY KEY, hours_left REAL NOT NULL, period_end INTEGER, last24h_hours REAL, starts_used INTEGER, active INTEGER); INSERT INTO plan VALUES (1, 5, 2, NULL, NULL, NULL); CREATE TABLE box_events (id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, box TEXT NOT NULL, size TEXT NOT NULL, state TEXT NOT NULL, repo TEXT); INSERT INTO box_events (t, box, size, state, repo) VALUES (1, 'b', 'large', 'idle', NULL); PRAGMA user_version = 2`)
  raw.close()
  const db = new RunsDb(file)
  assert.equal((db.raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 4)
  assert.equal(db.lastPlan()!.walletHours, null)
  db.plan({ t: 3, hoursLeft: 0, periodEnd: 4, last24hHours: null, startsUsed: null, active: null, walletHours: 7 })
  assert.equal(db.lastPlan()!.walletHours, 7)
  db.boxEvent({ t: 2, box: 'b', size: 'large', state: 'stopping', repo: null, reason: 'idle (past the warm target)' })
  assert.deepEqual(db.boxEventsSince(0).map((e) => [e.state, e.reason]), [['idle', null], ['stopping', 'idle (past the warm target)']])
  db.close()
})

test('pool hours: a restart that records idle again is one idle stretch; an early stop counts a start only in its own pool', () => {
  const H = 3_600_000
  const day = Date.UTC(2026, 10, 20)
  let id = 0
  const ev = (h: number, box: string, state: string, reason: string | null = null) => ({ id: ++id, t: day + h * H, box, size: 'large', state, repo: null, reason })
  const events = [
    ev(1, 'tbx-a-large-aaaaaa', 'busy'), ev(2, 'tbx-a-large-aaaaaa', 'idle'), ev(2.5, 'tbx-a-large-aaaaaa', 'idle'), ev(3, 'tbx-a-large-aaaaaa', 'busy'), ev(4, 'tbx-a-large-aaaaaa', 'idle'),
    ev(4.1, 'tbx-a-large-aaaaaa', 'stopping', 'idle (past the warm target)'), ev(4.15, 'tbx-a-large-aaaaaa', 'stopped'),
    ev(4.12, 'tbx-b-large-bbbbbb', 'resuming'), ev(4.13, 'tbx-b-large-bbbbbb', 'busy'), ev(5, 'tbx-b-large-bbbbbb', 'stopped'),
  ]
  const [d] = poolDays([], events, day, day + 24 * H)
  assert.equal(d.hours.gap, 2, 'idle 2 h to 3 h, then busy: one gap (2 plan hours on a large box), not a gap and a tail')
  assert.equal(d.hours.tail, 0)
  assert.equal(d.earlyStops, 1)
  assert.equal(d.earlyStopsThenStart, 0, 'the start was in another pool')
})
