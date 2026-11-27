import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Activity, pastTarget, startsGuard, unitsPerAgent, warmUnits } from '../../src/tb/warm.ts'
import { RunsDb } from '../../src/tb/runs-db.ts'

const MIN = 60_000

test('activity: a run counts 30 min; a hint counts its TTL; a run refreshes the hint; gone ends it', () => {
  const a = new Activity()
  a.run('/w/a', 'o/r', 'tbx-h-shared', 0)
  a.hint('/w/b', 'o/r', 'tbx-h-shared', 60 * MIN, 0)
  assert.deepEqual(a.active(10 * MIN).map((x) => [x.root, x.source]), [['/w/a', 'runs'], ['/w/b', 'hint']])
  // a's run is 31 min old; b's hint still holds
  assert.deepEqual(a.active(31 * MIN).map((x) => x.root), ['/w/b'])
  // b runs at 50 min: its hint is good to 110 min, its run to 80 min
  a.run('/w/b', 'o/r', 'tbx-h-shared', 50 * MIN)
  assert.deepEqual(a.active(90 * MIN).map((x) => [x.root, x.source]), [['/w/b', 'hint']])
  assert.equal(a.active(111 * MIN).length, 0)
  a.hint('/w/c', 'o/r', 'tbx-h-shared', 60 * MIN, 0)
  assert.equal(a.gone('/w/c'), true)
  assert.equal(a.active(1 * MIN).some((x) => x.root === '/w/c'), false)
  assert.equal(a.ranRecently('tbx-h-shared', 51 * MIN), true)
  assert.equal(a.ranRecently('tbx-h-other', 51 * MIN), false)
})

test('warm target: max(D_recent, D_agents); one box at least while the pool ran a test in 30 min; else 0', () => {
  assert.equal(warmUnits({ dRecent: 6, dAgents: 3, active: true, boxUnits: 4 }), 6)
  assert.equal(warmUnits({ dRecent: 1, dAgents: 2.5, active: true, boxUnits: 4 }), 4)
  assert.equal(warmUnits({ dRecent: null, dAgents: 0, active: false, boxUnits: 4 }), 0)
  assert.equal(warmUnits({ dRecent: null, dAgents: 9, active: false, boxUnits: 4 }), 9)
})

test('past the target: busy boxes count first, then the idle ones used most recently; the rest are past it', () => {
  const u = () => 4
  const boxes = [
    { name: 'busy', state: 'busy', size: 'large', lastUsed: 0 },
    { name: 'idle-new', state: 'idle', size: 'large', lastUsed: 30 },
    { name: 'idle-mid', state: 'idle', size: 'large', lastUsed: 20 },
    { name: 'idle-old', state: 'idle', size: 'large', lastUsed: 10 },
    { name: 'stopped', state: 'stopped', size: 'large', lastUsed: 40 },
  ]
  assert.deepEqual(pastTarget(boxes, 8, u), ['idle-mid', 'idle-old'])
  assert.deepEqual(pastTarget(boxes, 4, u), ['idle-new', 'idle-mid', 'idle-old'])
  assert.deepEqual(pastTarget(boxes, 0, u), ['idle-new', 'idle-mid', 'idle-old'])
  assert.deepEqual(pastTarget(boxes, 100, u), [])
})

test('starts guard: on when the starts left (less the reserve) are 25% of the limit (less the reserve) or less', () => {
  assert.equal(startsGuard({ day: 65, dayLimit: 200 }, 20), true)
  assert.equal(startsGuard({ day: 66, dayLimit: 200 }, 20), false)
  assert.equal(startsGuard({ day: 5 }, 20), false, 'no limit known: off')
  assert.equal(startsGuard(null, 20), false)
})

test('units per agent: mean busy units over mean active worktrees, from runs.db; no runs: null', () => {
  const db = new RunsDb(':memory:')
  const now = 48 * 3600_000
  assert.equal(unitsPerAgent(db, 'o/r', now), null)
  // two worktrees each run one 2-unit shard for 10 min, every 20 min, all day: busy half the time
  let n = 0
  for (let t = now - 24 * 3600_000 - 30 * MIN; t < now; t += 20 * MIN)
    for (const root of ['/w/a', '/w/b'])
      db.startRun({ id: `r${n++}`, repo: 'o/r', root, suite: 's', shape: 'whole', argsN: 0, whereRan: 'boat', boatWhy: null, startedAt: t, cpus: 4, shards: [{ name: 'x', box: 'b', size: 'large', slot: 0, how: 'reused', units: 2, memMb: 4096, secs: 600, code: 0, started: true }] })
  const v = unitsPerAgent(db, 'o/r', now)!
  // 2 agents always active; 2 × 2 units busy half the time: 2 units / 2 agents = 1
  assert.ok(Math.abs(v - 1) < 0.15, String(v))
  assert.equal(unitsPerAgent(db, 'o/other', now), null)
})
