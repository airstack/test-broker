import '../tmp-root.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LOG_EXT, pruneSeeds, readRunLog, tidyRuns } from '../../src/tb/housekeep.ts'
import { tmp } from '../harness.ts'

const H = 3_600_000
const age = (f: string, ms: number) => {
  const t = (Date.now() - ms) / 1000
  utimesSync(f, t, t)
}

test('tidy: a log older than compressAfter is compressed (same mtime, readable); a live run and a new log are left; old ones go', async () => {
  const dir = tmp('tb-tidy-')
  const text = 'line of a test run\n'.repeat(5000)
  for (const id of ['tb-001-old', 'tb-002-new', 'tb-003-live', 'tb-004-gone']) writeFileSync(join(dir, `${id}.log`), text)
  age(join(dir, 'tb-001-old.log'), 30 * H)
  age(join(dir, 'tb-003-live.log'), 30 * H)
  age(join(dir, 'tb-004-gone.log'), 20 * 24 * H)
  const mtime = statSync(join(dir, 'tb-001-old.log')).mtimeMs
  mkdirSync(join(dir, 'tb-001-old.artifacts', 'a', 'report'), { recursive: true })
  writeFileSync(join(dir, 'tb-001-old.artifacts', 'a', 'dev.log'), 'x'.repeat(100_000))
  writeFileSync(join(dir, 'tb-001-old.artifacts', 'a', 'small.txt'), 'x')
  writeFileSync(join(dir, 'tb-001-old.artifacts', 'a', 'report', 'index.html'), 'x'.repeat(100_000))
  writeFileSync(join(dir, 'tb-001-old.artifacts', 'a', 'report', 'data.log'), 'x'.repeat(100_000))
  age(join(dir, 'tb-001-old.artifacts'), 30 * H)
  const r = await tidyRuns(dir, { now: Date.now(), keepDays: 14, compressAfterMs: 24 * H, live: new Set(['tb-003-live']) })
  assert.deepEqual(r.errors, [])
  assert.equal(r.deleted, 1)
  assert.ok(!existsSync(join(dir, 'tb-004-gone.log')))
  assert.ok(!existsSync(join(dir, 'tb-001-old.log')))
  assert.ok(existsSync(join(dir, `tb-001-old.log${LOG_EXT}`)))
  assert.equal(Math.round(statSync(join(dir, `tb-001-old.log${LOG_EXT}`)).mtimeMs / 1000), Math.round(mtime / 1000), 'the age still counts from the run')
  assert.ok(statSync(join(dir, `tb-001-old.log${LOG_EXT}`)).size < text.length / 10)
  assert.equal(readRunLog(dir, 'tb-001-old'), text)
  assert.equal(readRunLog(dir, 'tb-002-new'), text)
  assert.ok(existsSync(join(dir, 'tb-003-live.log')), 'a live run is never touched')
  assert.deepEqual(readdirSync(join(dir, 'tb-001-old.artifacts', 'a')).sort(), ['dev.log.gz', 'report', 'small.txt'])
  assert.ok(existsSync(join(dir, 'tb-001-old.artifacts', 'a', 'report', 'data.log')), 'nothing inside a report dir is compressed')
  assert.ok(existsSync(join(dir, 'tb-001-old.artifacts', 'a', 'report', 'index.html')), 'a report still opens')
  assert.equal(readRunLog(dir, '../etc/passwd'), null)
  assert.equal(readRunLog(dir, 'tb-999-none'), null)
})

test('seeds: the newest 3 per repo stay, and any seed in use; a stale build leftover goes', async () => {
  const dir = tmp('tb-seeds-')
  const f = (repo: string, n: number) => join(dir, `${repo}-${String(n).padStart(12, '0')}.bundle`)
  for (let i = 0; i < 6; i++) {
    writeFileSync(f('o__a', i), 'x')
    age(f('o__a', i), (10 - i) * H)
  }
  writeFileSync(f('o__b', 0), 'x')
  writeFileSync(join(dir, 'o__a-x.bundle.tmp'), 'x')
  age(join(dir, 'o__a-x.bundle.tmp'), 2 * H)
  writeFileSync(join(dir, 'o__a-y.bundle.tmp'), 'x')
  const removed = await pruneSeeds(dir, { now: Date.now(), inUse: (x) => x === f('o__a', 0) })
  assert.deepEqual(readdirSync(dir).sort(), [f('o__a', 0), f('o__a', 3), f('o__a', 4), f('o__a', 5), f('o__b', 0), join(dir, 'o__a-y.bundle.tmp')].map((x) => x.slice(dir.length + 1)).sort())
  assert.equal(removed.length, 3)
})

test('seeds: a seed taken up during the pass stays (checked again before the rm)', async () => {
  const dir = tmp('tb-seeds2-')
  const f = (n: number) => join(dir, `o__a-${String(n).padStart(12, '0')}.bundle`)
  for (let i = 0; i < 5; i++) {
    writeFileSync(f(i), 'x')
    age(f(i), (10 - i) * H)
  }
  // f(0) is taken up after the listing: in use from the second check on
  let calls = 0
  const removed = await pruneSeeds(dir, { now: Date.now(), inUse: (x) => x === f(0) && ++calls > 1 })
  assert.deepEqual(removed, [f(1)])
  assert.ok(existsSync(f(0)))
})

test('tidy: two passes at once compress each log once (no error, no lost file)', async () => {
  const dir = tmp('tb-tidy2-')
  for (let i = 0; i < 30; i++) {
    writeFileSync(join(dir, `tb-${i}-x.log`), 'line\n'.repeat(20_000))
    age(join(dir, `tb-${i}-x.log`), 30 * H)
  }
  const o = { now: Date.now(), keepDays: 14, compressAfterMs: 24 * H, live: new Set<string>() }
  const [a, b] = await Promise.all([tidyRuns(dir, o), tidyRuns(dir, o)])
  // the daemon runs one pass at a time; two at once must still not lose a log
  for (let i = 0; i < 30; i++) assert.equal(readRunLog(dir, `tb-${i}-x`), 'line\n'.repeat(20_000))
  assert.ok(a.compressed + b.compressed >= 30)
})
