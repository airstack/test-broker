import { test } from 'node:test'
import assert from 'node:assert/strict'
import { boxName, inWarmHours, parseBoxName, parseLegacyName } from '../../src/core/boatpool.ts'
import { harness } from '../harness.ts'

test('box names: cib-<daemonId>-<env>-<size>-<rand6>; another daemon\'s and v0.1 names are told apart', () => {
  assert.match(boxName('ub1', 'acme', 'large'), /^cib-ub1-acme-large-[a-z0-9]{6}$/)
  assert.deepEqual(parseBoxName('ub1', 'cib-ub1-my-env-default-abc123'), { env: 'my-env', size: 'default', rand: 'abc123' })
  assert.equal(parseBoxName('ub1', 'cib-ub2-acme-default-abc123'), null)
  assert.equal(parseBoxName('ub1', 'cib-ub1-acme-huge-abc123'), null)
  assert.deepEqual(parseLegacyName('cib-acme-large-abc123', (p) => p === 'acme'), { profile: 'acme', size: 'large', rand: 'abc123' })
  assert.equal(parseLegacyName('cib-ub2-acme-default-abc123', (p) => p === 'acme'), null)
})

test('warm hours, including a window across midnight', () => {
  const at = (h: number, m = 0) => new Date(2026, 0, 1, h, m).getTime()
  assert.equal(inWarmHours('09:00-18:00', at(12)), true)
  assert.equal(inWarmHours('09:00-18:00', at(20)), false)
  assert.equal(inWarmHours('22:00-06:00', at(23)), true)
  assert.equal(inWarmHours(null, at(12)), false)
})

test('reconcile: adopts our unknown boxes, renames + adopts v0.1 boxes of known profiles, ignores others, drops vanished rows', async () => {
  const h = harness()
  h.boat.addBox('cib-tst-acme-default-aaaaaa', 'ready')
  h.boat.addBox('cib-tst-acme-large-bbbbbb', 'stopped', 'large', { stoppedAt: 5 })
  const legacy = h.boat.addBox('cib-app-default-cccccc', 'stopped')
  h.boat.addBox('cib-other-acme-default-dddddd', 'ready')
  h.boat.addBox('my-own-box', 'ready')
  const pool = h.d.c.pool!
  const rep = await pool.reconcile()
  assert.deepEqual(rep.renamed, ['cib-app-default-cccccc → cib-tst-acme-default-cccccc'])
  assert.equal(legacy.name, 'cib-tst-acme-default-cccccc')
  assert.deepEqual(pool.boxes().map((b) => [b.name, b.state]), [
    ['cib-tst-acme-default-aaaaaa', 'idle'],
    ['cib-tst-acme-default-cccccc', 'stopped'],
    ['cib-tst-acme-large-bbbbbb', 'stopped'],
  ])
  assert.equal(pool.boxes()[2].since, 5)
  h.boat.boxes = h.boat.boxes.filter((b) => b.name !== 'cib-tst-acme-default-aaaaaa')
  await pool.reconcile()
  assert.equal(pool.boxes().length, 2)
})

test('reconcile leaves transitional rows alone until they are 10 min old, then reads the box again', async () => {
  const h = harness()
  const pool = h.d.c.pool!
  const now = h.clock.t
  h.d.c.db.insertBox({ name: 'cib-tst-acme-default-eeeeee', boatId: null, env: 'acme', size: 'default', state: 'creating', since: now, lastRepo: null, lastUsed: now, infraFails: 0, reason: null, createdAt: now })
  h.d.c.db.insertBox({ name: 'cib-tst-acme-default-ffffff', boatId: null, env: 'acme', size: 'default', state: 'creating', since: now, lastRepo: null, lastUsed: now, infraFails: 0, reason: null, createdAt: now })
  h.boat.addBox('cib-tst-acme-default-eeeeee', 'ready')
  await pool.reconcile()
  assert.deepEqual(pool.boxes().map((b) => b.state), ['creating', 'creating'])
  h.advance(11 * 60_000)
  await pool.reconcile()
  assert.deepEqual(pool.boxes().map((b) => [b.name, b.state]), [['cib-tst-acme-default-eeeeee', 'idle']])
})

test('sweep: a box quarantined longer than deleteAfterDays is deleted; a newer one stays', async () => {
  const h = harness({ cfg: { pool: { idleStopSec: 60, warmHours: null, deleteAfterDays: 7, ttlSec: 100 } } })
  h.boat.addBox('cib-tst-acme-default-aaaaaa', 'stopped')
  h.boat.addBox('cib-tst-acme-default-bbbbbb', 'stopped')
  const pool = h.d.c.pool!
  await pool.reconcile()
  pool.setState('cib-tst-acme-default-aaaaaa', 'quarantined', { reason: 'test' })
  h.advance(6 * 86400_000)
  pool.setState('cib-tst-acme-default-bbbbbb', 'quarantined', { reason: 'test' })
  h.advance(2 * 86400_000)
  const rep = await pool.sweep()
  await h.d.idle()
  assert.deepEqual(rep.deleted, ['cib-tst-acme-default-aaaaaa'])
  assert.deepEqual(pool.boxes().map((b) => [b.name, b.state]), [['cib-tst-acme-default-bbbbbb', 'quarantined']])
})

test('Boat says stopped → stopped; quarantined boxes stay quarantined and are stopped if running', async () => {
  const h = harness()
  const b = h.boat.addBox('cib-tst-acme-default-aaaaaa', 'ready')
  const q = h.boat.addBox('cib-tst-acme-default-qqqqqq', 'ready')
  const pool = h.d.c.pool!
  await pool.reconcile()
  pool.setState(q.name, 'quarantined', { reason: 'test' })
  b.state = 'stopped'
  await pool.reconcile()
  await h.d.idle()
  assert.deepEqual(pool.boxes().map((x) => x.state), ['stopped', 'quarantined'])
  assert.ok(h.boat.calls.includes(`stop ${q.id}`))
})

test('sweep: idle past idleStopSec → stopping → stopped; the last running box of a size stays in warm hours; long-stopped → deleted', async () => {
  const h = harness({ cfg: { pool: { idleStopSec: 60, warmHours: null, deleteAfterDays: 7, ttlSec: 100 } } })
  h.boat.addBox('cib-tst-acme-default-aaaaaa', 'ready')
  h.boat.addBox('cib-tst-acme-default-bbbbbb', 'ready')
  const pool = h.d.c.pool!
  await pool.reconcile()
  let release!: () => void
  h.boat.gate.stop = new Promise((r) => (release = r))
  h.advance(61_000)
  const sweeping = pool.sweep()
  assert.deepEqual(pool.boxes().map((b) => b.state), ['stopping', 'stopping'], 'written before the Boat call returns')
  release()
  assert.deepEqual((await sweeping).stopped.length, 2)
  assert.deepEqual(pool.boxes().map((b) => b.state), ['stopped', 'stopped'])
  h.advance(8 * 86400_000)
  await pool.sweep()
  await h.d.idle()
  assert.equal(pool.boxes().length, 0)
  assert.equal(h.boat.boxes.length, 0)

  const w = harness({ cfg: { pool: { idleStopSec: 60, warmHours: '00:00-23:59', deleteAfterDays: 7, ttlSec: 100 } } })
  w.boat.addBox('cib-tst-acme-default-aaaaaa', 'ready')
  w.boat.addBox('cib-tst-acme-default-bbbbbb', 'ready')
  await w.d.c.pool!.reconcile()
  w.advance(61_000)
  const rep = await w.d.c.pool!.sweep()
  assert.equal(rep.stopped.length, 1)
  assert.equal(rep.kept.length, 1)
})

test('reconcile never acts on a row that changed while `boat list` ran (a resume finished under a new shard)', async () => {
  const h = harness()
  const bx = h.boat.addBox('cib-tst-acme-default-aaaaaa', 'stopped')
  const pool = h.d.c.pool!
  await pool.reconcile()
  assert.equal(pool.boxes()[0].state, 'stopped')
  let release!: () => void
  h.boat.gate.list = new Promise((r) => (release = r))
  h.advance(1000)
  const rec = pool.reconcile() // Boat answers "stopped"
  // meanwhile a shard resumes the box and starts on it
  const got = await pool.place({ env: 'acme', size: 'default', repo: 'me/app', avoid: [] })
  assert.deepEqual(got, { box: bx.name, how: 'resumed' })
  await pool.start(bx.name)
  assert.equal(pool.boxes()[0].state, 'busy')
  release()
  await rec
  assert.equal(pool.boxes()[0].state, 'busy', 'not forced stopped under the running shard')
  delete h.boat.gate.list
  await pool.reconcile()
  assert.equal(pool.boxes()[0].state, 'busy')
})

test('`boat limits` is read once per ~5 s, not per placement attempt; a start invalidates the cached read', async () => {
  const h = harness()
  h.boat.budget.day = 0 // every placement attempt needs a start the budget refuses
  const { makeOrigin } = await import('../harness.ts')
  const { sha } = makeOrigin(h.origins, 'me/app')
  await h.submit({ sha }) // test-all: 3 shards, each tries to place
  const limits = () => h.boat.calls.filter((c) => c === 'limits').length
  await h.pass()
  assert.equal(limits(), 1)
  await h.pass()
  assert.equal(limits(), 1, 'still cached')
  h.advance(5_001)
  await h.pass()
  assert.equal(limits(), 2)
  // with budget, a create is a start: the next placement reads the limits again
  h.boat.budget.day = 100
  h.advance(5_001)
  await h.pass()
  const after = limits()
  const pool = h.d.c.pool!
  const r = await pool.place({ env: 'acme', size: 'default', repo: 'me/app', avoid: [] })
  assert.ok('box' in r || 'none' in r)
  assert.equal(limits(), after + 1, 'the starts placed in that pass invalidated the cache')
  for (const j of h.d.c.db.recentJobs({ limit: 5 })) h.d.c.jobs.cancel(j.id, 'test')
  await h.d.idle()
})

test('a resumed or created box is not handed out until Boat says it is hydrated; a box that never is, after hydrateMaxMs', async () => {
  const h = harness()
  const stopped = h.boat.addBox('cib-tst-acme-default-aaaaaa', 'stopped', 'default', { stoppedAt: 5 })
  const pool = h.d.c.pool!
  pool.hydratePollMs = 5
  await pool.reconcile()
  h.boat.unhydrated.set(stopped.id, 2)
  const r = await pool.place({ env: 'acme', size: 'default', repo: 'me/app', avoid: [] })
  assert.ok('box' in r, JSON.stringify(r))
  await pool.start(r.box)
  assert.equal(h.boat.calls.filter((c) => c === `hydrated ${stopped.id}`).length, 3, 'polled until hydrated')
  assert.ok(h.boat.calls.indexOf(`resume ${stopped.id}`) < h.boat.calls.indexOf(`hydrated ${stopped.id}`))
  assert.equal(pool.boxes().find((b) => b.name === r.box)?.state, 'busy')

  // a create waits too; a box that stays unhydrated is used after hydrateMaxMs, with a log line
  pool.hydrateMaxMs = 30
  const logs: string[] = []
  const log = h.d.c.pool!.d.log
  pool.d.log = (m: string) => { logs.push(m); log(m) }
  const realCreate = h.boat.create.bind(h.boat)
  h.boat.create = async (o) => {
    const id = await realCreate(o)
    h.boat.unhydrated.set(id, 1000)
    return id
  }
  const c = await pool.place({ env: 'acme', size: 'large', repo: 'me/app', avoid: [] })
  assert.ok('box' in c, JSON.stringify(c))
  await pool.start(c.box)
  assert.ok(logs.some((m) => /still not hydrated after 0s; going on/.test(m)), logs.join('\n'))
  assert.equal(pool.boxes().find((b) => b.name === c.box)?.state, 'busy')
})
