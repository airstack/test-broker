import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ApiFail, GithubApi, Missing, parseGhApiI, readAttempt, readPull, readRepo } from '../../src/ci/daemon/github-api.ts'
import { FakeGithubApi, fixtureBody, fixtureRaw } from '../fake-github-api.ts'

const api = (f: FakeGithubApi, o: Partial<ConstructorParameters<typeof GithubApi>[0]> = {}) => {
  const t = { now: 1_794_370_000_000 }
  const sleeps: number[] = []
  const a = new GithubApi({ run: f.run, now: () => t.now, sleep: async (ms) => void sleeps.push(ms), ...o })
  return { a, t, sleeps }
}

test('every recorded fixture parses: status, headers (lowercased), JSON body', () => {
  const dir = join(import.meta.dirname, 'fixtures', 'github')
  for (const f of readdirSync(dir)) {
    const name = f.replace(/\.json$/, '')
    const p = parseGhApiI(fixtureRaw(name).raw)
    assert.ok(p, name)
    assert.ok([200, 404, 500].includes(p.status), `${name}: ${p.status}`)
    assert.equal(typeof p.headers['x-github-request-id'], 'string', name)
    if (p.status === 200) assert.notEqual(p.body, null, name)
  }
  assert.equal(parseGhApiI('garbage'), null)
  assert.equal(parseGhApiI(''), null)
})

test('the strict readers read the recorded answers', () => {
  const r = readRepo(fixtureBody('repo-private'))
  assert.deepEqual(r, { fullName: 'octo-other/ci-broker-spike', private: true, push: true, defaultBranch: 'main' })
  assert.equal(readRepo(fixtureBody('repo-no-push')).push, false)
  assert.equal(readRepo(fixtureBody('repo-public')).private, false)
  const a = readAttempt(fixtureBody('attempt-pr.hook'))
  assert.equal(a.event, 'pull_request')
  assert.equal(a.status, 'in_progress')
  assert.equal(a.headBranch, 'spike-pr-2')
  assert.deepEqual(a.actor, { id: 304762783, login: 'octo-other', type: 'User' })
  assert.equal(a.repo, 'octo-other/ci-broker-spike')
  const p = readPull(fixtureBody('pull-pr.hook'))
  assert.equal(p.headRepo, 'octo-other/ci-broker-spike')
  assert.equal(p.changedFiles, 1)
})

test('a missing or null required field is a Missing naming the field, never a TypeError', () => {
  for (const field of ['head_sha', 'status', 'display_title', 'path', 'event', 'head_branch']) {
    const b = fixtureBody('attempt-dispatch.hook')
    b[field] = null
    assert.throws(() => readAttempt(b), (e: unknown) => e instanceof Missing && e.field === field)
  }
  const b = fixtureBody('attempt-dispatch.hook')
  delete b.triggering_actor
  assert.throws(() => readAttempt(b), (e: unknown) => e instanceof Missing && e.field === 'triggering_actor')
  const c = fixtureBody('attempt-dispatch.hook')
  c.actor.id = '12'
  assert.throws(() => readAttempt(c), (e: unknown) => e instanceof Missing && e.field === 'actor.id')
  const d = fixtureBody('attempt-dispatch.hook')
  d.head_repository = null
  assert.throws(() => readAttempt(d), (e: unknown) => e instanceof Missing && e.field === 'head_repository')
  assert.throws(() => readAttempt(null), (e: unknown) => e instanceof Missing)
})

test('GithubApi.repo: 200 → info, 404 → null; every call is `gh api -i <path>` with a 15 s timeout', async () => {
  const f = new FakeGithubApi()
  f.setRepo('me/app')
  const seen: any[] = []
  const { a } = api(f, { run: async (args, o) => (seen.push([args, o.timeoutSec]), f.run(args, o)) })
  assert.deepEqual(await a.repo('me/app'), { fullName: 'me/app', private: true, push: true, defaultBranch: 'main' })
  assert.equal(await a.repo('me/gone'), null)
  assert.deepEqual(seen[0], [['api', '-i', 'repos/me/app'], 15])
})

test('a primary rate limit (403, remaining 0) → ApiFail rate with the reset time; no call is made until then', async () => {
  const f = new FakeGithubApi()
  f.setRepo('me/app')
  f.rateLimited('primary')
  const { a, t } = api(f)
  await assert.rejects(a.repo('me/app'), (e: unknown) => e instanceof ApiFail && e.kind === 'rate' && e.until === f.resetAt * 1000 && /rate limited until \d\d:\d\d/.test(e.message))
  const n = f.calls.length
  await assert.rejects(a.repo('me/app'), (e: unknown) => e instanceof ApiFail && e.kind === 'rate')
  assert.equal(f.calls.length, n, 'no call while limited')
  t.now = f.resetAt * 1000 + 1
  assert.ok(await a.repo('me/app'))
})

test('a secondary rate limit (429 + retry-after, or a 403 message without the header) → rate, until now + retry-after', async () => {
  const f = new FakeGithubApi()
  f.setRepo('me/app')
  f.rateLimited('secondary', 1, '120')
  const { a, t } = api(f)
  await assert.rejects(a.repo('me/app'), (e: unknown) => e instanceof ApiFail && e.kind === 'rate' && e.until === t.now + 120_000)
  const g = new FakeGithubApi()
  g.setRepo('me/app')
  g.failNext(/./, 403, {}, 1, '{"message":"You have exceeded a secondary rate limit"}')
  const b = api(g)
  await assert.rejects(b.a.repo('me/app'), (e: unknown) => e instanceof ApiFail && e.kind === 'rate' && e.until === b.t.now + 60_000)
})

test('a 5xx is retried twice (after 1 s and 3 s), then refused; 4xx and timeouts are not retried', async () => {
  const f = new FakeGithubApi()
  f.setRepo('me/app')
  f.failNext(/repos\/me\/app$/, 500, {}, 2)
  const { a, sleeps } = api(f)
  assert.ok(await a.repo('me/app'))
  assert.deepEqual(sleeps, [1000, 3000])
  f.failNext(/repos\/me\/app$/, 502, {}, 3)
  await assert.rejects(a.repo('me/app'), (e: unknown) => e instanceof ApiFail && e.kind === 'http' && e.status === 502)
  const g = new FakeGithubApi()
  g.timeout = /./
  const b = api(g)
  await assert.rejects(b.a.repo('me/app'), (e: unknown) => e instanceof ApiFail && e.kind === 'timeout')
  assert.equal(g.calls.length, 1)
  g.timeout = null
  g.offline = true
  await assert.rejects(b.a.repo('me/app'), (e: unknown) => e instanceof ApiFail && e.kind === 'http' && /unreachable|connecting/.test(e.message))
  const h = new FakeGithubApi()
  h.failNext(/./, 403, {}, 1, '{"message":"Resource not accessible"}')
  const c = api(h)
  await assert.rejects(c.a.repo('me/app'), (e: unknown) => e instanceof ApiFail && e.status === 403 && e.kind === 'http')
  assert.equal(h.calls.length, 1)
})

test('the recorded 500 of pull files (spike) is retried and then read', async () => {
  const f = new FakeGithubApi()
  f.addPull({ repo: 'me/app', n: 1, sha: 'a'.repeat(40), branch: 'b' })
  f.failNext(/pulls\/1\/files/, 500, {}, 1, '')
  const { a } = api(f)
  assert.deepEqual((await a.pullFiles('me/app', 1, 1)).map((x) => x.filename), ['README.md'])
})

test('pull files are read page by page (100 each) from changed_files; a meter counts every call made', async () => {
  const f = new FakeGithubApi()
  const files = Array.from({ length: 250 }, (_, i) => ({ filename: `f${i}` }))
  f.addPull({ repo: 'me/app', n: 3, sha: 'a'.repeat(40), branch: 'b', files })
  let n = 0
  const { a } = api(f)
  const got = await a.pullFiles('me/app', 3, 250, () => n++)
  assert.equal(got.length, 250)
  assert.equal(n, 3)
  assert.equal(f.count(/pulls\/3\/files\?per_page=100&page=\d$/), 3)
})

test('unparsable output → ApiFail parse; a 401 calls onUnauthorized (the token is re-read)', async () => {
  let reread = 0
  const a = new GithubApi({ run: async () => ({ code: 0, stdout: 'not http', stderr: '' }), now: () => 0, sleep: async () => {} })
  await assert.rejects(a.repo('me/app'), (e: unknown) => e instanceof ApiFail && e.kind === 'parse')
  const f = new FakeGithubApi()
  f.failNext(/./, 401, {}, 1, '{"message":"Bad credentials"}')
  const b = new GithubApi({ run: f.run, now: () => 0, sleep: async () => {}, onUnauthorized: () => void reread++ })
  await assert.rejects(b.repo('me/app'), (e: unknown) => e instanceof ApiFail && e.status === 401)
  assert.equal(reread, 1)
})
