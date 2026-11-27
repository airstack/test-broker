import '../tmp-root.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import type { UsageRun, UsageShard } from '../../src/tb/runs-db.ts'
import { BoxFlags, boxScores, SPEED_DEFAULTS, type SpeedConfig } from '../../src/tb/boxspeed.ts'
import { MachineConfigError, parseMachineConfig } from '../../src/tb/machine-config.ts'
import { parseRepoConfig, RepoConfigError } from '../../src/tb/repo-config.ts'
import { tmp } from '../harness.ts'

const H = 3_600_000
const NOW = Date.UTC(2026, 10, 27, 12, 0, 0)
const cfg = (p: Partial<SpeedConfig> = {}): SpeedConfig => ({ ...SPEED_DEFAULTS, ...p })

const shard = (box: string, secs: number, o: Partial<UsageShard> = {}): UsageShard =>
  ({ name: 'unit', box, size: 'large', slot: 0, how: 'reused', units: 2, memMb: 8192, secs, code: 0, started: true, argsKey: '-', ...o }) as UsageShard
const run = (at: number, shards: UsageShard[], o: Partial<UsageRun> = {}): UsageRun =>
  ({ id: `r${at}`, repo: 'o/a', root: '/w', branch: null, head: null, tree: null, suite: 'test-all', shape: 'whole', argsN: 0, whereRan: 'boat', boatWhy: null, startedAt: at, endedAt: at + 60_000, exitCode: 0, endedHow: 'done', cpus: 8, cpuMin: 1, planHours: 0.1, shards, heavy: null, steer: null, ...o }) as UsageRun

/** n runs, one shard each, round-robin over boxes; `slow` boxes take `factor` × 100 s */
function history(n: number, boxes: string[], slow: Record<string, number> = {}, spanH = 10): UsageRun[] {
  const out: UsageRun[] = []
  for (let i = 0; i < n; i++) {
    const b = boxes[i % boxes.length]
    const jitter = 1 + ((i * 7) % 5) / 100
    out.push(run(NOW - spanH * H + (i * spanH * H) / n, [shard(b, Math.round(100 * (slow[b] ?? 1) * jitter))]))
  }
  return out
}

test('a box half again as slow as its peers on the same shard scores about 1.5; its peers about 1.0', () => {
  const s = boxScores(history(80, ['a', 'b', 'c', 'd'], { d: 1.6 }), NOW, cfg())
  assert.ok(s.get('d')!.score >= 1.5 && s.get('d')!.score <= 1.7, JSON.stringify([...s]))
  for (const b of ['a', 'b', 'c']) assert.ok(Math.abs(s.get(b)!.score - 1) < 0.1, `${b}: ${s.get(b)!.score}`)
  assert.equal(s.get('d')!.samples, 20)
  assert.equal(s.get('d')!.last, Math.max(...history(80, ['a', 'b', 'c', 'd']).filter((r) => r.shards![0].box === 'd').map((r) => r.startedAt)))
})

test('no score: too few shards, a key on fewer than 3 boxes, failed or short shards, other keys never mixed', () => {
  // 9 shards on d (minSamples 10)
  assert.equal(boxScores(history(36, ['a', 'b', 'c', 'd'], { d: 2 }), NOW, cfg()).get('d'), undefined)
  // 2 boxes only: no peers to judge by
  assert.equal(boxScores(history(80, ['a', 'd'], { d: 2 }), NOW, cfg()).size, 0)
  // failed and short shards do not count
  const failed = history(80, ['a', 'b', 'c', 'd'], { d: 2 }).map((r) => ({ ...r, shards: r.shards!.map((x) => (x.box === 'd' ? { ...x, code: 1 } : x)) }))
  assert.equal(boxScores(failed, NOW, cfg()).get('d'), undefined)
  assert.equal(boxScores(history(80, ['a', 'b', 'c', 'd'], { d: 2 }), NOW, cfg({ minSecs: 500 })).size, 0)
  // d only runs a key that takes twice as long by nature (other args): it is compared with that key's runs only
  const mixed = [...history(80, ['a', 'b', 'c']), ...history(80, ['a', 'b', 'c', 'd'], { a: 2, b: 2, c: 2, d: 2 }).map((r) => ({ ...r, id: `${r.id}x`, shards: r.shards!.map((x) => ({ ...x, argsKey: 'big' })) }))]
  assert.ok(Math.abs(boxScores(mixed, NOW, cfg()).get('d')!.score - 1) < 0.1)
})

test('only recent shards count, against peers near their time; a recovered box scores normal again', () => {
  // slow 30 h ago, normal in the last day: the window (ageHours 24) holds only the normal runs
  const old = history(80, ['a', 'b', 'c', 'd'], { d: 2 }).map((r) => ({ ...r, id: `${r.id}o`, startedAt: r.startedAt - 30 * H }))
  const s = boxScores([...old, ...history(80, ['a', 'b', 'c', 'd'])], NOW, cfg())
  assert.ok(Math.abs(s.get('d')!.score - 1) < 0.1, JSON.stringify(s.get('d')))
  // the shard got twice as slow for everyone 20 h ago: peers near the time are the measure, so no box is slow
  const before = history(80, ['a', 'b', 'c', 'd'], {}, 4).map((r) => ({ ...r, id: `${r.id}b`, startedAt: r.startedAt - 20 * H }))
  const after = history(80, ['a', 'b', 'c', 'd'], { a: 2, b: 2, c: 2, d: 2 }, 4)
  const t = boxScores([...before, ...after.filter((r) => r.shards![0].box !== 'd')], NOW, cfg({ nearHours: 3 }))
  for (const [, v] of t) assert.ok(Math.abs(v.score - 1) < 0.1)
})

test('box flags: drains and slow clocks persist; undrain restarts the slow clock; prune forgets gone boxes', () => {
  const f = join(tmp('tb-flags-'), 'box-flags.json')
  const a = new BoxFlags(f)
  a.setSlow('x', 100)
  a.setDrain('x', { at: 200, reason: 'slow', by: 'retire' })
  a.setDrain('y', { at: 300, reason: 'bad disk', by: 'operator' })
  const b = new BoxFlags(f)
  assert.equal(b.slowSince('x'), 100)
  assert.deepEqual(b.drain('y'), { at: 300, reason: 'bad disk', by: 'operator' })
  assert.equal(b.retiredSince(0), 1)
  assert.equal(b.undrain('x'), true)
  assert.equal(b.slowSince('x'), null)
  assert.equal(b.undrain('x'), false)
  b.prune(new Set(['x']), 400)
  assert.equal(new BoxFlags(f).drain('y'), null)
})

test('config: boat.speed and a suite\'s avoidSlow are checked', () => {
  const c = parseMachineConfig({ boat: { speed: { mode: 'avoid', slowAt: 1.5 } } })
  assert.equal(c.boat.speed.mode, 'avoid')
  assert.equal(c.boat.speed.slowAt, 1.5)
  assert.equal(c.boat.speed.retireAfterMin, SPEED_DEFAULTS.retireAfterMin)
  assert.equal(parseMachineConfig(undefined).boat.speed.mode, 'retire')
  assert.throws(() => parseMachineConfig({ boat: { speed: { mode: 'fast' } } }), MachineConfigError)
  assert.equal(c.boat.speed.clearAt, 1.25)
  assert.equal(parseMachineConfig({ boat: { speed: { slowAt: 1.2 } } }).boat.speed.clearAt, 1.2)
  assert.throws(() => parseMachineConfig({ boat: { speed: { slowAt: 1.3, clearAt: 1.35 } } }), /clearAt: must not be more than slowAt/)
  assert.throws(() => parseMachineConfig({ boat: { speed: { slowAt: 1 } } }), MachineConfigError)
  assert.throws(() => parseMachineConfig({ boat: { speed: { nope: 1 } } }), /unknown key "nope"/)
  assert.throws(() => parseMachineConfig({ boat: { speed: { minSamples: 50, window: 40 } } }), /minSamples/)
  const doc = (avoidSlow: unknown) => ({ boat: { remoteScript: 'r.sh' }, suites: { e2e: { local: { cpus: 2 }, boat: { avoidSlow, shards: [{ name: 'a', args: [] }] } } } })
  assert.equal(parseRepoConfig(doc(true), '/w').suites.e2e.boat!.avoidSlow, true)
  assert.equal(parseRepoConfig({ boat: { remoteScript: 'r.sh' }, suites: { e2e: { local: { cpus: 2 }, boat: { shards: [{ name: 'a', args: [] }] } } } }, '/w').suites.e2e.boat!.avoidSlow, false)
  assert.throws(() => parseRepoConfig(doc('yes'), '/w'), RepoConfigError)
})
