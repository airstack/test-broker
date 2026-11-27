import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dockerSkip } from '../docker.ts'
import { defaults } from '../../src/ci/config.ts'
import { realGit } from '../../src/core/mirror.ts'
import { dockerArgs, runLocal, tryLocalSlot, waitLocalSlot } from '../../src/ci/local.ts'

const tmp = () => mkdtempSync(join(tmpdir(), "cib-local-"))
const lockIn = (d: string) => join(d, "local.lock")


test('the local slot is exclusive and frees on release', async () => {
  const d = tmp()
  const a = await tryLocalSlot(lockIn(d))
  assert.ok(a)
  assert.equal(await tryLocalSlot(lockIn(d)), null)
  await a.release()
  const b = await tryLocalSlot(lockIn(d))
  assert.ok(b)
  await b.release()
})

test('waitLocalSlot gets the slot once it is released, and gives up on abort', async () => {
  const d = tmp()
  const a = (await tryLocalSlot(lockIn(d)))!
  const ac = new AbortController()
  const pending = waitLocalSlot(lockIn(d), ac.signal)
  setTimeout(() => void a.release(), 100)
  const b = await pending
  await b.release()
  const c = (await tryLocalSlot(lockIn(d)))!
  const ac2 = new AbortController()
  const p2 = waitLocalSlot(lockIn(d), ac2.signal)
  ac2.abort()
  await assert.rejects(p2, /aborted/)
  await c.release()
})

test('a host run returns the command exit code and streams output', async () => {
  let out = ''
  const code = await runLocal({ dir: tmp(), mirrorObjects: tmpdir(), where: 'host', cmd: 'echo hi; exit 7', cfg: defaults(), onData: (s) => (out += s) })
  assert.equal(code, 7)
  assert.equal(out, 'hi\n')
})

test('aborting a host run stops it quickly with a non-zero code', async () => {
  const ac = new AbortController()
  const t0 = Date.now()
  setTimeout(() => ac.abort(), 100)
  const code = await runLocal({ dir: tmp(), mirrorObjects: tmpdir(), where: 'host', cmd: 'sleep 30', cfg: defaults(), onData: () => {}, signal: ac.signal })
  assert.notEqual(code, 0)
  assert.ok(Date.now() - t0 < 2000)
})

test('runLocal hands extra env to the command', async () => {
  let out = ''
  const code = await runLocal({ dir: tmp(), mirrorObjects: tmpdir(), where: 'host', cmd: 'echo "tok=$CIB_T"', cfg: defaults(), onData: (s) => (out += s), env: { CIB_T: 'abc' } })
  assert.equal(code, 0)
  assert.match(out, /tok=abc/)
})

test('cancel of a host run whose group ignores SIGTERM: SIGKILL after the grace', async () => {
  const ac = new AbortController()
  const code = await runLocal({
    dir: tmp(), mirrorObjects: tmpdir(), where: 'host', cfg: defaults(), signal: ac.signal, killGraceMs: 0,
    cmd: `trap '' TERM; bash -c "trap '' TERM; echo ready; while :; do sleep 1; done"`,
    onData: (s) => s.includes('ready') && ac.abort(),
  })
  assert.notEqual(code, 0)
})

test('cancel of a host run whose escaped grandchild keeps the output pipe open still resolves (bounded wait, pipes destroyed)', async () => {
  const { readFileSync } = await import('node:fs')
  const dir = tmp()
  const ac = new AbortController()
  try {
    const code = await runLocal({
      dir, mirrorObjects: tmpdir(), where: 'host', cfg: defaults(), signal: ac.signal, killGraceMs: 0, closeWaitMs: 0,
      cmd: `setsid sleep 300 & echo $! > ${dir}/pid; echo ready; wait`,
      onData: (s) => s.includes('ready') && ac.abort(),
    })
    assert.notEqual(code, 0)
  } finally {
    try {
      process.kill(Number(readFileSync(join(dir, 'pid'), 'utf8')), 'SIGKILL')
    } catch {}
  }
})

// ---- trust layer: the hardened local lane

import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync as exists, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { nonoArgv } from '../../src/ci/local.ts'
import { copyArtifacts, removeTree } from '../../src/ci/daemon/exec-local.ts'
import { Mirror } from '../../src/core/mirror.ts'
import { describe as describeStatus } from '../../src/ci/daemon/statuses.ts'
import { Credentials } from '../../src/ci/credentials.ts'
import { harness, idOf, makeOrigin, pushCommit, sh, TEST_PROFILE, until } from '../harness.ts'

const base = { name: 'cib-x', dir: '/s/work/me__x/7-abc', mirrorObjects: '/s/work/me__x.git/objects', image: 'img:1', cmd: 'just test-all', cfg: defaults(), uid: 1002, gid: 1002, repo: 'me/x' }
const pair = (a: string[], k: string, v: string) => a.some((x, i) => x === k && a[i + 1] === v)

test('docker args, full lane: the checkout rw and the mirror objects ro, no work root; cap-drop, no-new-privileges, pids 8192; shared volumes; env by name', () => {
  const a = dockerArgs({ ...base, lane: 'full', envNames: ['GITHUB_TOKEN'], tmpfs: ['.wrangler'], labels: { 'ci-broker.daemon': 'ub1', 'ci-broker.job': '7' } })
  assert.deepEqual(a.slice(0, 5), ['run', '--rm', '--init', '--name', 'cib-x'])
  assert.ok(pair(a, '--sysctl', 'net.ipv4.ip_unprivileged_port_start=1024'))
  assert.ok(pair(a, '-v', '/s/work/me__x/7-abc:/s/work/me__x/7-abc'))
  assert.ok(pair(a, '-v', '/s/work/me__x.git/objects:/s/work/me__x.git/objects:ro'))
  assert.ok(!a.some((x) => x === '/s/work:/s/work' || /^\/s\/work:/.test(x)), 'the work root is never mounted')
  assert.ok(pair(a, '--cap-drop', 'ALL'))
  assert.ok(pair(a, '--security-opt', 'no-new-privileges'))
  assert.ok(pair(a, '--pids-limit', '8192'))
  assert.ok(pair(a, '-v', 'ci-broker-pnpm-store:/pnpm-store'))
  assert.ok(pair(a, '-v', 'ci-broker-ms-playwright:/ms-playwright'))
  assert.ok(pair(a, '-e', 'GITHUB_TOKEN'))
  assert.ok(!a.join(' ').includes('GITHUB_TOKEN='))
  assert.ok(!a.includes('--network'))
  assert.ok(pair(a, '--tmpfs', '/s/work/me__x/7-abc/.wrangler:exec,size=6g,uid=1002,gid=1002'))
  assert.ok(pair(a, '-w', '/s/work/me__x/7-abc'))
  assert.ok(a.join(' ').includes('--label ci-broker.daemon=ub1 --label ci-broker.job=7'))
  for (const p of [['--cpus', '6'], ['--memory', '20g'], ['--user', '1002:1002']]) assert.ok(pair(a, p[0], p[1]), p.join(' '))
  assert.deepEqual(a.slice(-4), ['img:1', 'bash', '-lc', 'just test-all'])
  assert.ok(!dockerArgs({ ...base, lane: 'full', relax: ['caps'] }).includes('--cap-drop'), 'dockerRelax caps (full lane only)')
})

test('docker args, public lane: --network ci-broker-pub, per-repo volumes, pids 4096, never env, always cap-drop (dockerRelax ignored)', () => {
  const a = dockerArgs({ ...base, lane: 'public', envNames: ['GITHUB_TOKEN'], relax: ['caps'] })
  assert.ok(pair(a, '--sysctl', 'net.ipv4.ip_unprivileged_port_start=1024'))
  assert.ok(pair(a, '--network', 'ci-broker-pub'))
  assert.ok(pair(a, '-v', 'ci-broker-pub-me__x-pnpm:/pnpm-store'))
  assert.ok(pair(a, '-v', 'ci-broker-pub-me__x-ms-playwright:/ms-playwright'))
  assert.ok(pair(a, '--pids-limit', '4096'))
  assert.ok(pair(a, '--cap-drop', 'ALL'))
  assert.ok(!a.includes('GITHUB_TOKEN'))
  assert.ok(!a.some((v) => v.startsWith('ci-broker-pnpm-store') || v.startsWith('ci-broker-ms-playwright')))
})

test('nono (single host mode): nonoProfile → nono run -s --profile <p> --allow <dir> --read <objects> [nono…] -- bash -lc <cmd>', () => {
  assert.deepEqual(nonoArgv({ dir: '/d', mirrorObjects: '/m/objects', cmd: 'x', nono: ['--net-block'], nonoProfile: 'dev' }), ['nono', 'run', '-s', '--profile', 'dev', '--allow', '/d', '--read', '/m/objects', '--net-block', '--', 'bash', '-lc', 'x'])
  assert.deepEqual(nonoArgv({ dir: '/d', mirrorObjects: '/m/objects', cmd: 'x', nono: [] }), ['nono', 'run', '--allow', '/d', '--', 'bash', '-lc', 'x'])
  assert.equal(nonoArgv({ dir: '/d', mirrorObjects: '/m/objects', cmd: 'x', nono: false }), null)
})

const ident = ['-c', 'user.email=t@t', '-c', 'user.name=t']

test('mirror: every fetch passes the URL (a planted remote.origin.url is never used); new mirrors get gc.auto=0; a planted credential helper never runs', async () => {
  const root = tmp()
  const o = makeOrigin(join(root, 'origins'), 'me/app')
  const calls: string[][] = []
  const git = realGit(60)
  const m = new Mirror(join(root, 'work'), (r) => join(root, 'origins', `${r}.git`), (args, x) => (calls.push(args), git(args, x)))
  await m.ensure('me/app')
  const mp = m.path('me/app')
  assert.equal(execFileSync('git', ['--git-dir', mp, 'config', 'gc.auto'], { encoding: 'utf8' }).trim(), '0')
  assert.ok(calls.filter((c) => c.includes('fetch')).every((c) => c.includes(join(root, 'origins', 'me/app.git'))), JSON.stringify(calls))
  assert.ok(calls.every((c) => c.includes('core.hooksPath=/dev/null') && c.includes('core.fsmonitor=false') && c.includes('gc.auto=0')))
  execFileSync('git', ['--git-dir', mp, 'config', 'remote.origin.url', join(root, 'nowhere.git')])
  const marker = join(root, 'helper-ran')
  execFileSync('git', ['--git-dir', mp, 'config', 'credential.helper', `!f() { touch ${marker}; }; f`])
  const sha2 = pushCommit(o.work, 'g.txt', 'x\n')
  await m.ensure('me/app')
  assert.ok(await m.has('me/app', sha2), 'fetched from the real URL, not the planted one')
  const d = new Credentials({ ...defaults({ HOME: root }), stateDir: join(root, 'state') }, { addSecret: () => {} })
  spawnSync('git', ['--git-dir', mp, 'credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', env: { ...d.gitEnv({ PATH: process.env.PATH }) } })
  assert.ok(!exists(marker), "the mirror's own credential.helper is reset by the daemon's env")
})

test('mirror gc: skipped while the repo has an active job, run otherwise', async () => {
  const root = tmp()
  makeOrigin(join(root, 'origins'), 'me/app')
  const calls: string[][] = []
  const git = realGit(60)
  const m = new Mirror(join(root, 'work'), (r) => join(root, 'origins', `${r}.git`), (args, x) => (calls.push(args), git(args, x)))
  await m.ensure('me/app')
  assert.equal(await m.gc('me/app', () => true), false)
  assert.ok(!calls.some((c) => c.includes('gc')))
  assert.equal(await m.gc('me/app', () => false), true)
  assert.ok(calls.some((c) => c.includes('gc')))
})

test('the clone layout: a fresh clone per run; hooks and fsmonitor in its .git never run; a read-only dir left by the job is removed', async () => {
  const h = harness({ resources: [{ id: 'local', kind: 'local', profiles: ['*'] }], profile: { ...TEST_PROFILE, local: { where: 'host', commands: { one: 'echo one' } } } })
  const o = makeOrigin(h.origins, 'me/app')
  const gitCalls: { args: string[]; cwd?: string }[] = []
  const realg = realGit(60)
  ;(h.d.c.mirror as any).git = (args: string[], x: any) => (gitCalls.push({ args, cwd: x?.cwd }), realg(args, x))
  await h.d.c.jobs.submit({ repo: 'me/app', profile: 'app', mode: 'one', commit: o.sha, detach: true })
  await h.pass()
  await until(() => h.local.runs.length === 1)
  const run = h.local.runs[0]
  const dir = run.dir
  assert.ok(exists(join(dir, '.git', 'objects', 'info', 'alternates')), 'a --shared clone')
  assert.equal(readFileSync(join(dir, '.git', 'objects', 'info', 'alternates'), 'utf8').trim(), join(h.d.c.mirror.path('me/app'), 'objects'))
  assert.equal(readFileSync(join(dir, 'f.txt'), 'utf8'), 'v1\n')
  assert.equal(run.mirrorObjects, join(h.d.c.mirror.path('me/app'), 'objects'))
  // the "job" plants code for the daemon's next git call in its clone, and leaves a read-only dir
  const marker = join(h.root, 'planted-ran')
  writeFileSync(join(dir, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 })
  execFileSync('git', ['-C', dir, 'config', 'core.fsmonitor', `touch ${marker}`])
  mkdirSync(join(dir, 'ro', 'deep'), { recursive: true })
  writeFileSync(join(dir, 'ro', 'deep', 'f'), 'x')
  chmodSync(join(dir, 'ro', 'deep'), 0o500)
  chmodSync(join(dir, 'ro'), 0o500)
  const n = gitCalls.length
  run.finish(0)
  await h.settle()
  assert.ok(!exists(dir), 'removed, read-only dirs too')
  assert.ok(!exists(marker), 'nothing the job planted ran')
  assert.ok(!gitCalls.slice(n).some((c) => c.cwd === dir || c.args.includes(dir)), 'no git call in the job dir after the run')
})

test('artifacts: regular files and dirs only; a symlink, a FIFO and a symlinked parent dir are skipped and listed in SKIPPED.txt', () => {
  const dir = tmp()
  const out = tmp()
  const host = tmp()
  writeFileSync(join(host, 'passwd'), 'root:x:0:0\n')
  mkdirSync(join(dir, 'out', 'sub'), { recursive: true })
  writeFileSync(join(dir, 'out', 'report.txt'), 'ok\n')
  writeFileSync(join(dir, 'out', 'sub', 'b.txt'), 'b\n')
  symlinkSync(join(host, 'passwd'), join(dir, 'out', 'leak'))
  execFileSync('mkfifo', [join(dir, 'out', 'fifo')])
  symlinkSync(host, join(dir, 'linked'))
  const notes: string[] = []
  copyArtifacts({ dir, dest: join(out, 'one'), paths: ['out', 'linked/passwd', 'linked', 'missing'], note: (s) => void notes.push(s) })
  assert.equal(readFileSync(join(out, 'one', 'out', 'report.txt'), 'utf8'), 'ok\n')
  assert.equal(readFileSync(join(out, 'one', 'out', 'sub', 'b.txt'), 'utf8'), 'b\n')
  assert.ok(!exists(join(out, 'one', 'out', 'leak')))
  assert.ok(!exists(join(out, 'one', 'out', 'fifo')))
  assert.ok(!exists(join(out, 'one', 'linked')))
  const skipped = readFileSync(join(out, 'one', 'SKIPPED.txt'), 'utf8')
  for (const p of ['out/leak', 'out/fifo', 'linked/passwd', 'linked']) assert.match(skipped, new RegExp(`^${p.replace('/', '\\/')}: `, 'm'))
  assert.ok(!readdirSync(join(out, 'one')).includes('missing'))
})

test('removeTree: chmod -R u+rwX then rm -rf (a read-only tree goes too)', async () => {
  const d = tmp()
  mkdirSync(join(d, 'a', 'b'), { recursive: true })
  writeFileSync(join(d, 'a', 'b', 'f'), 'x')
  chmodSync(join(d, 'a', 'b'), 0o500)
  chmodSync(join(d, 'a'), 0o500)
  await removeTree(join(d, 'a'))
  assert.ok(!exists(join(d, 'a')))
})

test('statuses: a public-lane run says so at the end of its description', () => {
  assert.equal(describeStatus({ error: null }, [{ state: 'passed', reason: null }], 'passed', 190, 'ub1-52', 'public'), '1/1 shards passed in 3m10s (job ub1-52) (public lane)')
  assert.equal(describeStatus({ error: null }, [{ state: 'passed', reason: null }], 'passed', 190, 'ub1-52', 'full'), '1/1 shards passed in 3m10s (job ub1-52)')
})

test('gc removes ci-broker-pub-* volumes of repos with no job in retentionDays', async () => {
  const sys: string[][] = []
  const h = harness({
    deps: {
      sys: async (cmd, args) => {
        sys.push([cmd, ...args])
        if (args[0] === 'volume' && args[1] === 'ls') return { code: 0, stdout: 'ci-broker-pub-me__app-pnpm\nci-broker-pub-me__app-ms-playwright\nci-broker-pub-old__gone-pnpm\nother\n', stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      },
    },
  })
  const o = makeOrigin(h.origins, 'me/app')
  await h.submit({ sha: o.sha, mode: 'one' })
  await h.d.c.jobs.prune()
  const rm = sys.filter((c) => c[1] === 'volume' && c[2] === 'rm')
  assert.deepEqual(rm.map((c) => c.slice(3)), [['ci-broker-pub-old__gone-pnpm']])
})

test('docker-backed: a container with the hardened args can write its checkout but not the mirror', { skip: dockerSkip() }, async () => {
  const root = tmp()
  const o = makeOrigin(join(root, 'origins'), 'me/app')
  const m = new Mirror(join(root, 'work'), (r) => join(root, 'origins', `${r}.git`), realGit(60))
  await m.ensure('me/app')
  const dir = join(root, 'work', 'me__app', '1-x')
  await m.cloneForRun('me/app', o.sha, dir)
  const net = `cib-test-${process.pid}`
  spawnSync('docker', ['network', 'create', net], { stdio: 'ignore' })
  try {
    const cfg = { ...defaults(), trust: { ...defaults().trust, publicNetwork: net }, local: { cpus: 1, memory: '256m' } }
    const objects = join(m.path('me/app'), 'objects')
    const cmd = `touch ${dir}/written && ! touch ${objects}/x 2>/dev/null && ! sh -c 'echo x >> ${m.path('me/app')}/config' 2>/dev/null && ! ls ${root}/origins 2>/dev/null && echo SAFE`
    const args = dockerArgs({ name: `cib-t-${process.pid}`, dir, mirrorObjects: objects, image: 'alpine:latest', cmd, cfg, uid: process.getuid!(), gid: process.getgid!(), lane: 'public', repo: 'me/app' }).map((a) => (a === 'bash' ? 'sh' : a))
    const vols = args.filter((a, i) => args[i - 1] === '-v' && a.startsWith('ci-broker-pub-')).map((a) => a.split(':')[0])
    const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 60_000 })
    for (const v of vols) spawnSync('docker', ['volume', 'rm', v], { stdio: 'ignore' })
    assert.match(r.stdout, /SAFE/, r.stdout + r.stderr)
    assert.ok(exists(join(dir, 'written')))
    assert.ok(!exists(join(objects, 'x')))
  } finally {
    spawnSync('docker', ['network', 'rm', net], { stdio: 'ignore' })
  }
})
