import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OutagePause } from '../../src/tb/outage.ts'

const MIN = 60_000

function make(cfg = { outageFails: 3, outageWindowMin: 5, outagePauseMin: 5 }) {
  let now = Date.UTC(2026, 10, 23, 6, 10)
  const logs: string[] = []
  const p = new OutagePause(() => cfg, () => now, (m) => logs.push(m))
  return { p, logs, cfg, tick: (ms: number) => (now += ms) }
}

test('outage: failed starts on 2+ boxes within the window pause Boat; the pause runs out; one box alone never pauses it', () => {
  const t = make()
  t.p.failed('b1', 'resume failed: 500')
  t.p.failed('b1', 'resume failed: 500')
  t.p.failed('b1', 'resume failed: 500')
  assert.equal(t.p.check(), null, 'one bad box is quarantine, not an outage')
  t.p.failed('b2', 'upload failed: mkdir exited 124')
  assert.match(t.p.check() ?? '', /^Boat paused until 06:15 UTC: .*mkdir exited 124/)
  assert.equal(t.p.view().paused, true)
  t.tick(5 * MIN)
  assert.equal(t.p.check(), null, 'the pause ran out: try Boat again')
  assert.equal(t.p.view().probing, true)
})

test('outage: old failures fall out of the window', () => {
  const t = make()
  t.p.failed('b1', 'x')
  t.p.failed('b2', 'x')
  t.tick(6 * MIN)
  t.p.failed('b3', 'x')
  assert.equal(t.p.check(), null)
  assert.equal(t.p.view().recentFails, 1)
})

test('outage: after the pause, the first failed start pauses it again at once; a start that works clears it', () => {
  const t = make()
  for (const b of ['b1', 'b2', 'b3']) t.p.failed(b, 'x')
  t.tick(5 * MIN)
  assert.equal(t.p.check(), null)
  t.p.failed('b1', 'still down')
  assert.match(t.p.check() ?? '', /paused until 06:20 UTC/)
  t.tick(5 * MIN)
  assert.equal(t.p.check(), null)
  t.p.ok()
  assert.deepEqual(t.p.view(), { paused: false, until: null, probing: false, recentFails: 0, last: 'still down' })
  t.p.failed('b1', 'x')
  assert.equal(t.p.check(), null, 'back to counting from zero')
  assert.ok(t.logs.some((l) => /outage pause cleared/.test(l)), t.logs.join('\n'))
})

test('outage: outageFails 0 never pauses', () => {
  const t = make({ outageFails: 0, outageWindowMin: 5, outagePauseMin: 5 })
  for (let i = 0; i < 10; i++) t.p.failed(`b${i}`, 'x')
  assert.equal(t.p.check(), null)
})
