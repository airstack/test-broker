// The public lane on Boat: root's trust.repos.<repo>.publicBoat names an environment that injects nothing, used by
// that repo's public lane only. The scheduler, the pool and the executor each check it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { envInjects } from '../../src/core/boat.ts'
import { ConfigError, publicBoatEnv, publicBoatEnvs, TRUST_DEFAULTS, validateTrust, type ResourceCfg } from '../../src/ci/config.ts'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Db, SCHEMA_VERSION } from '../../src/ci/db.ts'
import { harness, idOf, makeOrigin, pushCommit, TEST_PROFILE, tmp, until } from '../harness.ts'

// ssh and GitHub-hosted are set up and serve every profile: the public lane must still never use them
const RES: ResourceCfg[] = [
  { id: 'local', kind: 'local', profiles: ['*'] },
  { id: 'vps1', kind: 'ssh', profiles: ['*'], host: 'vps1', slots: 2 },
  { id: 'boat', kind: 'boat', profiles: ['*'], maxBoxes: 6 },
  { id: 'gh', kind: 'github', profiles: ['*'], workflow: 'ci-broker-hosted.yml', modes: ['one'], afterWaitSec: 0 },
]
const PUB_PROFILE = { ...TEST_PROFILE, local: { where: 'container', image: 'i', commands: { one: 'echo one' } } }
const trust = (repos: Record<string, any>, more: Record<string, unknown> = {}) => ({ ...structuredClone(TRUST_DEFAULTS), repos, ...more })

function setup(o: { repos?: Record<string, any>; more?: Record<string, unknown>; profile?: any } = {}) {
  const h = harness({ resources: RES, profile: o.profile ?? PUB_PROFILE, cfg: { trust: trust(o.repos ?? { 'me/app': { publicBoat: 'pub-app' } }, o.more) as any } })
  h.boat.envs['pub-app'] = { version: 3, injects: [] }
  h.boat.envs.acme = { version: 1, injects: ['safeForThirdParties is not true', 'passGithub'] }
  h.local.busy = true
  return h
}
const pubJob = (h: ReturnType<typeof setup>, sha: string, mode = 'one') => h.d.c.jobs.submit({ repo: 'me/app', profile: 'app', mode, commit: sha, detach: true, lane: 'public', env: 'noenv' })

test('config: publicBoat is an environment name, one repo per environment; publicBoatMaxBoxes defaults to 4', () => {
  assert.equal(TRUST_DEFAULTS.publicBoatMaxBoxes, 4)
  validateTrust(trust({ 'me/a': { publicBoat: 'pub-a' }, 'me/b': { publicBoat: 'pub-b' } }) as any)
  assert.throws(() => validateTrust(trust({ 'me/a': { publicBoat: 'bad name' } }) as any), (e: any) => e instanceof ConfigError && /publicBoat: a Boat environment name/.test(e.message))
  assert.throws(() => validateTrust(trust({ 'me/a': { publicBoat: 'p' }, 'me/b': { publicBoat: 'p' } }) as any), /p is me\/a's already/)
  assert.throws(() => validateTrust(trust({}, { publicBoatMaxBoxes: 0 }) as any), /publicBoatMaxBoxes: must be a positive number/)
  const t = trust({ 'Me/App': { publicBoat: 'pub-app' }, 'me/x': {} }) as any
  assert.equal(publicBoatEnv(t, 'me/app'), 'pub-app', 'repo names match without case')
  assert.equal(publicBoatEnv(t, 'me/x'), null)
  assert.deepEqual([...publicBoatEnvs(t)], ['pub-app'])
})

test('envInjects: empty only when the environment injects nothing; anything missing counts as injected', () => {
  const clean = {
    name: 'p', safeForThirdParties: true, proxyAiCredentials: false, credentialProfileId: null, envContents: '', secretFiles: [], selectedRepositories: [],
    effective: { passAgentsCredentials: false, passGithub: false, passSandboxCredentials: false, passSecrets: false },
  }
  assert.deepEqual(envInjects(clean), [])
  // the plugins environment (private): GitHub on, a repo, the master switch off
  assert.deepEqual(envInjects({ ...clean, safeForThirdParties: false, effective: { ...clean.effective, passGithub: true }, selectedRepositories: [{ fullName: 'me/x' }] }), ['safeForThirdParties is not true', 'passGithub', 'repos'])
  assert.deepEqual(envInjects({ ...clean, envContents: 'A=1\n', secretFiles: [{ path: 'x' }], credentialProfileId: 'c1', proxyAiCredentials: true }), ['proxyAiCredentials', 'a credential profile', 'secret files', 'variables'])
  const { effective: _e, ...noEff } = clean
  assert.deepEqual(envInjects(noEff), ['no effective toggles'])
  assert.deepEqual(envInjects({ ...clean, effective: { passGithub: false } }), ['passSecrets', 'passSandboxCredentials', 'passAgentsCredentials'])
  // Boat's newer answer: a count of variables instead of their text
  const { envContents: _c, ...counted } = clean
  assert.deepEqual(envInjects({ ...counted, variables: 0 }), [])
  assert.deepEqual(envInjects({ ...counted, variables: 2 }), ['variables'])
  assert.deepEqual(envInjects(counted), ['variables'], 'neither field: counted as injected')
  assert.deepEqual(envInjects({ ...clean, variables: 3 }), ['variables'], 'an empty text does not hide a count')
  assert.deepEqual(envInjects({ ...clean, variables: 0 }), [])
  assert.deepEqual(envInjects(null), ['no environment in the answer'])
})

test('a public-lane job with root\'s publicBoat: the local slot busy, its shard goes to a box in that environment (never the profile\'s)', async () => {
  const h = setup()
  const o = makeOrigin(h.origins, 'me/app')
  const r = await pubJob(h, o.sha)
  await h.pass()
  await until(() => h.ctl.pending.length === 1)
  assert.equal(h.boat.boxes.length, 1)
  assert.equal(h.boat.boxes[0].environment, 'pub-app', 'root\'s environment, not the profile\'s boatEnvironment (acme)')
  assert.ok(h.boat.calls.filter((c) => c === 'env info pub-app').length >= 2, 'the scheduler and the executor both checked it')
  const row = h.d.c.db.box(h.boat.boxes[0].name)!
  assert.deepEqual([row.pubRepo, row.envVersion], ['me/app', 3], 'marked for the repo, at its first-seen version')
  assert.match(h.d.c.db.shards(idOf(r.id))[0].where!, /^boat:/, 'not ssh, not GitHub-hosted')
  h.ctl.pending[0].done(0)
  await h.settle()
  assert.equal(h.d.c.db.job(idOf(r.id))!.state, 'passed')
  // the next job reuses the box (no new start)
  const before = h.boat.startsUsed
  await pubJob(h, pushCommit(o.work, 'f.txt', 'v2\n'))
  await h.pass()
  await until(() => h.ctl.pending.length === 1)
  assert.equal(h.boat.boxes.length, 1)
  assert.equal(h.boat.startsUsed, before)
  h.ctl.pending[0].done(0)
  await h.settle()
})

test('without publicBoat a public-lane job still waits for the local slot (never Boat)', async () => {
  const h = setup({ repos: {} })
  const o = makeOrigin(h.origins, 'me/app')
  const r = await pubJob(h, o.sha)
  await h.pass()
  assert.match(h.d.c.db.job(idOf(r.id))!.waitWhy!, /public lane: local only/)
  assert.equal(h.boat.boxes.length, 0)
  assert.ok(!h.boat.calls.some((c) => c.startsWith('env info')))
})

test('an environment that injects anything: the job waits, no box, a TRUST log line', async () => {
  const h = setup()
  h.boat.envs['pub-app'] = { version: 4, injects: ['passGithub'] }
  const o = makeOrigin(h.origins, 'me/app')
  const r = await pubJob(h, o.sha)
  await h.pass()
  const j = h.d.c.db.job(idOf(r.id))!
  assert.equal(j.state, 'queued')
  assert.match(j.waitWhy!, /public environment pub-app injects passGithub/)
  assert.equal(h.boat.boxes.length, 0)
  assert.ok(h.logs.some((l) => /^TRUST public environment pub-app injects passGithub/.test(l)))
})

test('an environment that cannot be checked: the job waits (no box)', async () => {
  const h = setup()
  h.boat.failEnvInfo = true
  const o = makeOrigin(h.origins, 'me/app')
  const r = await pubJob(h, o.sha)
  await h.pass()
  assert.match(h.d.c.db.job(idOf(r.id))!.waitWhy!, /pub-app could not be checked/)
  assert.equal(h.boat.boxes.length, 0)
})

test('an adopted box in the public environment (not made by its public lane) is deleted, never used; a new box is made', async () => {
  const h = setup()
  await h.d.c.pool!.reconcile()
  const old = h.boat.addBox('cib-tst-pub-app-default-aaaaaa', 'stopped', 'default', { environment: 'pub-app', environmentVersion: 2, stoppedAt: Date.now() })
  await h.d.c.pool!.reconcile()
  assert.ok(h.d.c.db.box(old.name), 'adopted')
  const o = makeOrigin(h.origins, 'me/app')
  await pubJob(h, o.sha)
  await h.pass()
  await until(() => h.ctl.pending.length === 1)
  await until(() => !h.boat.byName(old.name), 'the v2 box is deleted')
  assert.equal(h.boat.boxes.length, 1)
  assert.equal(h.boat.boxes[0].environmentVersion, 3)
  assert.ok(h.logs.some((l) => l.includes(`box ${old.name}: deleted (in public environment pub-app but not made by its public lane)`)))
  h.ctl.pending[0].done(0)
  await h.settle()
})

test('the environment turns unsafe after placement: the executor\'s own check fails the shard before anything goes to the box', async () => {
  const h = setup()
  let open!: () => void
  h.boat.gate.create = new Promise<void>((r) => (open = r))
  const o = makeOrigin(h.origins, 'me/app')
  const r = await pubJob(h, o.sha)
  await h.pass()
  await until(() => h.boat.calls.some((c) => c.startsWith('create ')))
  h.boat.envs['pub-app'] = { version: 4, injects: ['passSecrets'] }
  open()
  await h.settle()
  const j = h.d.c.db.job(idOf(r.id))!
  assert.notEqual(j.state, 'passed')
  assert.equal(h.ctl.pending.length, 0, 'nothing ran on the box')
  // never run: back to the queue (avoiding that box), and the job waits on the gate
  assert.equal(j.state, 'running')
  assert.match(j.waitWhy!, /public environment pub-app injects passSecrets/)
  const sh = h.d.c.db.shards(j.id)[0]
  assert.equal(sh.state, 'queued')
  assert.equal(sh.startedAt, null)
  assert.equal(sh.attempt, 1, 'a refusal is not an infra failure: the retry is not spent')
  assert.ok(h.logs.some((l) => /requeue: trust: boat: public environment pub-app injects passSecrets/.test(l)), h.logs.join('\n'))
})

test('a full-lane job never uses a public-lane environment, even when its profile names one', async () => {
  const h = setup({ profile: { ...PUB_PROFILE, boatEnvironment: 'pub-app' } })
  const o = makeOrigin(h.origins, 'me/app')
  const r = await h.d.c.jobs.submit({ repo: 'me/app', profile: 'app', mode: 'one', commit: o.sha, detach: true, lane: 'full', env: 'noenv' })
  await h.pass()
  await h.pass()
  assert.equal(h.boat.boxes.length, 0, 'no box in the public environment')
  const s = h.d.c.db.shards(idOf(r.id))[0]
  assert.ok(!s.where?.startsWith('boat:'), s.where ?? '')
  assert.ok(h.d.c.jobs !== undefined)
})

test('publicBoatMaxBoxes caps new boxes over every public environment', async () => {
  const h = setup({ repos: { 'me/app': { publicBoat: 'pub-app' }, 'me/other': { publicBoat: 'pub-other' } }, more: { publicBoatMaxBoxes: 1 } })
  h.boat.addBox('cib-tst-pub-other-default-bbbbbb', 'running', 'default', { environment: 'pub-other', environmentVersion: 1 })
  await h.d.c.pool!.reconcile()
  const o = makeOrigin(h.origins, 'me/app')
  const r = await pubJob(h, o.sha)
  await h.pass()
  assert.match(h.d.c.db.job(idOf(r.id))!.waitWhy!, /the public lane has 1 box\(es\), its cap \(trust.publicBoatMaxBoxes 1\)/)
  assert.equal(h.boat.boxes.length, 1)
})

/** One passed public-lane job, so the pool holds an idle box marked for me/app at v3. */
async function withPublicBox() {
  const h = setup()
  const o = makeOrigin(h.origins, 'me/app')
  await pubJob(h, o.sha)
  await h.pass()
  await until(() => h.ctl.pending.length === 1)
  h.ctl.pending[0].done(0)
  await h.settle()
  const box = h.boat.boxes[0]
  assert.equal(h.d.c.db.box(box.name)!.state, 'idle')
  return { h, box, o }
}

test('boat env upgrade re-pins a box to a new version: it is never used again, and deleted', async () => {
  const { h, box, o } = await withPublicBox()
  h.boat.envs['pub-app'] = { version: 4, injects: [] }
  box.environmentVersion = 4
  h.advance(31_000)
  await pubJob(h, pushCommit(o.work, 'f.txt', 'v2\n'))
  await h.pass()
  await until(() => h.ctl.pending.length === 1)
  await until(() => !h.boat.byName(box.name), 'the re-pinned box is deleted')
  assert.ok(h.logs.some((l) => l.includes(`box ${box.name}: deleted (at pub-app v4 (first v3), not the checked v4)`)))
  h.ctl.pending[0].done(0)
  await h.settle()
})

test('root removes publicBoat: the box the public lane used never takes a full-lane job (the mark is on the row)', async () => {
  const { h, box } = await withPublicBox()
  h.cfg.trust.repos = {}
  // a full-lane pick in the old public environment (a profile could name it now): never the marked box
  const got = await h.d.c.pool!.place({ env: 'pub-app', size: 'default', repo: 'me/app', avoid: [] })
  assert.ok('box' in got)
  assert.notEqual(got.box, box.name)
  assert.equal(h.d.c.db.box(got.box)!.pubRepo, null)
})

test('a public environment moved to another repo: the first repo\'s box is not the new repo\'s', async () => {
  const { h, box } = await withPublicBox()
  h.cfg.trust.repos = { 'me/other': { publicBoat: 'pub-app' } }
  h.advance(31_000)
  const g = await h.d.c.pool!.publicGate('pub-app', 'me/other', { envs: new Set(['pub-app']), max: 4 })
  assert.ok('allow' in g)
  assert.equal(g.allow(h.d.c.db.box(box.name) ?? ({} as any)), false)
  assert.ok(!h.boat.byName(box.name), 'deleted: it is me/app\'s')
})

test('a box Boat lists without an environment version is never fit, and is deleted once idle', async () => {
  const { h, box } = await withPublicBox()
  delete box.environmentVersion
  h.d.c.db.updateBox(box.name, { envVersion: null })
  h.advance(31_000)
  const g = await h.d.c.pool!.publicGate('pub-app', 'me/app', { envs: new Set(['pub-app']), max: 4 })
  assert.ok('allow' in g)
  assert.ok(!h.boat.byName(box.name))
  assert.ok(h.logs.some((l) => l.includes(`box ${box.name}: deleted (Boat lists no pub-app version for it)`)))
})

test('health check, public lane: through the gate, on a box marked for the repo; a refusal is "not checked", never failing', async () => {
  const h = setup({ profile: { ...PUB_PROFILE, check: ['cmd', 'echo checking'] } })
  makeOrigin(h.origins, 'me/app')
  const lanes = new Map([['app', { lane: 'public' as const, env: 'noenv' as const }]])
  const out: any[] = []
  const p = h.d.c.checks.run('boat', { profile: 'app', lanes }, (e) => out.push(e))
  await until(() => h.ctl.pending.length === 1 || out.some((e) => e.t === 'result'), 'the check runs')
  assert.equal(h.ctl.pending.length, 1, JSON.stringify(out))
  h.ctl.pending[0].done(0)
  assert.equal(await p, 0)
  const b = h.boat.boxes[0]
  assert.equal(b.environment, 'pub-app')
  assert.equal(h.d.c.db.box(b.name)!.pubRepo, 'me/app')
  h.boat.envs['pub-app'] = { version: 5, injects: ['passGithub'] }
  h.advance(31_000)
  await h.d.c.checks.run('boat', { profile: 'app', lanes }, (e) => out.push(e))
  assert.ok(out.some((e) => /not checked: boat: public environment pub-app injects passGithub/.test(JSON.stringify(e))), JSON.stringify(out))
  assert.equal(h.d.c.db.health('boat', 'app').failing, false)
})

test('health check, full lane: refused in a public environment', async () => {
  const h = setup({ profile: { ...PUB_PROFILE, boatEnvironment: 'pub-app', check: ['cmd', 'echo checking'] } })
  makeOrigin(h.origins, 'me/app')
  const out: any[] = []
  await h.d.c.checks.run('boat', { profile: 'app', lanes: new Map([['app', { lane: 'full' as const, env: 'noenv' as const }]]) }, (e) => out.push(e))
  assert.ok(out.some((e) => /pub-app is a public-lane environment: never a full-lane job/.test(JSON.stringify(e))), JSON.stringify(out))
  assert.equal(h.boat.boxes.length, 0)
})

test('config: two repo keys that differ only in case are refused', () => {
  assert.throws(() => validateTrust(trust({ 'Me/App': {}, 'me/app': { publicBoat: 'p' } }) as any), /are one repo/)
})

test('db: a v3 file is migrated in place (jobs kept), boxes get pub_repo and env_version', () => {
  const path = join(tmp(), 'brokerd.db')
  const fresh = new Db(path)
  fresh.raw.exec('ALTER TABLE boxes DROP COLUMN pub_repo; ALTER TABLE boxes DROP COLUMN env_version; PRAGMA user_version = 3')
  fresh.raw.exec("INSERT INTO boxes (name, boat_id, env, size, state, since, last_repo, last_used, infra_fails, reason, created_at) VALUES ('b1', 'bx_1', 'acme', 'default', 'idle', 1, NULL, 1, 0, NULL, 1)")
  fresh.close()
  const db = new Db(path, 99)
  assert.equal(db.movedAside, null)
  assert.equal((db.raw.prepare('PRAGMA user_version').get() as any).user_version, SCHEMA_VERSION)
  const b = db.box('b1')!
  assert.deepEqual([b.pubRepo, b.envVersion], [null, null])
  db.markBoxPublic('b1', 'Me/App')
  db.markBoxPublic('b1', 'me/other')
  assert.equal(db.box('b1')!.pubRepo, 'me/app', 'set once, lowercased')
  db.close()
  void DatabaseSync
})
