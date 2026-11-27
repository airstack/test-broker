// The watchdog: blocks when a served repo stops qualifying, the operator's runnerctl command (never a call), API
// errors never block, unblock rules, a tick and an unblock serialized, the door re-check, the network probe.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { banner } from '../../src/ci/daemon/local-door.ts'
import { probeScript, probeVerdict } from '../../src/ci/daemon/watchdog.ts'
import { harness, idOf, makeOrigin, TEST_PROFILE, tmp, until, type Harness } from '../harness.ts'

type DockerMode = 'ok' | 'reached' | 'dns' | 'nonet'
/** FakeDocker: `docker network inspect` and the probe container; every call logged. */
function fakeSys(mode: { v: DockerMode }, calls: string[][]) {
  return async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args])
    if (cmd !== 'docker') return { code: 0, stdout: '', stderr: '' }
    if (args[0] === 'network' && args[1] === 'inspect') {
      if (mode.v === 'nonet') return { code: 1, stdout: '', stderr: 'Error: No such network' }
      return { code: 0, stdout: args.includes('bridge') ? '172.17.0.1 172.30.0.1 \n' : 'cib-pub0\n', stderr: '' }
    }
    if (args[0] === 'run') {
      const out = mode.v === 'reached' ? 'blocked 172.17.0.1:22\nreached 10.0.0.1:22 (refused)\ndns ok\ngithub ok\n' : mode.v === 'dns' ? 'blocked 172.17.0.1:22\ndns fail\ngithub fail\n' : 'blocked 172.17.0.1:22\nblocked 10.0.0.1:22\ndns ok\ngithub ok\n'
      return { code: 0, stdout: out, stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
}

function setup(o: { split?: boolean; runners?: boolean; root?: string; local?: boolean } = {}) {
  const runners = join(tmp(), 'runners.json')
  writeFileSync(runners, JSON.stringify(o.runners === false ? [] : [{ id: 'me__app-1', repo: 'me/app', name: 'host-app-r1' }, { id: 'me__app-2', repo: 'me/app', name: 'host-app-r2' }]))
  const mode = { v: 'ok' as DockerMode }
  const calls: string[][] = []
  const h = harness({
    root: o.root,
    profile: { ...TEST_PROFILE, local: { where: 'container', image: 'i', commands: { one: 'echo one' } } },
    resources: o.local ? [{ id: 'local', kind: 'local', profiles: ['*'] }, { id: 'boat', kind: 'boat', profiles: ['*'], maxBoxes: 4 }] : undefined,
    cfg: { runnersJson: runners, ...(o.split ? { layout: 'split' as const, operatorUid: process.getuid!() } : {}) },
    deps: { sys: fakeSys(mode, calls) },
  })
  return { h, mode, calls }
}

test('a repo that turns public mid-run: its full-lane job fails, a block row with the reason, the banner gives the operator runnerctl stop (the daemon calls nothing)', async () => {
  const { h, calls } = setup()
  const o = makeOrigin(h.origins, 'me/app')
  const r = await h.submit({ sha: o.sha, mode: 'one' })
  await h.pass()
  await until(() => h.ctl.pending.length === 1, 'a Boat shard running')
  h.github.setRepo('me/app', { private: false })
  await h.d.watchdog.tick()
  const b = h.d.c.tdb.block('me/app')!
  assert.match(b.reason, /^tier private → public at \d\d:\d\d \(public\)$/)
  await until(() => ['error', 'failed', 'cancelled'].includes(h.d.c.db.job(idOf(r.id))!.state), 'the job ended')
  assert.equal(h.d.c.db.job(idOf(r.id))!.state, 'error')
  assert.match(h.d.c.db.job(idOf(r.id))!.error!, /trust: me\/app is now public \(public\); stopped/)
  const ban = banner(h.d)
  assert.match(ban[0], /^me\/app BLOCKED since \d\d:\d\d: tier private → public .*Stop its 2 runner\(s\): sudo -n ci-broker-runnerctl stop me\/app$/)
  assert.ok(h.logs.some((l) => /^TRUST blocked repo=me\/app: .*sudo -n ci-broker-runnerctl stop me\/app/.test(l)))
  assert.ok(!calls.some((c) => c.some((x) => /runnerctl|sudo/.test(x))), 'no runnerctl call')
  // the doors refuse it now
  await assert.rejects(h.d.c.trust.admitLocal({ repo: 'me/app', mode: 'one' }), /trust\/blocked/)
})

test('a public repo with only public-lane jobs (no runners) is left alone', async () => {
  const { h } = setup({ runners: false, local: true })
  h.github.setRepo('me/app', { private: false })
  const o = makeOrigin(h.origins, 'me/app')
  h.local.busy = true
  const r = await h.d.c.jobs.submit({ repo: 'me/app', profile: 'app', mode: 'one', commit: o.sha, detach: true, lane: 'public', env: 'noenv' })
  await h.d.watchdog.tick()
  assert.equal(h.d.c.tdb.block('me/app'), null)
  assert.equal(h.d.c.db.job(idOf(r.id))!.state, 'queued')
  assert.equal(h.d.c.tdb.tier('me/app')!.tier, 'public', 'the tier cache is refreshed')
})

test('GitHub down: no block, a watch error, in the banner after two ticks', async () => {
  const { h } = setup()
  const o = makeOrigin(h.origins, 'me/app')
  await h.submit({ sha: o.sha, mode: 'one' })
  h.github.offline = true
  await h.d.watchdog.tick()
  assert.equal(h.d.c.tdb.block('me/app'), null)
  assert.equal(h.d.c.tdb.watchErrors().length, 1)
  assert.ok(!banner(h.d).some((l) => /watchdog can't check/.test(l)))
  h.advance(2 * 300_000)
  await h.d.watchdog.tick()
  assert.ok(banner(h.d).some((l) => /^watchdog can't check me\/app since \d\d:\d\d: .*unreachable/.test(l)))
  h.github.offline = false
  await h.d.watchdog.tick()
  assert.deepEqual(h.d.c.tdb.watchErrors(), [])
})

test('unblock: refused while public; allowed after the flip back, with the runnerctl start command', async () => {
  const { h } = setup()
  h.github.setRepo('me/app', { private: false })
  const o = makeOrigin(h.origins, 'me/app')
  await h.submit({ sha: o.sha, mode: 'one' })
  await h.d.watchdog.tick()
  assert.ok(h.d.c.tdb.block('me/app'))
  await assert.rejects(h.d.unblock('me/app'), /is public .*stays blocked/)
  h.github.setRepo('me/app', { private: true })
  await h.d.watchdog.tick()
  assert.ok(h.d.c.tdb.block('me/app'), 'a flip back does not unblock by itself')
  assert.deepEqual(await h.d.unblock('me/app'), { ok: true, startCmd: 'sudo -n ci-broker-runnerctl start me/app' })
  assert.equal(h.d.c.tdb.block('me/app'), null)
})

test('a tick and an unblock at once are serialized: the unblock re-checks after the tick (no lost block)', async () => {
  const { h } = setup()
  h.github.setRepo('me/app', { private: false })
  const o = makeOrigin(h.origins, 'me/app')
  await h.submit({ sha: o.sha, mode: 'one' })
  await h.d.watchdog.tick()
  h.github.setRepo('me/app', { private: true })
  let release!: () => void
  h.github.gate = new Promise<void>((r) => (release = r))
  const tick = h.d.watchdog.tick()
  await until(() => h.github.calls.length > 0 && h.github.calls.at(-1) === 'repos/me/app')
  const n = h.github.calls.length
  const un = h.d.unblock('me/app')
  await new Promise((r) => setImmediate(r))
  assert.equal(h.github.calls.length, n, 'the unblock waits for the tick')
  h.github.setRepo('me/app', { private: false })
  h.github.gate = null
  release()
  await tick
  await assert.rejects(un, /stays blocked/)
  assert.ok(h.d.c.tdb.block('me/app'))
})

test('the network probe: a reachable target or broken DNS → public-net refusals and a banner line; ok → admitted', async () => {
  const { h, mode, calls } = setup({ split: true, runners: false })
  h.github.setRepo('me/app', { private: false })
  mode.v = 'reached'
  await h.d.watchdog.tick()
  assert.equal(h.d.c.netCheck!.ok, false)
  assert.match(h.d.c.netCheck!.why, /10\.0\.0\.1:22 \(refused\) reachable/)
  assert.ok(banner(h.d).some((l) => /^public network ci-broker-pub failed its check/.test(l)))
  await assert.rejects(h.d.c.trust.admitLocal({ repo: 'me/app', mode: 'one' }), /trust\/public-net/)
  const run = calls.find((c) => c[1] === 'run')!
  assert.ok(run.includes('--network') && run.includes('ci-broker-pub') && run.includes('--cap-drop'))
  assert.ok(run.some((a) => /^busybox@sha256:[0-9a-f]{64}$/.test(a)), 'the probe image is pinned by digest')
  mode.v = 'dns'
  await h.d.watchdog.tick()
  assert.match(h.d.c.netCheck!.why, /DNS/)
  mode.v = 'nonet'
  await h.d.watchdog.tick()
  assert.match(h.d.c.netCheck!.why, /missing/)
  mode.v = 'ok'
  await h.d.watchdog.tick()
  assert.equal(h.d.c.netCheck!.ok, true)
  assert.equal((await h.d.c.trust.admitLocal({ repo: 'me/app', mode: 'one' })).lane, 'public')
})

test('probe script and verdict', () => {
  const s = probeScript(['10.0.0.1'])
  assert.match(s, /t 10\.0\.0\.1 22/)
  assert.match(s, /nslookup api\.github\.com/)
  assert.deepEqual(probeVerdict('blocked a:22\ndns ok\ngithub ok\n'), { ok: true, why: '1 targets blocked, DNS and GitHub work' })
  assert.equal(probeVerdict('blocked a:22\ndns ok\ngithub fail\n').ok, false)
  assert.equal(probeVerdict('').ok, false)
})

test('the door re-check: a changed dir closes the GitHub door (banner)', async () => {
  const { h } = setup({ split: true })
  h.d.c.cfg.githubSocketPath = join(tmp(), 'sock', 'github.sock')
  h.d.c.githubDoor = 'open'
  await h.d.watchdog.tick()
  assert.match(h.d.c.githubDoor, /^closed: .*missing/)
  assert.ok(banner(h.d).some((l) => /^GitHub door closed/.test(l)))
})

test('blocks survive a main-DB reset (trust.db is never moved aside)', async () => {
  const root = tmp()
  const a = setup({ root })
  a.h.github.setRepo('me/app', { private: false })
  const o = makeOrigin(a.h.origins, 'me/app')
  await a.h.submit({ sha: o.sha, mode: 'one' })
  await a.h.d.watchdog.tick()
  a.h.d.c.db.close()
  const raw = new DatabaseSync(join(root, 'state', 'brokerd.db'))
  raw.exec('PRAGMA user_version = 2')
  raw.close()
  const b: Harness = setup({ root }).h
  assert.ok(b.d.c.db.movedAside)
  assert.ok(b.d.c.tdb.block('me/app'))
})

test('correctness #19: the network probe runs outside the mutex (an unblock never waits for it), and only when a repo is public or none ran yet', async () => {
  const { h, calls } = setup({ split: true, runners: false })
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const sys0 = (h.d.c as any).sys
  ;(h.d.c as any).sys = async (cmd: string, args: string[]) => {
    if (cmd === 'docker' && args[0] === 'run') await gate
    return sys0(cmd, args)
  }
  const tick = h.d.watchdog.tick()
  await until(() => calls.some((c) => c[1] === 'network'))
  h.d.c.tdb.setBlock('me/app', h.clock.t, 'x')
  assert.deepEqual(await h.d.unblock('me/app'), { ok: true, startCmd: null }, 'unblock did not wait for the probe')
  release()
  await tick
  const n = calls.filter((c) => c[1] === 'run').length
  await h.d.watchdog.tick()
  assert.equal(calls.filter((c) => c[1] === 'run').length, n, 'no public repo and a check done: no probe container')
  h.github.setRepo('me/app', { private: false })
  await h.d.watchdog.tick()
  assert.equal(calls.filter((c) => c[1] === 'run').length, n + 1)
})
