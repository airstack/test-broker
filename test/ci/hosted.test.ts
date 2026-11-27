// The github resource (GitHub-hosted CI via workflow_dispatch) against an in-process fake gh.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ResourceCfg } from '../../src/ci/config.ts'
import { Daemon } from '../../src/ci/daemon/daemon.ts'
import { conclusionCode, runToken, tokenOf } from '../../src/ci/daemon/exec-github.ts'
import { FakeGh } from '../fake-gh.ts'
import { makeFakeSsh } from '../fake-ssh.ts'
import { harness, idOf, makeOrigin, tmp, until, type Harness } from '../harness.ts'

const job = (h: Harness, id: string) => h.d.c.db.job(idOf(id))!
const shards = (h: Harness, id: string) => h.d.c.db.shards(idOf(id))
const gh = (o: Partial<ResourceCfg> = {}): ResourceCfg => ({ id: 'gh', kind: 'github', profiles: ['*'], workflow: 'ci-broker-hosted.yml', modes: ['test-all'], afterWaitSec: 900, ...o })
const tick = () => new Promise<void>((r) => setImmediate(r))

function ghHarness(resources: ResourceCfg[], extra: { cfg?: Record<string, unknown> } = {}): { h: Harness; fake: FakeGh } {
  const fake = new FakeGh()
  const h = harness({ resources, cfg: { githubPollSec: 0, ...extra.cfg }, deps: { gh: fake.handle, githubWait: tick } })
  return { h, fake }
}

test('run-name tokens: attempt 1 is the job name, later attempts get a suffix; matching is exact (ub1-4 is not ub1-41)', () => {
  assert.equal(runToken('ub1-41', 1), 'ub1-41')
  assert.equal(runToken('ub1-41', 2), 'ub1-41.2')
  assert.equal(tokenOf('ci-broker ub1-41 test-all abc'), 'ub1-41')
  assert.notEqual(tokenOf('ci-broker ub1-41 test-all abc'), 'ub1-4')
  assert.equal(tokenOf('something else'), null)
  assert.deepEqual(['success', 'failure', 'cancelled', 'timed_out'].map(conclusionCode), [0, 1, null, null])
})

test('a pushed job of a listed mode waits afterWaitSec, then one dispatch takes all its shards; log + artifacts come back', async () => {
  const { h, fake } = ghHarness([gh()])
  const { sha } = makeOrigin(h.origins, 'me/app')
  const r = await h.submit({ sha })
  await h.pass()
  assert.equal(fake.dispatches().length, 0)
  assert.match(job(h, r.id).waitWhy!, /gh: after 900s of waiting/)
  h.advance(901_000)
  await h.pass()
  await until(() => fake.runs.length === 1 && h.d.c.db.ghRunsInFlight()[0]?.state === 'running', 'the dispatched run found')
  const d = fake.dispatches()[0]
  assert.deepEqual(d.slice(0, 7), ['workflow', 'run', 'ci-broker-hosted.yml', '--repo', 'me/app', '--ref', 'main'])
  assert.ok(d.includes(`sha=${sha}`) && d.includes('mode=test-all') && d.includes('args=[]') && d.includes('job=tst-1'))
  assert.deepEqual(shards(h, r.id).map((s) => [s.name, s.state, s.where]), [['hosted', 'running', 'github:gh']])
  assert.equal(job(h, r.id).placement, 'github')
  const st = h.d.status()
  assert.equal(st.githubRuns.length, 1)
  assert.equal(st.githubRuns[0].runId, fake.runs[0].databaseId)
  fake.complete(fake.runs[0].databaseId, 'success')
  await until(() => job(h, r.id).state === 'passed', 'the job')
  await h.d.idle()
  const dir = h.d.c.streams.dir(idOf(r.id))
  assert.match(readFileSync(join(dir, 'hosted.log'), 'utf8'), /line one of run 9001/)
  assert.equal(readFileSync(join(dir, 'artifacts', 'hosted', 'ci-artifacts', 'report.txt'), 'utf8'), 'hosted report\n')
  assert.deepEqual(h.d.c.db.ghRunsInFlight(), [])
})

test('a failed run fails the job; args go as JSON', async () => {
  const { h, fake } = ghHarness([gh({ afterWaitSec: 0, modes: ['cmd'] })])
  const { sha } = makeOrigin(h.origins, 'me/app')
  const r = await h.submit({ sha, mode: 'cmd', args: ['echo', 'a b'] })
  await h.pass()
  await until(() => h.d.c.db.ghRunsInFlight()[0]?.state === 'running')
  assert.ok(fake.dispatches()[0].includes('args=["echo","a b"]'))
  fake.complete(fake.runs[0].databaseId, 'failure')
  await until(() => job(h, r.id).state === 'failed')
  assert.equal(shards(h, r.id)[0].code, 1)
})

test('excluded from github: an unlisted mode, a snapshot job, and a job one of whose shards has started', async () => {
  const root = tmp('cib-gh-')
  const f = makeFakeSsh(join(root, 'fake'))
  const fake = new FakeGh()
  const h = harness({ root, resources: [{ id: 'vps1', kind: 'ssh', profiles: ['*'], host: 'vps1', slots: 1 }, gh({ afterWaitSec: 10, modes: ['test-all'] })], cfg: { sshBin: f.ssh, scpBin: f.scp, githubPollSec: 0 }, deps: { gh: fake.handle, githubWait: tick } })
  writeFileSync(join(h.cfg.profilesDir, 'app', 'remote.sh'), 'sleep 300 & wait\n')
  const o = makeOrigin(h.origins, 'me/app')
  // a started shard: one test-all shard runs on the ssh slot, the other two wait
  const started = await h.submit({ sha: o.sha })
  await h.pass()
  assert.equal(shards(h, started.id).filter((s) => s.state === 'running').length, 1)
  // an unlisted mode (one), with the slot busy
  const unlisted = await h.submit({ sha: o.sha, mode: 'e2e' })
  // a snapshot job of a listed mode
  writeFileSync(join(o.work, 'f.txt'), 'dirty\n')
  const { buildSnapshot, bundleStream } = await import('../../src/core/snapshot.ts')
  const s = await buildSnapshot(o.work, { maxFileMb: 50 })
  const snap = await h.d.c.jobs.submit({ repo: 'me/app', profile: 'app', mode: 'test-all', commit: s.commit, tree: s.tree, headCandidates: s.headCandidates, detach: true })
  const b = await bundleStream(o.work, s.commit, snap.base ?? null)
  await Promise.all([h.d.c.jobs.receiveBundle(idOf(snap.id), b.stream), b.done])
  h.advance(3600_000 - 1000)
  await h.pass()
  assert.equal(fake.dispatches().length, 0)
  assert.equal(job(h, started.id).placement, 'sharded')
  assert.match(job(h, unlisted.id).waitWhy!, /gh: mode e2e not listed/)
  assert.match(job(h, snap.id).waitWhy!, /gh: pushed jobs only/)
  for (const id of [started.id, unlisted.id, snap.id]) h.d.c.jobs.cancel(idOf(id), 'test')
  await h.d.idle()
})

test('cancel cancels the GitHub run; restart recovery cancels runs still in flight', async () => {
  const { h, fake } = ghHarness([gh({ afterWaitSec: 0 })])
  const o = makeOrigin(h.origins, 'me/app')
  const r = await h.submit({ sha: o.sha })
  await h.pass()
  await until(() => h.d.c.db.ghRunsInFlight()[0]?.state === 'running')
  h.d.c.jobs.cancel(idOf(r.id), 'test')
  await until(() => job(h, r.id).state === 'cancelled')
  await h.d.idle()
  assert.ok(fake.calls.some((c) => c[0] === 'run' && c[1] === 'cancel' && c[2] === String(fake.runs[0].databaseId)))
  assert.equal(fake.runs[0].conclusion, 'cancelled')
  assert.equal(h.d.c.db.ghRun('tst-1')!.state, 'cancelled')
  // a run left in flight by a daemon that died
  h.d.c.db.insertGhRun({ token: 'tst-77', resource: 'gh', repo: 'me/app', workflow: 'ci-broker-hosted.yml', jobId: 77, idx: 0, attempt: 1, dispatchedAt: h.clock.t })
  await fake.handle(['workflow', 'run', 'ci-broker-hosted.yml', '--repo', 'me/app', '--ref', 'main', '-f', 'job=tst-77', '-f', 'mode=test-all', '-f', `sha=${o.sha}`])
  const left = fake.runs.at(-1)!
  const d2 = new Daemon({ ghApi: h.github.run, apiSleep: async () => {}, cfg: h.cfg, boat: h.boat, now: () => h.clock.t, log: (m) => h.logs.push(m), gh: fake.handle, sys: async () => ({ code: 0, stdout: '', stderr: '' }) })
  await d2.recover()
  assert.equal(left.conclusion, 'cancelled')
  assert.equal(h.d.c.db.ghRun('tst-77')!.state, 'cancelled')
  assert.ok(h.logs.some((l) => /recovery: github run tst-77 \(\d+\): cancelled/.test(l)))
})

test('a failed dispatch is an infra failure charged to the github resource; the retry dispatches again with a new token', async () => {
  const { h, fake } = ghHarness([gh({ afterWaitSec: 0 })])
  fake.failDispatch = 'HTTP 422: Workflow does not have workflow_dispatch trigger'
  const o = makeOrigin(h.origins, 'me/app')
  const r = await h.submit({ sha: o.sha })
  await h.pass()
  await until(() => shards(h, r.id)[0]?.attempt === 2 && fake.dispatches().length === 2, 'the retry')
  fake.failDispatch = null
  await until(() => job(h, r.id).state !== 'running' && job(h, r.id).state !== 'queued')
  // second failure: an error, and the resource now has 2 charged failures → failing
  assert.equal(job(h, r.id).state, 'error')
  assert.equal(h.d.c.db.health('gh', 'app').failing, true)
})

test('the retry of a lost run uses the attempt token, so the old run is never mistaken for it', async () => {
  const { h, fake } = ghHarness([gh({ afterWaitSec: 0 })])
  const o = makeOrigin(h.origins, 'me/app')
  const r = await h.submit({ sha: o.sha })
  await h.pass()
  await until(() => h.d.c.db.ghRunsInFlight()[0]?.state === 'running')
  fake.complete(fake.runs[0].databaseId, 'startup_failure')
  await until(() => fake.dispatches().length === 2, 'the retry dispatch')
  assert.ok(fake.dispatches()[1].includes('job=tst-1.2'))
  await until(() => h.d.c.db.ghRunsInFlight()[0]?.state === 'running' && h.d.c.db.ghRunsInFlight()[0]?.token === 'tst-1.2')
  fake.complete(fake.runs[1].databaseId, 'success')
  await until(() => job(h, r.id).state === 'passed')
  await h.d.idle()
})

test('a github re-dispatch re-reads the job first: a job cancelled (or a shard taken) since the pass read it is never dispatched', async () => {
  const { h, fake } = ghHarness([gh({ afterWaitSec: 0 })])
  const o = makeOrigin(h.origins, 'me/app')
  const r = await h.submit({ sha: o.sha })
  const id = idOf(r.id)
  h.d.c.scheduler.paused = true
  // the state a re-queued github shard is in (infra retry), as a pass read it
  h.d.c.db.deleteShards(id)
  h.d.c.db.insertShard({ jobId: id, idx: 0, name: 'hosted', size: '-', args: [], state: 'queued', queuedAt: h.clock.t })
  h.d.c.db.updateJob(id, { placement: 'github', state: 'running' })
  const staleJob = h.d.c.db.job(id)!
  const staleShard = h.d.c.db.shard(id, 0)!
  h.d.c.jobs.cancel(id, 'test')
  const t = await (h.d.c.scheduler as any).tryShard(staleJob, staleShard)
  assert.equal(t.placed, false)
  assert.equal(fake.dispatches().length, 0, 'no paid dispatch for a cancelled job')
  await h.d.idle()
})
