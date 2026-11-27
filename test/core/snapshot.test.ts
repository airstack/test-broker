import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { buildSnapshot, bundleStream, repoFromUrl } from '../../src/core/snapshot.ts'
import { Mirror, realGit } from '../../src/core/mirror.ts'
import { makeOrigin, pushCommit, sh, tmp } from '../harness.ts'

const snap = (dir: string, maxFileMb = 50) => buildSnapshot(dir, { maxFileMb })

function setup() {
  const root = tmp()
  const o = makeOrigin(join(root, 'origins'), 'me/app', { 'f.txt': 'v1\n', '.gitignore': 'secret.env\n' })
  return { root, ...o }
}

test('repoFromUrl reads owner/name from https, ssh, scp-like and path URLs', () => {
  for (const u of ['https://github.com/me/app.git', 'git@github.com:me/app.git', 'ssh://git@github.com/me/app', '/tmp/x/origins/me/app.git'])
    assert.equal(repoFromUrl(u), 'me/app', u)
})

test('a clean tree is HEAD itself', async () => {
  const { work, sha } = setup()
  const s = await snap(work)
  assert.deepEqual([s.commit, s.dirty, s.head], [sha, false, sha])
  assert.equal(s.headCandidates[0], sha)
})

test('dirty + untracked go in, ignored stays out; the index, branches and HEAD are untouched', async () => {
  const { work, sha } = setup()
  writeFileSync(join(work, 'f.txt'), 'v2\n')
  writeFileSync(join(work, 'new.txt'), 'n\n')
  writeFileSync(join(work, 'secret.env'), 'TOKEN=x\n')
  const statusBefore = sh(work, 'status', '--porcelain')
  const s = await snap(work)
  assert.equal(s.dirty, true)
  assert.notEqual(s.commit, sha)
  assert.equal(sh(work, 'rev-parse', `${s.commit}^`), sha)
  assert.equal(sh(work, 'show', `${s.commit}:f.txt`), 'v2')
  assert.equal(sh(work, 'show', `${s.commit}:new.txt`), 'n')
  assert.throws(() => sh(work, 'cat-file', '-e', `${s.commit}:secret.env`))
  assert.equal(sh(work, 'status', '--porcelain'), statusBefore)
  assert.equal(sh(work, 'rev-parse', 'HEAD'), sha)
  assert.equal(sh(work, 'for-each-ref', 'refs/ci-broker'), '')
})

test('works in a linked worktree and with no git identity at all', async () => {
  const { work } = setup()
  const wt = join(tmp(), 'wt')
  sh(work, 'worktree', 'add', '-q', '-b', 'side', wt)
  writeFileSync(join(wt, 'side.txt'), 's\n')
  const env: Record<string, string> = { HOME: tmp(), EMAIL: '', GIT_AUTHOR_NAME: '', GIT_COMMITTER_NAME: '', GIT_AUTHOR_EMAIL: '', GIT_COMMITTER_EMAIL: '' }
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]))
  Object.assign(process.env, env)
  try {
    const s = await snap(wt)
    assert.equal(s.dirty, true)
    assert.equal(sh(wt, 'show', `${s.commit}:side.txt`), 's')
    assert.match(sh(wt, 'log', '-1', '--format=%an <%ae>', s.commit), /^ci-broker </)
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

test('a new file over snapshotMaxFileMb is refused with its name', async () => {
  const { work } = setup()
  writeFileSync(join(work, 'big.bin'), Buffer.alloc(2 * 1024 * 1024))
  await assert.rejects(snap(work, 1), /big\.bin/)
})

test('head candidates: first-parent ancestors, then the merge-base with origin/<default>', async () => {
  const { work, sha } = setup()
  sh(work, 'remote', 'set-head', 'origin', 'main')
  sh(work, 'checkout', '-q', '-b', 'feature')
  writeFileSync(join(work, 'g.txt'), 'g\n')
  sh(work, 'add', '-A')
  sh(work, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'local only')
  const s = await snap(work)
  assert.equal(s.headCandidates.length, 2)
  assert.equal(s.headCandidates[1], sha)
})

test('bundle round trip: unpushed base → daemon picks the pushed ancestor; stale remote-tracking ref skipped; remote bundle checks out with CIB_BASE', async () => {
  const { root, work, sha: first } = setup()
  const second = pushCommit(work, 'f.txt', 'v2\n')
  // a local commit that is never pushed, then a dirty edit on top
  writeFileSync(join(work, 'h.txt'), 'h\n')
  sh(work, 'add', '-A')
  sh(work, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'unpushed')
  writeFileSync(join(work, 'f.txt'), 'v3\n')
  // origin/main points at a commit origin no longer has (stale remote-tracking ref after a force-push elsewhere)
  const ghost = sh(work, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit-tree', `${first}^{tree}`, '-p', first, '-m', 'ghost')
  sh(work, 'update-ref', 'refs/remotes/origin/main', ghost)
  const s = await snap(work)
  const m = new Mirror(join(root, 'state', 'work'), (r) => join(root, 'origins', `${r}.git`), realGit(60))
  await m.ensure('me/app')
  assert.equal(await m.hasOrFetch('me/app', s.commit), false)
  assert.ok(!s.headCandidates.includes(ghost) || s.headCandidates.indexOf(ghost) > 1)
  const base = await m.firstPresent('me/app', [...s.headCandidates, ghost])
  assert.equal(base, second)
  // client side: bundle against the base
  const file = join(tmp(), 'snap.bundle')
  const b = await bundleStream(work, s.commit, base)
  await Promise.all([pipeline(b.stream, createWriteStream(file)), b.done])
  assert.equal(sh(work, 'for-each-ref', 'refs/ci-broker'), '', 'temp ref deleted')
  assert.equal(await m.fetchBundle('me/app', file, 7), s.commit)
  // daemon side: the remote bundle (fixed ref name) applies to a partial clone that fetched the base by sha
  const rb = join(tmp(), 'remote.bundle')
  await m.remoteBundle('me/app', 7, base, rb)
  const box = tmp()
  execFileSync('git', ['clone', '-q', '--no-checkout', join(root, 'origins', 'me/app.git'), box])
  sh(box, 'fetch', '-q', 'origin', base!)
  sh(box, 'fetch', '-q', rb, '+refs/cib/snap:refs/cib/slot-0')
  sh(box, 'checkout', '-q', '--detach', s.commit)
  assert.equal(sh(box, 'show', 'HEAD:f.txt'), 'v3')
  assert.equal(sh(box, 'show', 'HEAD:h.txt'), 'h')
})

test('mirror: heads-only fetch with prune keeps refs/cib/*; a sha off any branch is fetched by sha', async () => {
  const { root, work, sha } = setup()
  const m = new Mirror(join(root, 'state', 'work'), (r) => join(root, 'origins', `${r}.git`), realGit(60))
  await m.ensure('me/app')
  // a commit only reachable from a non-branch ref on origin (like refs/pull/1/merge)
  const side = sh(work, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit-tree', `${sha}^{tree}`, '-p', sha, '-m', 'pr merge')
  sh(work, 'push', '-q', 'origin', `${side}:refs/pull/1/merge`)
  assert.equal(await m.has('me/app', side), false)
  assert.equal(await m.hasOrFetch('me/app', side), true)
  await m.ensure('me/app')
  assert.equal(await m.has('me/app', side), true, 'prune must not drop refs/cib/sha/*')
  assert.equal(await m.pruneRefs('me/app', () => ({ jobs: new Set(), shas: new Set() })), 1)
  assert.ok(existsSync(m.path('me/app')))
  mkdirSync(join(root, 'x'), { recursive: true })
})

test('mirror: a commit held only by a snapshot ref is not "on origin": hasOrFetch is false and it is never a bundle base', async () => {
  const { root, work, sha } = setup()
  const m = new Mirror(join(root, 'state', 'work'), (r) => join(root, 'origins', `${r}.git`), realGit(60))
  await m.ensure('me/app')
  // two unpushed commits on top of the pushed one; the client bundles the second as job 3's snapshot
  writeFileSync(join(work, 'u1.txt'), '1\n')
  sh(work, 'add', '-A')
  sh(work, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'unpushed 1')
  const u1 = sh(work, 'rev-parse', 'HEAD')
  writeFileSync(join(work, 'u2.txt'), '2\n')
  sh(work, 'add', '-A')
  sh(work, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'unpushed 2')
  const u2 = sh(work, 'rev-parse', 'HEAD')
  const file = join(tmp(), 'snap.bundle')
  const b = await bundleStream(work, u2, sha)
  await Promise.all([pipeline(b.stream, createWriteStream(file)), b.done])
  assert.equal(await m.fetchBundle('me/app', file, 3), u2)
  assert.equal(await m.has('me/app', u2), true, 'the objects are in the mirror')
  assert.equal(await m.hasOrFetch('me/app', u2), false, 'but origin does not have the commit')
  assert.equal(await m.hasOrFetch('me/app', u1), false)
  assert.equal(sh(m.path('me/app'), 'for-each-ref', 'refs/cib/sha'), '', 'no refs/cib/sha ref for an unpushed commit')
  assert.equal(await m.firstPresent('me/app', [u1, sha]), sha, 'an earlier snapshot commit is not a base a box can fetch from origin')
  // pushed later to a ref that is not a branch: origin has it now, so it is "on origin"
  sh(work, 'push', '-q', 'origin', `${u1}:refs/pull/9/head`)
  assert.equal(await m.hasOrFetch('me/app', u1), true)
  assert.equal(await m.firstPresent('me/app', [u1, sha]), u1)
})
