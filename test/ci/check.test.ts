// `ci-broker check` on every kind: pass clears failing, fail sets it, "not checked" changes nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ResourceCfg } from '../../src/ci/config.ts'
import type { CheckEvent } from '../../src/ci/daemon/checks.ts'
import { tokenOf } from '../../src/ci/daemon/exec-github.ts'
import { listen } from '../../src/ci/daemon/server.ts'
import { Client } from '../../src/ci/client/http.ts'
import { check as checkCmd, status as statusCmd } from '../../src/ci/client/commands.ts'
import { FakeGh, HOSTED_YAML } from '../fake-gh.ts'
import { makeFakeSsh, type FakeSsh } from '../fake-ssh.ts'
import { harness, makeOrigin, TEST_PROFILE, tmp, until, type Harness } from '../harness.ts'

const PROFILE = { ...TEST_PROFILE, check: ['cmd', 'echo checking'] }
const vps: ResourceCfg = { id: 'vps1', kind: 'ssh', profiles: ['app'], host: 'vps1', slots: 2 }

async function runCheck(h: Harness, id: string, o: { profile?: string; useReserve?: boolean } = {}) {
  const evs: CheckEvent[] = []
  const code = await h.d.c.checks.run(id, o, (e) => evs.push(e))
  const results = evs.filter((e) => e.t === 'result') as Extract<CheckEvent, { t: 'result' }>[]
  const log = evs.filter((e) => e.t === 'log').map((e) => (e as any).data).join('')
  return { code, results, log }
}

function sshH(remote: string): { h: Harness; f: FakeSsh } {
  const root = tmp('cib-chk-')
  const f = makeFakeSsh(join(root, 'fake'))
  const h = harness({ root, profile: PROFILE, resources: [vps], cfg: { sshBin: f.ssh, scpBin: f.scp } })
  writeFileSync(join(h.cfg.profilesDir, 'app', 'remote.sh'), remote)
  makeOrigin(h.origins, 'me/app')
  return { h, f }
}

test('ssh check passes: clears failing and its infra failures, records the last check; reports disk, sudo and RAM per slot', async () => {
  const { h, f } = sshH('echo "remote $*"\n')
  f.sudo('vps1', true)
  h.d.c.db.setHealth('vps1', 'app', { failing: true, reason: '2 infra failures', infraFails: 2 })
  const r = await runCheck(h, 'vps1')
  assert.equal(r.code, 0)
  assert.equal(r.results.length, 1)
  assert.equal(r.results[0].ok, true)
  assert.match(r.log, /remote [0-9a-f]{40} cmd echo checking/)
  assert.match(r.results[0].report!, /free disk \d+ GB; sudo -n true: works; RAM [\d.]+ GB \([\d.]+ GB per slot, 2 slot\(s\)\)/)
  const hl = h.d.c.db.health('vps1', 'app')
  assert.deepEqual([hl.failing, hl.infraFails, hl.lastCheckOk], [false, 0, true])
  assert.ok(hl.lastCheckAt && hl.lastCheckLog)
  assert.deepEqual(h.d.c.db.slots(), [])
})

test('ssh check fails: sets failing (the scheduler skips the host); no sudo is reported', async () => {
  const { h } = sshH('echo broken; exit 93\n')
  const r = await runCheck(h, 'vps1', { profile: 'app' })
  assert.equal(r.code, 1)
  assert.match(r.results[0].report!, /sudo -n true: NO/)
  const hl = h.d.c.db.health('vps1', 'app')
  assert.deepEqual([hl.failing, hl.lastCheckOk], [true, false])
  assert.match(hl.reason!, /check failed: exit 93/)
})

test('an unreachable ssh host fails its check', async () => {
  const { h, f } = sshH('true\n')
  f.down('vps1')
  const r = await runCheck(h, 'vps1')
  assert.equal(r.code, 1)
  assert.match(r.results[0].message, /no exit status .*unreachable|ssh .* failed|exit 255/)
  assert.equal(h.d.c.db.health('vps1', 'app').failing, true)
})

test('boat check at the reserve: exit 3 "not checked: no Boat budget", no start, nothing changed; --use-reserve runs it', async () => {
  const h = harness({ profile: PROFILE })
  h.boat.onCommand = undefined // real bash on the fake box
  writeFileSync(join(h.cfg.profilesDir, 'app', 'remote.sh'), 'echo "remote $*"\n')
  makeOrigin(h.origins, 'me/app')
  h.boat.budget.day = h.cfg.startsReserve
  h.d.c.db.setHealth('boat', 'app', { failing: true, reason: 'old' })
  const r = await runCheck(h, 'boat')
  assert.equal(r.code, 3)
  assert.equal(r.results[0].ok, null)
  assert.match(r.results[0].message, /not checked: no Boat budget/)
  assert.equal(h.boat.calls.filter((c) => c.startsWith('create') || c.startsWith('resume')).length, 0)
  assert.equal(h.d.c.db.boxes().length, 0)
  const hl = h.d.c.db.health('boat', 'app')
  assert.deepEqual([hl.failing, hl.reason, hl.lastCheckAt], [true, 'old', null])
  const r2 = await runCheck(h, 'boat', { useReserve: true })
  assert.equal(r2.code, 0, r2.log)
  assert.equal(h.boat.startsUsed, 1)
  assert.match(r2.log, /remote [0-9a-f]{40} cmd echo checking/)
  assert.match(r2.results[0].report!, /free disk \d+ GB on cib-tst-acme-default-/)
  assert.equal(h.d.c.db.health('boat', 'app').failing, false)
  assert.deepEqual(h.d.c.db.boxes().map((b) => b.state), ['idle'])
})

test('boat check uses an idle running box first (no start), whatever its size, and clears the box\'s infra failures', async () => {
  const h = harness({ profile: PROFILE })
  h.boat.onCommand = undefined
  writeFileSync(join(h.cfg.profilesDir, 'app', 'remote.sh'), 'echo ok\n')
  makeOrigin(h.origins, 'me/app')
  h.boat.budget.day = 0
  h.boat.addBox('cib-tst-acme-large-aaaaaa', 'ready', 'large')
  await h.d.timers.boat()
  h.d.c.db.updateBox('cib-tst-acme-large-aaaaaa', { infraFails: 1 })
  const r = await runCheck(h, 'boat')
  assert.equal(r.code, 0, r.log)
  assert.equal(h.boat.startsUsed, 0)
  assert.equal(h.d.c.db.box('cib-tst-acme-large-aaaaaa')!.infraFails, 0)
  assert.equal(h.d.c.db.box('cib-tst-acme-large-aaaaaa')!.state, 'idle')
})

test('local check runs the check through the local path (the check args as a local mode)', async () => {
  const h = harness({ profile: PROFILE, resources: [{ id: 'local', kind: 'local', profiles: ['*'] }] })
  makeOrigin(h.origins, 'me/app')
  const p = runCheck(h, 'local')
  await until(() => h.local.runs.length === 1, 'the local run')
  assert.equal(h.local.runs[0].cmd, 'echo checking')
  assert.deepEqual(h.d.c.db.slots().map((s) => [s.resource, s.jobId]), [['local', 0]])
  h.local.runs[0].finish(0)
  const r = await p
  assert.equal(r.code, 0)
  assert.match(r.results[0].report!, /free disk/)
  assert.equal(h.d.c.db.health('local', 'app').lastCheckOk, true)
  assert.equal(h.local.busy, false)
  assert.deepEqual(h.d.c.db.slots(), [])
})

test('github check: the workflow must be on the default branch with workflow_dispatch and the inputs; nothing is dispatched', async () => {
  const fake = new FakeGh()
  const gh: ResourceCfg = { id: 'gh', kind: 'github', profiles: ['app'], workflow: 'ci-broker-hosted.yml', modes: ['test-all'] }
  const h = harness({ profile: PROFILE, resources: [gh], deps: { gh: fake.handle } })
  const r = await runCheck(h, 'gh')
  assert.equal(r.code, 1)
  assert.match(r.results[0].message, /not found on me\/app@main/)
  assert.equal(h.d.c.db.health('gh', 'app').failing, true)
  fake.workflows.set('me/app ci-broker-hosted.yml', HOSTED_YAML)
  const r2 = await runCheck(h, 'gh')
  assert.equal(r2.code, 0)
  assert.equal(h.d.c.db.health('gh', 'app').failing, false)
  assert.equal(fake.dispatches().length, 0)
  assert.ok(fake.calls.some((c) => c.join(' ') === 'workflow view ci-broker-hosted.yml --repo me/app --ref main --yaml'))
  // the template in ci/workflows/ passes as it is, and its run-name carries the token the daemon looks for
  const tpl = readFileSync(join(import.meta.dirname, '..', '..', 'ci', 'workflows', 'ci-broker-hosted.yml'), 'utf8')
  fake.workflows.set('me/app ci-broker-hosted.yml', tpl)
  assert.equal((await runCheck(h, 'gh')).code, 0)
  const runName = /^run-name: "(.*)"$/m.exec(tpl)![1].replace('${{ inputs.job }}', 'tst-9').replace(/\$\{\{[^}]*\}\}/g, 'x')
  assert.equal(tokenOf(runName), 'tst-9')
})

test('over the socket: `ci-broker check` streams the log, prints PASS with the report, exits 0; status shows slots and the last check', async () => {
  const { h, f } = sshH('echo "remote $*"\n')
  f.sudo('vps1', true)
  const server = await listen(h.d, h.cfg.socketPath)
  try {
    const client = new Client(h.cfg.socketPath)
    let out = ''
    const code = await checkCmd(client, (s) => void (out += s), 'vps1', undefined, false)
    assert.equal(code, 0, out)
    assert.match(out, /\[vps1\/app\] .*remote [0-9a-f]{40} cmd echo checking/)
    assert.match(out, /PASS {2}vps1\/app: exit 0\n {6}report: free disk/)
    let st = ''
    await statusCmd(client, (s) => void (st += s))
    assert.match(st, /vps1 +ssh +profiles app {2}\(host vps1, 2 slot\(s\)\)/)
    assert.match(st, /slot 0: free\n +slot 1: free/)
    assert.match(st, /app +ok +last check \d+s ago pass/)
    await assert.rejects(client.stream('/resources/nope/check', () => {}, undefined, {}), /no resource nope/)
  } finally {
    server.closeAllConnections()
    server.close()
  }
})
