// The GitHub door: a real unix socket in a temp setgid dir, the trust checks over the fake GitHub API, the client's
// runner mode end to end, tickets, the route list, joins across doors, `admit` and `dispatch`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { request, type Server } from 'node:http'
import { join } from 'node:path'
import { githubClient, parseArgs } from '../../src/ci/cli.ts'
import { admit } from '../../src/ci/client/admit.ts'
import { argsDigest, dispatch } from '../../src/ci/client/dispatch.ts'
import { GhDoorClient, PROTOCOL } from '../../src/ci/client/http.ts'
import { submit, type SubmitOpts } from '../../src/ci/client/submit.ts'
import { openGithubDoor } from '../../src/ci/daemon/gh-door.ts'
import { banner } from '../../src/ci/daemon/local-door.ts'
import { listen } from '../../src/ci/daemon/server.ts'
import { EVE } from '../fake-github-api.ts'
import { harness, idOf, makeOrigin, TEST_PROFILE, tmp, until, type Harness } from '../harness.ts'

const PROFILE = { ...TEST_PROFILE, github: { prMode: 'one' } }

async function door(o: { root?: string; sockMode?: number; runners?: string[] } = {}) {
  const base = o.root ?? tmp()
  const sockDir = join(base, 'sock')
  mkdirSync(sockDir, { recursive: true })
  chmodSync(sockDir, o.sockMode ?? 0o2750)
  const runners = join(base, 'runners.json')
  writeFileSync(runners, JSON.stringify((o.runners ?? ['host-app-r1']).map((name, i) => ({ id: `me__app-${i + 1}`, repo: 'me/app', name }))))
  const h = harness({ root: o.root ? join(base, 'd') : undefined, profile: PROFILE, cfg: { githubSocketPath: join(sockDir, 'github.sock'), runnersJson: runners } })
  const servers = await openGithubDoor(h.d, { gid: process.getgid!() })
  const local = await listen(h.d, h.cfg.socketPath)
  return { h, sock: join(sockDir, 'github.sock'), servers: [...servers, local], base }
}
const close = (d: { servers: Server[] }) => d.servers.forEach((s) => s.close())

function raw(socket: string, method: string, path: string, body?: unknown, headers: Record<string, string> = { 'x-cib-protocol': String(PROTOCOL) }): Promise<[number, any]> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body)
    const req = request({ socketPath: socket, method, path, headers: { ...(data ? { 'content-type': 'application/json' } : {}), ...headers } }, async (res) => {
      let s = ''
      for await (const c of res) s += c
      let b: any = s
      try {
        b = s ? JSON.parse(s) : null
      } catch {}
      resolve([res.statusCode ?? 0, b])
    })
    req.on('error', reject)
    req.end(data)
  })
}

/** a dispatch run of `mode` on the pushed sha by octo-other, on our runner */
function run(h: Harness, sha: string, o: { runId?: number; mode?: string; args?: string[] } = {}) {
  const runId = o.runId ?? 4411
  h.github.addRun({ repo: 'me/app', runId, sha, title: `broker ${o.mode ?? 'one'} ${sha} ${argsDigest(o.args ?? [])}` })
  return { GITHUB_REPOSITORY: 'me/app', GITHUB_RUN_ID: String(runId), GITHUB_RUN_ATTEMPT: '1', GITHUB_REF: 'refs/heads/main' }
}
const claims = (env: Record<string, string>) => ({ repo: env.GITHUB_REPOSITORY, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT, ref: env.GITHUB_REF })

test('the door: only its own routes; every local route is 404 there', async () => {
  const d = await door()
  try {
    assert.equal(d.h.d.c.githubDoor, 'open')
    assert.equal(statSync(d.sock).mode & 0o777, 0o660)
    for (const [m, p] of [['GET', '/status'], ['GET', '/jobs'], ['POST', '/jobs'], ['POST', '/drain'], ['POST', '/gc'], ['POST', '/resources/boat/reset'], ['POST', '/resources/boat/check'], ['GET', '/trust'], ['POST', '/trust/unblock'], ['GET', '/doctor'], ['GET', '/daemon-log'], ['POST', '/admin/seed'], ['GET', '/hello'], ['GET', '/gh/status'], ['PUT', '/gh/jobs/tst-1/bundle'], ['POST', '/gh/jobs/tst-1/cancel'], ['GET', '/jobs/tst-1/files.tar']] as const) {
      const [s] = await raw(d.sock, m, p, m === 'GET' ? undefined : {})
      assert.equal(s, 404, `${m} ${p}`)
    }
    const [s, b] = await raw(d.sock, 'GET', '/gh/hello', undefined, {})
    assert.deepEqual([s, b], [200, { protocol: PROTOCOL, daemonId: 'tst' }])
  } finally {
    close(d)
  }
})

test('protocol on the door: N and N-1 accepted, N-2 → 426 (update the runner client)', async () => {
  const d = await door()
  try {
    const o = makeOrigin(d.h.origins, 'me/app')
    const env = run(d.h, o.sha)
    for (const [v, want] of [[String(PROTOCOL), 200], [String(PROTOCOL - 1), 200], [String(PROTOCOL - 2), 426]] as const) {
      const [s, b] = await raw(d.sock, 'POST', '/gh/admit', claims(env), { 'x-cib-protocol': v })
      assert.equal(s, want, `${v}: ${JSON.stringify(b)}`)
      if (want === 426) assert.match(b.error, /the client is older than the daemon: update it/)
    }
  } finally {
    close(d)
  }
})

test('a runner job end to end: admitted, the daemon sets the fields, the client follows with its ticket and gets the logs and artifacts through files.tar', async () => {
  const d = await door()
  d.h.boat.onCommand = undefined // the real wrapper + remote.sh on the fake box (it writes out/a.txt)
  try {
    const o = makeOrigin(d.h.origins, 'me/app')
    const env = run(d.h, o.sha)
    const ws = tmp()
    const out: string[] = []
    const client = new GhDoorClient(d.sock, claims(env))
    const opts: SubmitOpts = { mode: 'one', args: [], cwd: ws, maxFileMb: 50, interestGraceSec: 30, out: (s) => void out.push(s), err: (s) => void out.push(s), reconnectMs: 0, github: true, repo: 'me/app', sha: o.sha, label: 'my label', force: true,
      env: { ...env, GITHUB_STEP_SUMMARY: join(ws, 's.md'), GITHUB_WORKSPACE: ws } }
    assert.equal(await submit(client, opts), 0, out.join(''))
    const j = d.h.d.c.db.job(1)!
    assert.deepEqual([j.door, j.source, j.lane, j.env, j.pinned, j.label, j.ghRun], ['github', 'pushed', 'full', 'noenv', false, 'github run 4411.1 by octo-other', '4411.1 workflow_dispatch octo-other'])
    assert.ok(client.ticket)
    assert.equal(readFileSync(join(ws, 'ci-broker-artifacts', 'one', 'out', 'a.txt'), 'utf8'), 'art\n')
    assert.match(readFileSync(join(ws, 'ci-broker-artifacts', 'one.log'), 'utf8'), /remote/)
    assert.match(readFileSync(join(ws, 's.md'), 'utf8'), /Logs: `ci-broker logs tst-1`/)
    assert.deepEqual(d.h.d.c.tdb.runUse('me/app#4411.1'), { run: 'me/app#4411.1', job: 'tst-1', how: 'new', t: d.h.clock.t })
    assert.ok(d.h.logs.some((l) => /^TRUST admitted door=github repo=me\/app run=4411\.1 event=workflow_dispatch actor=octo-other sha=[0-9a-f]{40} → job tst-1$/.test(l)))
    const [s, view] = await raw(d.sock, 'GET', `/gh/jobs/tst-1?ticket=${client.ticket}`)
    assert.equal(s, 200)
    assert.equal(view.dir, '')
    assert.equal(view.key, undefined)
    // a second submit of the same run attempt is refused loudly
    const [s2, b2] = await raw(d.sock, 'POST', '/gh/jobs', { ...claims(env), sha: o.sha, mode: 'one', args: [] })
    assert.equal(s2, 403)
    assert.match(b2.error, /run 4411\.1 already submitted job tst-1/)
  } finally {
    close(d)
  }
})

test('ignored client fields: detach, force, label, tree, source never reach the job', async () => {
  const d = await door()
  try {
    const o = makeOrigin(d.h.origins, 'me/app')
    const env = run(d.h, o.sha)
    const [s, r] = await raw(d.sock, 'POST', '/gh/jobs', { ...claims(env), sha: o.sha, mode: 'one', args: [], detach: true, force: true, label: 'mine', tree: 'f'.repeat(40), source: 'local', lane: 'public', env: 'env', door: 'local' })
    assert.equal(s, 200, JSON.stringify(r))
    const j = d.h.d.c.db.job(idOf(r.id))!
    assert.deepEqual([j.pinned, j.label, j.source, j.lane, j.env, j.door], [false, 'github run 4411.1 by octo-other', 'pushed', 'full', 'noenv', 'github'])
    assert.notEqual(j.tree, 'f'.repeat(40))
    assert.ok(r.interest, 'an interest (never detached)')
  } finally {
    close(d)
  }
})

test('tickets: missing, wrong, another job\'s, a reused id after a DB reset, an hour after the end → 404; valid after a daemon restart', async () => {
  const root = tmp()
  const d = await door({ root })
  let d2: Awaited<ReturnType<typeof door>> | null = null
  try {
    const o = makeOrigin(d.h.origins, 'me/app')
    const env = run(d.h, o.sha)
    const [, r] = await raw(d.sock, 'POST', '/gh/jobs', { ...claims(env), sha: o.sha, mode: 'one', args: [] })
    const t = r.ticket as string
    for (const q of ['', '?ticket=', `?ticket=${t.slice(0, -2)}xx`, `?ticket=${t.replace(/^4411/, '4412')}`]) assert.equal((await raw(d.sock, 'GET', `/gh/jobs/tst-1${q}`))[0], 404, q)
    const env2 = run(d.h, o.sha, { runId: 5000, mode: 'cmd', args: ['x'] })
    const [, r2] = await raw(d.sock, 'POST', '/gh/jobs', { ...claims(env2), sha: o.sha, mode: 'cmd', args: ['x'] })
    assert.equal((await raw(d.sock, 'GET', `/gh/jobs/${r.id}?ticket=${r2.ticket}`))[0], 404, "another job's ticket")
    assert.equal((await raw(d.sock, 'GET', `/gh/jobs/${r.id}?ticket=${t}`))[0], 200)
    // a daemon restart on the same state: the key is in trust.db
    close(d)
    d2 = await door({ root })
    assert.equal((await raw(d2.sock, 'GET', `/gh/jobs/${r.id}?ticket=${t}`))[0], 200)
    // the job ends; an hour later its ticket is dead
    d2.h.d.c.db.updateJob(1, { state: 'failed', endedAt: d2.h.clock.t })
    assert.equal((await raw(d2.sock, 'GET', `/gh/jobs/${r.id}?ticket=${t}`))[0], 200, 'still valid right after the end')
    d2.h.advance(61 * 60_000)
    assert.equal((await raw(d2.sock, 'GET', `/gh/jobs/${r.id}?ticket=${t}`))[0], 404)
    // a main-DB reset: ids restart, the old ticket names another createdAt
    const db = d2.h.d.c.db
    db.raw.exec('DELETE FROM jobs; DELETE FROM shards; DELETE FROM sqlite_sequence')
    db.insertJob({ key: 'k', repo: 'me/app', profile: 'app', profileHash: 'h', mode: 'one', args: [], commit: o.sha, tree: 't', source: 'pushed', base: null, label: null, state: 'queued', pinned: true, createdAt: d2.h.clock.t, lane: 'full', env: 'noenv', door: 'local', ghRun: null })
    assert.equal((await raw(d2.sock, 'GET', `/gh/jobs/tst-1?ticket=${t}`))[0], 404)
  } finally {
    close(d)
    if (d2) close(d2)
  }
})

test('dir checks: missing, wrong mode or wrong group → the door stays closed and the banner says why', async () => {
  for (const [mode, re] of [[0o755, /mode 0755, want 2750/], [0o2750, /has group/]] as const) {
    const base = tmp()
    mkdirSync(join(base, 'sock'))
    chmodSync(join(base, 'sock'), mode)
    const h = harness({ cfg: { layout: 'split', githubSocketPath: join(base, 'sock', 'github.sock') } })
    const s = await openGithubDoor(h.d, { gid: mode === 0o2750 ? process.getgid!() + 1 : process.getgid!() })
    assert.deepEqual(s, [])
    assert.match(h.d.c.githubDoor, re)
    assert.ok(banner(h.d).some((l) => /^GitHub door closed: /.test(l)))
    assert.ok(!existsSync(join(base, 'sock', 'github.sock')))
  }
  const h = harness({ cfg: { layout: 'split', githubSocketPath: join(tmp(), 'nope', 'github.sock') } })
  await openGithubDoor(h.d, { gid: process.getgid!() })
  assert.match(h.d.c.githubDoor, /missing/)
})

test('joins across doors: a GitHub-door request never joins a local env job; it joins a noenv one (ticket + run_uses joined)', async () => {
  const d = await door()
  try {
    const o = makeOrigin(d.h.origins, 'me/app')
    const envJob = await d.h.d.c.jobs.submit({ repo: 'me/app', profile: 'app', mode: 'one', commit: o.sha, detach: true, lane: 'full', env: 'env' })
    await d.h.pass()
    const env = run(d.h, o.sha)
    const [, r] = await raw(d.sock, 'POST', '/gh/jobs', { ...claims(env), sha: o.sha, mode: 'one', args: [] })
    assert.notEqual(r.id, envJob.id)
    assert.ok(!r.joined)
    const e2 = run(d.h, o.sha, { runId: 6000 })
    const [, r2] = await raw(d.sock, 'POST', '/gh/jobs', { ...claims(e2), sha: o.sha, mode: 'one', args: [] })
    assert.equal(r2.id, r.id)
    assert.equal(r2.joined, true)
    assert.ok(r2.ticket)
    assert.equal(d.h.d.c.tdb.runUse('me/app#6000.1')!.how, 'joined')
    assert.equal((await raw(d.sock, 'GET', `/gh/jobs/${r2.id}?ticket=${r2.ticket}`))[0], 200)
  } finally {
    close(d)
  }
})

test('a withdraw needs this job\'s interest; the last interest gone cancels the job', async () => {
  const d = await door()
  try {
    const o = makeOrigin(d.h.origins, 'me/app')
    const env = run(d.h, o.sha)
    const [, r] = await raw(d.sock, 'POST', '/gh/jobs', { ...claims(env), sha: o.sha, mode: 'one', args: [] })
    const other = d.h.d.c.jobs.openInterest(999)
    assert.equal((await raw(d.sock, 'DELETE', `/gh/jobs/${r.id}/interest/${other}?ticket=${r.ticket}`))[0], 404)
    assert.equal((await raw(d.sock, 'DELETE', `/gh/jobs/${r.id}/interest/${r.interest}?ticket=${r.ticket}`))[0], 200)
    assert.ok(['cancelling', 'cancelled'].includes(d.h.d.c.db.job(idOf(r.id))!.state))
  } finally {
    close(d)
  }
})

test('files.tar over the door: the ticket is needed; only regular files', async () => {
  const d = await door()
  try {
    const o = makeOrigin(d.h.origins, 'me/app')
    const env = run(d.h, o.sha)
    const [, r] = await raw(d.sock, 'POST', '/gh/jobs', { ...claims(env), sha: o.sha, mode: 'one', args: [] })
    const dir = d.h.d.c.streams.dir(idOf(r.id))
    mkdirSync(join(dir, 'artifacts', 'one'), { recursive: true })
    writeFileSync(join(dir, 'artifacts', 'one', 'r.txt'), 'r\n')
    symlinkSync('/etc/hostname', join(dir, 'artifacts', 'one', 'leak'))
    assert.equal((await raw(d.sock, 'GET', `/gh/jobs/${r.id}/files.tar`))[0], 404)
    const c = new GhDoorClient(d.sock, claims(env))
    c.ticket = r.ticket
    const dest = tmp()
    await c.download(`/jobs/${r.id}/files.tar`, dest)
    assert.equal(readFileSync(join(dest, 'artifacts', 'one', 'r.txt'), 'utf8'), 'r\n')
    assert.ok(!existsSync(join(dest, 'artifacts', 'one', 'leak')))
  } finally {
    close(d)
  }
})

test('admit: 0 admitted; 77 refused (annotation first); 2 door down or no socket in the env', async () => {
  const d = await door()
  try {
    const o = makeOrigin(d.h.origins, 'me/app')
    const env = run(d.h, o.sha)
    const out: string[] = []
    assert.equal(await admit({ ...env, CI_BROKER_GITHUB_SOCKET: d.sock }, { out: (s) => void out.push(s) }), 0)
    assert.match(out.join(''), /admitted \(full lane\)/)
    out.length = 0
    d.h.github.addRun({ repo: 'me/app', runId: 7, sha: o.sha, actor: EVE })
    assert.equal(await admit({ ...env, GITHUB_RUN_ID: '7', CI_BROKER_GITHUB_SOCKET: d.sock }, { out: (s) => void out.push(s) }), 77)
    assert.match(out[0], /^::error title=ci-broker refused \(trust\/actor\)::actor eve \(id 9\) is not on the approved list/)
    assert.match(out[1], /^ci-broker: REFUSED \(trust\/actor\)/)
    out.length = 0
    assert.equal(await admit({ ...env, CI_BROKER_GITHUB_SOCKET: join(tmp(), 'none.sock') }, { out: (s) => void out.push(s) }), 2)
    assert.match(out[0], /^::error title=ci-broker GitHub door down::/)
    assert.equal(await admit(env, { out: () => {} }), 2)
  } finally {
    close(d)
  }
})

test('admit retries a `runner` refusal (the job\'s runner_name may lag) and then refuses', async () => {
  const d = await door({ runners: ['other-runner'] })
  try {
    const o = makeOrigin(d.h.origins, 'me/app')
    const env = run(d.h, o.sha)
    let n = 0
    d.h.github.onCall = (p) => void (/\/jobs\?/.test(p) && n++)
    const out: string[] = []
    assert.equal(await admit({ ...env, CI_BROKER_GITHUB_SOCKET: d.sock }, { out: (s) => void out.push(s), waitMs: 0, tries: 3 }), 77)
    assert.equal(n, 3)
    assert.match(out.join(''), /trust\/runner/)
  } finally {
    close(d)
  }
})

test('the client: --github with CI_BROKER_GITHUB_SOCKET → the GitHub door; unset → the local socket', () => {
  const env = { GITHUB_REPOSITORY: 'me/app', GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1', GITHUB_REF: 'refs/heads/main' }
  const g = githubClient(parseArgs(['submit', '--github', '--sha', 'x']), { ...env, CI_BROKER_GITHUB_SOCKET: '/s/github.sock' })
  assert.ok(g instanceof GhDoorClient)
  assert.equal(g!.socket, '/s/github.sock')
  assert.equal(githubClient(parseArgs(['submit', '--github']), env), null)
  assert.equal(githubClient(parseArgs(['submit']), { ...env, CI_BROKER_GITHUB_SOCKET: '/s' }), null)
})

test('dispatch: the args digest in the run name; gh workflow run on the default branch with the compact JSON args', async () => {
  const calls: string[][] = []
  const gh = async (args: string[]) => (calls.push(args), args[0] === 'repo' ? { code: 0, stdout: 'main\n', stderr: '' } : { code: 0, stdout: '', stderr: '' })
  const out: string[] = []
  const sha = 'a'.repeat(40)
  assert.equal(await dispatch({ repo: 'me/app', sha, mode: 'e2e', args: ['--grep', 'x'], cwd: '.', gh, out: (s) => void out.push(s) }), 0)
  const digest = argsDigest(['--grep', 'x'])
  assert.deepEqual(calls[1], ['workflow', 'run', 'broker.yml', '--repo', 'me/app', '--ref', 'refs/heads/main', '-f', `sha=${sha}`, '-f', 'mode=e2e', '-f', 'args=["--grep","x"]', '-f', `argsHash=${digest}`])
  assert.match(out[0], new RegExp(`broker e2e ${sha} ${digest}`))
  await dispatch({ repo: 'me/app', sha, mode: 'all', args: [], cwd: '.', gh, out: () => {} })
  assert.deepEqual(calls[3].slice(-4), ['-f', 'args=[]', '-f', 'argsHash=-'])
  await assert.rejects(dispatch({ repo: 'me/app', sha: 'abc', mode: 'all', args: [], cwd: '.', gh, out: () => {} }), /full sha/)
})

test('the hook script: env -i with an allowlist, node from its own release dir', () => {
  const s = readFileSync(join(import.meta.dirname, '..', '..', 'bin', 'cib-admit.sh'), 'utf8')
  assert.match(s, /exec \/usr\/bin\/env -i PATH="\$D\/bin:\/usr\/bin:\/bin"/)
  assert.match(s, /"\$D\/node\/bin\/node" "\$D\/src\/ci\/cli\.ts" admit/)
  assert.ok(!/NODE_OPTIONS|LD_PRELOAD|BASH_ENV/.test(s.split('\n').filter((l) => !l.startsWith('#')).join('\n')))
  assert.equal(statSync(join(import.meta.dirname, '..', '..', 'bin', 'cib-admit.sh')).mode & 0o111, 0o111)
})

// ---------------------------------------------------------------- review fixes (batch 1)

test('review (correctness #2): during a switch drain /gh/jobs answers 503 before the admission (no API call, no rate slot)', async () => {
  const d = await door()
  try {
    const o = makeOrigin(d.h.origins, 'me/app')
    const env = run(d.h, o.sha)
    d.h.d.c.switchDrain = true
    const n = d.h.github.calls.length
    for (let i = 0; i < 40; i++) {
      const [s, b] = await raw(d.sock, 'POST', '/gh/jobs', { ...claims(env), sha: o.sha, mode: 'one', args: [] })
      assert.equal(s, 503)
      assert.match(b.error, /draining for switch/)
    }
    assert.equal(d.h.github.calls.length, n)
    d.h.d.c.switchDrain = false
    const [s] = await raw(d.sock, 'POST', '/gh/jobs', { ...claims(env), sha: o.sha, mode: 'one', args: [] })
    assert.equal(s, 200, 'the 40 waits used no per-minute slot')
  } finally {
    close(d)
  }
})

test('review #17: a null or non-object body is a 400; a bad % escape answers (404); a body over 80 KiB is a 413', async () => {
  const d = await door()
  try {
    for (const b of [null, 7, 'x', [1]]) assert.equal((await raw(d.sock, 'POST', '/gh/admit', b))[0], 400, JSON.stringify(b))
    assert.equal((await raw(d.sock, 'GET', '/gh/jobs/%zz'))[0], 404)
    assert.equal((await raw(d.h.cfg.socketPath, 'GET', '/jobs/%zz'))[0], 404)
    const [s] = await raw(d.sock, 'POST', '/gh/admit', { repo: 'x'.repeat(100_000) })
    assert.equal(s, 413)
  } finally {
    close(d)
  }
})

test('review #4: the GitHub door re-reads root\'s config at every request', async () => {
  const d = await door()
  try {
    let n = 0
    d.h.d.reloadConfig = (door: string) => void (door === 'github' && n++)
    const o = makeOrigin(d.h.origins, 'me/app')
    const env = run(d.h, o.sha)
    await raw(d.sock, 'POST', '/gh/admit', claims(env))
    await raw(d.sock, 'POST', '/gh/jobs', { ...claims(env), sha: o.sha, mode: 'one', args: [] })
    assert.equal(n, 2)
  } finally {
    close(d)
  }
})

test('review #6: a GitHub-door request never joins or reuses a snapshot job (a client-made tree)', async () => {
  const d = await door()
  try {
    const o = makeOrigin(d.h.origins, 'me/app')
    const c = d.h.d.c
    await c.mirror.ensure('me/app')
    const tree = await c.mirror.treeOf('me/app', o.sha)
    const { jobKey, profileHash } = await import('../../src/ci/profile.ts')
    const key = jobKey({ repo: 'me/app', profile: 'app', profileHash: profileHash(c.profile('app')), mode: 'one', tree, args: [], lane: 'full', env: 'noenv' })
    const base = { key, repo: 'me/app', profile: 'app', profileHash: 'h', mode: 'one', args: [], commit: 'c'.repeat(40), tree, source: 'snapshot' as const, base: null, label: null, pinned: true, createdAt: d.h.clock.t, lane: 'full' as const, env: 'noenv' as const, door: 'local' as const, ghRun: null }
    const passed = c.db.insertJob({ ...base, state: 'passed' })
    c.db.updateJob(passed, { endedAt: d.h.clock.t })
    c.db.insertJob({ ...base, state: 'running' })
    const env = run(d.h, o.sha)
    const [s, r] = await raw(d.sock, 'POST', '/gh/jobs', { ...claims(env), sha: o.sha, mode: 'one', args: [] })
    assert.equal(s, 200, JSON.stringify(r))
    assert.ok(!r.reused && !r.joined, JSON.stringify(r))
    assert.equal(r.id, 'tst-3')
  } finally {
    close(d)
  }
})

test('review #9: doctor warns when a profile repo\'s default branch is not protected', async () => {
  const d = await door()
  try {
    const { doctor } = await import('../../src/ci/daemon/local-door.ts')
    d.h.github.setBranch('me/app', 'main', false)
    const r = await doctor(d.h.d, null)
    assert.ok(r.lines.some((l) => l.ok === null && /me\/app: the default branch main is not protected/.test(l.text)), JSON.stringify(r.lines))
    d.h.github.setBranch('me/app', 'main', true)
    const r2 = await doctor(d.h.d, null)
    assert.ok(r2.lines.some((l) => l.ok === true && /me\/app: main is protected/.test(l.text)))
  } finally {
    close(d)
  }
})

test('correctness #14: when files.tar can\'t be fetched, --github reads nothing (the door\'s job dir is empty, never the workspace)', async () => {
  const d = await door()
  d.h.boat.onCommand = undefined
  try {
    const o = makeOrigin(d.h.origins, 'me/app')
    const env = run(d.h, o.sha)
    const ws = tmp()
    mkdirSync(join(ws, 'artifacts', 'planted'), { recursive: true })
    const out: string[] = []
    const client = new GhDoorClient(d.sock, claims(env))
    client.download = async () => {
      throw new Error('tar broke')
    }
    const code = await submit(client, { mode: 'one', args: [], cwd: ws, maxFileMb: 50, interestGraceSec: 30, out: (s) => void out.push(s), err: (s) => void out.push(s), reconnectMs: 0, github: true, repo: 'me/app', sha: o.sha, env: { ...env, GITHUB_STEP_SUMMARY: join(ws, 's.md'), GITHUB_WORKSPACE: ws } })
    assert.equal(code, 0)
    assert.match(out.join(''), /no job files here: groups, annotations and artifacts skipped/)
    const { readdirSync } = await import('node:fs')
    assert.deepEqual(readdirSync(join(ws, 'ci-broker-artifacts')), [])
  } finally {
    close(d)
  }
})

// ---------------------------------------------------------------- re-review fixes

test('re-review #1: a local submit claiming another commit\'s tree is refused; the GitHub door never reuses such a job', async () => {
  const d = await door()
  try {
    const o = makeOrigin(d.h.origins, 'me/app')
    const { pushCommit, sh } = await import('../harness.ts')
    const b = pushCommit(o.work, 'g.txt', 'b\n')
    const a = o.sha
    await d.h.d.c.mirror.ensure('me/app')
    const treeB = await d.h.d.c.mirror.treeOf('me/app', b)
    await assert.rejects(d.h.d.c.jobs.submit({ repo: 'me/app', profile: 'app', mode: 'one', commit: a, tree: treeB, detach: true }), /tree [0-9a-f]{12} is not .* tree of/)
    const [s, body] = await raw(d.h.cfg.socketPath, 'POST', '/jobs', { repo: 'me/app', profile: 'app', mode: 'one', commit: a, tree: treeB, detach: true })
    assert.equal(s, 400, JSON.stringify(body))
    d.h.github.addRun({ repo: 'me/app', runId: 4411, sha: b, title: `broker one ${b} -` })
    const [s2, r2] = await raw(d.sock, 'POST', '/gh/jobs', { repo: 'me/app', runId: '4411', runAttempt: '1', ref: 'refs/heads/main', sha: b, mode: 'one', args: [] })
    assert.equal(s2, 200, JSON.stringify(r2))
    assert.ok(!r2.reused && !r2.joined)
    void sh
  } finally {
    close(d)
  }
})
