// The artifacts tar command the Boat and ssh executors run on a reused slot: it must never hand back an earlier job's
// tarball.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { remoteCommand, artifactsCommand } from '../../src/core/boat-commands.ts'
import { tmp } from '../harness.ts'

function slot() {
  const home = tmp('cib-art-')
  const wt = join(home, 'cib', '0', 'me__app')
  mkdirSync(wt, { recursive: true })
  const tgz = join(home, 'cib', '0', 'artifacts.tgz')
  writeFileSync(tgz, 'an earlier job\n')
  const run = () => spawnSync('bash', ['-c', artifactsCommand(0, 'me/app', ['out', 'logs'])], { encoding: 'utf8', env: { ...process.env, HOME: home } })
  return { home, wt, tgz, run }
}

test('no artifact path exists: exit 3, and an earlier job\'s tarball is removed, not left for download', () => {
  const s = slot()
  const r = s.run()
  assert.equal(r.status, 3, r.stdout + r.stderr)
  assert.equal(existsSync(s.tgz), false)
})

test('no worktree: exit 3, and the earlier tarball is gone too', () => {
  const s = slot()
  spawnSync('rm', ['-rf', s.wt])
  assert.equal(s.run().status, 3)
  assert.equal(existsSync(s.tgz), false)
})

test('artifacts exist: a fresh tarball of only those paths, its size printed', () => {
  const s = slot()
  mkdirSync(join(s.wt, 'out'))
  writeFileSync(join(s.wt, 'out', 'a.txt'), 'new\n')
  const r = s.run()
  assert.equal(r.status, 0, r.stderr)
  const list = spawnSync('tar', ['tzf', s.tgz], { encoding: 'utf8' }).stdout
  assert.match(list, /^out\/a\.txt$/m)
  assert.match(r.stdout.trim(), /^\d+$/)
})

test('remoteCommand: Boat runs turn fsync off (CIB_NOFSYNC=1, ); ssh runs do not', () => {
  const o = { slot: 0, repo: 'o/r', sha: 'abc', base: null, bundle: false, args: ['test'] }
  assert.match(remoteCommand(o), /\bCIB_NOFSYNC=0 bash/)
  const c = remoteCommand({ ...o, noFsync: true })
  assert.match(c, /\bCIB_NOFSYNC=1 bash "\$HOME\/cib\/0\/cib-wrap\.sh" 'abc' 'test'$/)
})
