import { test } from 'node:test'
import assert from 'node:assert/strict'
import { argsKey, DEFAULT_START_COST_SEC, EtaModel } from '../../src/tb/eta.ts'
import { RunsDb } from '../../src/tb/runs-db.ts'

const K = { repo: 'o/r', suite: 'int', shape: 'narrowed', shard: 'int', argsKey: argsKey(['services/a']) }

test('argsKey: a short stable hash; no args is "-"', () => {
  assert.equal(argsKey([]), '-')
  assert.equal(argsKey(['a', 'b']), argsKey(['a', 'b']))
  assert.notEqual(argsKey(['a', 'b']), argsKey(['b', 'a']))
  assert.match(argsKey(['x']), /^[0-9a-f]{10}$/)
})

test('estimate: p75 and p90 of the key; under 5 samples it falls back to all args; none: null', () => {
  const m = new EtaModel()
  assert.equal(m.estimate(K), null)
  for (const s of [100, 110, 120, 130, 140, 150]) m.add({ ...K, argsKey: argsKey(['services/big']) }, s, 'reused')
  // the key has no samples of its own: all args
  assert.deepEqual(m.estimate(K), { p75: 140, p90: 150 })
  for (const s of [20, 21, 22, 23, 24]) m.add(K, s, 'shared')
  assert.deepEqual(m.estimate(K), { p75: 23, p90: 24 })
})

test('remaining: p75 less elapsed, at least 5 s; past p90 it may be stuck: 1.5 × p75 less elapsed, at least 15 s', () => {
  const m = new EtaModel()
  // p75 40, p90 40
  for (const s of [20, 20, 20, 40, 40]) m.add(K, s, 'reused')
  assert.equal(m.remaining(K, 10), 30)
  assert.equal(m.remaining(K, 38), 5)
  assert.equal(m.remaining(K, 41), 19)
  assert.equal(m.remaining(K, 100), 15)
  assert.equal(m.remaining({ ...K, shard: 'other' }, 1), null)
})

test('startCost: p50 started less p50 warm, at least 10 s; too few samples: the default', () => {
  const m = new EtaModel()
  assert.equal(m.startCost(K), DEFAULT_START_COST_SEC)
  for (let i = 0; i < 5; i++) m.add(K, 30, 'reused')
  for (let i = 0; i < 3; i++) m.add(K, 75, 'resumed')
  assert.equal(m.startCost(K), 45)
  for (let i = 0; i < 20; i++) m.add(K, 31, 'created')
  assert.equal(m.startCost(K), 10)
})

test('load: passing Boat shards from runs.db; an old narrowed row (no argsKey) counts toward all args only', () => {
  const db = new RunsDb(':memory:')
  const shard = (o: object) => ({ name: 'int', box: 'b', size: 'large', slot: 0, how: 'reused', units: 2, memMb: 4096, code: 0, started: true, ...o })
  db.startRun({ id: 'r1', repo: 'o/r', root: '/w', suite: 'int', shape: 'narrowed', argsN: 1, whereRan: 'boat', boatWhy: null, startedAt: 1000, cpus: 4, shards: [shard({ secs: 50, argsKey: K.argsKey })] as never })
  for (let i = 0; i < 5; i++)
    db.startRun({ id: `old${i}`, repo: 'o/r', root: '/w', suite: 'int', shape: 'narrowed', argsN: 1, whereRan: 'boat', boatWhy: null, startedAt: 1000 + i, cpus: 4, shards: [shard({ secs: 200 })] as never })
  db.startRun({ id: 'failed', repo: 'o/r', root: '/w', suite: 'int', shape: 'narrowed', argsN: 1, whereRan: 'boat', boatWhy: null, startedAt: 1000, cpus: 4, shards: [shard({ secs: 999, code: 1, argsKey: K.argsKey })] as never })
  const m = new EtaModel()
  m.load(db, 0)
  // one sample of its own (under 5): all args, which hold the old rows too
  assert.deepEqual(m.estimate(K), { p75: 200, p90: 200 })
  assert.equal(m.estimate({ ...K, argsKey: argsKey(['nothing']) })!.p75, 200)
})
