// Review fixes that live below the doors: the snapshot tree check, the ssh secret rule, the check's lane, config reload.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bundleStream } from '../../src/core/snapshot.ts'
import { defaults, loadSplitConfig, reloadLive } from '../../src/ci/config.ts'
import { SshExecutor } from '../../src/ci/daemon/exec-ssh.ts'
import { parseInstallConf } from '../../src/ci/install-conf.ts'
import { harness, idOf, makeOrigin, sh, TEST_PROFILE, until } from '../harness.ts'

test('security #6: a snapshot bundle whose tree is not the claimed tree fails the job', async () => {
  const h = harness()
  const o = makeOrigin(h.origins, 'me/app')
  writeFileSync(join(o.work, 'f.txt'), 'local edit\n')
  sh(o.work, 'add', '-A')
  sh(o.work, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'local')
  const commit = sh(o.work, 'rev-parse', 'HEAD')
  const r = await h.d.c.jobs.submit({ repo: 'me/app', profile: 'app', mode: 'one', commit, tree: 'f'.repeat(40), detach: true, headCandidates: [o.sha] })
  assert.ok(r.needBundle)
  const b = await bundleStream(o.work, commit, o.sha)
  await assert.rejects(Promise.all([h.d.c.jobs.receiveBundle(idOf(r.id), b.stream), b.done]), /tree/)
  assert.match(h.d.c.db.job(idOf(r.id))!.error!, /bundle tree [0-9a-f]{12} is not the claimed tree ffffffffffff/)
})

test('security #5: the ssh secret goes only to jobs that may get job secrets (a GitHub-door noenv job gets none)', async () => {
  const cfg = { ...defaults(), layout: 'split' as const }
  const r = { id: 'vps', kind: 'ssh' as const, profiles: ['*'], host: 'vps', slots: 1, secret: 'tok' }
  const ex = new SshExecutor(cfg, [r], {} as any, '/x', (n) => (n === 'tok' ? 'secret-v' : null))
  assert.equal(await ex.token(r, { door: 'local', lane: 'full', env: 'env' } as any), 'secret-v')
  assert.equal(await ex.token(r, { door: 'github', lane: 'full', env: 'noenv' } as any), null)
  assert.equal(await ex.token(r, { door: 'github', lane: 'full', env: 'env' } as any), 'secret-v')
})

test('security #1: a health check runs in the lane its admission gave (a public repo: the public lane)', async () => {
  const prof = { ...TEST_PROFILE, check: ['one'], local: { where: 'container', image: 'i', commands: { one: 'echo one' } } }
  const h = harness({ resources: [{ id: 'local', kind: 'local', profiles: ['*'] }], profile: prof, cfg: { layout: 'split', operatorUid: process.getuid!() } })
  h.d.c.netCheck = { ok: true, why: '', at: h.clock.t }
  h.github.setRepo('me/app', { private: false })
  makeOrigin(h.origins, 'me/app')
  const { admitCheck } = await import('../../src/ci/daemon/local-door.ts')
  const lanes = await admitCheck(h.d, 'local', 'app')
  assert.deepEqual([...lanes!.entries()], [['app', { lane: 'public', env: 'noenv' }]])
  const p = h.d.c.checks.run('local', { profile: 'app', lanes: lanes! }, () => {})
  await until(() => h.local.runs.length === 1)
  assert.equal(h.local.runs[0].lane, 'public')
  h.local.runs[0].finish(0)
  await p
})

test('security #4: a bad tuning.json never blocks root\'s config from applying (reloadLive)', () => {
  const d = mkdtempSync(join(tmpdir(), 'cib-rl-'))
  const ic = parseInstallConf(`OPERATOR=dev\nOPERATOR_GROUP=dev\nDAEMON_USER=cibroker-admin\nRUNNER_USER=cibroker-runner\nOPT_DIR=${d}/opt\nSTATE_DIR=${d}/state\nETC_DIR=${d}/etc\nTOOLS_DIR=${d}/tools\n`)
  mkdirSync(join(d, 'etc'), { recursive: true })
  mkdirSync(join(d, 'state/operator'), { recursive: true })
  writeFileSync(join(d, 'etc/config.json'), JSON.stringify({ trust: { githubUsers: [{ login: 'a', id: 1 }] } }))
  chmodSync(join(d, 'etc/config.json'), 0o644)
  const deps = { rootUid: process.getuid!(), uidOf: () => process.getuid!() }
  const c = loadSplitConfig(ic, deps)
  writeFileSync(join(d, 'etc/config.json'), JSON.stringify({ trust: { githubUsers: [] } }))
  writeFileSync(join(d, 'state/operator/tuning.json'), '{ broken')
  assert.throws(() => reloadLive(c, deps), /tuning\.json: not valid JSON/)
  assert.deepEqual(c.trust.githubUsers, [], "root's revocation applied anyway")
  writeFileSync(join(d, 'etc/config.json'), JSON.stringify({ trust: { githubUsers: [{ login: 'b', id: 2 }] } }))
  assert.doesNotThrow(() => reloadLive(c, deps, { tuning: 'ignore' }))
  assert.deepEqual(c.trust.githubUsers, [{ login: 'b', id: 2 }])
})

// ---------------------------------------------------------------- batch 2: jobs, local runs, profiles

import { existsSync, readdirSync, symlinkSync, utimesSync } from 'node:fs'
import { applyTuning } from '../../src/ci/config.ts'
import { dockerArgs, runLocal } from '../../src/ci/local.ts'

test('security #14: a job runs the profile snapshot it was admitted with (pinned in its row)', async () => {
  const prof = { ...TEST_PROFILE, local: { where: 'container', image: 'i', commands: { one: 'echo admitted' } } }
  const h = harness({ resources: [{ id: 'local', kind: 'local', profiles: ['*'] }], profile: prof, cfg: { layout: 'split', operatorUid: process.getuid!() } })
  const o = makeOrigin(h.origins, 'me/app')
  h.d.c.scheduler.paused = true
  const r = await h.d.c.jobs.submit({ repo: 'me/app', profile: 'app', mode: 'one', commit: o.sha, detach: true })
  const j = h.d.c.db.job(idOf(r.id))!
  assert.ok(j.profileDir.startsWith(join(h.cfg.stateDir, 'profiles')), j.profileDir)
  writeFileSync(join(h.root, 'profiles', 'app', 'profile.json'), JSON.stringify({ ...prof, local: { ...prof.local, commands: { one: 'echo swapped' } } }))
  h.d.c.scheduler.paused = false
  await h.pass()
  await until(() => h.local.runs.length === 1)
  assert.match(h.local.runs[0].cmd, /echo admitted/)
})

test('correctness #20: prune removes profile snapshots no job uses (older than an hour), keeps the used ones', async () => {
  const h = harness({ cfg: { layout: 'split', operatorUid: process.getuid!() } })
  const o = makeOrigin(h.origins, 'me/app')
  await h.submit({ sha: o.sha, mode: 'one' })
  const snaps = join(h.cfg.stateDir, 'profiles')
  const used = readdirSync(snaps)[0]
  mkdirSync(join(snaps, 'app-000000000000'))
  mkdirSync(join(snaps, 'app-111111111111'))
  const old = (Date.now() - 2 * 3600_000) / 1000
  for (const d of [used, 'app-000000000000']) utimesSync(join(snaps, d), old, old)
  await h.d.c.jobs.prune()
  assert.deepEqual(readdirSync(snaps).sort(), [used, 'app-111111111111'].sort())
})

test('security #15: a tmpfs mount point under a committed symlink is refused (nothing is made outside the checkout)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cib-co-'))
  const outside = mkdtempSync(join(tmpdir(), 'cib-out-'))
  symlinkSync(outside, join(dir, 'a'))
  const { defaults: dd } = await import('../../src/ci/config.ts')
  await assert.rejects(runLocal({ dir, mirrorObjects: '/x', where: 'container', image: 'i', cmd: 'true', cfg: dd(), onData: () => {}, tmpfs: ['a/b'] }), /tmpfs a\/b: a\/? ?.*symlink/)
  assert.ok(!existsSync(join(outside, 'b')))
})

test('security #16: a cancelled local run copies no artifacts', async () => {
  const prof = { ...TEST_PROFILE, artifacts: ['out'], local: { where: 'container', image: 'i', commands: { one: 'echo one' } } }
  const h = harness({ resources: [{ id: 'local', kind: 'local', profiles: ['*'] }], profile: prof })
  const o = makeOrigin(h.origins, 'me/app')
  const r = await h.d.c.jobs.submit({ repo: 'me/app', profile: 'app', mode: 'one', commit: o.sha, detach: true })
  await h.pass()
  await until(() => h.local.runs.length === 1)
  mkdirSync(join(h.local.runs[0].dir, 'out'))
  writeFileSync(join(h.local.runs[0].dir, 'out', 'x'), 'x')
  h.d.c.jobs.cancel(idOf(r.id), 'test')
  await h.settle()
  assert.ok(!existsSync(join(h.d.c.streams.dir(idOf(r.id)), 'artifacts')))
  assert.match(readFileSync(join(h.d.c.streams.dir(idOf(r.id)), 'local.log'), 'utf8'), /cancelled: artifacts not copied/)
})

test('security #20: tuning.json values are type-checked; pool.__proto__ is refused', () => {
  const bad = (t: unknown, re: RegExp) => assert.throws(() => applyTuning(defaults(), t), re)
  bad({ local: { cpus: 'many' } }, /local\.cpus/)
  bad({ local: { memory: '20g --privileged' } }, /local\.memory/)
  bad(JSON.parse('{ "pool": { "__proto__": { "x": 1 } } }'), /pool\.__proto__/)
  bad({ pool: { idleStopSec: -1 } }, /pool\.idleStopSec/)
  bad({ pool: { warmHours: 'always' } }, /pool\.warmHours/)
  const c = defaults()
  applyTuning(c, { local: { cpus: 2, memory: '8g' }, pool: { warmHours: '08:00-20:00' } })
  assert.deepEqual([c.local.cpus, c.local.memory, c.pool.warmHours], [2, '8g', '08:00-20:00'])
})

test('correctness #8: in split the full lane uses its own volumes (not the single daemon\'s, owned by the operator\'s uid)', () => {
  const base = { name: 'n', dir: '/d', mirrorObjects: '/m', image: 'i', cmd: 'c', uid: 1, gid: 1, repo: 'me/x', lane: 'full' as const }
  const s = dockerArgs({ ...base, cfg: { ...defaults(), layout: 'split' } })
  assert.ok(s.includes('ci-broker-full-pnpm-store:/pnpm-store') && s.includes('ci-broker-full-ms-playwright:/ms-playwright'))
  const g = dockerArgs({ ...base, cfg: defaults() })
  assert.ok(g.includes('ci-broker-pnpm-store:/pnpm-store'))
})

// ---------------------------------------------------------------- re-review fixes

test('re-review #4: a bad tuning.json never closes the GitHub door (it refuses a local submit only)', () => {
  const d = mkdtempSync(join(tmpdir(), 'cib-rl-'))
  const ic = parseInstallConf(`OPERATOR=dev\nOPERATOR_GROUP=dev\nDAEMON_USER=cibroker-admin\nRUNNER_USER=cibroker-runner\nOPT_DIR=${d}/opt\nSTATE_DIR=${d}/state\nETC_DIR=${d}/etc\nTOOLS_DIR=${d}/tools\n`)
  mkdirSync(join(d, 'etc'), { recursive: true })
  mkdirSync(join(d, 'state/operator'), { recursive: true })
  writeFileSync(join(d, 'etc/config.json'), JSON.stringify({ trust: { githubUsers: [{ login: 'a', id: 1 }] } }))
  chmodSync(join(d, 'etc/config.json'), 0o644)
  const splitDeps = { rootUid: process.getuid!(), uidOf: () => process.getuid!() }
  const h = harness({ cfg: { layout: 'split', operatorUid: process.getuid!(), installConf: ic }, deps: { splitDeps } })
  writeFileSync(join(d, 'state/operator/tuning.json'), '{ broken')
  assert.doesNotThrow(() => h.d.reloadConfig('github'))
  assert.throws(() => h.d.reloadConfig('local'), /trust\/profile.*tuning\.json/)
})

test('re-review #5: a reused snapshot is touched (prune keeps it); in split a job whose pinned snapshot is gone fails, never loads by name', async () => {
  const h = harness({ cfg: { layout: 'split', operatorUid: process.getuid!() } })
  const p1 = h.d.c.profile('app')
  const old = (Date.now() - 2 * 3600_000) / 1000
  utimesSync(p1.dir, old, old)
  const p2 = h.d.c.profile('app')
  assert.equal(p2.dir, p1.dir)
  const { statSync } = await import('node:fs')
  assert.ok(Date.now() - statSync(p2.dir).mtimeMs < 60_000, 'touched on reuse')
  assert.throws(() => h.d.c.jobProfile({ profile: 'app', profileDir: join(h.cfg.stateDir, 'profiles', 'app-gone') }), /snapshot .* is gone/)
})

// ---------------------------------------------------------------- live rollout fixes

test('rollout #1: a health check reads root\'s config again first (a secret set after the start applies to it, as to a submit)', async () => {
  const d = mkdtempSync(join(tmpdir(), 'cib-ck-'))
  const ic = parseInstallConf(`OPERATOR=dev\nOPERATOR_GROUP=dev\nDAEMON_USER=cibroker-admin\nRUNNER_USER=cibroker-runner\nOPT_DIR=${d}/opt\nSTATE_DIR=${d}/state\nETC_DIR=${d}/etc\nTOOLS_DIR=${d}/tools\n`)
  mkdirSync(join(d, 'etc/secrets'), { recursive: true })
  mkdirSync(join(d, 'state/operator'), { recursive: true })
  const root = (secrets: object) => {
    writeFileSync(join(d, 'etc/config.json'), JSON.stringify({ trust: { githubUsers: [{ login: 'a', id: 1 }] }, secrets }))
    chmodSync(join(d, 'etc/config.json'), 0o644)
  }
  root({})
  const prof = { ...TEST_PROFILE, check: ['one'], local: { where: 'container', image: 'i', env: { GITHUB_TOKEN: 'tok' }, commands: { one: 'echo one' } } }
  const splitDeps = { rootUid: process.getuid!(), uidOf: () => process.getuid!() }
  const h = harness({ resources: [{ id: 'local', kind: 'local', profiles: ['*'] }], profile: prof, cfg: { layout: 'split', operatorUid: process.getuid!(), installConf: ic, secrets: {} }, deps: { splitDeps } })
  makeOrigin(h.origins, 'me/app')
  const { admitCheck } = await import('../../src/ci/daemon/local-door.ts')
  await assert.rejects(admitCheck(h.d, 'local', 'app'), /secret tok is not set/)
  // the admin's install.sh --set-secret tok: the file, then the name in root's config
  writeFileSync(join(d, 'etc/secrets/tok'), 'tok-value')
  root({ tok: {} })
  const lanes = await admitCheck(h.d, 'local', 'app')
  assert.deepEqual([...lanes!.entries()], [['app', { lane: 'full', env: 'env' }]])
})
