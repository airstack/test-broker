import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Daemon } from '../../src/ci/daemon/daemon.ts'
import { ShardControl } from '../fake-boat.ts'
import { harness, idOf, makeOrigin, pushCommit, until, type Harness } from '../harness.ts'

const job = (h: Harness, id: string) => h.d.c.db.job(idOf(id))!
const shard = (h: Harness, id: string, idx = 0) => h.d.c.db.shard(idOf(id), idx)!
const box = (h: Harness, name: string) => h.d.c.db.box(name)!

/** Two idle boxes (A preferred: last ran this repo) and no start budget, so placements are predictable. */
async function twoBoxes(h: Harness) {
  h.boat.budget.day = 0
  h.boat.addBox('cib-tst-acme-default-aaaaaa', 'ready')
  h.boat.addBox('cib-tst-acme-default-bbbbbb', 'ready')
  await h.d.timers.boat()
  h.d.c.db.updateBox('cib-tst-acme-default-aaaaaa', { lastRepo: 'me/app' })
  return { A: 'cib-tst-acme-default-aaaaaa', B: 'cib-tst-acme-default-bbbbbb' }
}
const onBox = (h: Harness, name: string) => h.boat.byName(name)!.id

async function runOnce(h: Harness, code: number, where: string) {
  await until(() => h.ctl.pending.some((p) => p.id === where), `a run on ${where}`)
  h.ctl.pending.find((p) => p.id === where)!.done(code)
}

test('infra exit on attempt 1 → retried on another box; a pass there charges the first box once', async () => {
  const h = harness()
  const { A, B } = await twoBoxes(h)
  const { sha } = makeOrigin(h.origins, 'me/app')
  const r = await h.submit({ sha, mode: 'one' })
  await h.pass()
  await runOnce(h, 91, onBox(h, A))
  await until(() => shard(h, r.id).attempt === 2 && shard(h, r.id).state === 'running')
  assert.deepEqual(shard(h, r.id).avoid, [A])
  assert.equal(box(h, A).infraFails, 0, 'not charged before the retry shows it')
  await runOnce(h, 0, onBox(h, B))
  await h.settle()
  assert.equal(job(h, r.id).state, 'passed')
  assert.equal(box(h, A).infraFails, 1)
  assert.equal(box(h, B).infraFails, 0)
})

test('the same infra exit on both attempts → failed (the commit), nobody charged', async () => {
  const h = harness()
  const { A, B } = await twoBoxes(h)
  const { sha } = makeOrigin(h.origins, 'me/app')
  const r = await h.submit({ sha, mode: 'one' })
  await h.pass()
  await runOnce(h, 93, onBox(h, A))
  await runOnce(h, 93, onBox(h, B))
  await h.settle()
  assert.equal(job(h, r.id).state, 'failed')
  assert.match(shard(h, r.id).reason!, /the commit/)
  assert.deepEqual([box(h, A).infraFails, box(h, B).infraFails], [0, 0])
})

test('exit 96 (disk) is charged at once and not again when the retry passes; a different infra exit on attempt 2 → error', async () => {
  const h = harness()
  const { A, B } = await twoBoxes(h)
  const o = makeOrigin(h.origins, 'me/app')
  const r = await h.submit({ sha: o.sha, mode: 'one' })
  await h.pass()
  await runOnce(h, 96, onBox(h, A))
  await until(() => box(h, A).infraFails === 1)
  await runOnce(h, 0, onBox(h, B))
  await h.settle()
  assert.equal(job(h, r.id).state, 'passed')
  assert.equal(box(h, A).infraFails, 1)
  h.d.resetResource('boat')
  const r2 = await h.submit({ sha: pushCommit(o.work, 'x', '2'), mode: 'one' })
  await h.pass()
  await runOnce(h, 91, onBox(h, A))
  await runOnce(h, 92, onBox(h, B))
  await h.settle()
  assert.equal(job(h, r2.id).state, 'error')
  assert.match(shard(h, r2.id).reason!, /second infra failure/)
  assert.equal(box(h, A).infraFails, 1, 'attempt 2 got past exit 91: the first box is charged')
})

test('a box charged infraFailLimit times in a row is quarantined: stopped, never picked, until resources reset', async () => {
  const h = harness()
  const { A, B } = await twoBoxes(h)
  const o = makeOrigin(h.origins, 'me/app')
  for (const n of ['1', '2']) {
    await h.submit({ sha: pushCommit(o.work, 'x', n), mode: 'one' })
    await h.pass()
    await runOnce(h, 96, onBox(h, A))
    await runOnce(h, 0, onBox(h, B))
    await h.settle()
    h.d.c.db.updateBox(A, { lastRepo: 'me/app' })
  }
  assert.equal(box(h, A).state, 'quarantined')
  assert.ok(h.boat.calls.includes(`stop ${onBox(h, A)}`))
  await h.submit({ sha: pushCommit(o.work, 'x', '3'), mode: 'one' })
  await h.pass()
  await until(() => h.ctl.pending.length === 1)
  assert.equal(h.ctl.pending[0].id, onBox(h, B))
  h.ctl.finish(0)
  await h.settle()
  assert.deepEqual(h.d.resetResource('boat'), { health: 0, boxes: 1 })
  assert.deepEqual([box(h, A).state, box(h, A).infraFails], ['stopped', 0])
})

test('an unreachable box (exit 255) is charged at once, its slot killed, and the shard retried elsewhere', async () => {
  const h = harness()
  const { A, B } = await twoBoxes(h)
  const { sha } = makeOrigin(h.origins, 'me/app')
  const r = await h.submit({ sha, mode: 'one' })
  await h.pass()
  await runOnce(h, 255, onBox(h, A))
  await runOnce(h, 1, onBox(h, B))
  await h.settle()
  assert.equal(job(h, r.id).state, 'failed')
  assert.equal(box(h, A).infraFails, 1)
})

test('queue timeout → error naming what it waited for; shard timeout → killed, failed (timeout), box freed', async () => {
  const h = harness()
  h.boat.budget.day = 0
  const o = makeOrigin(h.origins, 'me/app')
  const r = await h.submit({ sha: o.sha, mode: 'one' })
  await h.pass()
  h.advance((h.cfg.queueTimeoutSec + 1) * 1000)
  h.d.timers.tick()
  await h.settle()
  assert.equal(job(h, r.id).state, 'error')
  assert.match(shard(h, r.id).reason!, /no resource within 3600s: .*reserve/)

  h.boat.budget.day = 100
  const r2 = await h.submit({ sha: pushCommit(o.work, 'x', '2'), mode: 'one' })
  await h.pass()
  await until(() => h.ctl.pending.length === 1)
  h.advance((h.cfg.shardTimeoutSec + 1) * 1000)
  h.d.timers.tick()
  await h.settle()
  assert.equal(job(h, r2.id).state, 'failed')
  assert.match(shard(h, r2.id).reason!, /timeout/)
  assert.equal(h.d.c.db.boxes()[0].state, 'idle')
})

test('interests: a dropped stream lapses after the grace and the unpinned job is cancelled; a pinned job runs on', async () => {
  const h = harness()
  const o = makeOrigin(h.origins, 'me/app')
  const r = await h.submit({ sha: o.sha, mode: 'one', detach: false })
  assert.ok(r.interest)
  h.d.c.jobs.connect(r.interest)
  await h.pass()
  await until(() => h.ctl.pending.length === 1)
  h.d.c.jobs.disconnect(r.interest)
  h.advance((h.cfg.interestGraceSec - 1) * 1000)
  h.d.c.jobs.sweepInterests()
  assert.equal(job(h, r.id).state, 'running')
  h.d.c.jobs.connect(r.interest) // reconnects within the grace
  h.d.c.jobs.disconnect(r.interest)
  h.advance((h.cfg.interestGraceSec + 1) * 1000)
  h.d.timers.tick()
  await h.settle()
  assert.equal(job(h, r.id).state, 'cancelled')
  assert.equal(shard(h, r.id).state, 'cancelled')

  const r2 = await h.submit({ sha: pushCommit(o.work, 'x', '2'), mode: 'one', detach: true })
  assert.equal(r2.interest, undefined)
  await h.pass()
  h.advance(3600_000)
  h.d.c.jobs.sweepInterests()
  assert.notEqual(job(h, r2.id).state, 'cancelled')
})

test('withdrawing the last interest cancels at once; another interest keeps the job', async () => {
  const h = harness()
  const o = makeOrigin(h.origins, 'me/app')
  const r = await h.submit({ sha: o.sha, mode: 'one', detach: false })
  const j = await h.submit({ sha: o.sha, mode: 'one', detach: false })
  assert.equal(j.joined, true)
  h.d.c.jobs.connect(r.interest)
  h.d.c.jobs.connect(j.interest)
  h.d.c.jobs.withdraw(r.interest)
  assert.notEqual(job(h, r.id).state, 'cancelling')
  h.d.c.jobs.withdraw(j.interest)
  await h.settle()
  assert.equal(job(h, r.id).state, 'cancelled')
})

test('dedupe: a passed key is reused, a queued/running one joined, --force makes a new job', async () => {
  const h = harness()
  const o = makeOrigin(h.origins, 'me/app')
  const r = await h.submit({ sha: o.sha, mode: 'one' })
  assert.equal((await h.submit({ sha: o.sha, mode: 'one' })).joined, true)
  await h.pass()
  await until(() => h.ctl.pending.length === 1)
  h.ctl.finish(0)
  await h.settle()
  const again = await h.submit({ sha: o.sha, mode: 'one' })
  assert.deepEqual([again.id, again.reused], [r.id, true])
  const forced = await h.submit({ sha: o.sha, mode: 'one', force: true })
  assert.notEqual(forced.id, r.id)
  const other = await h.submit({ sha: o.sha, mode: 'cmd', args: ['true'] })
  assert.notEqual(other.id, r.id)
})

test('a cancelling job is never joined: the same key makes a new job', async () => {
  const h = harness()
  h.ctl.ignoreAbort = true
  const o = makeOrigin(h.origins, 'me/app')
  const r = await h.submit({ sha: o.sha, mode: 'one' })
  await h.pass()
  await until(() => h.ctl.pending.length === 1)
  h.d.c.jobs.cancel(idOf(r.id), 'test')
  assert.equal(job(h, r.id).state, 'cancelling')
  const n = await h.submit({ sha: o.sha, mode: 'one' })
  assert.notEqual(n.id, r.id)
  assert.equal(n.joined, undefined)
  h.ctl.finish(143, `CIB_SHA='${o.sha}'`)
  await until(() => job(h, r.id).state === 'cancelled')
})

test('restart: a running shard is re-queued as attempt 2, its busy box killed and freed; a job nobody comes back for is cancelled after the grace', async () => {
  const h = harness()
  const o = makeOrigin(h.origins, 'me/app')
  const pinned = await h.submit({ sha: o.sha, mode: 'one', detach: true })
  const loose = await h.submit({ sha: pushCommit(o.work, 'x', '2'), mode: 'one', detach: false })
  h.d.c.jobs.connect(loose.interest)
  await h.pass()
  await until(() => h.ctl.pending.length === 2)
  // the old process dies; a new daemon starts on the same state
  const ctl = new ShardControl()
  h.boat.onCommand = ctl.handle
  const logs: string[] = []
  const d2 = new Daemon({ ghApi: h.github.run, apiSleep: async () => {}, cfg: h.cfg, boat: h.boat, now: () => h.clock.t, log: (m) => logs.push(m), sys: async () => ({ code: 0, stdout: '', stderr: '' }), gh: async () => ({ code: 0, stdout: '', stderr: '' }), load: () => ({ load1: 0, nproc: 8 }), localLock: async () => null })
  d2.c.scheduler.paused = true
  await d2.recover()
  const s1 = d2.c.db.shard(idOf(pinned.id), 0)!
  assert.deepEqual([s1.state, s1.attempt], ['queued', 2])
  assert.ok(d2.c.db.boxes().every((b) => b.state === 'idle'))
  assert.ok(logs.some((l) => /busy → idle/.test(l)))
  assert.deepEqual([...d2.c.held], [idOf(loose.id)])
  d2.c.scheduler.paused = false
  d2.c.scheduler.wake()
  await d2.c.scheduler.idle()
  await until(() => ctl.pending.length === 1)
  assert.match(ctl.pending[0].cmd, new RegExp(o.sha), 'only the pinned job runs while the other waits for its client')
  h.advance((h.cfg.interestGraceSec + 1) * 1000)
  d2.timers.tick()
  await d2.c.scheduler.idle()
  assert.equal(d2.c.db.job(idOf(loose.id))!.state, 'cancelled')
  ctl.finish(0)
  await until(() => d2.c.db.job(idOf(pinned.id))!.state === 'passed')
})

test('restart during attempt 2 → error (daemon restarted); a waiting-bundle job → error', async () => {
  const h = harness()
  const o = makeOrigin(h.origins, 'me/app')
  const r = await h.submit({ sha: o.sha, mode: 'one' })
  const snap = await h.d.c.jobs.submit({ repo: 'me/app', profile: 'app', mode: 'one', commit: 'e'.repeat(40), tree: 'f'.repeat(40), detach: true })
  assert.equal(snap.needBundle, true)
  await h.pass()
  await until(() => h.ctl.pending.length === 1)
  h.d.c.db.updateShard(idOf(r.id), 0, { attempt: 2 })
  const d2 = new Daemon({ ghApi: h.github.run, apiSleep: async () => {}, cfg: h.cfg, boat: h.boat, now: () => h.clock.t, log: () => {}, sys: async () => ({ code: 0, stdout: '', stderr: '' }), gh: async () => ({ code: 0, stdout: '', stderr: '' }), localLock: async () => null })
  d2.c.scheduler.paused = true
  await d2.recover()
  assert.equal(d2.c.db.job(idOf(r.id))!.state, 'error')
  assert.equal(d2.c.db.job(idOf(snap.id))!.state, 'error')
})

test('drain: nothing new is placed; onDrained fires once the last shard ends', async () => {
  let drained = 0
  const h = harness({ deps: { onDrained: () => void drained++ } })
  const o = makeOrigin(h.origins, 'me/app')
  await h.submit({ sha: o.sha, mode: 'one' })
  await h.pass()
  await until(() => h.ctl.pending.length === 1)
  assert.deepEqual(h.d.drain(), { running: 1 })
  await assert.rejects(h.submit({ sha: pushCommit(o.work, 'x', '2'), mode: 'one' }), /draining/)
  assert.equal(drained, 0)
  h.ctl.finish(0)
  await until(() => drained === 1)
})

test('a failed create puts the shard back on the same attempt and backs creates off for a minute', async () => {
  const h = harness()
  h.boat.failCreate = true
  const { sha } = makeOrigin(h.origins, 'me/app')
  const r = await h.submit({ sha, mode: 'one' })
  await h.settle()
  assert.deepEqual([shard(h, r.id).state, shard(h, r.id).attempt], ['queued', 1])
  assert.equal(h.boat.calls.filter((c) => c.startsWith('create')).length, 1)
  assert.match(job(h, r.id).waitWhy!, /create\(s\) in a row failed/)
  h.boat.failCreate = false
  h.advance(61_000)
  await h.pass()
  await until(() => h.ctl.pending.length === 1)
})

test('a snapshot job is not cancelled for a missing stream while its bundle uploads; the grace starts once it is queued', async () => {
  const h = harness()
  const r = await h.d.c.jobs.submit({ repo: 'me/app', profile: 'app', mode: 'one', commit: 'e'.repeat(40), tree: 'f'.repeat(40) })
  makeOrigin(h.origins, 'me/app')
  assert.ok(r.needBundle && r.interest)
  h.advance((h.cfg.interestGraceSec + 5) * 1000)
  h.d.c.jobs.sweepInterests()
  assert.equal(job(h, r.id).state, 'waiting-bundle')
})

test('a snapshot commit bundled once stays a snapshot: a second submit of it (another mode) needs a bundle again', async () => {
  const h = harness()
  const o = makeOrigin(h.origins, 'me/app')
  const { writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  writeFileSync(join(o.work, 'f.txt'), 'dirty\n')
  const { buildSnapshot, bundleStream } = await import('../../src/core/snapshot.ts')
  const s = await buildSnapshot(o.work, { maxFileMb: 50 })
  const req = { repo: 'me/app', profile: 'app', commit: s.commit, tree: s.tree, headCandidates: s.headCandidates, detach: true }
  const first = await h.d.c.jobs.submit({ ...req, mode: 'one' })
  const b = await bundleStream(o.work, s.commit, first.base ?? null)
  await Promise.all([h.d.c.jobs.receiveBundle(idOf(first.id), b.stream), b.done])
  const second = await h.d.c.jobs.submit({ ...req, mode: 'test-all', wantStatus: true })
  assert.equal(second.needBundle, true)
  assert.equal(second.base, o.sha)
  assert.equal(job(h, second.id).source, 'snapshot')
  assert.deepEqual(second.status, { asked: false, why: 'snapshot' })
  for (const r of [first, second]) h.d.c.jobs.cancel(idOf(r.id), 'test')
  await h.d.idle()
})

test('prune: a job created while mirror refs are being pruned keeps its dir; old jobs and row-less dirs go', async () => {
  const { realGit } = await import('../../src/core/mirror.ts')
  const { existsSync, mkdirSync } = await import('node:fs')
  const { join } = await import('node:path')
  const git = realGit(60)
  let gate: Promise<void> | null = null
  let atGate: (() => void) | null = null
  const h = harness({
    deps: {
      git: async (args, o) => {
        if (gate && args.includes('for-each-ref') && args.includes('refs/cib/')) {
          atGate?.()
          await gate
        }
        return git(args, o)
      },
    },
  })
  const o = makeOrigin(h.origins, 'me/app')
  const old = await h.submit({ sha: o.sha, mode: 'one' })
  h.d.c.jobs.cancel(idOf(old.id), 'test')
  await h.d.idle()
  mkdirSync(join(h.d.c.streams.jobsDir, '999'), { recursive: true })
  h.advance((h.cfg.retentionDays + 1) * 86400_000)
  let release!: () => void
  gate = new Promise((r) => (release = r))
  const reached = new Promise<void>((r) => (atGate = r))
  const pruning = h.d.c.jobs.prune()
  await reached
  // a new job arrives while prune waits on git (inserted directly: a submit would wait for the mirror lock)
  const freshId = h.d.c.db.insertJob({ key: 'k2', repo: 'me/app', profile: 'app', profileHash: 'h', mode: 'one', args: [], commit: o.sha, tree: 't', source: 'pushed', base: null, label: null, state: 'queued', pinned: true, createdAt: h.clock.t, lane: 'full', env: 'noenv', door: 'local', ghRun: null })
  h.d.c.streams.append(freshId, { t: 'state', state: 'queued' })
  const dir = h.d.c.streams.dir(freshId)
  assert.ok(existsSync(dir))
  release()
  const res = await pruning
  assert.equal(res.jobs, 1)
  assert.ok(existsSync(dir), "the new job's dir survives the prune")
  assert.equal(existsSync(h.d.c.streams.dir(idOf(old.id))), false)
  assert.equal(existsSync(join(h.d.c.streams.jobsDir, '999')), false, 'a dir with no row goes')
})

test('a DB moved aside on a schema change takes jobs/ with it: a new job 1 never replays the old job 1; aside files go after retentionDays', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const { existsSync, mkdirSync, readdirSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const h0 = harness()
  const state = h0.cfg.stateDir
  mkdirSync(state, { recursive: true })
  h0.d.c.db.close()
  const { rmSync } = await import('node:fs')
  rmSync(join(state, 'brokerd.db'), { force: true })
  for (const ext of ['-wal', '-shm']) rmSync(join(state, `brokerd.db${ext}`), { force: true })
  const raw = new DatabaseSync(join(state, 'brokerd.db'))
  raw.exec('CREATE TABLE old (x); PRAGMA user_version = 1')
  raw.close()
  mkdirSync(join(state, 'jobs', '1'), { recursive: true })
  writeFileSync(join(state, 'jobs', '1', 'stream.ndjson'), JSON.stringify({ seq: 1, t: 'done', summary: { state: 'passed' } }) + '\n')
  writeFileSync(join(state, 'jobs', '1', 'remote.bundle'), 'stale')
  const h = harness({ root: h0.root })
  const aside = readdirSync(state).filter((f) => f.startsWith('jobs.v1-'))
  assert.equal(aside.length, 1, `jobs/ moved aside: ${readdirSync(state).join(', ')}`)
  const o = makeOrigin(h.origins, 'me/app')
  const r = await h.submit({ sha: o.sha, mode: 'one' })
  assert.equal(idOf(r.id), 1)
  assert.deepEqual(h.d.c.streams.read(1).map((e) => e.t), ['state'], 'only the new job 1 events')
  assert.equal(existsSync(join(h.d.c.streams.dir(1), 'remote.bundle')), false)
  h.d.c.jobs.cancel(1, 'test')
  await h.d.idle()
  await h.d.c.jobs.prune()
  assert.ok(readdirSync(state).some((f) => f.startsWith('jobs.v1-')), 'kept within retentionDays')
  h.advance((h.cfg.retentionDays + 1) * 86400_000)
  await h.d.c.jobs.prune()
  assert.deepEqual(readdirSync(state).filter((f) => /\.v1-/.test(f)), [], 'old DB and jobs dir pruned')
})

test('a shard log that cannot be written (disk full, a dir in its place) never throws out of the output callback; the result stands', async () => {
  const { mkdirSync, rmSync } = await import('node:fs')
  const { join } = await import('node:path')
  const h = harness()
  const o = makeOrigin(h.origins, 'me/app')
  const r = await h.submit({ sha: o.sha, mode: 'one' })
  await h.pass()
  await until(() => h.ctl.pending.length === 1)
  const log = join(h.d.c.streams.dir(idOf(r.id)), 'one.log')
  rmSync(log)
  mkdirSync(log)
  assert.doesNotThrow(() => h.ctl.finish(0, undefined, 'some output\n'))
  await h.settle()
  assert.equal(job(h, r.id).state, 'passed')
  assert.ok(h.logs.some((l) => /one\.log/.test(l) && /EISDIR/.test(l)), h.logs.join('\n'))
})

test('a throwing step in the timer tick is logged, the rest of the tick still runs', async () => {
  const h = harness()
  let woke = 0
  h.d.c.jobs.timeouts = () => {
    throw new Error('ENOSPC: no space left on device')
  }
  const wake = h.d.c.scheduler.wake.bind(h.d.c.scheduler)
  h.d.c.scheduler.wake = () => (woke++, wake())
  assert.doesNotThrow(() => h.d.timers.tick())
  assert.equal(woke, 1)
  assert.ok(h.logs.some((l) => /tick.*ENOSPC/.test(l)))
})

test('crash handlers: an unhandled rejection is logged and the daemon keeps running; an uncaught exception is logged and exits for systemd to restart', async () => {
  const { crashHandlers } = await import('../../src/ci/daemon/main.ts')
  const logs: string[] = []
  const exits: number[] = []
  const hd = crashHandlers((m) => logs.push(m), (c) => exits.push(c))
  hd.unhandledRejection(new Error('a stray rejection'))
  assert.deepEqual(exits, [])
  hd.uncaughtException(new Error('boom'))
  assert.deepEqual(exits, [1])
  assert.ok(logs.some((l) => /unhandled rejection.*a stray rejection/.test(l)))
  assert.ok(logs.some((l) => /uncaught exception.*boom/.test(l)))
})

test('a charge that reaches the limit on a box busy with another shard quarantines it only when that shard releases it', async () => {
  const h = harness()
  const { A, B } = await twoBoxes(h)
  const o = makeOrigin(h.origins, 'me/app')
  const r1 = await h.submit({ sha: o.sha, mode: 'one' })
  await h.pass()
  await runOnce(h, 91, onBox(h, A))
  await until(() => shard(h, r1.id).attempt === 2 && shard(h, r1.id).state === 'running')
  // A is idle again: another job's shard takes it
  const r2 = await h.submit({ sha: pushCommit(o.work, 'x', '2'), mode: 'one' })
  await h.pass()
  await until(() => h.ctl.pending.some((p) => p.id === onBox(h, A)))
  h.d.c.db.updateBox(A, { infraFails: h.cfg.infraFailLimit - 1 })
  await runOnce(h, 0, onBox(h, B))
  await until(() => job(h, r1.id).state === 'passed')
  assert.equal(box(h, A).state, 'busy', 'not quarantined under a running shard')
  assert.ok(!h.boat.calls.includes(`stop ${onBox(h, A)}`))
  assert.equal(shard(h, r2.id).state, 'running')
  await runOnce(h, 0, onBox(h, A))
  await h.settle()
  assert.equal(job(h, r2.id).state, 'passed')
  assert.equal(box(h, A).state, 'quarantined')
  assert.ok(h.boat.calls.includes(`stop ${onBox(h, A)}`))
})

test('recovery gates the scheduler: nothing is placed and no slot is freed until cleanup is done; recovered busy boxes idle with lastUsed = now', async () => {
  const h = harness({ cfg: { pool: { idleStopSec: 60, warmHours: null, deleteAfterDays: 7, ttlSec: 100 } } })
  const o = makeOrigin(h.origins, 'me/app')
  h.boat.addBox('cib-tst-acme-default-aaaaaa', 'ready')
  await h.d.timers.boat()
  const A = 'cib-tst-acme-default-aaaaaa'
  h.d.c.pool!.setState(A, 'busy')
  h.d.c.db.takeSlot({ resource: 'local', slot: 0, jobId: 42, idx: 0, since: h.clock.t })
  h.advance(3600_000)
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  let atGate!: () => void
  const reached = new Promise<void>((r) => (atGate = r))
  const d2 = new Daemon({
    ghApi: h.github.run, apiSleep: async () => {},
    cfg: h.cfg, boat: h.boat, now: () => h.clock.t, log: (m) => h.logs.push(m), gh: async () => ({ code: 0, stdout: '', stderr: '' }), localLock: async () => null,
    sys: async () => {
      atGate()
      await gate
      return { code: 0, stdout: '', stderr: '' }
    },
  })
  const rec = d2.recover()
  await reached
  const r = await d2.c.jobs.submit({ repo: 'me/app', profile: 'app', mode: 'one', commit: o.sha, detach: true })
  d2.c.scheduler.wake()
  await d2.c.scheduler.idle()
  assert.equal(d2.c.db.job(idOf(r.id))!.state, 'queued', 'not placed while recovery runs')
  assert.equal(d2.c.db.slots().length, 1, 'slots are freed only after cleanup')
  release()
  await rec
  const b = d2.c.db.box(A)!
  assert.equal(b.state === 'busy' || b.state === 'idle', true, `box ${b.state}`)
  assert.equal(d2.c.db.slots().filter((s) => s.jobId === 42).length, 0)
  await until(() => h.ctl.pending.length === 1, 'the job placed after recovery')
  assert.ok(!h.boat.calls.some((c) => c.startsWith('stop')), 'the recovered box was not idle-stopped')
  d2.c.jobs.cancel(idOf(r.id), 'test')
  await d2.idle()
})

test('creates that keep failing: the backoff doubles per environment (capped), and the shard still hits queueTimeoutSec from when it was queued', async () => {
  const h = harness({ cfg: { queueTimeoutSec: 600 } })
  h.boat.failCreate = true
  const { sha } = makeOrigin(h.origins, 'me/app')
  const r = await h.submit({ sha, mode: 'one' })
  const creates = () => h.boat.calls.filter((c) => c.startsWith('create')).length
  await h.settle()
  assert.equal(creates(), 1)
  h.advance(61_000)
  await h.settle()
  assert.equal(creates(), 2, 'retried after 60 s')
  h.advance(61_000)
  await h.settle()
  assert.equal(creates(), 2, 'the second failure backs off 120 s')
  h.advance(60_000)
  await h.settle()
  assert.equal(creates(), 3)
  assert.equal(shard(h, r.id).queuedAt, job(h, r.id).createdAt, 'a resource that never started does not restart the queue clock')
  h.advance(600_000)
  h.d.timers.tick()
  await h.settle()
  assert.equal(shard(h, r.id).state, 'error')
  assert.match(shard(h, r.id).reason!, /no resource within 600s/)
})

test('a Boat exec that ends with no exit status is an infra failure: retried once on another box, not a test failure', async () => {
  const h = harness()
  const { A, B } = await twoBoxes(h)
  const o = makeOrigin(h.origins, 'me/app')
  const r = await h.submit({ sha: o.sha, mode: 'one' })
  await h.pass()
  await until(() => h.ctl.pending.some((p) => p.id === onBox(h, A)))
  h.ctl.pending.find((p) => p.id === onBox(h, A))!.done(null as unknown as number)
  await until(() => shard(h, r.id).attempt === 2 && shard(h, r.id).state === 'running')
  assert.deepEqual(shard(h, r.id).avoid, [A])
  await runOnce(h, 0, onBox(h, B))
  await h.settle()
  assert.equal(job(h, r.id).state, 'passed')
})

test('a --github submit of a sha origin does not have is refused (400), never turned into a snapshot', async () => {
  const h = harness()
  const o = makeOrigin(h.origins, 'me/app')
  const { writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  writeFileSync(join(o.work, 'f.txt'), 'local only\n')
  const { buildSnapshot } = await import('../../src/core/snapshot.ts')
  const s = await buildSnapshot(o.work, { maxFileMb: 50 })
  await assert.rejects(
    h.d.c.jobs.submit({ repo: 'me/app', profile: 'app', mode: 'one', commit: s.commit, tree: s.tree, headCandidates: s.headCandidates, source: 'github', detach: true }),
    (e: any) => e.status === 400 && /not on origin/.test(e.message) && /--github/.test(e.message),
  )
  assert.equal(h.d.c.db.recentJobs({ limit: 10 }).length, 0)
  const ok = await h.d.c.jobs.submit({ repo: 'me/app', profile: 'app', mode: 'one', commit: o.sha, tree: null, source: 'github', detach: true })
  assert.equal(job(h, ok.id).source, 'pushed')
  h.d.c.jobs.cancel(idOf(ok.id), 'test')
  await h.d.idle()
})

test('tool stderr tails in shard reasons, job errors, job events, stream messages and log lines are scrubbed', async () => {
  const h = harness()
  const { A } = await twoBoxes(h)
  const secret = 'hunter2-very-secret'
  const token = 'ghp_' + 'Z'.repeat(36)
  h.d.c.secrets.add(secret)
  h.boat.scp = async () => {
    throw new Error(`scp: permission denied (${secret}) ${token}`)
  }
  const o = makeOrigin(h.origins, 'me/app')
  const r = await h.submit({ sha: o.sha, mode: 'one' })
  await h.pass()
  await until(() => shard(h, r.id).attempt === 2)
  h.d.c.jobs.fail(idOf(r.id), `git said: ${token}`)
  await h.settle()
  const id = idOf(r.id)
  const texts = [
    ...h.d.c.db.events(id).map((e) => e.message),
    ...h.d.c.db.shards(id).map((s) => s.reason ?? ''),
    job(h, r.id).error ?? '',
    JSON.stringify(h.d.c.streams.read(id)),
    JSON.stringify(h.d.c.db.box(A)),
    ...h.logs,
  ]
  assert.ok(texts.some((t) => t.includes('permission denied')), 'the reason is there')
  for (const t of texts) assert.ok(!t.includes(secret) && !t.includes(token), `unscrubbed: ${t}`)
})

test('a submit of a mode that needs args with none is a 400 with the usage (no vacuous pass, no ci-broker/<mode> status)', async () => {
  const h = harness()
  const o = makeOrigin(h.origins, 'me/app')
  await assert.rejects(h.submit({ sha: o.sha, mode: 'cmd', wantStatus: true }), (e: any) => e.status === 400 && /mode cmd needs args/.test(e.message))
  assert.equal(h.d.c.db.recentJobs({ limit: 10 }).length, 0)
})
