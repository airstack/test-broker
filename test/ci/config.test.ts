import '../tmp-root.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, resolveResources } from '../../src/ci/config.ts'

test('defaults when there is no config file', () => {
  const c = loadConfig('/nonexistent/config.json', { HOME: '/home/x' })
  assert.equal(c.startsReserve, 20)
  assert.equal(c.pool.idleStopSec, 1200)
  assert.equal(c.pool.warmHours, null)
  assert.equal(c.runnersPerRepo, 8)
  assert.equal(c.queueTimeoutSec, 3600)
  assert.equal(c.shardTimeoutSec, 7200)
  assert.equal(c.interestGraceSec, 30)
  assert.equal(c.infraFailLimit, 2)
  assert.equal(c.retentionDays, 14)
  assert.equal(c.artifactsMaxMb, 200)
  assert.equal(c.snapshotMaxFileMb, 50)
  assert.equal(c.localMaxLoadFactor, 0.5)
  assert.equal(c.stateDir, '/home/x/.local/state/ci-broker')
  assert.equal(c.socketPath, '/home/x/.local/state/ci-broker/brokerd.sock')
  assert.equal(c.boatBin, '/home/x/.local/bin/boat')
  assert.match(c.daemonId, /^[a-z0-9]+$/)
})

test('a file overrides one nested value and keeps the other defaults; the socket follows stateDir', () => {
  const d = mkdtempSync(join(tmpdir(), 'cib-'))
  const p = join(d, 'config.json')
  writeFileSync(p, JSON.stringify({ pool: { idleStopSec: 60 }, stateDir: '/s', daemonId: 'ub1' }))
  const c = loadConfig(p, { HOME: '/home/x' })
  assert.equal(c.pool.idleStopSec, 60)
  assert.equal(c.pool.deleteAfterDays, 7)
  assert.equal(c.socketPath, '/s/brokerd.sock')
  assert.equal(c.daemonId, 'ub1')
})

test('a daemonId that would break box names is refused', () => {
  const d = mkdtempSync(join(tmpdir(), 'cib-'))
  const p = join(d, 'config.json')
  writeFileSync(p, JSON.stringify({ daemonId: 'ub-1' }))
  assert.throws(() => loadConfig(p, { HOME: '/h' }), /daemonId/)
})

test('no resources key → local + boat for every profile, boat maxBoxes 10', () => {
  const c = loadConfig('/nonexistent', { HOME: '/h' })
  assert.deepEqual(resolveResources(c), [
    { id: 'local', kind: 'local', profiles: ['*'] },
    { id: 'boat', kind: 'boat', profiles: ['*'], maxBoxes: 10 },
  ])
})

test('ssh and github resources get their defaults; a github resource without a workflow is refused', () => {
  const c = loadConfig('/nonexistent', { HOME: '/h' })
  assert.equal(c.sshBin, 'ssh')
  assert.equal(c.githubPollSec, 30)
  c.resources = [
    { id: 'vps1', kind: 'ssh', profiles: ['acme'] },
    { id: 'gh', kind: 'github', profiles: ['acme'], workflow: 'ci-broker-hosted.yml' },
  ]
  assert.deepEqual(resolveResources(c), [
    { id: 'vps1', kind: 'ssh', profiles: ['acme'], host: 'vps1', slots: 1 },
    { id: 'gh', kind: 'github', profiles: ['acme'], workflow: 'ci-broker-hosted.yml', modes: [], afterWaitSec: 900 },
  ])
  c.resources = [{ id: 'gh', kind: 'github', profiles: ['*'] }]
  assert.throws(() => resolveResources(c), /needs a workflow/)
})

// ---- trust layer: the two config owners (split), trust validation

import { chmodSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs'
import { applyLiveCaps, applyTuning, defaults, loadSplitConfig, reloadLive, validateTrust, type Config } from '../../src/ci/config.ts'
import { parseInstallConf } from '../../src/ci/install-conf.ts'

const me = process.getuid!()

/** A split layout under a temp root: install.conf paths rewritten into it; root's file owned by "root" = us. */
function split(root: unknown, tuning?: unknown) {
  const d = mkdtempSync(join(tmpdir(), 'cib-split-'))
  const ic = parseInstallConf(
    `OPERATOR=dev\nOPERATOR_GROUP=dev\nDAEMON_USER=cibroker-admin\nRUNNER_USER=cibroker-runner\nOPT_DIR=${d}/opt\nSTATE_DIR=${d}/state\nETC_DIR=${d}/etc\nTOOLS_DIR=${d}/tools\n`,
  )
  mkdirSync(join(d, 'etc'), { recursive: true })
  mkdirSync(join(d, 'state/operator'), { recursive: true })
  if (root !== undefined) {
    writeFileSync(join(d, 'etc/config.json'), typeof root === 'string' ? root : JSON.stringify(root))
    chmodSync(join(d, 'etc/config.json'), 0o644)
  }
  if (tuning !== undefined) writeFileSync(join(d, 'state/operator/tuning.json'), typeof tuning === 'string' ? tuning : JSON.stringify(tuning))
  const deps = { rootUid: me, uidOf: () => me }
  return { d, ic, deps, load: (o = deps) => loadSplitConfig(ic, o) }
}

test('trust defaults: an empty approved list, watch 300 s, offline 24 h, door limits 30/min, 1000 calls/h, 20 jobs', () => {
  const t = defaults({ HOME: '/h' }).trust
  assert.deepEqual(t, { githubUsers: [], repos: {}, watchSec: 300, localOfflineMaxAgeSec: 86400, githubDoorPerMin: 30, githubDoorCallsPerHour: 1000, githubDoorMaxJobs: 20, githubDoorPerMinTotal: 60, githubDoorCallsPerHourTotal: 2000, publicNetwork: 'ci-broker-pub', publicBoatMaxBoxes: 4 })
})

test('trust validation: pinned {login,id} and unpinned strings; bad logins, ids, repo keys and workflows refused', () => {
  const ok = { ...defaults().trust, githubUsers: [{ login: 'simple10', id: 104495 }, 'bob'], repos: { 'simple10/acme': { githubUsers: [], workflow: '.github/workflows/broker.yml', envForGithubDoor: false } } }
  assert.doesNotThrow(() => validateTrust(ok))
  const bad = (patch: any, re: RegExp) => assert.throws(() => validateTrust({ ...ok, ...patch }), re)
  bad({ githubUsers: [{ login: 'a b', id: 1 }] }, /login/)
  bad({ githubUsers: [{ login: 'a', id: 0 }] }, /positive integer/)
  bad({ githubUsers: [{ login: 'a', id: '5' }] }, /positive integer/)
  bad({ githubUsers: [{ login: 'a', id: 5, extra: 1 }] }, /entry is/)
  bad({ repos: { '../x': {} } }, /owner\/name/)
  bad({ repos: { 'a/..': {} } }, /owner\/name/)
  bad({ repos: { 'a/b': { workflow: 'ci.yml' } } }, /\.github\/workflows/)
  bad({ repos: { 'a/b': { workflow: '.github/workflows/../x.yml' } } }, /\.github\/workflows/)
  bad({ repos: { 'a/b': { pin: 1 } } }, /unknown key/)
})

test('split: paths come only from install.conf; root config read; credentials default to the daemon home', () => {
  const s = split({ daemonId: 'ub1', trust: { githubUsers: [{ login: 'simple10', id: 104495 }] }, secrets: { fetchToken: {} } })
  const c = s.load()
  assert.equal(c.layout, 'split')
  assert.equal(c.stateDir, `${s.d}/state/admin/state`)
  assert.equal(c.socketPath, `${s.d}/state/local/brokerd.sock`)
  assert.equal(c.githubSocketPath, `${s.d}/state/sock/github.sock`)
  assert.equal(c.profilesDir, `${s.d}/state/operator/profiles`)
  assert.equal(c.boatBin, `${s.d}/tools/boat`)
  assert.equal(c.ghBin, `${s.d}/tools/gh`)
  assert.deepEqual(c.credentials, { github: { file: `${s.d}/state/admin/github-token` }, boat: { configHome: `${s.d}/state/admin/.config` } })
  assert.deepEqual(c.secrets, { fetchToken: { file: `${s.d}/etc/secrets/fetchToken` } })
  assert.deepEqual(c.trust.githubUsers, [{ login: 'simple10', id: 104495 }])
  assert.equal(c.trust.watchSec, 300)
})

test('split: no path keys in root config; tokenCmd, secret cmd and ssh githubTokenCmd are single-only; unknown keys refused', () => {
  for (const k of ['stateDir', 'socketPath', 'profilesDir', 'boatBin']) assert.throws(() => split({ [k]: '/x' }).load(), new RegExp(`${k} is a path key`))
  assert.throws(() => split({ credentials: { github: { tokenCmd: 'gh auth token' } } }).load(), /tokenCmd is single-only/)
  assert.throws(() => split({ secrets: { a: { cmd: 'echo x' } } }).load(), /cmd is single-only/)
  assert.throws(() => split({ resources: [{ id: 'v', kind: 'ssh', profiles: ['*'], githubTokenCmd: 'gh auth token' }] }).load(), /githubTokenCmd is single-only/)
  assert.throws(() => split({ wat: 1 }).load(), /unknown key wat/)
})

test('split: root config must be root-owned and not group/other-writable', () => {
  const s = split({})
  chmodSync(join(s.d, 'etc/config.json'), 0o666)
  assert.throws(() => s.load(), /owned by root/)
  chmodSync(join(s.d, 'etc/config.json'), 0o644)
  assert.throws(() => s.load({ ...s.deps, rootUid: me + 1 }), /owned by root/)
})

test("tuning.json: allowlisted keys apply; a root-only or unknown key is refused naming it; no path keys", () => {
  const s = split({ resources: [{ id: 'local', kind: 'local', profiles: ['*'] }, { id: 'boat', kind: 'boat', profiles: ['*'], maxBoxes: 4 }] }, { local: { cpus: 3 }, pool: { idleStopSec: 60 }, boat: { maxBoxes: 2 }, retentionDays: 3 })
  const c = s.load()
  assert.equal(c.local.cpus, 3)
  assert.equal(c.pool.idleStopSec, 60)
  assert.equal(c.retentionDays, 3)
  // root's entry keeps its value; the resolved cap (what the pool uses) is tuning's
  assert.equal(c.resources!.find((r) => r.kind === 'boat')!.maxBoxes, 4)
  assert.equal(resolveResources(c).find((r) => r.kind === 'boat')!.maxBoxes, 2)
  for (const [t, key] of [[{ trust: { githubUsers: ['eve'] } }, 'trust.githubUsers'], [{ secrets: { x: {} } }, 'secrets.x'], [{ stateDir: '/x' }, 'stateDir'], [{ daemonId: 'x' }, 'daemonId'], [{ local: { image: 'x' } }, 'local.image'], [{ startsReserve: 1 }, 'startsReserve']] as const)
    assert.throws(() => applyTuning(defaults(), t), new RegExp(`key ${key.replace('.', '\\.')} is not allowed`))
  assert.throws(() => applyTuning(defaults(), { pool: { nope: 1 } }), /pool\.nope is unknown/)
})

test('tuning.json is an operator file: a symlink (to a key file) is refused without its content; another owner refused; bad JSON says only that', () => {
  const s = split({})
  const key = join(s.d, 'github-token')
  writeFileSync(key, 'ghp_SECRETSECRETSECRETSECRET1234')
  symlinkSync(key, join(s.d, 'state/operator/tuning.json'))
  assert.throws(() => s.load(), (e: Error) => /tuning\.json: is a symlink/.test(e.message) && !e.message.includes('SECRET'))
  const t = split({}, '{ "local": ghp_SECRETSECRETSECRETSECRET1234 }')
  assert.throws(() => t.load(), (e: Error) => /tuning\.json: not valid JSON/.test(e.message) && !e.message.includes('SECRET'))
  const u = split({}, { local: { cpus: 2 } })
  assert.throws(() => u.load({ rootUid: me, uidOf: () => me + 1 }), /tuning\.json: not owned by the operator/)
})

test('reloadLive: a new approved list and tuning apply without a restart', () => {
  const s = split({ trust: { githubUsers: [] } }, { local: { cpus: 2 } })
  const c: Config = s.load()
  writeFileSync(join(s.d, 'etc/config.json'), JSON.stringify({ trust: { githubUsers: [{ login: 'simple10', id: 104495 }] } }))
  writeFileSync(join(s.d, 'state/operator/tuning.json'), JSON.stringify({ local: { cpus: 5 } }))
  reloadLive(c, s.deps)
  assert.deepEqual(c.trust.githubUsers, [{ login: 'simple10', id: 104495 }])
  assert.equal(c.local.cpus, 5)
  assert.ok(readFileSync(join(s.d, 'etc/config.json'), 'utf8'))
})

test('reloadLive + applyLiveCaps: tuning.json boat.maxBoxes reaches the resolved boat resource without a restart', () => {
  const s = split({ trust: { githubUsers: [] } }, {})
  const c: Config = s.load()
  const res = resolveResources(c)
  const boat = res.find((r) => r.kind === 'boat')!
  assert.equal(boat.maxBoxes, 10)
  const tune = (t: unknown) => {
    writeFileSync(join(s.d, 'state/operator/tuning.json'), JSON.stringify(t))
    reloadLive(c, s.deps)
    applyLiveCaps(c, res)
  }
  tune({ boat: { maxBoxes: 20 } })
  assert.equal(boat.maxBoxes, 20)
  tune({ boat: { maxBoxes: 12 } })
  assert.equal(boat.maxBoxes, 12)
  tune({})
  assert.equal(boat.maxBoxes, 10)
})

test('single: ssh githubTokenCmd has no default; secrets may be a file or a cmd', () => {
  const c = loadConfig('/nonexistent', { HOME: '/h' })
  c.resources = [{ id: 'vps1', kind: 'ssh', profiles: ['*'] }]
  assert.equal(resolveResources(c)[0].githubTokenCmd, undefined)
  const d = mkdtempSync(join(tmpdir(), 'cib-'))
  writeFileSync(join(d, 'c.json'), JSON.stringify({ secrets: { a: { cmd: 'echo x' }, b: { file: '/x' } } }))
  assert.deepEqual(loadConfig(join(d, 'c.json'), { HOME: '/h' }).secrets, { a: { cmd: 'echo x' }, b: { file: '/x' } })
})
