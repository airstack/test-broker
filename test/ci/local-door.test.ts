// The local door: admission on POST /jobs and checks, the 403 shape and exit 77, the protocol, the trust routes,
// the banner, /hello and the client's fallbacks, the switch drain, files.tar, /admin/seed, /daemon-log, the
// one-daemon lock, warm mirrors and the split socket's dir check.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, request, type Server } from 'node:http'
import { join } from 'node:path'
import { clientConfig } from '../../src/ci/cli.ts'
import * as cmd from '../../src/ci/client/commands.ts'
import { Client, PROTOCOL, pickClient } from '../../src/ci/client/http.ts'
import { formatReceipt } from '../../src/ci/client/receipt.ts'
import { jobFiles, submit, type SubmitOpts } from '../../src/ci/client/submit.ts'
import { startProblem, takeDaemonLock, warmMirrors } from '../../src/ci/daemon/main.ts'
import { DoorClosed, listen } from '../../src/ci/daemon/server.ts'
import { harness, idOf, makeOrigin, TEST_PROFILE, tmp, until, type Harness } from '../harness.ts'

async function up(o: Parameters<typeof harness>[0] = {}): Promise<{ h: Harness; server: Server; client: Client; out: string[]; err: string[] }> {
  const h = harness(o)
  const server = await listen(h.d, h.cfg.socketPath)
  const client = new Client(h.cfg.socketPath)
  await client.sayHello()
  return { h, server, client, out: [], err: [] }
}
const opts = (t: { out: string[]; err: string[] }, h: Harness, o: Partial<SubmitOpts>): SubmitOpts => ({
  mode: 'one', args: [], cwd: '.', maxFileMb: 50, interestGraceSec: h.cfg.interestGraceSec, out: (s) => void t.out.push(s), err: (s) => void t.err.push(s), reconnectMs: 0, retryMs: 0, profile: 'app', ...o,
})
function addProfile(h: Harness, name: string, repo: string, extra: object = {}) {
  mkdirSync(join(h.root, 'profiles', name), { recursive: true })
  writeFileSync(join(h.root, 'profiles', name, 'profile.json'), JSON.stringify({ ...TEST_PROFILE, name, repo, ...extra }))
  writeFileSync(join(h.root, 'profiles', name, 'remote.sh'), 'echo remote\n')
}
/** a raw request with chosen headers: [status, body] */
function raw(socket: string, method: string, path: string, headers: Record<string, string> = {}, body?: unknown): Promise<[number, any]> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body)
    const req = request({ socketPath: socket, method, path, headers: { ...(data ? { 'content-type': 'application/json' } : {}), ...headers } }, async (res) => {
      let s = ''
      for await (const c of res) s += c
      resolve([res.statusCode ?? 0, s ? JSON.parse(s) : null])
    })
    req.on('error', reject)
    req.end(data)
  })
}

test('a refused submit: 403 { error, trust: { check, door, repo, run } }; the client prints REFUSED and exits 77', async () => {
  const t = await up()
  try {
    addProfile(t.h, 'other', 'me/other')
    const o = makeOrigin(t.h.origins, 'me/app')
    const [status, body] = await raw(t.h.cfg.socketPath, 'POST', '/jobs', { 'x-cib-protocol': String(PROTOCOL) }, { repo: 'me/app', profile: 'other', mode: 'one', commit: o.sha })
    assert.equal(status, 403)
    assert.deepEqual(body.trust, { check: 'profile', door: 'local', repo: 'me/app', run: null })
    assert.match(body.error, /^refused \(trust\/profile\): profile other is for me\/other, not me\/app/)
    const code = await submit(t.client, opts(t, t.h, { cwd: o.work, profile: 'other', sha: o.sha }))
    assert.equal(code, 77)
    assert.match(t.err.join(''), /^ci-broker: REFUSED \(trust\/profile\): profile other is for me\/other, not me\/app$/m)
    assert.match(t.h.logs.join('\n'), /TRUST refused door=local repo=me\/app check=profile/)
    assert.equal(t.h.d.c.tdb.events({ limit: 5 }).filter((e) => e.checkId === 'profile').length, 2)
  } finally {
    t.server.close()
  }
})

test('--github: a refusal prints ::error title=ci-broker refused (trust/<check>)::<reason> outside the stopped commands', async () => {
  const t = await up()
  try {
    addProfile(t.h, 'other', 'me/other')
    const o = makeOrigin(t.h.origins, 'me/app')
    const ws = tmp()
    const env = { GITHUB_STEP_SUMMARY: join(ws, 'summary.md'), GITHUB_WORKSPACE: ws, GITHUB_RUN_ID: '1' }
    const code = await submit(t.client, opts(t, t.h, { cwd: o.work, profile: 'other', sha: o.sha, github: true, env }))
    assert.equal(code, 77)
    const out = t.out.join('')
    const stop = /::stop-commands::([0-9a-f]+)\n/.exec(out)![1]
    const resumed = out.indexOf(`::${stop}::`)
    const ann = out.indexOf('::error title=ci-broker refused (trust/profile)::profile other is for me/other')
    assert.ok(resumed >= 0 && ann > resumed, out)
  } finally {
    t.server.close()
  }
})

test('the protocol: N and N-1 accepted; N-2, none or junk → 426; /hello answers without it', async () => {
  const t = await up()
  try {
    for (const [v, want] of [[String(PROTOCOL), 200], [String(PROTOCOL - 1), 200], [String(PROTOCOL - 2), 426], ['x', 426]] as const) {
      const [s, b] = await raw(t.h.cfg.socketPath, 'GET', '/status', { 'x-cib-protocol': v })
      assert.equal(s, want, v)
      if (want === 426) assert.match(b.error, /older than the daemon: update it/)
    }
    assert.equal((await raw(t.h.cfg.socketPath, 'GET', '/status'))[0], 426)
    const [s, hello] = await raw(t.h.cfg.socketPath, 'GET', '/hello')
    assert.equal(s, 200)
    assert.deepEqual(hello, { protocol: PROTOCOL, daemonId: 'tst', layout: 'single', filesTar: true })
  } finally {
    t.server.close()
  }
})

test('a shard exiting 77 is a failed shard: the client exits 1, never 77', async () => {
  const t = await up()
  try {
    const o = makeOrigin(t.h.origins, 'me/app')
    const p = submit(t.client, opts(t, t.h, { cwd: o.work, mode: 'one' }))
    await until(() => t.h.ctl.pending.length === 1)
    t.h.ctl.pending[0].done(77)
    assert.equal(await p, 1)
    assert.match(t.out.join(''), /RESULT: FAIL/)
  } finally {
    t.server.close()
  }
})

test('single: a public repo is refused at the local door (public-local-only: the public lane needs split); a check of it too', async () => {
  const t = await up()
  try {
    t.h.github.setRepo('me/app', { private: false })
    const o = makeOrigin(t.h.origins, 'me/app')
    assert.equal(await submit(t.client, opts(t, t.h, { cwd: o.work, sha: o.sha })), 77)
    assert.match(t.err.join(''), /REFUSED \(trust\/public-local-only\)/)
    const [s, b] = await raw(t.h.cfg.socketPath, 'POST', '/resources/boat/check', { 'x-cib-protocol': String(PROTOCOL) }, { profile: 'app' })
    assert.equal(s, 403)
    assert.equal(b.trust.check, 'public-local-only')
  } finally {
    t.server.close()
  }
})

test('the scheduler: a public-lane job runs only on the local resource; while the slot is busy it waits (never Boat)', async () => {
  const h = harness({ resources: [{ id: 'local', kind: 'local', profiles: ['*'] }, { id: 'boat', kind: 'boat', profiles: ['*'], maxBoxes: 4 }], profile: { ...TEST_PROFILE, local: { where: 'container', image: 'i', commands: { one: 'echo one' } } } })
  const o = makeOrigin(h.origins, 'me/app')
  h.local.busy = true
  const r = await h.d.c.jobs.submit({ repo: 'me/app', profile: 'app', mode: 'one', commit: o.sha, detach: true, lane: 'public', env: 'noenv' })
  await h.pass()
  const j = h.d.c.db.job(idOf(r.id))!
  assert.equal(j.state, 'queued')
  assert.match(j.waitWhy!, /public lane: local only/)
  assert.equal(h.ctl.pending.length, 0)
  assert.equal(h.boat.boxes.length, 0, 'no Boat box for a public-lane job')
  h.local.busy = false
  await h.pass()
  await until(() => h.local.runs.length === 1)
  assert.equal(h.d.c.db.job(idOf(r.id))!.placement, 'local')
})

test('the job key carries the lane and env class: a public-lane pass is never reused for a full-lane request', async () => {
  const h = harness({ resources: [{ id: 'local', kind: 'local', profiles: ['*'] }], profile: { ...TEST_PROFILE, local: { where: 'container', image: 'i', commands: { one: 'echo one' } } } })
  const o = makeOrigin(h.origins, 'me/app')
  const pub = await h.d.c.jobs.submit({ repo: 'me/app', profile: 'app', mode: 'one', commit: o.sha, detach: true, lane: 'public', env: 'noenv' })
  await h.pass()
  await until(() => h.local.runs.length === 1)
  h.local.runs[0].finish(0)
  await h.settle()
  assert.equal(h.d.c.db.job(idOf(pub.id))!.state, 'passed')
  assert.match(pub.key, / public noenv$/)
  const full = await h.d.c.jobs.submit({ repo: 'me/app', profile: 'app', mode: 'one', commit: o.sha, detach: true, lane: 'full', env: 'noenv' })
  assert.ok(!full.reused)
  const again = await h.d.c.jobs.submit({ repo: 'me/app', profile: 'app', mode: 'one', commit: o.sha, detach: true, lane: 'public', env: 'noenv' })
  assert.equal(again.reused, true)
})

test('trust routes: /trust/check one line per check; /trust/log; /trust; unblock refused while public, allowed once private', async () => {
  const t = await up()
  try {
    const lines: string[] = []
    const out = (s: string) => void lines.push(s)
    const parsed = (pos: string[], flags: Record<string, string> = {}) => ({ cmd: 'trust', positional: pos, flags, rest: [] })
    assert.equal(await cmd.trust(t.client, out, parsed(['check', 'me/app'])), 0)
    assert.match(lines.join(''), /request: names valid ✓\n.*profile: app is me\/app's ✓\n.*blocked: not blocked ✓\n.*repo-access: tier private \(private, push\) → lane full ✓\n.*→ lane full/s)
    lines.length = 0
    t.h.d.c.tdb.setBlock('me/app', t.h.clock.t, 'tier private → public at 14:02')
    assert.equal(await cmd.trust(t.client, out, parsed(['check', 'me/app'])), 77)
    assert.match(lines.join(''), /refused \(trust\/blocked\)/)
    lines.length = 0
    assert.equal(await cmd.trust(t.client, out, parsed(['log'])), 0)
    assert.match(lines.join(''), /local\s+REFUSE me\/app \[blocked\]/)
    lines.length = 0
    assert.equal(await cmd.trust(t.client, out, parsed([])), 0)
    assert.match(lines.join(''), /approved \(global\): simple10 \(104495\), octo-other \(304762783\)/)
    assert.match(lines.join(''), /BLOCKED me\/app/)
    t.h.github.setRepo('me/app', { private: false })
    await assert.rejects(cmd.trust(t.client, out, parsed(['unblock', 'me/app'])), /is public .*stays blocked/)
    t.h.github.setRepo('me/app', { private: true })
    lines.length = 0
    assert.equal(await cmd.trust(t.client, out, parsed(['unblock', 'me/app'])), 0)
    assert.match(lines.join(''), /me\/app: unblocked/)
    assert.equal(t.h.d.c.tdb.block('me/app'), null)
  } finally {
    t.server.close()
  }
})

test('the status banner: a block with the operator\'s runnerctl stop command for its runners', async () => {
  const runners = join(tmp(), 'runners.json')
  writeFileSync(runners, JSON.stringify([{ id: 'me__app-1', repo: 'me/app', name: 'host-app-r1' }, { id: 'me__app-2', repo: 'me/app', name: 'host-app-r2' }]))
  const t = await up({ cfg: { runnersJson: runners } })
  try {
    t.h.d.c.tdb.setBlock('me/app', t.h.clock.t, 'tier private → public at 14:02')
    const out: string[] = []
    await cmd.status(t.client, (s) => void out.push(s))
    const s = out.join('')
    assert.match(s, /^!! TRUST\n   me\/app BLOCKED since \d\d:\d\d: tier private → public at 14:02\. Stop its 2 runner\(s\): sudo -n ci-broker-runnerctl stop me\/app\n     After review: ci-broker trust unblock me\/app\n/)
  } finally {
    t.server.close()
  }
})

test('pickClient: the first socket that answers; an old daemon (no /hello) → hello null → the job dir is read directly', async () => {
  const t = await up()
  const old = createServer((req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: `no route ${req.method} ${req.url}` }))
  })
  const oldSock = join(tmp(), 'old.sock')
  await new Promise<void>((r) => old.listen(oldSock, () => r()))
  try {
    const c = await pickClient([join(tmp(), 'none.sock'), t.h.cfg.socketPath])
    assert.equal(c.socket, t.h.cfg.socketPath)
    assert.equal(c.hello!.layout, 'single')
    const o = await pickClient([oldSock, t.h.cfg.socketPath])
    assert.equal(o.socket, oldSock)
    assert.equal(o.hello, null)
    const job: any = { id: 'tst-1', dir: '/the/job/dir' }
    assert.deepEqual(await jobFiles(o, job), { dir: '/the/job/dir', temp: false })
  } finally {
    t.server.close()
    old.close()
  }
})

test('files.tar: regular files and dirs only (a symlink to a host file is left out); a split client reads the job through it', async () => {
  const t = await up()
  try {
    const o = makeOrigin(t.h.origins, 'me/app')
    const r = await t.h.submit({ sha: o.sha, mode: 'one' })
    const dir = t.h.d.c.streams.dir(idOf(r.id))
    mkdirSync(join(dir, 'artifacts', 'one', 'sub'), { recursive: true })
    writeFileSync(join(dir, 'artifacts', 'one', 'sub', 'r.txt'), 'report\n')
    writeFileSync(join(dir, 'extra.log'), 'log line\n')
    const secret = join(tmp(), 'secret')
    writeFileSync(secret, 'host file\n')
    symlinkSync(secret, join(dir, 'artifacts', 'one', 'leak.txt'))
    symlinkSync(secret, join(dir, 'x.log'))
    t.client.hello = { ...t.client.hello!, layout: 'split' }
    const f = await jobFiles(t.client, { id: r.id, dir: '/not/readable' } as any)
    assert.equal(f.temp, true)
    assert.equal(readFileSync(join(f.dir, 'artifacts', 'one', 'sub', 'r.txt'), 'utf8'), 'report\n')
    assert.equal(readFileSync(join(f.dir, 'extra.log'), 'utf8'), 'log line\n')
    assert.ok(!existsSync(join(f.dir, 'artifacts', 'one', 'leak.txt')))
    assert.ok(!existsSync(join(f.dir, 'x.log')))
  } finally {
    t.server.close()
  }
})

test('receipts never print the job dir', () => {
  const job: any = { id: 'tst-3', repo: 'me/app', commit: 'a'.repeat(40), source: 'pushed', profile: 'app', mode: 'one', args: [], state: 'passed', summary: { text: 'RESULT: PASS', secs: 3 }, error: null, dir: '/var/lib/ci-broker/admin/state/jobs/3', artifacts: ['one'], statusTargets: [] }
  const r = formatReceipt(job, { args: [], wantStatus: false })
  assert.ok(!r.includes('/var/lib'), r)
  assert.match(r, /logs: ci-broker logs tst-3/)
  assert.match(formatReceipt(job, { args: [], wantStatus: false, artifactsDir: '/w/out' }), /artifacts: one in \/w\/out/)
})

test('the switch drain: new submits get 503 "draining for switch", the client waits it out (following the socket), queued work goes on', async () => {
  const t = await up()
  try {
    const o = makeOrigin(t.h.origins, 'me/app')
    const [s, b] = await raw(t.h.cfg.socketPath, 'POST', '/drain', { 'x-cib-protocol': String(PROTOCOL) }, { forSwitch: true })
    assert.equal(s, 200)
    assert.equal(b.forSwitch, true)
    assert.equal((await raw(t.h.cfg.socketPath, 'POST', '/jobs', { 'x-cib-protocol': String(PROTOCOL) }, { repo: 'me/app', mode: 'one', commit: o.sha }))[0], 503)
    let picks = 0
    const p = submit(t.client, opts(t, t.h, { cwd: o.work, sha: o.sha, detach: true, pick: async () => {
      if (++picks === 3) t.h.d.c.switchDrain = false
      return t.client
    } }))
    assert.equal(await p, 0)
    assert.equal(picks, 3)
    assert.match(t.err.join(''), /draining for the switch to the split layout; waiting/)
  } finally {
    t.server.close()
  }
})

test('after a daemon change the job is unknown: the client submits once more and follows the new job', async () => {
  const a = await up()
  const b = await up()
  b.h.boat.onCommand = undefined
  try {
    const oa = makeOrigin(a.h.origins, 'me/app')
    const { cpSync } = await import('node:fs')
    cpSync(join(a.h.origins, 'me', 'app.git'), join(b.h.origins, 'me', 'app.git'), { recursive: true })
    let moved = false
    const p = submit(a.client, opts(a, a.h, { cwd: oa.work, sha: oa.sha, pick: async () => (moved ? b.client : a.client) }))
    await until(() => a.h.ctl.pending.length === 1)
    moved = true
    a.server.close()
    a.server.closeAllConnections()
    assert.equal(await p, 0, a.out.join('') + a.err.join(''))
    assert.match(a.err.join(''), /no longer knows job tst-1 .*submitting again/)
  } finally {
    a.server.close()
    b.server.close()
  }
})

test('/admin/seed: job ids continue above the old daemon\'s; refused once the DB has a job', async () => {
  const t = await up()
  try {
    const h = { 'x-cib-protocol': String(PROTOCOL) }
    assert.deepEqual(await raw(t.h.cfg.socketPath, 'POST', '/admin/seed', h, { nextId: 500 }), [200, { ok: true, next: 'tst-500' }])
    const o = makeOrigin(t.h.origins, 'me/app')
    assert.equal((await t.h.submit({ sha: o.sha, mode: 'one' })).id, 'tst-500')
    assert.equal((await raw(t.h.cfg.socketPath, 'POST', '/admin/seed', h, { nextId: 900 }))[0], 409)
  } finally {
    t.server.close()
  }
})

test('/daemon-log: the daemon\'s own log (scrubbed), the last N lines', async () => {
  const logFile = join(tmp(), 'daemon.log')
  const t = await up({ deps: { logFile } })
  try {
    t.h.d.c.secrets.add('s3cr3t-value')
    t.h.d.c.log('one s3cr3t-value')
    t.h.d.c.log('two')
    t.h.d.c.log('three')
    const out: string[] = []
    await cmd.daemonLog(t.client, (s) => void out.push(s), { follow: false, n: '2' })
    assert.deepEqual(out.join('').trim().split('\n').map((l) => l.split(' ').slice(1).join(' ')), ['two', 'three'])
    assert.ok(!readFileSync(logFile, 'utf8').includes('s3cr3t-value'))
  } finally {
    t.server.close()
  }
})

test('client config: install.conf → the split socket first, then single\'s; the lock from install.conf', () => {
  const d = tmp()
  writeFileSync(join(d, 'install.conf'), readFileSync(join(import.meta.dirname, 'fixtures', 'install-conf', 'ok-default.conf')))
  const c = clientConfig({ HOME: '/home/op', CI_BROKER_INSTALL_CONF: join(d, 'install.conf') })
  assert.deepEqual(c.sockets, ['/var/lib/ci-broker/local/brokerd.sock', '/home/op/.local/state/ci-broker/brokerd.sock'])
  assert.equal(c.splitLock, '/var/lib/ci-broker/local/local.lock')
  assert.equal(c.githubSocket, '/var/lib/ci-broker/sock/github.sock')
  assert.deepEqual(clientConfig({ HOME: '/home/op', CI_BROKER_INSTALL_CONF: join(d, 'none') }).sockets, ['/home/op/.local/state/ci-broker/brokerd.sock'])
})

test('one daemon: a second one can\'t take the lock; a single daemon refuses while install.conf exists', async () => {
  const h = harness()
  const a = await takeDaemonLock(h.cfg)
  assert.ok(a)
  assert.equal(await takeDaemonLock(h.cfg), null)
  await a!.release()
  const ic = join(tmp(), 'install.conf')
  assert.equal(startProblem(h.cfg, { CI_BROKER_INSTALL_CONF: ic }), null)
  writeFileSync(ic, 'x')
  assert.match(startProblem(h.cfg, { CI_BROKER_INSTALL_CONF: ic })!, /single daemon refuses to start/)
  assert.equal(startProblem({ ...h.cfg, layout: 'split' }, { CI_BROKER_INSTALL_CONF: ic }), null)
})

test('--warm-mirrors clones every profile repo\'s mirror', async () => {
  const h = harness()
  makeOrigin(h.origins, 'me/app')
  assert.equal(await warmMirrors(h.d), 0)
  assert.ok(existsSync(join(h.cfg.stateDir, 'work', 'me__app.git', 'HEAD')))
})

test('split socket: the dir must already be <daemon>:<group> 2750 (never made or chmodded by the daemon); the socket ends up 0660', async () => {
  const h = harness()
  const dir = join(tmp(), 'local')
  mkdirSync(dir)
  chmodSync(dir, 0o755)
  const want = { uid: process.getuid!(), gid: process.getgid!(), mode: 0o2750 }
  await assert.rejects(listen(h.d, join(dir, 'brokerd.sock'), { dirCheck: want, sockMode: 0o660 }), (e: unknown) => e instanceof DoorClosed && /mode 0755, want 2750/.test((e as Error).message))
  assert.equal(statSync(dir).mode & 0o7777, 0o755, 'not chmodded')
  await assert.rejects(listen(h.d, join(tmp(), 'nope', 'brokerd.sock'), { dirCheck: want }), /missing/)
  chmodSync(dir, 0o2750)
  await assert.rejects(listen(h.d, join(dir, 'brokerd.sock'), { dirCheck: { ...want, gid: want.gid + 1 } }), /has group/)
  const s = await listen(h.d, join(dir, 'brokerd.sock'), { dirCheck: want, sockMode: 0o660 })
  try {
    assert.equal(statSync(join(dir, 'brokerd.sock')).mode & 0o777, 0o660)
    assert.ok(readdirSync(dir).includes('brokerd.sock'))
  } finally {
    s.close()
  }
})

test('local runs: job secrets by name, read at run time, only for env-class full-lane jobs; the public lane gets none', async () => {
  const sec = join(tmp(), 'tok')
  writeFileSync(sec, 'tok-value-123\n')
  const prof = { ...TEST_PROFILE, local: { where: 'container', image: 'i', env: { GITHUB_TOKEN: 'tok', MISSING: 'gone' }, commands: { one: 'echo one' } } }
  const mk = () => harness({ resources: [{ id: 'local', kind: 'local', profiles: ['*'] }], profile: { ...prof, local: { ...prof.local, env: { GITHUB_TOKEN: 'tok' } } }, cfg: { secrets: { tok: { file: sec } } } })
  const h = mk()
  const o = makeOrigin(h.origins, 'me/app')
  await h.d.c.jobs.submit({ repo: 'me/app', profile: 'app', mode: 'one', commit: o.sha, detach: true, lane: 'full', env: 'env' })
  await h.pass()
  await until(() => h.local.runs.length === 1)
  assert.deepEqual(h.local.runs[0].env, { GITHUB_TOKEN: 'tok-value-123' })
  assert.ok(h.d.c.secrets.has('tok-value-123'), 'scrubbed from then on')
  const p = mk()
  const po = makeOrigin(p.origins, 'me/app')
  const pr = await p.d.c.jobs.submit({ repo: 'me/app', profile: 'app', mode: 'one', commit: po.sha, detach: true, lane: 'public', env: 'noenv' })
  await p.pass()
  await until(() => p.local.runs.length === 1)
  assert.deepEqual(p.local.runs[0].env, {})
  p.local.runs[0].finish(0)
  await p.settle()
  assert.match(readFileSync(join(p.d.c.streams.dir(idOf(pr.id)), 'local.log'), 'utf8'), /public lane: local\.env not passed \(1 names\)/)
  const m = harness({ resources: [{ id: 'local', kind: 'local', profiles: ['*'] }], profile: prof, cfg: { secrets: { tok: { file: sec } } } })
  const mo = makeOrigin(m.origins, 'me/app')
  const mr = await m.d.c.jobs.submit({ repo: 'me/app', profile: 'app', mode: 'one', commit: mo.sha, detach: true, lane: 'full', env: 'env' })
  await m.settle()
  assert.match(m.d.c.db.shard(idOf(mr.id), 0)!.reason ?? '', /secret gone is not set/)
})

test('the CLI connects only for daemon commands: help, dispatch and install never look for a socket', async () => {
  const { DAEMON_CMDS } = await import('../../src/ci/cli.ts')
  for (const c of ['help', 'dispatch', 'install', 'admit']) assert.ok(!DAEMON_CMDS.has(c), c)
  for (const c of ['submit', 'status', 'trust', 'local-lock']) assert.ok(DAEMON_CMDS.has(c), c)
  // a run of `help` with HOME pointing at a dir whose socket would record a connect
  const home = tmp()
  const sockDir = join(home, '.local', 'state', 'ci-broker')
  mkdirSync(sockDir, { recursive: true })
  let hits = 0
  const srv = createServer((_q, r) => (hits++, r.end('{}')))
  await new Promise<void>((r) => srv.listen(join(sockDir, 'brokerd.sock'), () => r()))
  try {
    const { spawnSync } = await import('node:child_process')
    const r = spawnSync(process.execPath, [join(import.meta.dirname, '..', '..', 'src', 'ci', 'cli.ts'), 'help'], { env: { PATH: process.env.PATH, HOME: home, CI_BROKER_INSTALL_CONF: join(home, 'none') }, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(hits, 0)
  } finally {
    srv.close()
  }
})

test('correctness #5: a fresh split state waits for its job id seed: submits get 503 (clients wait) until /admin/seed', async () => {
  const root = tmp()
  mkdirSync(join(root, 'state'), { recursive: true })
  writeFileSync(join(root, 'state', 'await-seed'), '')
  const t = await up({ root })
  try {
    const o = makeOrigin(t.h.origins, 'me/app')
    const h = { 'x-cib-protocol': String(PROTOCOL) }
    const [s, b] = await raw(t.h.cfg.socketPath, 'POST', '/jobs', h, { repo: 'me/app', profile: 'app', mode: 'one', commit: o.sha })
    assert.equal(s, 503)
    assert.match(b.error, /draining for switch.*job id seed/)
    const st: string[] = []
    await cmd.status(t.client, (x) => void st.push(x))
    assert.match(st.join(''), /waiting for its job id seed/)
    assert.deepEqual(await raw(t.h.cfg.socketPath, 'POST', '/admin/seed', h, { nextId: 77 }), [200, { ok: true, next: 'tst-77' }])
    assert.ok(!existsSync(join(root, 'state', 'await-seed')))
    assert.equal((await raw(t.h.cfg.socketPath, 'POST', '/jobs', h, { repo: 'me/app', profile: 'app', mode: 'one', commit: o.sha, detach: true }))[1].id, 'tst-77')
  } finally {
    t.server.close()
  }
})

test('correctness #6: the split daemon makes local.lock (0660, the operator\'s group) at start, so local-lock works before any job', async () => {
  const { ensureLocalLock } = await import('../../src/ci/daemon/main.ts')
  const dir = tmp()
  const f = join(dir, 'local.lock')
  ensureLocalLock(f)
  assert.equal(statSync(f).mode & 0o777, 0o660)
  ensureLocalLock(f)
  assert.equal(statSync(f).mode & 0o777, 0o660)
})

test('correctness #10: messages say what to do (daemon down, protocol, trust refusals)', async () => {
  await assert.rejects(new Client(join(tmp(), 'none.sock')).request('GET', '/status'), (e: Error) => /sudo -n ci-broker-runnerctl daemon start/.test(e.message) && /systemctl --user start ci-brokerd/.test(e.message))
  const c = await pickClient([join(tmp(), 'split.sock'), join(tmp(), 'single.sock')])
  assert.match(c.socket, /split\.sock$/, 'none answering: the first (split) socket names the error')
  const t = await up()
  try {
    const [, old] = await raw(t.h.cfg.socketPath, 'GET', '/status', { 'x-cib-protocol': String(PROTOCOL - 2) })
    assert.match(old.error, /the client is older than the daemon.*git pull/)
    const [, nu] = await raw(t.h.cfg.socketPath, 'GET', '/status', { 'x-cib-protocol': String(PROTOCOL + 1) })
    assert.match(nu.error, /the daemon is older than the client.*install\.sh --release/)
    t.h.github.setRepo('me/app', { push: false })
    const o = makeOrigin(t.h.origins, 'me/app')
    const [, r] = await raw(t.h.cfg.socketPath, 'POST', '/jobs', { 'x-cib-protocol': String(PROTOCOL) }, { repo: 'me/app', profile: 'app', mode: 'one', commit: o.sha })
    assert.match(r.error, /the daemon's GitHub token needs push.*ci-broker doctor/)
  } finally {
    t.server.close()
  }
})

test('correctness #11: doctor warns on a release that is not current, runner units not in runners.json, a stale host-address drop-in', async () => {
  const sys = tmp()
  mkdirSync(join(sys, 'multi-user.target.wants'), { recursive: true })
  mkdirSync(join(sys, 'ci-broker-runner@.service.d'), { recursive: true })
  writeFileSync(join(sys, 'multi-user.target.wants', 'ci-broker-runner@me__app-1.service'), '')
  writeFileSync(join(sys, 'multi-user.target.wants', 'ci-broker-runner@me__app-9.service'), '')
  writeFileSync(join(sys, 'ci-broker-runner@.service.d', '10-host-addrs.conf'), '[Service]\nIPAddressDeny=203.0.113.77/32\n')
  const runners = join(tmp(), 'runners.json')
  writeFileSync(runners, JSON.stringify([{ id: 'me__app-1', repo: 'me/app', name: 'r1' }]))
  const rel = join(tmp(), 'RELEASE')
  writeFileSync(rel, `${'b'.repeat(40)}\nprotocol 2\n`)
  const h = harness({ cfg: { layout: 'split', operatorUid: process.getuid!(), runnersJson: runners, releaseFile: rel }, deps: { ownRelease: 'a'.repeat(40), systemdDir: sys } })
  const { doctor } = await import('../../src/ci/daemon/local-door.ts')
  const r = await doctor(h.d, null)
  const text = r.lines.map((l) => l.text).join('\n')
  assert.match(text, /current release b{12} is not what this daemon runs \(a{12}\): restart/)
  assert.match(text, /runner unit ci-broker-runner@me__app-9 is not in runners\.json/)
  assert.ok(!/me__app-1 is not in/.test(text))
  assert.match(text, /10-host-addrs\.conf is out of date.*runnerctl install-unit/)
})

test('correctness #13: a switch drain can be cancelled (POST /drain {cancel}); submits go through again', async () => {
  const t = await up()
  try {
    const h = { 'x-cib-protocol': String(PROTOCOL) }
    await raw(t.h.cfg.socketPath, 'POST', '/drain', h, { forSwitch: true })
    assert.equal(t.h.d.c.switchDrain, true)
    assert.deepEqual((await raw(t.h.cfg.socketPath, 'POST', '/drain', h, { cancel: true }))[1], { cancelled: true })
    assert.equal(t.h.d.c.switchDrain, false)
  } finally {
    t.server.close()
  }
})
