import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, duration, MAX_DESCRIPTION } from '../../src/ci/daemon/statuses.ts'
import { Daemon } from '../../src/ci/daemon/daemon.ts'
import { harness, idOf, makeOrigin, sh, TEST_PROFILE, until, type Harness } from '../harness.ts'

const job = (h: Harness, id: string) => h.d.c.db.job(idOf(id))!
const posts = (h: Harness) => h.gh.calls.map((c) => ({ path: c[3], state: c[5].slice(6), context: c[7].slice(8), description: c[9].slice(12) }))
const streamKinds = (h: Harness, id: string) =>
  readFileSync(join(h.d.c.streams.dir(idOf(id)), 'stream.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).t)

/** Submit, let its one shard end with `code`, settle. */
async function runOne(h: Harness, s: Parameters<Harness['submit']>[0], code: number) {
  const r = await h.submit(s)
  await h.pass()
  await until(() => h.ctl.pending.length === 1, 'the shard run')
  h.ctl.finish(code)
  await h.settle()
  return r
}

test('duration and description: 7m08s style, ≤ 140 characters with the job name kept', () => {
  assert.deepEqual([duration(42), duration(428), duration(3720)], ['42s', '7m08s', '1h02m'])
  const shards = Array.from({ length: 10 }, () => ({ state: 'passed' as const, reason: null }))
  assert.equal(describe({ error: null }, shards, 'passed', 428, 'ub1-41'), '10/10 shards passed in 7m08s (job ub1-41)')
  const long = describe({ error: 'x'.repeat(300) }, shards, 'error', 1, 'ub1-41')
  assert.equal(long.length, MAX_DESCRIPTION)
  assert.match(long, /^error: x+… \(job ub1-41\)$/)
})

test('a pushed, unfiltered job posts ci-broker/<mode> on its end: success, failure', async () => {
  const h = harness()
  const { sha } = makeOrigin(h.origins, 'me/app')
  const r = await runOne(h, { sha, mode: 'one', wantStatus: true }, 0)
  assert.equal(r.status.asked, true)
  assert.deepEqual(posts(h), [{ path: `repos/me/app/statuses/${sha}`, state: 'success', context: 'ci-broker/one', description: '1/1 shards passed in 0s (job tst-1)' }])
  const t = h.d.c.db.statusTargets(1)[0]
  assert.equal(t.state, 'success')
  assert.notEqual(t.postedAt, null)
  assert.ok(h.d.c.db.events(1).some((e) => e.kind === 'status' && /posted/.test(e.message)))

  const h2 = harness()
  const o2 = makeOrigin(h2.origins, 'me/app')
  await runOne(h2, { sha: o2.sha, mode: 'one', wantStatus: true }, 1)
  assert.equal(posts(h2)[0].state, 'failure')
  assert.equal(posts(h2)[0].description, '0/1 shards passed in 0s (job tst-1)')
})

test('an error job posts error with its reason; a cancelled job posts nothing', async () => {
  const h = harness()
  const { sha } = makeOrigin(h.origins, 'me/app')
  const r = await h.submit({ sha, mode: 'one', wantStatus: true })
  h.d.c.jobs.fail(idOf(r.id), 'no resource could run it')
  await h.settle()
  assert.equal(job(h, r.id).state, 'error')
  assert.deepEqual(posts(h).map((p) => [p.state, p.description]), [['error', 'error: no resource could run it (job tst-1)']])

  const r2 = await h.submit({ sha, mode: 'test-all', wantStatus: true })
  h.d.c.jobs.cancel(idOf(r2.id), 'test')
  await h.settle()
  assert.equal(job(h, r2.id).state, 'cancelled')
  assert.equal(h.gh.calls.length, 1)
  assert.equal(streamKinds(h, r2.id).at(-1), 'done')
})

test('no status for args, --no-status, a profile with status:false, or a snapshot; the reason comes back', async () => {
  const h = harness()
  mkdirSync(join(h.root, 'profiles', 'quiet'), { recursive: true })
  writeFileSync(join(h.root, 'profiles', 'quiet', 'profile.json'), JSON.stringify({ ...TEST_PROFILE, name: 'quiet', status: false }))
  writeFileSync(join(h.root, 'profiles', 'quiet', 'remote.sh'), 'true\n')
  const o = makeOrigin(h.origins, 'me/app')
  const ids: string[] = []
  const sub = async (x: Parameters<Harness['submit']>[0]) => {
    const r = await h.submit(x)
    ids.push(r.id)
    return r.status
  }
  assert.deepEqual(await sub({ sha: o.sha, mode: 'cmd', args: ['x'], wantStatus: true }), { asked: false, why: 'args' })
  assert.deepEqual(await sub({ sha: o.sha, mode: 'one', wantStatus: false }), { asked: false, why: 'no-status' })
  assert.deepEqual(await sub({ sha: o.sha, mode: 'one', profile: 'quiet', wantStatus: true }), { asked: false, why: 'disabled' })
  // a snapshot: a commit origin doesn't have, with its tree
  assert.deepEqual(await sub({ sha: 'f'.repeat(40), tree: sh(o.work, 'rev-parse', 'HEAD^{tree}'), mode: 'e2e', wantStatus: true }), { asked: false, why: 'snapshot' })
  for (const id of ids) assert.deepEqual(h.d.c.db.statusTargets(idOf(id)), [])
  for (const id of ids) h.d.c.jobs.cancel(idOf(id), 'test over')
  await h.settle()
  assert.equal(h.gh.calls.length, 0)
})

test('a failed post is logged and recorded on the target; the job result does not change', async () => {
  const h = harness()
  h.gh.fail = 'HTTP 403: Resource not accessible by integration'
  const { sha } = makeOrigin(h.origins, 'me/app')
  const r = await runOne(h, { sha, mode: 'one', wantStatus: true }, 0)
  assert.equal(job(h, r.id).state, 'passed')
  const t = h.d.c.db.statusTargets(1)[0]
  assert.equal(t.postedAt, null)
  assert.equal(t.error, 'gh api exited 1: HTTP 403: Resource not accessible by integration')
  assert.ok(h.logs.some((l) => /status: ci-broker\/one success on me\/app@\w+: NOT posted/.test(l)))
  assert.equal(streamKinds(h, r.id).at(-1), 'done')
})

test('done is streamed only after the statuses are posted (so the receipt can say what happened)', async () => {
  let release!: () => void
  const h = harness({ deps: { gh: () => new Promise((res) => (release = () => res({ code: 0, stdout: '', stderr: '' }))) } })
  const { sha } = makeOrigin(h.origins, 'me/app')
  const r = await h.submit({ sha, mode: 'one', wantStatus: true })
  await h.pass()
  await until(() => h.ctl.pending.length === 1)
  h.ctl.finish(0)
  await until(() => job(h, r.id).state === 'passed' && !!release)
  assert.notEqual(streamKinds(h, r.id).at(-1), 'done')
  release()
  await h.settle()
  assert.equal(streamKinds(h, r.id).at(-1), 'done')
  assert.notEqual(h.d.c.db.statusTargets(1)[0].postedAt, null)
})

test('reuse posts at once for the submitted commit; a commit already showing the success is not posted again', async () => {
  const h = harness()
  const { sha, work } = makeOrigin(h.origins, 'me/app')
  await runOne(h, { sha, mode: 'one', wantStatus: true }, 0)
  const again = await h.submit({ sha, mode: 'one', wantStatus: true })
  assert.equal(again.reused, true)
  assert.equal(h.gh.calls.length, 1)
  const { execFileSync } = await import('node:child_process')
  execFileSync('git', ['-C', work, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'same tree'])
  execFileSync('git', ['-C', work, 'push', '-q', 'origin', 'HEAD:main'])
  const sha2 = execFileSync('git', ['-C', work, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const r2 = await h.submit({ sha: sha2, mode: 'one', wantStatus: true })
  assert.equal(r2.reused, true)
  assert.deepEqual(posts(h)[1], { path: `repos/me/app/statuses/${sha2}`, state: 'success', context: 'ci-broker/one', description: 'reused job tst-1 (same tree)' })
  assert.equal(h.gh.calls.length, 2)
  // --no-status on a reuse: no post, the reason comes back
  assert.deepEqual((await h.submit({ sha: sha2, mode: 'one', wantStatus: false })).status, { asked: false, why: 'no-status' })
  assert.equal(h.gh.calls.length, 2)
})

test('joining with another pushed commit of the same tree adds its own target; both are posted at the end', async () => {
  const h = harness()
  const { sha, work } = makeOrigin(h.origins, 'me/app')
  const r = await h.submit({ sha, mode: 'one', wantStatus: true })
  await h.pass()
  await until(() => h.ctl.pending.length === 1)
  const { execFileSync } = await import('node:child_process')
  execFileSync('git', ['-C', work, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'same tree'])
  execFileSync('git', ['-C', work, 'push', '-q', 'origin', 'HEAD:main'])
  const sha2 = execFileSync('git', ['-C', work, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const j = await h.submit({ sha: sha2, mode: 'one', wantStatus: true })
  assert.equal(j.joined, true)
  assert.deepEqual(j.status, { asked: true })
  h.ctl.finish(0)
  await h.settle()
  assert.equal(job(h, r.id).state, 'passed')
  assert.deepEqual(posts(h).map((p) => p.path).sort(), [`repos/me/app/statuses/${sha}`, `repos/me/app/statuses/${sha2}`].sort())
})

test('a daemon that died while posting: the next start posts the statuses, then sends done', async () => {
  const h = harness({ deps: { gh: () => new Promise(() => {}) } }) // the post never returns: the process "dies" there
  const { sha } = makeOrigin(h.origins, 'me/app')
  const r = await h.submit({ sha, mode: 'one', wantStatus: true })
  await h.pass()
  await until(() => h.ctl.pending.length === 1)
  h.ctl.finish(0)
  await until(() => job(h, r.id).state === 'passed')
  assert.notEqual(streamKinds(h, r.id).at(-1), 'done')
  const calls: string[][] = []
  const d2 = new Daemon({ ghApi: h.github.run, apiSleep: async () => {}, cfg: h.cfg, boat: h.boat, now: () => h.clock.t, log: () => {}, sys: async () => ({ code: 0, stdout: '', stderr: '' }), gh: async (a) => (calls.push(a), { code: 0, stdout: '', stderr: '' }), localLock: async () => null })
  await d2.recover()
  await d2.idle()
  assert.equal(calls.length, 1)
  assert.equal(calls[0][5], 'state=success')
  assert.deepEqual(streamKinds(h, r.id).filter((k) => k === 'done'), ['done'])
  // a second start has nothing left to do
  const d3 = new Daemon({ ghApi: h.github.run, apiSleep: async () => {}, cfg: h.cfg, boat: h.boat, now: () => h.clock.t, log: () => {}, sys: async () => ({ code: 0, stdout: '', stderr: '' }), gh: async (a) => (calls.push(a), { code: 0, stdout: '', stderr: '' }), localLock: async () => null })
  await d3.recover()
  await d3.idle()
  assert.equal(calls.length, 1)
})
