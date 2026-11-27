import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LogSummer } from '../../src/tb/logsum.ts'

const feedAll = (text: string, size = 7) => {
  const s = new LogSummer()
  // in odd-sized chunks: a line may be split anywhere
  for (let i = 0; i < text.length; i += size) s.feed(text.slice(i, i + size))
  return s.result()
}

test('log summary: the timed steps, the last test count, failing tests and the bytes by source (vitest)', () => {
  const log = [
    '=== [0s] checkout 047bbdb6602e903a512329fdf94959329a9433dc (snapshot)',
    '=== [0s] pnpm install',
    '=== [12s] unit shard unit',
    '=== just guards',
    'stdout | src/lifecycle.int.test.ts > removes the app',
    "{ '$module': 'lifecycle', level: 'info' }",
    "{ '$module': 'lifecycle', level: 'info' }",
    '',
    'stderr | src/era.int.test.ts > x',
    'warn',
    '',
    '\x1b[31m FAIL \x1b[39m |shared| scripts/a.unit.test.ts > approval > every route is listed',
    '      Tests  1 failed | 12332 passed | 4 skipped (12337)',
    '  Tests        17946 passed, 1 failed, 4 skipped   (17951 total)',
    'resources: peak RAM 10055 MB of 15991 MB (box), CPU busy mean 84% p95 99% of 4 CPU(s), 41 samples',
    '=== [85s] done: mode=unit-named sha=047bbdb6602e903a512329fdf94959329a9433dc slot=0 rc=0 elapsed=85s',
    '',
  ].join('\n')
  const r = feedAll(log)
  assert.deepEqual(r.phases, [{ name: 'checkout <sha> (snapshot)', secs: 0 }, { name: 'pnpm install', secs: 12 }, { name: 'unit shard unit', secs: 73 }])
  assert.deepEqual(r.tests, { passed: 17946, failed: 1, skipped: 4 }, 'the last count line: the run total')
  assert.deepEqual(r.failing, ['|shared| scripts/a.unit.test.ts > approval > every route is listed'])
  assert.equal(r.sources[0].source, 'src/lifecycle.int.test.ts')
  assert.equal(r.sources[1].source, 'src/era.int.test.ts')
  assert.equal(r.sources.at(-1)!.source, '(rest)')
  assert.equal(r.bytes, Buffer.byteLength(log))
  assert.equal(r.lines, log.split('\n').length - 1)
})

test('log summary: pytest and playwright counts and names; no counts: null', () => {
  const py = feedAll('FAILED tests/gates/test_x.py::test_y - AssertionError\n===== 1 failed, 27 passed, 2 skipped in 2.45s =====\n')
  assert.deepEqual(py.tests, { passed: 27, failed: 1, skipped: 2 })
  assert.deepEqual(py.failing, ['tests/gates/test_x.py::test_y'])
  const pw = feedAll('  1) [chromium] › e2e/login.spec.ts:12:3 › signs in\n\n  1 failed\n  10 passed (1.2m)\n')
  assert.deepEqual(pw.tests, { passed: 10, failed: 1, skipped: 0 })
  assert.deepEqual(pw.failing, ['e2e/login.spec.ts:12:3 › signs in'])
  assert.equal(feedAll('nothing here\n').tests, null)
})

test('log summary: caps (failing names, sources) and a line with no end', () => {
  const many = Array.from({ length: 30 }, (_, i) => ` FAIL  f${i}.test.ts > t`).join('\n') + '\n'
  assert.equal(feedAll(many, 100).failing.length, 20)
  const blocks = Array.from({ length: 9 }, (_, i) => `stdout | s${i}.test.ts > t\n${'x'.repeat(10 * (i + 1))}\n`).join('\n')
  const r = feedAll(blocks, 50)
  assert.equal(r.sources.length, 6, 'top 5 and the rest')
  assert.equal(r.sources[0].source, 's8.test.ts')
  const s = new LogSummer()
  s.feed('y'.repeat(70_000))
  assert.equal(s.result().lines, 1)
})

test('log summary: a long adversarial line is only counted (no slow pattern runs on it)', () => {
  const bad = '=' + ' 1 passed'.repeat(20_000) + 'x'
  const t0 = Date.now()
  const r = feedAll(`${bad}\n${'Tests  '.repeat(10_000)}\n${' FAIL  ' + 'a > '.repeat(20_000)}\n`, 4096)
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`)
  assert.equal(r.tests, null)
  assert.deepEqual(r.failing, [])
})
