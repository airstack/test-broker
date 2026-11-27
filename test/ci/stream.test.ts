import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JobStreams, type StreamEvent } from '../../src/ci/daemon/stream.ts'
import { tmp } from '../harness.ts'

test('events get increasing seqs, replay from a seq, then live without gaps or doubles', () => {
  const s = new JobStreams(tmp())
  s.append(1, { t: 'log', shard: 'a', data: 'one\n' })
  s.append(1, { t: 'log', shard: 'a', data: 'two\n' })
  const got: StreamEvent[] = []
  const off = s.follow(1, 1, (e) => got.push(e))
  s.append(1, { t: 'done', summary: {} })
  off()
  s.append(1, { t: 'log', shard: 'a', data: 'after\n' })
  assert.deepEqual(got.map((e) => e.seq), [2, 3])
})

test('seq continues after a restart (a new JobStreams over the same dir)', () => {
  const dir = tmp()
  new JobStreams(dir).append(4, { t: 'state', state: 'queued' })
  const e = new JobStreams(dir).append(4, { t: 'state', state: 'running' })
  assert.equal(e.seq, 2)
})

test('a failing file write or a throwing follower never throws out of append: other followers still get the event', async () => {
  const { mkdirSync } = await import('node:fs')
  const { join } = await import('node:path')
  const errs: string[] = []
  const s = new JobStreams(tmp(), (m) => errs.push(m))
  const got: number[] = []
  s.follow(1, 0, () => {
    throw new Error('follower broke')
  })
  s.follow(1, 0, (e) => got.push(e.seq))
  s.append(1, { t: 'state', state: 'queued' })
  // the stream file can't be written any more (a directory in its place)
  const f = join(s.dir(1), 'stream.ndjson')
  const { rmSync } = await import('node:fs')
  rmSync(f)
  mkdirSync(f)
  assert.doesNotThrow(() => s.append(1, { t: 'log', shard: 'a', data: 'x\n' }))
  assert.deepEqual(got, [1, 2])
  assert.ok(errs.some((m) => /follower broke/.test(m)))
  assert.ok(errs.some((m) => /stream\.ndjson/.test(m)))
})
