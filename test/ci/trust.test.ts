// Admission: every check id at both doors, as pure calls on a Trust over FakeGithubApi (recorded fixtures through
// the real parser), a real TrustDb and (for check 14) a real mirror.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defaults, TRUST_DEFAULTS, type Config } from '../../src/ci/config.ts'
import { TrustDb } from '../../src/ci/db.ts'
import { GithubApi } from '../../src/ci/daemon/github-api.ts'
import { Mirror, realGit } from '../../src/core/mirror.ts'
import { argsDigest, Trust, TrustRefusal, type GithubReq } from '../../src/ci/daemon/trust.ts'
import { ProfileError, type Profile } from '../../src/ci/profile.ts'
import { DEPENDABOT, EVE, FakeGithubApi, SIMPLE10, VU, type Account } from '../fake-github-api.ts'
import { makeOrigin, pushCommit, sh, tmp } from '../harness.ts'

const SHA = 'a'.repeat(40)
const SHA2 = 'b'.repeat(40)

const PROFILE = (o: Partial<Profile> = {}): Profile => ({
  name: 'app', repo: 'me/app', remoteScript: 'remote.sh', dir: '/nonexistent',
  local: { where: 'container', image: 'img', commands: { one: 'echo one', cmd: '{cmd}', all: 'echo all' } },
  github: { prMode: 'all' },
  modes: { all: 'one', one: [{ name: 'one', size: 'default', args: ['one'] }], cmd: [{ name: 'cmd', size: 'default', args: ['cmd'], passArgs: true, requireArgs: 'x' }], hostonly: [{ name: 'h', size: 'default', args: [] }] },
  ...o,
})

function setup(o: { cfg?: Partial<Config>; profiles?: Record<string, Profile>; runners?: string[] } = {}) {
  const f = new FakeGithubApi()
  f.setRepo('me/app')
  const clock = { t: 1_794_370_000_000 }
  const logs: string[] = []
  const tdb = new TrustDb(':memory:')
  const cfg: Config = { ...defaults({ HOME: tmp() }), layout: 'split', ...o.cfg }
  cfg.trust = { ...TRUST_DEFAULTS, githubUsers: [SIMPLE10, VU], ...o.cfg?.trust }
  const profiles: Record<string, Profile> = o.profiles ?? { app: PROFILE(), other: PROFILE({ name: 'other', repo: 'me/other' }) }
  const state = { merged: new Set<string>(), fetchFails: false, active: 0, net: { ok: true, why: '' } as { ok: boolean; why: string } | null, secrets: new Set<string>(), credentialSecrets: new Set<string>(), sshSecret: false }
  const api = new GithubApi({ run: f.run, now: () => clock.t, sleep: async () => {} })
  const trust = new Trust({
    cfg, tdb, api, now: () => clock.t, log: (m) => void logs.push(m),
    profile: (n) => {
      if (!profiles[n]) throw new ProfileError(`no profile '${n}'`)
      return profiles[n]
    },
    secretState: (n) => (state.credentialSecrets.has(n) ? 'credential' : state.secrets.has(n) ? 'set' : 'unset'),
    sshSecret: () => state.sshSecret,
    isMerged: async (_r, sha) => {
      if (state.fetchFails) throw new Error('fatal: unable to access origin')
      return state.merged.has(sha)
    },
    runnerNames: () => o.runners ?? ['host-app-r1'],
    activeGithubJobs: () => state.active,
    publicNet: () => state.net,
  })
  return { f, clock, logs, tdb, cfg, trust, state, profiles }
}
type S = ReturnType<typeof setup>

async function refused(p: Promise<unknown>, check: string, re?: RegExp) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof TrustRefusal, String(e))
    assert.equal(e.info.check, check, e.message)
    assert.equal(e.status, 403)
    if (re) assert.match(e.message, re)
    return true
  })
}

/** a dispatch run by `actor` (title binding mode, sha and args) */
function dispatch(s: S, o: { runId?: number; sha?: string; mode?: string; args?: string[]; actor?: Account; triggering?: Account; branch?: string; title?: string } = {}) {
  const runId = o.runId ?? 4411
  const sha = o.sha ?? SHA
  s.f.addRun({ repo: 'me/app', runId, sha, branch: o.branch ?? 'main', actor: o.actor, triggering: o.triggering, title: o.title ?? `broker ${o.mode ?? 'one'} ${sha} ${argsDigest(o.args ?? [])}` })
  const req: GithubReq = { repo: 'me/app', runId: String(runId), runAttempt: '1', ref: 'refs/heads/main', sha, mode: o.mode ?? 'one', args: o.args ?? [] }
  return req
}
/** a PR run: PR #n by `author`, the run's actor `actor` */
function prRun(s: S, o: { n?: number; runId?: number; sha?: string; branch?: string; author?: Account; actor?: Account; files?: { filename: string; previous_filename?: string }[]; changedFiles?: number } = {}) {
  const n = o.n ?? 7
  const runId = o.runId ?? 5511
  const sha = o.sha ?? SHA
  s.f.addRun({ repo: 'me/app', runId, event: 'pull_request', sha, branch: o.branch ?? 'feat', actor: o.actor, title: `broker pr #${n} ${sha}` })
  s.f.addPull({ repo: 'me/app', n, sha, branch: o.branch ?? 'feat', author: o.author, files: o.files, changedFiles: o.changedFiles })
  const req: GithubReq = { repo: 'me/app', runId: String(runId), runAttempt: '1', ref: `refs/pull/${n}/merge`, sha, mode: 'all', args: [] }
  return req
}

// ---------------------------------------------------------------- argsDigest

test('argsDigest: sha256 of the compact JSON (what jq -c prints); - for none', () => {
  assert.equal(argsDigest(['--grep', 'x']), createHash('sha256').update('["--grep","x"]').digest('hex'))
  assert.equal(argsDigest([]), '-')
})

// ---------------------------------------------------------------- 1. rate

test('rate: the 31st request in a minute is refused before any API call', async () => {
  const s = setup()
  const req = dispatch(s)
  for (let i = 0; i < 30; i++) await s.trust.admitGithub({ ...req, runId: String(100 + i) }, 'admit').catch(() => {})
  const n = s.f.calls.length
  await refused(s.trust.admitGithub(req, 'admit'), 'rate', /30 requests for me\/app in the last minute/)
  assert.equal(s.f.calls.length, n, 'no API call for a rate refusal')
  s.clock.t += 61_000
  await s.trust.admitGithub(req, 'admit')
})

test('rate: the hourly API budget; the 6th admit of one run', async () => {
  const s = setup({ cfg: { trust: { ...TRUST_DEFAULTS, githubUsers: [VU], githubDoorCallsPerHour: 3, githubDoorPerMin: 100 } as any } })
  const req = dispatch(s)
  await s.trust.admitGithub(req, 'admit') // repo, attempt, jobs = 3 calls
  await refused(s.trust.admitGithub(req, 'admit'), 'rate', /3 API calls for me\/app in the last hour/)
  const t = setup()
  const r2 = dispatch(t)
  for (let i = 0; i < 5; i++) await t.trust.admitGithub(r2, 'admit')
  await refused(t.trust.admitGithub(r2, 'admit'), 'rate', /5 times/)
})

test('rate limits from the API → github-api with the reset time; no call until then', async () => {
  const s = setup()
  const req = dispatch(s)
  s.f.rateLimited('primary')
  await refused(s.trust.admitGithub(req, 'admit'), 'github-api', /rate limited until \d\d:\d\d.*refusing/)
  const n = s.f.calls.length
  await refused(s.trust.admitGithub(req, 'admit'), 'github-api', /rate limited/)
  assert.equal(s.f.calls.length, n)
  const t = setup()
  const r2 = dispatch(t)
  t.f.rateLimited('secondary')
  await refused(t.trust.admitGithub(r2, 'admit'), 'github-api', /rate limited until/)
})

// ---------------------------------------------------------------- 2. request, 3. profile, 4. blocked

test('request: bad names at both doors (.. segments, a path profile, mode ., a short sha, 65 args)', async () => {
  const s = setup()
  const ok = dispatch(s)
  for (const [bad, re] of [[{ repo: 'me/..' }, /repo/], [{ repo: '../x' }, /repo/], [{ profile: '../x' }, /profile/], [{ mode: '.' }, /mode/], [{ sha: 'a'.repeat(41) }, /sha/], [{ args: Array(65).fill('x') }, /64 args/], [{ runId: '1;2' }, /runId/], [{ ref: 'main' }, /ref/]] as const) {
    await refused(s.trust.admitGithub({ ...ok, ...(bad as any) }, 'submit'), 'request', re)
    if (!('runId' in bad) && !('ref' in bad)) await refused(s.trust.admitLocal({ repo: 'me/app', mode: 'one', ...(bad as any) }), 'request', re)
  }
})

test('profile: missing, or another repo\'s profile → refused at both doors', async () => {
  const s = setup()
  await refused(s.trust.admitLocal({ repo: 'me/app', profile: 'nope', mode: 'one' }), 'profile', /no profile/)
  await refused(s.trust.admitLocal({ repo: 'me/app', profile: 'other', mode: 'one' }), 'profile', /is for me\/other, not me\/app/)
  await refused(s.trust.admitGithub({ ...dispatch(s), profile: 'other' }, 'submit'), 'profile', /default profile app, not other/)
  await refused(s.trust.admitLocal({ repo: 'me/zzz', mode: 'one' }), 'profile', /no profile 'zzz'/)
})

test('blocked: refused at both doors with the unblock hint', async () => {
  const s = setup()
  s.tdb.setBlock('me/app', s.clock.t, 'tier private → public')
  await refused(s.trust.admitLocal({ repo: 'me/app', mode: 'one' }), 'blocked', /trust unblock me\/app/)
  await refused(s.trust.admitGithub(dispatch(s), 'admit'), 'blocked')
})

test('every refusal: a log line and an events row naming the check', async () => {
  const s = setup()
  await refused(s.trust.admitLocal({ repo: 'me/app', profile: 'other', mode: 'one' }), 'profile')
  assert.match(s.logs.at(-1)!, /^TRUST refused door=local repo=me\/app check=profile: profile other is for me\/other/)
  const e = s.tdb.events({ limit: 1 })[0]
  assert.deepEqual([e.door, e.ok, e.checkId, e.repo], ['local', 0, 'profile', 'me/app'])
  assert.match(e.reason, /^refused \(trust\/profile\)/)
})

// ---------------------------------------------------------------- 5. repo (GitHub door: always live)

test('repo at the GitHub door: no push, 404, renamed → repo-access; public → repo-tier; offline/500/timeout → github-api', async () => {
  const cases: [(s: S) => void, string, RegExp][] = [
    [(s) => s.f.setRepo('me/app', { push: false }), 'repo-access', /cannot push/],
    [(s) => s.f.setRepo('me/app', null), 'repo-access', /not found/],
    [(s) => s.f.setRepo('me/app', { fullName: 'me/renamed' }), 'repo-access', /renamed/],
    [(s) => s.f.setRepo('me/app', { private: false }), 'repo-tier', /public/],
    [(s) => (s.f.offline = true), 'github-api', /unreachable/],
    [(s) => s.f.failNext(/repos\/me\/app$/, 500, {}, 3), 'github-api', /HTTP 500/],
    [(s) => (s.f.timeout = /repos\/me\/app$/), 'github-api', /timeout/],
  ]
  for (const [mut, check, re] of cases) {
    const s = setup()
    const req = dispatch(s)
    mut(s)
    await refused(s.trust.admitGithub(req, 'admit'), check, re)
  }
})

test('the GitHub door never uses the tier cache', async () => {
  const s = setup()
  s.tdb.setTier('me/app', 'private', s.clock.t)
  s.f.setRepo('me/app', { private: false })
  await refused(s.trust.admitGithub(dispatch(s), 'admit'), 'repo-tier')
  assert.equal(s.f.count(/^repos\/me\/app$/), 1)
})

// ---------------------------------------------------------------- the local door's tier

test('local tier: a young cache row is used with no call; a stale one is refreshed live', async () => {
  const s = setup()
  s.tdb.setTier('me/app', 'private', s.clock.t - 60_000)
  assert.equal((await s.trust.admitLocal({ repo: 'me/app', mode: 'one' })).lane, 'full')
  assert.equal(s.f.calls.length, 0)
  s.clock.t += 2 * 300_000
  s.f.setRepo('me/app', { private: false })
  const a = await s.trust.admitLocal({ repo: 'me/app', mode: 'one' })
  assert.equal(a.lane, 'public')
  assert.equal(s.f.calls.length, 1)
  assert.equal(s.tdb.tier('me/app')!.tier, 'public')
})

test('local tier offline: a 3 h old private → full lane (noted); 30 h old or none → public lane; a cached none is still refused', async () => {
  const s = setup()
  s.f.offline = true
  s.tdb.setTier('me/app', 'private', s.clock.t - 3 * 3600_000)
  const a = await s.trust.admitLocal({ repo: 'me/app', mode: 'one' })
  assert.equal(a.lane, 'full')
  assert.match(a.note!, /GitHub unreachable \(.*\); using the tier private checked 3h ago/)
  const ev = s.tdb.events({ limit: 1 })[0]
  assert.deepEqual([ev.ok, ev.door], [2, 'local'])
  assert.match(s.logs.at(-1)!, /TRUST offline door=local repo=me\/app/)
  s.tdb.setTier('me/app', 'private', s.clock.t - 30 * 3600_000)
  const b = await s.trust.admitLocal({ repo: 'me/app', mode: 'one' })
  assert.equal(b.lane, 'public')
  assert.match(b.note!, /no recent tier, running in the public lane/)
  const t = setup()
  t.f.offline = true
  assert.equal((await t.trust.admitLocal({ repo: 'me/app', mode: 'one' })).lane, 'public')
  t.tdb.setTier('me/app', 'none', t.clock.t - 3600_000)
  await refused(t.trust.admitLocal({ repo: 'me/app', mode: 'one' }), 'repo-access')
})

test('local tier: an explicit none (404, no push, renamed) is refused; public → the public lane', async () => {
  for (const mut of [{ push: false }, null, { fullName: 'x/y' }] as const) {
    const s = setup()
    s.f.setRepo('me/app', mut as any)
    await refused(s.trust.admitLocal({ repo: 'me/app', mode: 'one' }), 'repo-access', /is not ours/)
  }
  const s = setup()
  s.f.setRepo('me/app', { private: false })
  const a = await s.trust.admitLocal({ repo: 'me/app', mode: 'one' })
  assert.deepEqual([a.lane, a.env, a.tier], ['public', 'noenv', 'public'])
})

test('local door, public lane: container local command only; the network checked; no remote check; single refuses it', async () => {
  const s = setup()
  s.f.setRepo('me/app', { private: false })
  await refused(s.trust.admitLocal({ repo: 'me/app', mode: 'hostonly' }), 'public-local-only', /no local command for hostonly/)
  s.profiles.app = PROFILE({ local: { where: 'host', commands: { one: 'x' } } })
  s.tdb.setTier('me/app', 'public', s.clock.t)
  await refused(s.trust.admitLocal({ repo: 'me/app', mode: 'one' }), 'host-mode')
  s.cfg.layout = 'single'
  await refused(s.trust.admitLocal({ repo: 'me/app', mode: 'one' }), 'public-local-only', /split layout/)
  s.cfg.layout = 'split'
  s.profiles.app = PROFILE()
  await refused(s.trust.admitLocal({ repo: 'me/app', mode: 'one' }, { resourceKind: 'boat' }), 'public-remote')
  // root's publicBoat opens Boat (only Boat) to the repo's public lane
  s.cfg.trust.repos['me/app'] = { publicBoat: 'pub-app' }
  assert.equal((await s.trust.admitLocal({ repo: 'me/app', mode: 'one' }, { resourceKind: 'boat' })).lane, 'public')
  await refused(s.trust.admitLocal({ repo: 'me/app', mode: 'one' }, { resourceKind: 'ssh' }), 'public-remote', /local resource or Boat, not ssh/)
  delete s.cfg.trust.repos['me/app']
  s.state.net = { ok: false, why: 'reached 10.0.0.1' }
  await refused(s.trust.admitLocal({ repo: 'me/app', mode: 'one' }), 'public-net', /reached 10\.0\.0\.1/)
  s.state.net = null
  await refused(s.trust.admitLocal({ repo: 'me/app', mode: 'one' }), 'public-net', /not been checked/)
})

test('local door: split refuses host-mode commands; single allows them; env class and the missing-secret refusal', async () => {
  const s = setup({ profiles: { app: PROFILE({ local: { where: 'host', commands: { one: 'x' } } }) } })
  await refused(s.trust.admitLocal({ repo: 'me/app', mode: 'one' }), 'host-mode', /no host mode/)
  assert.equal((await s.trust.admitLocal({ repo: 'me/app', mode: 'cmd', args: ['x'] })).lane, 'full', 'no local command for the mode: it never runs on the host')
  s.cfg.layout = 'single'
  assert.equal((await s.trust.admitLocal({ repo: 'me/app', mode: 'one' })).lane, 'full')
  const t = setup({ profiles: { app: PROFILE({ local: { where: 'container', image: 'i', env: { GITHUB_TOKEN: 'fetchToken' }, commands: { one: 'x' } } }) } })
  await refused(t.trust.admitLocal({ repo: 'me/app', mode: 'one' }), 'profile', /secret fetchToken is not set/)
  assert.equal((await t.trust.admitLocal({ repo: 'me/app', mode: 'hostonly' })).env, 'env', 'no local command for the mode: no secret needed now')
  t.state.secrets.add('fetchToken')
  assert.equal((await t.trust.admitLocal({ repo: 'me/app', mode: 'one' })).env, 'env')
  t.f.setRepo('me/app', { private: false })
  t.tdb.setTier('me/app', 'public', t.clock.t)
  t.state.secrets.clear()
  assert.equal((await t.trust.admitLocal({ repo: 'me/app', mode: 'one' })).env, 'noenv', 'the public lane never gets job secrets')
})

// ---------------------------------------------------------------- 6. approved-list

test('approved-list: empty; only unpinned entries; a per-repo list REPLACES the global one', async () => {
  const s = setup({ cfg: { trust: { ...TRUST_DEFAULTS, githubUsers: [] } as any } })
  await refused(s.trust.admitGithub(dispatch(s), 'admit'), 'approved-list')
  const t = setup({ cfg: { trust: { ...TRUST_DEFAULTS, githubUsers: ['octo-other', 'simple10'] } as any } })
  await refused(t.trust.admitGithub(dispatch(t), 'admit'), 'approved-list', /no pinned entry/)
  const u = setup({ cfg: { trust: { ...TRUST_DEFAULTS, githubUsers: [VU], repos: { 'Me/App': { githubUsers: [] } } } as any } })
  await refused(u.trust.admitGithub(dispatch(u), 'admit'), 'approved-list')
  const v = setup({ cfg: { trust: { ...TRUST_DEFAULTS, githubUsers: [VU], repos: { 'me/app': { githubUsers: [SIMPLE10] } } } as any } })
  await refused(v.trust.admitGithub(dispatch(v), 'admit'), 'actor', /octo-other/)
})

// ---------------------------------------------------------------- 7. run

test('run: unknown, another repo\'s, completed, attempt mismatch', async () => {
  const s = setup()
  await refused(s.trust.admitGithub({ repo: 'me/app', runId: '1', runAttempt: '1', ref: 'refs/heads/main' }, 'admit'), 'run', /no run 1\.1/)
  const t = setup()
  t.f.addRun({ repo: 'me/other', runId: 9, sha: SHA })
  t.f.mutate(/runs\/9\/attempts\/1$/, (b) => (b.repository.full_name = 'me/other'))
  t.f.addRun({ repo: 'me/app', runId: 9, sha: SHA })
  t.f.mutate(/runs\/9\/attempts\/1$/, (b) => (b.repository.full_name = 'me/other'))
  await refused(t.trust.admitGithub({ repo: 'me/app', runId: '9', runAttempt: '1', ref: 'refs/heads/main' }, 'admit'), 'run', /belongs to me\/other/)
  const u = setup()
  u.f.addRun({ repo: 'me/app', runId: 3, sha: SHA, status: 'completed' })
  await refused(u.trust.admitGithub({ repo: 'me/app', runId: '3', runAttempt: '1', ref: 'refs/heads/main' }, 'admit'), 'run', /completed/)
  const v = setup()
  v.f.addRun({ repo: 'me/app', runId: 3, sha: SHA })
  v.f.mutate(/runs\/3\/attempts\/1$/, (b) => (b.run_attempt = 2))
  await refused(v.trust.admitGithub({ repo: 'me/app', runId: '3', runAttempt: '1', ref: 'refs/heads/main' }, 'admit'), 'run', /attempt 2/)
})

test('run: each required field missing or null → a run refusal naming it (no exception)', async () => {
  const fields: [string, (b: any) => void][] = [
    ['run_attempt', (b) => (b.run_attempt = null)], ['repository.full_name', (b) => delete b.repository], ['status', (b) => (b.status = null)], ['event', (b) => delete b.event],
    ['path', (b) => (b.path = null)], ['head_sha', (b) => delete b.head_sha], ['head_branch', (b) => (b.head_branch = null)], ['head_repository', (b) => (b.head_repository = null)],
    ['display_title', (b) => delete b.display_title], ['actor.id', (b) => (b.actor.id = null)], ['actor.login', (b) => delete b.actor.login], ['actor.type', (b) => (b.actor.type = 7)],
    ['triggering_actor', (b) => (b.triggering_actor = null)], ['triggering_actor.id', (b) => delete b.triggering_actor.id],
  ]
  for (const [name, fn] of fields) {
    const s = setup()
    s.f.addRun({ repo: 'me/app', runId: 3, sha: SHA })
    s.f.mutate(/runs\/3\/attempts\/1$/, fn)
    await refused(s.trust.admitGithub({ repo: 'me/app', runId: '3', runAttempt: '1', ref: 'refs/heads/main' }, 'admit'), 'run', new RegExp(`no valid ${name.replace('.', '\\.')}`))
  }
})

// ---------------------------------------------------------------- 8. workflow, 9. event, 10. actor, 11. runner

test('workflow: ci.yml refused; a per-repo workflow is honoured', async () => {
  const s = setup()
  s.f.addRun({ repo: 'me/app', runId: 3, sha: SHA, path: '.github/workflows/ci.yml' })
  await refused(s.trust.admitGithub({ repo: 'me/app', runId: '3', runAttempt: '1', ref: 'refs/heads/main' }, 'admit'), 'workflow', /ci\.yml, not \.github\/workflows\/broker\.yml/)
  s.cfg.trust.repos = { 'me/app': { workflow: '.github/workflows/ci.yml' } }
  await s.trust.admitGithub({ repo: 'me/app', runId: '3', runAttempt: '1', ref: 'refs/heads/main' }, 'admit')
})

test('event: pull_request_target, push, schedule refused', async () => {
  for (const ev of ['pull_request_target', 'push', 'schedule', 'workflow_run']) {
    const s = setup()
    s.f.addRun({ repo: 'me/app', runId: 3, sha: SHA, event: ev })
    await refused(s.trust.admitGithub({ repo: 'me/app', runId: '3', runAttempt: '1', ref: 'refs/heads/main' }, 'admit'), 'event', new RegExp(ev))
  }
})

test('actor: unlisted; a listed login with another id; an unpinned login; a listed Bot; a re-run by an unlisted user', async () => {
  const cases: [Account, Account | undefined, Partial<Config['trust']>][] = [
    [EVE, undefined, {}],
    [{ login: 'simple10', id: 777 }, undefined, {}],
    [EVE, undefined, { githubUsers: [VU, 'eve'] }],
    [DEPENDABOT, undefined, { githubUsers: [VU, { login: 'dependabot', id: DEPENDABOT.id }] }],
    [VU, EVE, {}],
  ]
  for (const [actor, triggering, t] of cases) {
    const s = setup({ cfg: { trust: { ...TRUST_DEFAULTS, githubUsers: [SIMPLE10, VU], ...t } as any } })
    await refused(s.trust.admitGithub(dispatch(s, { actor, triggering }), 'admit'), 'actor', new RegExp(`${(triggering ?? actor).login.replace(/[[\]]/g, '\\$&')} \\(id ${(triggering ?? actor).id}`))
  }
})

test('runner: no job on our runners; our job still queued', async () => {
  const s = setup({ runners: ['someone-else'] })
  await refused(s.trust.admitGithub(dispatch(s), 'admit'), 'runner', /host-app-r1 in_progress/)
  const t = setup()
  t.f.addRun({ repo: 'me/app', runId: 3, sha: SHA, title: `broker one ${SHA} -`, jobStatus: 'queued' })
  await refused(t.trust.admitGithub({ repo: 'me/app', runId: '3', runAttempt: '1', ref: 'refs/heads/main' }, 'admit'), 'runner', /queued/)
  const u = setup()
  u.f.addRun({ repo: 'me/app', runId: 3, sha: SHA, runner: null })
  await refused(u.trust.admitGithub({ repo: 'me/app', runId: '3', runAttempt: '1', ref: 'refs/heads/main' }, 'admit'), 'runner', /no runner/)
})

// ---------------------------------------------------------------- 12a pr, 12b pr-workflow, 12c dispatch

test('pr: passes for an approved author\'s PR from our repo against the default branch', async () => {
  const s = setup()
  const a = await s.trust.admitGithub(prRun(s), 'admit')
  assert.deepEqual([a.event, a.actor, a.lane, a.env], ['pull_request', 'octo-other', 'full', 'noenv'])
  assert.equal(a.ghRun, '5511.1 pull_request octo-other')
})

test('pr: not a PR ref; a number whose head differs; forks; base not default; closed; unlisted or bot author; head moved on', async () => {
  const cases: [string, (s: S) => GithubReq, RegExp][] = [
    ['ref', (s) => ({ ...prRun(s), ref: 'refs/heads/feat' }), /not a PR merge ref/],
    ['number', (s) => (prRun(s, { n: 7 }), s.f.addPull({ repo: 'me/app', n: 8, sha: SHA2, branch: 'other' }), { ...prRun(s, { n: 7 }), ref: 'refs/pull/8/merge' }), /head is bbbb/],
    ['fork', (s) => (prRun(s), s.f.mutate(/pulls\/7$/, (b) => (b.head.repo.full_name = 'eve/app')), prRun(s)), /comes from eve\/app/],
    ['fork-null', (s) => (prRun(s), s.f.mutate(/pulls\/7$/, (b) => (b.head.repo = null)), prRun(s)), /deleted fork/],
    ['base', (s) => (prRun(s), s.f.mutate(/pulls\/7$/, (b) => (b.base.ref = 'dev')), prRun(s)), /against dev, not the default branch main/],
    ['closed', (s) => (prRun(s), s.f.mutate(/pulls\/7$/, (b) => (b.state = 'closed')), prRun(s)), /is closed/],
    ['author', (s) => prRun(s, { author: EVE }), /author eve \(id 9\) is not on the approved list/],
    ['bot', (s) => prRun(s, { author: DEPENDABOT }), /author dependabot\[bot\].*Bot/],
    ['moved', (s) => (prRun(s), s.f.mutate(/pulls\/7$/, (b) => (b.head.sha = SHA2)), prRun(s)), /head is bbbb.*the run's is aaaa/],
    ['branch', (s) => (prRun(s), s.f.mutate(/pulls\/7$/, (b) => (b.head.ref = 'x')), prRun(s)), /head branch x/],
  ]
  for (const [, mk, re] of cases) {
    const s = setup()
    await refused(s.trust.admitGithub(mk(s), 'admit'), 'pr', re)
  }
})

test('pr-workflow: a file under .github/, a rename out of .github/, more than 3000 files', async () => {
  const s = setup()
  await refused(s.trust.admitGithub(prRun(s, { files: [{ filename: 'a' }, { filename: '.github/workflows/broker.yml' }] }), 'admit'), 'pr-workflow', /touches \.github\/workflows\/broker\.yml.*dispatch/)
  const t = setup()
  await refused(t.trust.admitGithub(prRun(t, { files: [{ filename: 'x.yml', previous_filename: '.github/workflows/x.yml' }] }), 'admit'), 'pr-workflow', /\.github\/workflows\/x\.yml/)
  const u = setup()
  await refused(u.trust.admitGithub(prRun(u, { changedFiles: 3001 }), 'admit'), 'pr-workflow', /3001 files/)
  assert.equal(u.f.count(/files/), 0)
  const v = setup()
  const files = Array.from({ length: 150 }, (_, i) => ({ filename: `f${i}` }))
  files[140] = { filename: '.github/x' }
  await refused(v.trust.admitGithub(prRun(v, { files }), 'admit'), 'pr-workflow', /\.github\/x/)
  assert.equal(v.f.count(/files/), 2, 'every page is read')
})

test('the recorded dispatch title (real run name) matches DISPATCH_TITLE', async () => {
  const { fixtureBody } = await import('../fake-github-api.ts')
  const { DISPATCH_TITLE } = await import('../../src/ci/daemon/trust.ts')
  const t = fixtureBody('attempt-dispatch.hook').display_title
  const m = DISPATCH_TITLE.exec(t)
  assert.ok(m, t)
  assert.equal(m![2], fixtureBody('attempt-dispatch.hook').head_sha)
})

test('the recorded 500 of pull files at hook time is retried, not refused', async () => {
  const s = setup()
  const req = prRun(s)
  s.f.failNext(/pulls\/7\/files/, 500, {}, 1, '')
  await s.trust.admitGithub(req, 'admit')
})

test('dispatch: a run from a non-default branch is refused', async () => {
  const s = setup()
  await refused(s.trust.admitGithub(dispatch(s, { branch: 'feat' }), 'admit'), 'dispatch', /ran from me\/app@feat, not me\/app@main/)
})

// ---------------------------------------------------------------- 13. match, 14. sha

test('match: PR with another mode, args, another sha; no prMode → pr-mode', async () => {
  const s = setup()
  await refused(s.trust.admitGithub({ ...prRun(s), mode: 'one' }, 'submit'), 'match', /runs mode all, not one/)
  await refused(s.trust.admitGithub({ ...prRun(s), args: ['x'] }, 'submit'), 'match', /no args/)
  await refused(s.trust.admitGithub({ ...prRun(s), sha: SHA2 }, 'submit'), 'match', /not the PR head/)
  const t = setup({ profiles: { app: PROFILE({ github: {} }) } })
  await refused(t.trust.admitGithub(prRun(t), 'submit'), 'pr-mode', /no github\.prMode/)
})

test('match: the dispatch title binds mode, sha and the args digest; a malformed title is refused', async () => {
  const s = setup()
  s.state.merged.add(SHA)
  const ok = dispatch(s, { mode: 'cmd', args: ['ls', '-la'] })
  await s.trust.admitGithub(ok, 'submit')
  await refused(s.trust.admitGithub({ ...ok, mode: 'one', args: [] }, 'replay'), 'match', /says cmd/)
  await refused(s.trust.admitGithub({ ...ok, args: ['rm', '-rf'] }, 'replay'), 'match')
  await refused(s.trust.admitGithub({ ...ok, sha: SHA2 }, 'replay'), 'match')
  const t = setup()
  await refused(t.trust.admitGithub(dispatch(t, { title: 'broker one' }), 'submit'), 'match', /is not 'broker <mode> <sha> <argsHash>'/)
})

test('sha: merged → ok; the head of an open PR by an approved author → ok; branch-only, an unlisted author or a failed fetch → refused', async () => {
  const s = setup()
  s.state.merged.add(SHA)
  await s.trust.admitGithub(dispatch(s), 'submit')
  const t = setup()
  t.f.setCommitPulls('me/app', SHA, [{ n: 3 }])
  await t.trust.admitGithub(dispatch(t), 'submit')
  const u = setup()
  u.f.setCommitPulls('me/app', SHA, [])
  await refused(u.trust.admitGithub(dispatch(u), 'submit'), 'sha', /neither merged/)
  const v = setup()
  v.f.setCommitPulls('me/app', SHA, [{ n: 3, author: EVE }, { n: 4, state: 'closed' }, { n: 5, headSha: SHA2 }, { n: 6, headRepo: 'eve/app' }])
  await refused(v.trust.admitGithub(dispatch(v), 'submit'), 'sha')
  const w = setup()
  w.state.fetchFails = true
  await refused(w.trust.admitGithub(dispatch(w), 'submit'), 'sha', /fetching me\/app from origin failed/)
})

test('sha (check 14) on a real mirror: an ancestor of the default branch after a fetch; a branch-only commit is not', async () => {
  const root = tmp()
  const o = makeOrigin(join(root, 'origins'), 'me/app')
  const merged = pushCommit(o.work, 'g.txt', 'x\n')
  sh(o.work, 'checkout', '-q', '-b', 'side')
  writeFileSync(join(o.work, 'h.txt'), 'y\n')
  sh(o.work, 'add', '-A')
  sh(o.work, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'side')
  sh(o.work, 'push', '-q', 'origin', 'side')
  const side = sh(o.work, 'rev-parse', 'HEAD')
  const m = new Mirror(join(root, 'work'), (r) => join(root, 'origins', `${r}.git`), realGit(60))
  assert.equal(await m.isMerged('me/app', merged, 'main'), true)
  assert.equal(await m.isMerged('me/app', side, 'main'), false)
  assert.equal(await m.isMerged('me/app', 'c'.repeat(40), 'main'), false)
  const gone = new Mirror(join(root, 'work2'), () => join(root, 'nowhere.git'), realGit(60))
  await assert.rejects(gone.isMerged('me/app', merged, 'main'))
})

// ---------------------------------------------------------------- 15. run-used / jobs-cap

test('run-used: one submit per run attempt, also after a restart (trust.db kept); jobs-cap', async () => {
  const dir = tmp()
  const s = setup()
  s.state.merged.add(SHA)
  const tdb = new TrustDb(join(dir, 'trust.db'))
  ;(s.trust.d as any).tdb = tdb
  const a = await s.trust.admitGithub(dispatch(s), 'submit')
  await refused(s.trust.admitGithub(dispatch(s), 'submit'), 'run-used', /in flight/)
  s.trust.recordRunUse(a.runKey, 'tst-4', 'joined')
  await refused(s.trust.admitGithub(dispatch(s), 'submit'), 'run-used', /run 4411\.1 already submitted job tst-4/)
  tdb.close()
  const s2 = setup()
  ;(s2.trust.d as any).tdb = new TrustDb(join(dir, 'trust.db'))
  s2.state.merged.add(SHA)
  await refused(s2.trust.admitGithub(dispatch(s2), 'submit'), 'run-used', /tst-4/)
  const t = setup()
  t.state.merged.add(SHA)
  t.state.active = 20
  await refused(t.trust.admitGithub(dispatch(t), 'submit'), 'jobs-cap', /20 GitHub-door jobs/)
})

test('the per-run cache: admit then submit → no second attempt/jobs/PR/files call; the repo call is made again', async () => {
  const s = setup()
  const req = prRun(s)
  await s.trust.admitGithub(req, 'admit')
  const before = { repo: s.f.count(/^repos\/me\/app$/), rest: s.f.calls.length - s.f.count(/^repos\/me\/app$/) }
  await s.trust.admitGithub(req, 'submit')
  assert.equal(s.f.count(/^repos\/me\/app$/), before.repo + 1)
  assert.equal(s.f.calls.length - s.f.count(/^repos\/me\/app$/), before.rest)
  s.clock.t += 11 * 60_000
  await s.trust.admitGithub(req, 'replay')
  assert.ok(s.f.calls.length - s.f.count(/^repos\/me\/app$/) > before.rest, 'the cache lives 10 minutes')
})

test('replay (trust check --run): one line per check, no run_uses row, no per-run limit', async () => {
  const s = setup()
  s.state.merged.add(SHA)
  const req = dispatch(s)
  for (let i = 0; i < 8; i++) await s.trust.admitGithub(req, 'replay')
  const lines: string[] = []
  await s.trust.admitGithub(req, 'replay', (l) => void lines.push(l))
  assert.deepEqual(lines.map((l) => l.split(':')[0]), ['rate', 'request', 'profile', 'blocked', 'repo', 'approved-list', 'run', 'workflow', 'event', 'actor', 'runner', 'dispatch', 'match', 'sha'])
  assert.match(lines[6], /^run: status in_progress, event workflow_dispatch, path \.github\/workflows\/broker\.yml ✓$/)
  assert.equal(s.tdb.runUse(`me/app#4411.1`), null)
})

// ---------------------------------------------------------------- tickets

test('tickets: valid for their job while active and an hour after; wrong MAC, another job, a reused id (other createdAt) → invalid; a restart keeps them', () => {
  const s = setup()
  const job = { id: 41, createdAt: 1000, endedAt: null as number | null, repo: 'me/app' }
  const t = s.trust.ticket(41, 1000, '4411', '1')
  assert.match(t, /^4411\.1\.[A-Za-z0-9_-]{43}$/)
  assert.ok(s.trust.ticketOk(t, job))
  assert.ok(!s.trust.ticketOk(null, job))
  assert.ok(!s.trust.ticketOk(t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A'), job))
  assert.ok(!s.trust.ticketOk(t, { ...job, id: 42 }))
  assert.ok(!s.trust.ticketOk(t, { ...job, createdAt: 1001 }))
  assert.ok(!s.trust.ticketOk(t.replace(/^4411\.1/, '4411.2'), job))
  assert.ok(s.trust.ticketOk(t, { ...job, endedAt: s.clock.t - 59 * 60_000 }))
  assert.ok(!s.trust.ticketOk(t, { ...job, endedAt: s.clock.t - 61 * 60_000 }))
  const again = new Trust({ ...s.trust.d })
  assert.ok(again.ticketOk(t, job), 'the key is in trust.db')
})

// ---------------------------------------------------------------- review fixes (security review, batch 1)

test('review #7: run ids with leading zeros are refused; the API\'s run id must equal the request\'s', async () => {
  const s = setup()
  const req = dispatch(s)
  await refused(s.trust.admitGithub({ ...req, runId: '04411' }, 'admit'), 'request', /runId/)
  await refused(s.trust.admitGithub({ ...req, runAttempt: '01' }, 'admit'), 'request', /runAttempt/)
  s.f.mutate(/runs\/4411\/attempts\/1$/, (b) => (b.id = 999))
  await refused(s.trust.admitGithub(req, 'admit'), 'run', /run id 999/)
})

test('review #8: a PR files list shorter than changed_files is refused and not cached; a bare .github counts', async () => {
  const s = setup()
  const req = prRun(s, { files: [{ filename: 'a' }], changedFiles: 2 })
  await refused(s.trust.admitGithub(req, 'admit'), 'pr-workflow', /lists 1 of 2 changed files/)
  s.f.addPull({ repo: 'me/app', n: 7, sha: SHA, branch: 'feat', files: [{ filename: 'a' }, { filename: 'b' }] })
  await s.trust.admitGithub(req, 'admit')
  const t = setup()
  await refused(t.trust.admitGithub(prRun(t, { files: [{ filename: '.github' }] }), 'admit'), 'pr-workflow', /\.github/)
})

test('review #9: a dispatch must come from refs/heads/<default branch> (a tag named main is refused)', async () => {
  const s = setup()
  await refused(s.trust.admitGithub({ ...dispatch(s), ref: 'refs/tags/main' }, 'admit'), 'dispatch', /refs\/tags\/main.*refs\/heads\/main/)
})

test('review #13: the GitHub door uses only the repo\'s default profile (its name, or trust.repos.<repo>.profile)', async () => {
  const s = setup({ profiles: { app: PROFILE(), app2: PROFILE({ name: 'app2' }) } })
  s.state.merged.add(SHA)
  await refused(s.trust.admitGithub({ ...dispatch(s), profile: 'app2' }, 'submit'), 'profile', /default profile app/)
  s.cfg.trust.repos = { 'me/app': { profile: 'app2' } as any }
  assert.equal((await s.trust.admitGithub(dispatch(s), 'submit')).profile.name, 'app2')
})

test('review #12: host mode and missing job secrets are refused at the GitHub door too', async () => {
  const s = setup({ profiles: { app: PROFILE({ local: { where: 'host', commands: { one: 'x' } } }) } })
  s.state.merged.add(SHA)
  await refused(s.trust.admitGithub(dispatch(s), 'submit'), 'host-mode')
  const t = setup({ profiles: { app: PROFILE({ local: { where: 'container', image: 'i', env: { T: 'tok' }, commands: { one: 'x' } } }) } })
  t.state.merged.add(SHA)
  t.cfg.trust.repos = { 'me/app': { envForGithubDoor: true } }
  await refused(t.trust.admitGithub(dispatch(t), 'submit'), 'profile', /secret tok is not set/)
})

test('review #22: a job secret equal to the daemon\'s GitHub credential is refused, not passed', async () => {
  const s = setup({ profiles: { app: PROFILE({ local: { where: 'container', image: 'i', env: { T: 'tok' }, commands: { one: 'x' } } }) } })
  s.state.credentialSecrets.add('tok')
  await refused(s.trust.admitLocal({ repo: 'me/app', mode: 'one' }), 'profile', /secret tok equals the daemon's GitHub credential/)
})

test('review #23: the door budgets are per repo, and an API call over the hourly budget is never made', async () => {
  const s = setup({ cfg: { trust: { ...TRUST_DEFAULTS, githubUsers: [VU], githubDoorCallsPerHour: 2, githubDoorPerMin: 100 } as any } })
  const req = dispatch(s)
  const n = s.f.calls.length
  await refused(s.trust.admitGithub(req, 'admit'), 'rate', /API calls for me\/app in the last hour/)
  assert.equal(s.f.calls.length - n, 2, 'stopped at the budget, mid-request')
  s.f.setRepo('me/other')
  s.f.addRun({ repo: 'me/other', runId: 77, sha: SHA })
  await refused(s.trust.admitGithub({ repo: 'me/other', runId: '77', runAttempt: '1', ref: 'refs/heads/main', profile: 'other' }, 'admit'), 'rate')
  assert.equal(s.f.count(/me\/other/), 2, 'another repo has its own budget')
})

test('review #10: a ticket lives an hour from when it was issued (a reused old job gets a live one)', () => {
  const s = setup()
  const t = s.trust.ticket(41, 1000, '4411', '1')
  const job = { id: 41, createdAt: 1000, endedAt: s.clock.t - 5 * 3600_000, repo: 'me/app' }
  assert.ok(!s.trust.ticketOk(t, job), 'old job, no run use')
  s.tdb.addRunUse('me/app#4411.1', 'tst-41', 'reused', s.clock.t - 60_000)
  assert.ok(s.trust.ticketOk(t, job), 'issued a minute ago')
  s.clock.t += 2 * 3600_000
  assert.ok(!s.trust.ticketOk(t, job))
})

test('review #5: a profile with an ssh resource holding a secret is an env-class job at the local door', async () => {
  const s = setup()
  s.state.sshSecret = true
  assert.equal((await s.trust.admitLocal({ repo: 'me/app', mode: 'one' })).env, 'env')
  s.state.sshSecret = false
  assert.equal((await s.trust.admitLocal({ repo: 'me/app', mode: 'one' })).env, 'noenv')
})

// ---------------------------------------------------------------- re-review fixes

test('re-review #2: buckets only for repos with a profile (unknown names share one); many names stay cheap; a global ceiling holds', async () => {
  const s = setup({ cfg: { trust: { ...TRUST_DEFAULTS, githubUsers: [VU], githubDoorPerMin: 1000, githubDoorPerMinTotal: 5 } as any } })
  const t0 = Date.now()
  for (let i = 0; i < 20_000; i++) await s.trust.admitGithub({ repo: `x/r${i}`, runId: '1', runAttempt: '1', ref: 'refs/heads/main' }, 'admit').catch(() => {})
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`)
  assert.ok((s.trust as any).doorReqs.size <= 3, `buckets: ${(s.trust as any).doorReqs.size}`)
  s.clock.t += 61_000
  const req = dispatch(s)
  for (let i = 0; i < 5; i++) await s.trust.admitGithub({ ...req, runId: String(500 + i) }, 'admit').catch(() => {})
  await refused(s.trust.admitGithub(req, 'admit'), 'rate', /all repos/)
})

test('re-review #3: a public-network check older than 2×watchSec counts as not checked: it is probed again before admitting', async () => {
  const s = setup()
  s.f.setRepo('me/app', { private: false })
  let probes = 0
  ;(s.trust.d as any).probeNet = async () => {
    probes++
    s.state.net = { ok: true, why: '', at: s.clock.t } as any
  }
  s.state.net = { ok: true, why: '', at: s.clock.t - 11 * 60_000 } as any
  assert.equal((await s.trust.admitLocal({ repo: 'me/app', mode: 'one' })).lane, 'public')
  assert.equal(probes, 1)
  ;(s.trust.d as any).probeNet = async () => void probes++
  s.state.net = { ok: true, why: '', at: s.clock.t - 11 * 60_000 } as any
  await refused(s.trust.admitLocal({ repo: 'me/app', mode: 'one' }), 'public-net', /older than/)
})
