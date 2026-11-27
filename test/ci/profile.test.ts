import '../tmp-root.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { jobKey, loadProfile, localCommand, profileHash, shardsFor } from '../../src/ci/profile.ts'

const p = loadProfile('example')

test('the example profile: test is 3 shards, all adds the e2e shard', () => {
  assert.deepEqual(shardsFor(p, 'test', []).map((s) => s.name), ['unit', 'int-1', 'int-2'])
  const all = shardsFor(p, 'all', [])
  assert.equal(all.length, 4)
  assert.deepEqual(all.slice(3).map((s) => [s.name, s.size]), [['e2e', 'large']])
})

test('passArgs appends the user args; other modes ignore them', () => {
  assert.deepEqual(shardsFor(p, 'int', ['test/int/a.test.ts', 'test/int/b.test.ts'])[0].args, ['int', 'test/int/a.test.ts', 'test/int/b.test.ts'])
  assert.deepEqual(shardsFor(p, 'test', ['x'])[0].args, ['unit'])
})

test('an unknown mode throws with the known modes', () => {
  assert.throws(() => shardsFor(p, 'nope', []), /unknown mode 'nope'.*test/)
})

test('local commands: quoted {args}, raw {cmd}, none for all', () => {
  assert.equal(localCommand(p, 'int', ['test/int/a.test.ts', "it's"]), `npm run test:int -- 'test/int/a.test.ts' 'it'\\''s'`)
  assert.equal(localCommand(p, 'cmd', ['npm run lint']), 'npm run lint')
  assert.equal(localCommand(p, 'e2e', ['tests/x.spec.ts']), `npm run test:e2e -- 'tests/x.spec.ts'`)
  assert.equal(localCommand(p, 'e2e', []), 'npm run test:e2e -- ')
  assert.equal(localCommand(p, 'all', []), null)
})

test('job key: repo, profile, profile hash, mode, tree, args hash or "-", lane, env class', () => {
  const tree = '105635ecdbdbed5879ef8f5df8b3629c88d09a27'
  const k = (args: string[], repo = 'me/x', lane: 'full' | 'public' = 'full', env: 'env' | 'noenv' = 'env') => jobKey({ repo, profile: 'example', profileHash: 'h1', mode: 'e2e', tree, args, lane, env })
  assert.equal(k([]), `me/x example h1 e2e ${tree} - full env`)
  assert.notEqual(k([], 'me/x', 'public', 'noenv'), k([], 'me/x', 'full', 'noenv'), 'a public-lane pass never serves a full-lane request')
  assert.notEqual(k([], 'me/x', 'full', 'noenv'), k([], 'me/x', 'full', 'env'), 'noenv never joins an env run')
  assert.notEqual(k([], 'me/x'), k([], 'me/y'))
  assert.match(k(['tests/a.spec.ts']), new RegExp(`^me/x example h1 e2e ${tree} [0-9a-f]{8} full env$`))
  assert.notEqual(k(['tests/a.spec.ts']), k(['tests/b.spec.ts']))
  assert.notEqual(k(['a b']), k(['a', 'b']))
})

test('profile hash covers every file in the profile dir', () => {
  const d = mkdtempSync(join(tmpdir(), 'cib-prof-'))
  cpSync(p.dir, join(d, 'example'), { recursive: true })
  const q = loadProfile('example', d)
  const h1 = profileHash(q)
  assert.equal(profileHash(q), h1)
  writeFileSync(join(q.dir, 'remote-run.sh'), '# changed\n', { flag: 'a' })
  assert.notEqual(profileHash(q), h1)
})

test('a mode whose shards need args (int, cmd) refuses an empty args list with its usage; e2e runs its default set without', () => {
  assert.throws(() => shardsFor(p, 'int', []), /mode int needs args: .*test file/)
  assert.throws(() => shardsFor(p, 'cmd', []), /mode cmd needs args: .*command/)
  assert.equal(shardsFor(p, 'e2e', []).length, 1)
})

// ---- trust layer: profiles as operator files, key rules

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, utimesSync } from 'node:fs'
import { ProfileError, validateProfile } from '../../src/ci/profile.ts'

const base = () => JSON.parse(readFileSync(join(p.dir, 'profile.json'), 'utf8'))
function opDir(json: any, extra: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cib-op-'))
  mkdirSync(join(root, json.name), { recursive: true })
  writeFileSync(join(root, json.name, 'profile.json'), JSON.stringify(json))
  writeFileSync(join(root, json.name, json.remoteScript ?? 'remote-run.sh'), 'echo hi\n')
  for (const [f, c] of Object.entries(extra)) writeFileSync(join(root, json.name, f), c)
  return root
}
const me = process.getuid!()

test('operator profiles (split): read with O_NOFOLLOW into a daemon-owned snapshot; the hash covers every file', () => {
  const root = opDir({ ...base(), local: { ...base().local, env: { GITHUB_TOKEN: 'fetchToken' } } })
  const snap = mkdtempSync(join(tmpdir(), 'cib-snap-'))
  const q = loadProfile('example', root, { layout: 'split', ownerUid: me, snapshotDir: snap })
  assert.ok(q.dir.startsWith(snap), q.dir)
  assert.ok(existsSync(join(q.dir, 'remote-run.sh')))
  const h1 = profileHash(q)
  writeFileSync(join(root, 'example', 'remote-run.sh'), 'echo changed\n')
  const r = loadProfile('example', root, { layout: 'split', ownerUid: me, snapshotDir: snap })
  assert.notEqual(profileHash(r), h1, 'a profile change applies at the next submit')
  assert.equal(readdirSync(snap).length, 2)
})

test('operator profiles: a symlinked file (to a key) is refused without echoing the content; another owner is refused', () => {
  const root = opDir({ ...base(), local: { ...base().local, env: {} } })
  const key = join(mkdtempSync(join(tmpdir(), 'cib-k-')), 'github-token')
  writeFileSync(key, 'ghp_SECRETSECRETSECRETSECRET1234')
  symlinkSync(key, join(root, 'example', 'Dockerfile'))
  const snap = mkdtempSync(join(tmpdir(), 'cib-snap-'))
  assert.throws(() => loadProfile('example', root, { layout: 'split', ownerUid: me, snapshotDir: snap }), (e: Error) => e instanceof ProfileError && /Dockerfile: is a symlink/.test(e.message) && !e.message.includes('SECRET'))
  const root2 = opDir({ ...base(), local: { ...base().local, env: {} } })
  symlinkSync(key, join(root2, 'example', 'x.json'))
  rmSync(join(root2, 'example', 'profile.json'))
  symlinkSync(key, join(root2, 'example', 'profile.json'))
  assert.throws(() => loadProfile('example', root2, { layout: 'split', ownerUid: me, snapshotDir: snap }), (e: Error) => !e.message.includes('SECRET'))
  const root3 = opDir({ ...base(), local: { ...base().local, env: {} } })
  assert.throws(() => loadProfile('example', root3, { layout: 'split', ownerUid: me + 1, snapshotDir: snap }), /not owned by the operator/)
  const root4 = opDir({ ...base(), local: { ...base().local, env: {} } })
  writeFileSync(join(root4, 'example', 'profile.json'), '{ "local": ghp_SECRETSECRETSECRETSECRET1234 ')
  assert.throws(() => loadProfile('example', root4, { layout: 'split', ownerUid: me, snapshotDir: snap }), (e: Error) => /not valid JSON/.test(e.message) && !e.message.includes('SECRET'))
})

test('profile keys: local.env values must be secret names (no commands); unknown keys and single-only keys are refused, naming the key', () => {
  const ok = { ...base(), local: { ...base().local, env: { GITHUB_TOKEN: 'fetchToken' } }, github: { prMode: 'all' } }
  assert.doesNotThrow(() => validateProfile(ok, 'split'))
  const bad = (mut: (x: any) => void, layout: 'single' | 'split', re: RegExp) => {
    const x = structuredClone(ok)
    mut(x)
    assert.throws(() => validateProfile(x, layout), (e: Error) => e instanceof ProfileError && re.test(e.message))
  }
  bad((x) => (x.local.env = { GITHUB_TOKEN: 'gh auth token' }), 'single', /local\.env\.GITHUB_TOKEN: .*secret's name/)
  bad((x) => (x.local.nonoProfile = 'p'), 'split', /local\.nonoProfile.*single/)
  bad((x) => (x.local.envForGithubDoor = true), 'single', /local\.envForGithubDoor.*trust\.repos/)
  bad((x) => (x.wat = 1), 'single', /unknown key wat/)
  bad((x) => (x.local.wat = 1), 'single', /unknown key local\.wat/)
  bad((x) => (x.github = { prMode: 'nope' }), 'single', /github\.prMode/)
  bad((x) => (x.github = { other: 1 }), 'single', /github\.other/)
  bad((x) => (x.local.dockerRelax = ['net']), 'single', /dockerRelax/)
  bad((x) => (x.artifacts = ['../../etc']), 'single', /artifacts/)
  bad((x) => (x.remoteScript = '../x.sh'), 'single', /remoteScript/)
  bad((x) => (x.repo = 'a/../b'), 'single', /repo/)
  const single = structuredClone(ok)
  single.local.nonoProfile = 'p'
  assert.doesNotThrow(() => validateProfile(single, 'single'))
})

test('profile names follow the name rule (never a path)', () => {
  for (const n of ['../x', '.', '..', 'a/b', '']) assert.throws(() => loadProfile(n, '/nonexistent'), (e: Error) => e instanceof ProfileError && /profile name/.test(e.message))
})

test('{cmd}: one arg is inserted as is (a shell command on purpose); two or more are each quoted', () => {
  assert.equal(localCommand(p, 'cmd', ['npm --version && node --version']), 'npm --version && node --version')
  assert.equal(localCommand(p, 'cmd', ['ls', '-la', 'a b']), "'ls' '-la' 'a b'")
  assert.equal(localCommand(p, 'cmd', ['a', "b; c"]), "'a' 'b; c'")
})

test('review: operator-written fields the daemon uses as paths or docker args are checked (shard names, image, tmpfs, sizes, env)', () => {
  const ok = { ...base(), local: { ...base().local, env: {} } }
  assert.doesNotThrow(() => validateProfile(ok, 'split'))
  const bad = (mut: (x: any) => void, re: RegExp) => {
    const x = structuredClone(ok)
    mut(x)
    assert.throws(() => validateProfile(x, 'split'), (e: Error) => e instanceof ProfileError && re.test(e.message))
  }
  bad((x) => (x.modes.test[0].name = '../../github-token'), /modes\.test\[0\]\.name/)
  bad((x) => (x.modes.test[0].name = 'local'), /reserved/)
  bad((x) => (x.modes.test[0].size = '--privileged'), /size/)
  bad((x) => (x.modes.test[0].args = ['ok', 3]), /args/)
  bad((x) => (x.modes.all = 'test + nope'), /unknown mode nope/)
  bad((x) => (x.local.image = '--privileged'), /local\.image/)
  bad((x) => (x.local.image = 'img with space'), /local\.image/)
  bad((x) => (x.local.tmpfs = ['.cache:rw,suid']), /local\.tmpfs/)
  bad((x) => (x.boatEnvironment = '-x'), /boatEnvironment/)
  bad((x) => (x.check = ['cmd', 7]), /check/)
  bad((x) => (x.infraExitCodes = [1, 'x']), /infraExitCodes/)
})
