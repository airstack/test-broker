import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ResourceCfg } from '../../src/ci/config.ts'
import { Daemon } from '../../src/ci/daemon/daemon.ts'
import { makeFakeSsh, type FakeSsh } from '../fake-ssh.ts'
import { harness, idOf, makeOrigin, pushCommit, tmp, until, type Harness } from '../harness.ts'

const job = (h: Harness, id: string) => h.d.c.db.job(idOf(id))!
const shards = (h: Harness, id: string) => h.d.c.db.shards(idOf(id))
const vps = (o: Partial<ResourceCfg> = {}): ResourceCfg => ({ id: 'vps1', kind: 'ssh', profiles: ['*'], host: 'vps1', slots: 1, ...o })
const boat: ResourceCfg = { id: 'boat', kind: 'boat', profiles: ['*'], maxBoxes: 4 }

function sshHarness(resources: ResourceCfg[], remote?: string, cfg: Record<string, unknown> = {}): { h: Harness; f: FakeSsh } {
  const root = tmp('cib-ssh-')
  const f = makeFakeSsh(join(root, 'fake'))
  const h = harness({ root, resources, cfg: { sshBin: f.ssh, scpBin: f.scp, ...cfg } })
  if (remote) writeFileSync(join(h.cfg.profilesDir, 'app', 'remote.sh'), remote)
  return { h, f }
}

/** A remote script that blocks on a fifo per slot until the test writes an exit code into it. */
const GATED = 'echo "started $CIB_SLOT"; read -r rc < "$HOME/cib/$CIB_SLOT/gate"; echo "remote $*"; exit "$rc"\n'
function gates(f: FakeSsh, host: string, slots: number) {
  for (let i = 0; i < slots; i++) {
    const d = join(f.home(host), 'cib', String(i))
    execFileSync('mkdir', ['-p', d])
    execFileSync('mkfifo', [join(d, 'gate')])
  }
  return (slot: number, code: number) => writeFile(join(f.home(host), 'cib', String(slot), 'gate'), `${code}\n`)
}

test('ssh comes before boat: the shard runs on the host slot with the real wrapper; output, log and artifacts come back', async () => {
  const { h, f } = sshHarness([vps(), boat])
  const { sha } = makeOrigin(h.origins, 'me/app')
  const r = await h.submit({ sha, mode: 'one' })
  await h.settle()
  const j = job(h, r.id)
  assert.equal(j.state, 'passed', JSON.stringify(shards(h, r.id)))
  assert.equal(shards(h, r.id)[0].where, 'ssh:vps1/0')
  assert.equal(h.boat.calls.filter((c) => c.startsWith('create')).length, 0)
  const dir = h.d.c.streams.dir(j.id)
  assert.match(readFileSync(join(dir, 'one.log'), 'utf8'), new RegExp(`remote ${sha} one`))
  assert.equal(readFileSync(join(dir, 'artifacts', 'one', 'out', 'a.txt'), 'utf8'), 'art\n')
  assert.deepEqual(h.d.c.db.slots(), [])
  const run = f.calls().find((c) => c[0] === 'ssh' && c.some((x) => x.includes('cib-wrap.sh" ')))!
  assert.deepEqual(run.slice(1, 6), ['-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', 'vps1'])
  assert.match(run[6], /CIB_TOKEN_LINE=0/)
  assert.ok(f.calls().some((c) => c[0] === 'scp' && c.at(-1) === 'vps1:cib/0/remote.sh'))
  assert.equal(existsSync(join(f.home('vps1'), 'cib', '0', 'run.pid')), false)
})

test('size filter: a host without the shard size is skipped (Boat takes it); a matching size goes to the host', async () => {
  const { h } = sshHarness([vps({ sizes: ['default'] }), boat])
  const o = makeOrigin(h.origins, 'me/app')
  const r = await h.submit({ sha: o.sha, mode: 'e2e' })
  await h.pass()
  await until(() => h.ctl.pending.length === 1, 'the e2e shard on a box')
  assert.match(shards(h, r.id)[0].where!, /^boat:/)
  const r2 = await h.submit({ sha: pushCommit(o.work, 'x.txt', '2'), mode: 'one' })
  await h.pass()
  await until(() => job(h, r2.id).state === 'passed', 'the one shard on the host')
  assert.equal(shards(h, r2.id)[0].where, 'ssh:vps1/0')
})

test('slots are exclusive: 2 slots run 2 shards, the third waits for a free slot and then takes it', async () => {
  const { h, f } = sshHarness([vps({ slots: 2 })], GATED)
  const release = gates(f, 'vps1', 2)
  const { sha } = makeOrigin(h.origins, 'me/app')
  const r = await h.submit({ sha })
  await h.pass()
  assert.deepEqual(shards(h, r.id).map((s) => [s.state, s.where]), [['running', 'ssh:vps1/0'], ['running', 'ssh:vps1/1'], ['queued', null]])
  assert.match(job(h, r.id).waitWhy!, /vps1: all 2 slot\(s\) busy/)
  assert.deepEqual(h.d.c.db.slots().map((s) => [s.resource, s.slot]), [['vps1', 0], ['vps1', 1]])
  await release(1, 0)
  await until(() => shards(h, r.id)[2].state === 'running', 'the third shard')
  assert.equal(shards(h, r.id)[2].where, 'ssh:vps1/1')
  await release(0, 0)
  await release(1, 0)
  await until(() => job(h, r.id).state === 'passed', 'the job')
  await h.d.idle()
})

test('githubTokenCmd: the token is the first stdin line (CIB_TOKEN_LINE=1), never in argv, and scrubbed from output', async () => {
  const token = 'vps-pat-SECRET-0123456789'
  const { h, f } = sshHarness([vps({ githubTokenCmd: `echo ${token}` })], 'echo "got=$GITHUB_TOKEN"; read -r x && echo "stdin:$x" || echo stdin-closed\n')
  const { sha } = makeOrigin(h.origins, 'me/app')
  const r = await h.submit({ sha, mode: 'one' })
  await h.settle()
  assert.equal(job(h, r.id).state, 'passed')
  const log = readFileSync(join(h.d.c.streams.dir(idOf(r.id)), 'one.log'), 'utf8')
  assert.match(log, /got=\*\*\*/)
  assert.match(log, /stdin-closed/)
  assert.ok(!log.includes(token))
  assert.ok(!JSON.stringify(f.calls()).includes(token), 'no token in any ssh/scp argv')
  assert.ok(f.calls().some((c) => c[0] === 'ssh' && /CIB_TOKEN_LINE=1/.test(c.at(-1)!)))
  assert.ok(!readFileSync(join(h.d.c.streams.dir(idOf(r.id)), 'stream.ndjson'), 'utf8').includes(token))
})

test('an unreachable host is charged at once and avoided by the retry; infraFailLimit charges → failing, then skipped', async () => {
  const { h, f } = sshHarness([vps(), boat])
  f.down('vps1')
  const o = makeOrigin(h.origins, 'me/app')
  const r = await h.submit({ sha: o.sha, mode: 'one' })
  await h.pass()
  await until(() => h.ctl.pending.length === 1, 'attempt 2 on a box')
  const s = shards(h, r.id)[0]
  assert.deepEqual([s.attempt, s.avoid], [2, ['vps1']])
  assert.match(s.where!, /^boat:/)
  assert.equal(h.d.c.db.health('vps1', 'app').infraFails, 1)
  h.ctl.finish(0)
  await until(() => job(h, r.id).state === 'passed')
  assert.equal(h.d.c.db.health('vps1', 'app').infraFails, 1, 'not charged twice when the retry passes')
  const r2 = await h.submit({ sha: pushCommit(o.work, 'x.txt', '2'), mode: 'one' })
  await h.pass()
  await until(() => h.ctl.pending.length === 1, 'second job retried on a box')
  const hl = h.d.c.db.health('vps1', 'app')
  assert.deepEqual([hl.failing, hl.infraFails], [true, 2])
  assert.match(hl.reason!, /unreachable/)
  h.ctl.finish(0)
  await until(() => job(h, r2.id).state === 'passed')
  const r3 = await h.submit({ sha: pushCommit(o.work, 'x.txt', '3'), mode: 'one' })
  await h.pass()
  await until(() => h.ctl.pending.length === 1)
  assert.equal(shards(h, r3.id)[0].attempt, 1)
  assert.match(shards(h, r3.id)[0].where!, /^boat:/)
})

test('exit 96 (disk) is charged to the host at once; an attributed infra exit only when the retry gets past it elsewhere', async () => {
  const { h, f } = sshHarness([vps(), boat], 'exit "$(cat "$HOME/rc")"\n')
  writeFileSync(join(f.home('vps1'), 'rc'), '96')
  const o = makeOrigin(h.origins, 'me/app')
  const r = await h.submit({ sha: o.sha, mode: 'one' })
  await h.pass()
  await until(() => h.ctl.pending.length === 1)
  assert.equal(h.d.c.db.health('vps1', 'app').infraFails, 1)
  h.ctl.finish(0)
  await until(() => job(h, r.id).state === 'passed')
  h.d.c.db.resetHealth('vps1')
  writeFileSync(join(f.home('vps1'), 'rc'), '91')
  const r2 = await h.submit({ sha: pushCommit(o.work, 'x.txt', '2'), mode: 'one' })
  await h.pass()
  await until(() => h.ctl.pending.length === 1)
  assert.equal(h.d.c.db.health('vps1', 'app').infraFails, 0, 'exit 91: not yet')
  h.ctl.finish(1) // attempt 2 got past the fetch phase on the box (and failed its tests)
  await until(() => job(h, r2.id).state === 'failed')
  assert.equal(h.d.c.db.health('vps1', 'app').infraFails, 1)
})

test('cancel kills the slot\'s process group through the wrapper\'s kill mode; the slot is freed', async () => {
  const { h, f } = sshHarness([vps()], 'echo started; sleep 300 & wait\n')
  const { sha } = makeOrigin(h.origins, 'me/app')
  const r = await h.submit({ sha, mode: 'one' })
  await h.pass()
  const pidf = join(f.home('vps1'), 'cib', '0', 'run.pid')
  await until(() => existsSync(pidf) && readFileSync(pidf, 'utf8').trim() !== '', 'the remote run')
  const pg = Number(readFileSync(pidf, 'utf8'))
  h.d.c.jobs.cancel(idOf(r.id), 'test')
  await h.d.idle()
  assert.equal(job(h, r.id).state, 'cancelled')
  assert.ok(f.calls().some((c) => c[0] === 'ssh' && c.at(-1)!.includes('cib-wrap.sh" --kill')))
  assert.throws(() => process.kill(-pg, 0))
  assert.deepEqual(h.d.c.db.slots(), [])
})

test('restart recovery kills the leftovers of every busy ssh slot', async () => {
  const { h, f } = sshHarness([vps({ slots: 2 })], 'sleep 300 & wait\n')
  const { sha } = makeOrigin(h.origins, 'me/app')
  await h.submit({ sha, mode: 'one' })
  await h.pass()
  const pidf = join(f.home('vps1'), 'cib', '0', 'run.pid')
  await until(() => existsSync(pidf) && readFileSync(pidf, 'utf8').trim() !== '', 'the remote run')
  const pg = Number(readFileSync(pidf, 'utf8'))
  // a second daemon on the same state (the first one "crashed": its run keeps going)
  const d2 = new Daemon({ ghApi: h.github.run, apiSleep: async () => {}, cfg: h.cfg, boat: h.boat, now: () => h.clock.t, log: (m) => h.logs.push(m), sys: async () => ({ code: 0, stdout: '', stderr: '' }) })
  await d2.recover()
  assert.ok(h.logs.some((l) => /recovery: ssh vps1 slot 0: killed leftovers/.test(l)), h.logs.join('\n'))
  assert.throws(() => process.kill(-pg, 0))
  h.d.c.jobs.cancel(1, 'test')
  await h.d.idle()
})

test('a snapshot job on an ssh slot gets the bundle (minus its base) next to the wrapper, with CIB_BUNDLE and CIB_BASE', async () => {
  const { h, f } = sshHarness([vps()], 'echo "bundle=$CIB_BUNDLE base=$CIB_BASE"; git bundle list-heads "$CIB_BUNDLE"\n')
  const o = makeOrigin(h.origins, 'me/app')
  writeFileSync(join(o.work, 'f.txt'), 'dirty\n')
  const { buildSnapshot, bundleStream } = await import('../../src/core/snapshot.ts')
  const s = await buildSnapshot(o.work, { maxFileMb: 50 })
  const r = await h.d.c.jobs.submit({ repo: 'me/app', profile: 'app', mode: 'one', commit: s.commit, tree: s.tree, headCandidates: s.headCandidates, detach: true })
  const b = await bundleStream(o.work, s.commit, r.base ?? null)
  await Promise.all([h.d.c.jobs.receiveBundle(idOf(r.id), b.stream), b.done])
  await h.settle()
  assert.equal(job(h, r.id).state, 'passed')
  const log = readFileSync(join(h.d.c.streams.dir(idOf(r.id)), 'one.log'), 'utf8')
  assert.match(log, new RegExp(`bundle=${f.home('vps1')}/cib/0/snapshot.bundle base=${o.sha}`))
  assert.match(log, new RegExp(`${s.commit} refs/cib/snap`))
})
