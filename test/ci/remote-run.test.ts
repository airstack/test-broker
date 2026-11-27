// The example profile's remote script, run locally under the real wrapper in a temp HOME with a stub npm: the checkout
// path (per-repo clone + per-slot worktree), snapshots via bundle + CIB_BASE, slot scratch, disk eviction, exit codes.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { randomBytes } from 'node:crypto'
import { buildSnapshot, bundleStream } from '../../src/core/snapshot.ts'
import { Mirror, realGit } from '../../src/core/mirror.ts'
import { WRAP_SCRIPT } from '../../src/ci/daemon/daemon.ts'
import { loadProfile, PROFILES_ROOT } from '../../src/ci/profile.ts'
import { makeOrigin, pushCommit, tmp } from '../harness.ts'

const SCRIPT = join(PROFILES_ROOT, 'example', 'remote-run.sh')
const shm: string[] = []
after(() => shm.forEach((d) => rmSync(d, { recursive: true, force: true })))

function env() {
  const home = tmp('cib-home-')
  const bin = join(home, 'stub-bin')
  mkdirSync(bin)
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  // npm: logs every call; `npm ci` / `npm install` exit STUB_INSTALL_RC, `npm test` / `npm run …` exit STUB_TEST_RC
  stub('npm', [
    'echo "$PWD :: npm $*" >> "$HOME/npm.log"',
    'case "$1" in',
    '  ci|install) exit "${STUB_INSTALL_RC:-0}" ;;',
    '  test|run) exit "${STUB_TEST_RC:-0}" ;;',
    'esac',
  ].join('\n'))
  const root = tmp('cib-orig-')
  const repo = `t${randomBytes(3).toString('hex')}/app`
  const o = makeOrigin(root, repo, { 'f.txt': 'v1\n', '.gitignore': 'node_modules/\n', 'package.json': '{ "name": "app" }\n' })
  return { home, bin, repo, name: repo.replace('/', '__'), url: join(root, `${repo}.git`), ...o }
}

function run(e: ReturnType<typeof env>, slot: number, sha: string, args: string[], extra: Record<string, string> = {}) {
  const d = join(e.home, 'cib', String(slot))
  mkdirSync(d, { recursive: true })
  copyFileSync(WRAP_SCRIPT, join(d, 'cib-wrap.sh'))
  copyFileSync(SCRIPT, join(d, 'remote.sh'))
  shm.push(`/dev/shm/cib-${e.name}-${slot}`)
  return spawnSync('bash', [join(d, 'cib-wrap.sh'), sha, ...args], {
    encoding: 'utf8',
    cwd: e.home,
    env: { ...process.env, HOME: e.home, PATH: `${e.bin}:${process.env.PATH}`, CIB_REPO: e.repo, CIB_SHA: sha, CIB_SLOT: String(slot), CIB_BASE: '', CIB_BUNDLE: '', CIB_CLONE_URL: e.url, CIB_MIN_FREE_GB: '0', GITHUB_TOKEN: '', ...extra },
  })
}

test('the remote script passes bash -n', () => {
  assert.equal(spawnSync('bash', ['-n', SCRIPT]).status, 0)
})

test('pushed sha: one clone per repo, one worktree per slot, slot-scoped TMPDIR and TEST_PORT_BASE', () => {
  const e = env()
  const r0 = run(e, 0, e.sha, ['cmd', 'cat f.txt; pwd; echo "tmp=$TMPDIR port=$TEST_PORT_BASE"'])
  assert.equal(r0.status, 0, r0.stdout + r0.stderr)
  assert.match(r0.stdout, /^v1$/m)
  assert.match(r0.stdout, new RegExp(`${e.home}/cib/0/${e.name}$`, 'm'))
  assert.match(r0.stdout, new RegExp(`tmp=/dev/shm/cib-${e.name}-0 port=8700`))
  assert.match(r0.stdout, /HEAD: [0-9a-f]+ one/)
  const sha2 = pushCommit(e.work, 'f.txt', 'v2\n')
  const r1 = run(e, 1, sha2, ['cmd', 'cat f.txt; echo "port=$TEST_PORT_BASE"'])
  assert.equal(r1.status, 0, r1.stdout)
  assert.match(r1.stdout, /^v2$/m)
  assert.match(r1.stdout, /port=8720/)
  assert.ok(existsSync(join(e.home, 'cib', 'repos', e.name, '.git')))
  assert.ok(existsSync(join(e.home, 'cib', '1', e.name, 'f.txt')))
  // slot 0 again: its worktree is reused, still at its own sha
  const r2 = run(e, 0, e.sha, ['cmd', 'cat f.txt'])
  assert.equal(r2.status, 0)
  assert.match(r2.stdout, /^v1$/m)
  assert.ok(existsSync(join(e.home, 'cib', '0', 'runs')))
  // the install ran in each slot's own worktree
  const installs = readFileSync(join(e.home, 'npm.log'), 'utf8').split('\n').filter((l) => / :: npm (ci|install)/.test(l))
  assert.ok(installs.length >= 3)
  assert.ok(installs.every((l) => l.startsWith(join(e.home, 'cib', '0', e.name) + ' ') || l.startsWith(join(e.home, 'cib', '1', e.name) + ' ')))
})

test('a snapshot: CIB_BASE is fetched from origin, the bundle goes to a per-slot ref, the snapshot sha is checked out', async () => {
  const e = env()
  const base = pushCommit(e.work, 'f.txt', 'v2\n')
  writeFileSync(join(e.work, 'f.txt'), 'dirty\n')
  const s = await buildSnapshot(e.work, { maxFileMb: 50 })
  const m = new Mirror(join(tmp(), 'work'), () => e.url, realGit(60))
  await m.ensure(e.repo)
  const client = join(tmp(), 'c.bundle')
  const b = await bundleStream(e.work, s.commit, base)
  await Promise.all([pipeline(b.stream, createWriteStream(client)), b.done])
  await m.fetchBundle(e.repo, client, 1)
  const remote = join(e.home, 'cib', '0', 'snapshot.bundle')
  mkdirSync(join(e.home, 'cib', '0'), { recursive: true })
  await m.remoteBundle(e.repo, 1, base, remote)
  const r = run(e, 0, s.commit, ['cmd', 'cat f.txt'], { CIB_BASE: base, CIB_BUNDLE: remote })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /^dirty$/m)
  assert.match(r.stdout, /ci-broker snapshot/)
})

test('an unfetchable sha exits 91 (infra)', () => {
  const e = env()
  const r = run(e, 0, 'f'.repeat(40), ['cmd', 'true'])
  assert.equal(r.status, 91, r.stdout)
  assert.match(r.stdout, /cannot fetch/)
})

test('below CIB_MIN_FREE_GB: other idle repos are evicted (oldest first), then exit 96', () => {
  const e = env()
  for (const other of ['old__x', 'new__y']) {
    mkdirSync(join(e.home, 'cib', 'repos', other, '.git'), { recursive: true })
    mkdirSync(join(e.home, 'cib', '0', other), { recursive: true })
  }
  writeFileSync(join(e.home, 'cib', 'repos', 'old__x.used'), '')
  const r = run(e, 0, e.sha, ['cmd', 'true'], { CIB_MIN_FREE_GB: '999999999' })
  assert.equal(r.status, 96, r.stdout)
  assert.ok(r.stdout.indexOf('evict new__y') < r.stdout.indexOf('evict old__x'), 'no stamp = oldest')
  assert.equal(existsSync(join(e.home, 'cib', 'repos', 'old__x')), false)
  assert.equal(existsSync(join(e.home, 'cib', '0', 'new__y')), false)
  assert.match(r.stdout, /not enough disk/)
})

const npmLog = (e: ReturnType<typeof env>) => readFileSync(join(e.home, 'npm.log'), 'utf8')

test("the script's ARTIFACTS list is the profile's artifacts", () => {
  const m = /^ARTIFACTS=\(([^)]*)\)$/m.exec(readFileSync(SCRIPT, 'utf8'))
  assert.ok(m, 'ARTIFACTS=(…) in the script')
  assert.deepEqual(m[1].trim().split(/\s+/), loadProfile('example').artifacts)
})

test('a reused slot: the artifacts of an earlier run (every profile artifact path, the tarball) are gone before the next run, even one that fails at checkout', () => {
  const e = env()
  const first = run(e, 0, e.sha, ['cmd', 'true'])
  assert.equal(first.status, 0, first.stdout)
  const wt = join(e.home, 'cib', '0', e.name)
  const paths = loadProfile('example').artifacts!
  assert.ok(paths.length >= 2)
  const stale = paths.map((p) => join(wt, p, 'stale.txt'))
  for (const f of stale) {
    mkdirSync(join(f, '..'), { recursive: true })
    writeFileSync(f, 'from an earlier job\n')
  }
  writeFileSync(join(e.home, 'cib', '0', 'artifacts.tgz'), 'old')
  const r = run(e, 0, 'f'.repeat(40), ['cmd', 'true'])
  assert.equal(r.status, 91, r.stdout)
  for (const f of stale) assert.equal(existsSync(f), false, `${f} survived`)
  assert.equal(existsSync(join(e.home, 'cib', '0', 'artifacts.tgz')), false)
})

test('modes: test runs npm test, int-shard passes --shard, e2e passes its args; the test exit code is the result', () => {
  const e = env()
  assert.equal(run(e, 0, e.sha, ['test']).status, 0)
  assert.equal(run(e, 0, e.sha, ['int-shard', '2/2']).status, 0)
  const r = run(e, 0, e.sha, ['e2e', 'tests/a.spec.ts'], { STUB_TEST_RC: '1' })
  assert.equal(r.status, 1, r.stdout)
  const log = npmLog(e)
  assert.match(log, / :: npm test$/m)
  assert.match(log, / :: npm run test:int -- --shard=2\/2$/m)
  assert.match(log, / :: npm run test:e2e -- tests\/a\.spec\.ts$/m)
})

test('a failing install is not hidden: it exits 93 (infra) before any test runs', () => {
  const e = env()
  const r = run(e, 0, e.sha, ['cmd', 'echo ran'], { STUB_INSTALL_RC: '1' })
  assert.equal(r.status, 93, r.stdout)
  assert.match(r.stdout, /npm install failed/)
  assert.doesNotMatch(r.stdout, /^ran$/m)
  assert.deepEqual(loadProfile('example').infraExitCodes!.filter((c) => [89, 90, 91, 92, 93].includes(c)), [89, 90, 91, 92, 93])
})
