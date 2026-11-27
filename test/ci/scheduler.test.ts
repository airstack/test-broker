import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { harness, idOf, makeOrigin, pushCommit, TEST_PROFILE, until, type Harness } from '../harness.ts'

const shards = (h: Harness, id: string) => h.d.c.db.shards(idOf(id))
const job = (h: Harness, id: string) => h.d.c.db.job(idOf(id))!
const events = (h: Harness, id: string) => h.d.c.db.events(idOf(id)).map((e) => `${e.shard ?? '-'} ${e.kind}: ${e.message}`)

async function adopt(h: Harness, names: { name: string; state?: string; size?: string }[]) {
  for (const b of names) h.boat.addBox(b.name, b.state ?? 'ready', b.size ?? 'default')
  await h.d.timers.boat()
}

test('a pushed job with no boxes: one box created per shard, all run, the job passes with a receipt', async () => {
  const h = harness()
  const { sha } = makeOrigin(h.origins, 'me/app')
  const r = await h.submit({ sha })
  assert.equal(r.needBundle, undefined)
  await h.pass()
  await until(() => h.ctl.pending.length === 3, '3 shard runs')
  assert.equal(h.boat.calls.filter((c) => c.startsWith('create ')).length, 3)
  assert.equal(h.boat.startsUsed, 3)
  assert.deepEqual(h.d.c.db.boxes().map((b) => b.state), ['busy', 'busy', 'busy'])
  for (const n of ['a', 'b', 'c']) h.ctl.finish(0, `'${n}'`, `ok ${n}\n`)
  await h.d.idle()
  const j = job(h, r.id)
  assert.equal(j.state, 'passed')
  assert.match(j.summary!.text, /RESULT: PASS/)
  assert.deepEqual(h.d.c.db.boxes().map((b) => [b.state, b.lastRepo]), [['idle', 'me/app'], ['idle', 'me/app'], ['idle', 'me/app']])
  assert.ok(events(h, r.id).some((e) => /a place: boat:cib-tst-acme-default-\w{6} \(created\)/.test(e)))
  const done = h.d.c.streams.read(idOf(r.id)).at(-1)!
  assert.equal(done.t, 'done')
})

test('an idle box is reused, preferring the one that last ran this repo; no start is spent', async () => {
  const h = harness()
  const { sha } = makeOrigin(h.origins, 'me/app')
  await adopt(h, [{ name: 'cib-tst-acme-default-aaaaaa' }, { name: 'cib-tst-acme-default-bbbbbb' }])
  h.d.c.db.updateBox('cib-tst-acme-default-bbbbbb', { lastRepo: 'me/app' })
  await h.submit({ sha, mode: 'one' })
  await h.pass()
  await until(() => h.ctl.pending.length === 1)
  assert.equal(h.d.c.db.box('cib-tst-acme-default-bbbbbb')!.state, 'busy')
  assert.equal(h.boat.startsUsed, 0)
  assert.ok(h.boat.calls.some((c) => c.startsWith('extend ')))
})

test('pending starts count against the reserve: with 2 starts above it, only 2 of 3 shards start while creates are in flight', async () => {
  const h = harness()
  h.boat.budget.day = h.cfg.startsReserve + 2
  let release!: () => void
  h.boat.gate.create = new Promise((r) => (release = r))
  const { sha } = makeOrigin(h.origins, 'me/app')
  const r = await h.submit({ sha })
  await h.pass()
  assert.deepEqual(h.d.c.db.boxes().map((b) => b.state), ['creating', 'creating'])
  assert.match(job(h, r.id).waitWhy!, /reserve/)
  release()
  await until(() => h.ctl.pending.length === 2)
  assert.equal(h.boat.startsUsed, 2)
  assert.equal(shards(h, r.id).filter((s) => s.state === 'queued').length, 1)
})

test('a failed `boat limits` read means no start', async () => {
  const h = harness()
  h.boat.failStarts = 10
  const { sha } = makeOrigin(h.origins, 'me/app')
  const r = await h.submit({ sha, mode: 'one' })
  await h.pass()
  assert.equal(h.boat.calls.filter((c) => c.startsWith('create')).length, 0)
  assert.match(job(h, r.id).waitWhy!, /cannot read Boat limits/)
})

test('a stopped box of the size is resumed before creating; the per-minute limit counts pending starts too', async () => {
  const h = harness()
  await adopt(h, [{ name: 'cib-tst-acme-default-aaaaaa', state: 'stopped' }])
  h.boat.budget.minute = 1
  const { sha } = makeOrigin(h.origins, 'me/app')
  const r = await h.submit({ sha })
  await h.pass()
  await until(() => h.ctl.pending.length === 1)
  assert.ok(h.boat.calls.some((c) => c.startsWith('resume ')))
  assert.equal(h.boat.calls.filter((c) => c.startsWith('create')).length, 0)
  assert.match(job(h, r.id).waitWhy!, /rate limit/)
})

test('at maxBoxes the least-recently-used stopped box of another size is deleted to make room; none → wait', async () => {
  const h = harness({ resources: [{ id: 'boat', kind: 'boat', profiles: ['*'], maxBoxes: 2 }] })
  await adopt(h, [
    { name: 'cib-tst-acme-default-aaaaaa', state: 'stopped' },
    { name: 'cib-tst-acme-default-bbbbbb', state: 'stopped' },
  ])
  h.d.c.db.updateBox('cib-tst-acme-default-aaaaaa', { lastUsed: 1 })
  const { sha, work } = makeOrigin(h.origins, 'me/app')
  await h.submit({ sha, mode: 'e2e' })
  await h.pass()
  await until(() => h.ctl.pending.length === 1)
  await until(() => h.boat.calls.some((c) => c.startsWith('delete ')))
  const names = h.d.c.db.boxes().map((b) => b.name)
  assert.ok(!names.includes('cib-tst-acme-default-aaaaaa'))
  assert.ok(names.includes('cib-tst-acme-default-bbbbbb'))
  assert.ok(names.some((n) => n.includes('-large-')))
  // now: one stopped default (b) + one busy large; a second large shard deletes b; a third has nothing to delete
  const sha2 = pushCommit(work, 'x.txt', '2')
  await h.submit({ sha: sha2, mode: 'e2e' })
  await h.pass()
  await until(() => h.ctl.pending.length === 2)
  const sha3 = pushCommit(work, 'x.txt', '3')
  const r3 = await h.submit({ sha: sha3, mode: 'e2e' })
  await h.pass()
  assert.match(job(h, r3.id).waitWhy!, /maxBoxes/)
})

test('fair turns: repos take turns (one placement per repo per round), so job A does not take every box', async () => {
  const h = harness()
  h.boat.budget.day = 0 // no starts: only the two idle boxes
  await adopt(h, [{ name: 'cib-tst-acme-default-aaaaaa' }, { name: 'cib-tst-acme-default-bbbbbb' }])
  const a = makeOrigin(h.origins, 'me/a', { 'a.txt': 'a\n' })
  const b = makeOrigin(h.origins, 'me/b', { 'b.txt': 'b\n' }) // (the job key has no repo: same tree = same key)
  for (const n of ['a', 'b']) {
    mkdirSync(join(h.root, 'profiles', n), { recursive: true })
    writeFileSync(join(h.root, 'profiles', n, 'profile.json'), JSON.stringify({ ...TEST_PROFILE, name: n, repo: `me/${n}` }))
    writeFileSync(join(h.root, 'profiles', n, 'remote.sh'), 'true\n')
  }
  h.d.c.scheduler.paused = true
  await h.submit({ repo: 'me/a', profile: 'a', sha: a.sha })
  await h.submit({ repo: 'me/b', profile: 'b', sha: b.sha })
  h.d.c.scheduler.paused = false
  await h.pass()
  await until(() => h.ctl.pending.length === 2)
  assert.deepEqual(h.ctl.pending.map((p) => /CIB_REPO='([^']+)'/.exec(p.cmd)![1]).sort(), ['me/a', 'me/b'])
})

test('fair turns within a repo: its jobs alternate', async () => {
  const h = harness()
  h.boat.budget.day = 0
  await adopt(h, [{ name: 'cib-tst-acme-default-aaaaaa' }, { name: 'cib-tst-acme-default-bbbbbb' }])
  const o = makeOrigin(h.origins, 'me/app')
  const sha2 = pushCommit(o.work, 'x.txt', '2')
  h.d.c.scheduler.paused = true
  await h.submit({ sha: o.sha })
  await h.submit({ sha: sha2 })
  h.d.c.scheduler.paused = false
  await h.pass()
  await until(() => h.ctl.pending.length === 2)
  assert.deepEqual(h.ctl.pending.map((p) => /CIB_SHA='([^']+)'/.exec(p.cmd)![1]).sort(), [o.sha, sha2].sort())
})

test('local whole when the slot is free and load is low; busy slot or high load → sharded to Boat', async () => {
  const resources = [
    { id: 'local', kind: 'local' as const, profiles: ['*'] },
    { id: 'boat', kind: 'boat' as const, profiles: ['*'], maxBoxes: 4 },
  ]
  const h = harness({ resources })
  const o = makeOrigin(h.origins, 'me/app')
  const r = await h.submit({ sha: o.sha })
  await h.pass()
  await until(() => h.local.runs.length === 1)
  assert.deepEqual(shards(h, r.id).map((s) => [s.name, s.state, s.where]), [['local', 'running', 'local-host']])
  assert.equal(job(h, r.id).placement, 'local')
  assert.match(h.local.runs[0].cmd, /echo local-test-all/)
  assert.equal(h.local.runs[0].labels?.['ci-broker.daemon'], 'tst')
  // the slot is taken: the next job goes to Boat
  const sha2 = pushCommit(o.work, 'x.txt', '2')
  const r2 = await h.submit({ sha: sha2 })
  await h.pass()
  await until(() => h.ctl.pending.length === 3)
  assert.equal(job(h, r2.id).placement, 'sharded')
  h.local.runs[0].finish(0)
  await until(() => job(h, r.id).state === 'passed')
  assert.equal(h.local.busy, false)
  assert.deepEqual(h.d.c.db.slots(), [])
  // high load: Boat even with the slot free
  h.local.load = 7
  const sha3 = pushCommit(o.work, 'x.txt', '3')
  const r3 = await h.submit({ sha: sha3, mode: 'cmd', args: ['true'] })
  await h.pass()
  await until(() => h.ctl.pending.length === 4)
  assert.equal(job(h, r3.id).placement, 'sharded')
})

test('a mode with no local command never runs locally', async () => {
  const h = harness({ resources: [{ id: 'local', kind: 'local', profiles: ['*'] }] })
  const o = makeOrigin(h.origins, 'me/app')
  const r = await h.submit({ sha: o.sha, mode: 'e2e' })
  await h.pass()
  assert.equal(h.local.runs.length, 0)
  assert.match(job(h, r.id).waitWhy!, /no local command for e2e/)
})

test('a snapshot job: waits for its bundle, then runs on a box with the real wrapper; output, log and artifacts come back', async () => {
  const h = harness()
  h.boat.onCommand = undefined // real bash on the fake box: cib-wrap.sh + the profile's remote.sh
  const o = makeOrigin(h.origins, 'me/app')
  const { execFileSync } = await import('node:child_process')
  const { writeFileSync, readFileSync, existsSync, createReadStream } = await import('node:fs')
  writeFileSync(join(o.work, 'f.txt'), 'dirty\n')
  const { buildSnapshot, bundleStream } = await import('../../src/core/snapshot.ts')
  const s = await buildSnapshot(o.work, { maxFileMb: 50 })
  const r = await h.d.c.jobs.submit({ repo: 'me/app', profile: 'app', mode: 'one', commit: s.commit, tree: s.tree, headCandidates: s.headCandidates, detach: true })
  assert.equal(r.needBundle, true)
  assert.equal(r.base, o.sha)
  assert.equal(job(h, r.id).state, 'waiting-bundle')
  const b = await bundleStream(o.work, s.commit, r.base)
  await Promise.all([h.d.c.jobs.receiveBundle(idOf(r.id), b.stream), b.done])
  await h.settle()
  const j = job(h, r.id)
  assert.equal(j.state, 'passed', JSON.stringify(shards(h, r.id)))
  const dir = h.d.c.streams.dir(j.id)
  assert.match(readFileSync(join(dir, 'one.log'), 'utf8'), new RegExp(`remote ${s.commit} one`))
  assert.ok(existsSync(join(dir, 'artifacts', 'one', 'out', 'a.txt')), 'artifacts downloaded')
  const box = h.boat.boxes[0]
  assert.ok(existsSync(join(box.home, 'cib', '0', 'snapshot.bundle')))
  assert.equal(existsSync(join(box.home, 'cib', '0', 'run.pid')), false)
  void execFileSync
  void createReadStream
})
