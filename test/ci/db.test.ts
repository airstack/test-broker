import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Db, SCHEMA_VERSION } from '../../src/ci/db.ts'
import { tmp } from '../harness.ts'

test('a fresh DB gets the schema and user_version; rows round-trip camelCase', () => {
  const path = join(tmp(), 'brokerd.db')
  const db = new Db(path)
  const id = db.insertJob({ key: 'k', repo: 'me/x', profile: 'p', profileHash: 'h', mode: 'm', args: ['a b'], commit: 'c'.repeat(40), tree: 't', source: 'pushed', base: null, label: null, state: 'queued', pinned: true, createdAt: 5, lane: 'full', env: 'noenv', door: 'local', ghRun: null })
  db.insertShard({ jobId: id, idx: 0, name: 's', size: 'default', args: ['x'], state: 'queued', queuedAt: 5 })
  db.updateShard(id, 0, { avoid: ['box1'], firstInfra: { resource: 'boat', box: 'box1', code: 91, kind: 'exit', charged: false } })
  const j = db.job(id)!
  assert.deepEqual([j.args, j.pinned, j.state], [['a b'], true, 'queued'])
  assert.deepEqual(db.shard(id, 0)!.avoid, ['box1'])
  assert.equal(db.shard(id, 0)!.firstInfra!.code, 91)
  db.close()
  const raw = new DatabaseSync(path)
  assert.equal((raw.prepare('PRAGMA user_version').get() as any).user_version, SCHEMA_VERSION)
  raw.close()
})

test('a DB with another schema version is moved aside and a fresh one started', () => {
  const dir = tmp()
  const path = join(dir, 'brokerd.db')
  const raw = new DatabaseSync(path)
  raw.exec('CREATE TABLE old (x); PRAGMA user_version = 99')
  raw.close()
  const db = new Db(path, 1234)
  assert.equal(db.job(1), null)
  assert.ok(readdirSync(dir).some((f) => f === 'brokerd.db.v99-1234'))
  db.close()
})

test('a slot is taken once; health defaults to usable and resets', () => {
  const db = new Db(':memory:')
  assert.equal(db.takeSlot({ resource: 'local', slot: 0, jobId: 1, idx: 0, since: 1 }), true)
  assert.equal(db.takeSlot({ resource: 'local', slot: 0, jobId: 2, idx: 0, since: 1 }), false)
  db.freeSlot('local', 0)
  assert.equal(db.takeSlot({ resource: 'local', slot: 0, jobId: 2, idx: 0, since: 1 }), true)
  assert.equal(db.health('boat', 'p').failing, false)
  db.setHealth('boat', 'p', { failing: true, reason: 'x', infraFails: 2 })
  assert.equal(db.health('boat', 'p').failing, true)
  db.resetHealth('boat')
  assert.deepEqual([db.health('boat', 'p').failing, db.health('boat', 'p').infraFails], [false, 0])
  assert.equal(existsSync(':memory:'), false)
})

// ---- trust layer: v3 columns, trust.db, the id seed

import { TrustDb, TRUST_VERSION } from '../../src/ci/db.ts'

const jobIn = (o: Record<string, unknown> = {}) => ({ key: 'k', repo: 'me/x', profile: 'p', profileHash: 'h', mode: 'm', args: [], commit: 'c'.repeat(40), tree: 't', source: 'pushed' as const, base: null, label: null, state: 'queued' as const, pinned: false, createdAt: 5, lane: 'full' as const, env: 'noenv' as const, door: 'local' as const, ghRun: null, ...o })

test('v3+ jobs carry lane, env class, door and the GitHub run', () => {
  assert.equal(SCHEMA_VERSION, 4)
  const db = new Db(':memory:')
  const id = db.insertJob(jobIn({ lane: 'public', env: 'noenv', door: 'github', ghRun: '4411.1 pull_request eve' }))
  const j = db.job(id)!
  assert.deepEqual([j.lane, j.env, j.door, j.ghRun], ['public', 'noenv', 'github', '4411.1 pull_request eve'])
})

test('the id seed: accepted only while the DB has no job; ids continue above it', () => {
  const db = new Db(':memory:')
  assert.equal(db.seedNextId(42), true)
  assert.equal(db.insertJob(jobIn()), 42)
  assert.equal(db.seedNextId(100), false)
  assert.equal(db.insertJob(jobIn()), 43)
})

test('trust.db: blocks, tiers, run uses, events, watch errors and the HMAC key round-trip', () => {
  const t = new TrustDb(':memory:')
  t.setBlock('a/b', 10, 'tier private → public')
  assert.deepEqual(t.block('a/b'), { repo: 'a/b', since: 10, reason: 'tier private → public' })
  assert.equal(t.block('A/B')?.repo, 'a/b', 'repo keys are case-insensitive')
  t.unblock('a/b')
  assert.equal(t.block('a/b'), null)
  t.setTier('a/b', 'private', 7)
  assert.deepEqual(t.tier('a/b'), { repo: 'a/b', tier: 'private', checkedAt: 7 })
  assert.equal(t.addRunUse('a/b#1.1', 'ub1-4', 'new', 3), true)
  assert.equal(t.addRunUse('a/b#1.1', 'ub1-5', 'joined', 4), false, 'one submit per run attempt')
  assert.deepEqual(t.runUse('a/b#1.1'), { run: 'a/b#1.1', job: 'ub1-4', how: 'new', t: 3 })
  t.addEvent({ t: 1, door: 'github', repo: 'a/b', run: '1.1', actor: 'eve', ok: 0, checkId: 'pr', reason: 'no', job: null })
  t.addEvent({ t: 2, door: 'local', repo: 'c/d', run: null, actor: null, ok: 2, checkId: null, reason: 'offline', job: null })
  assert.deepEqual(t.events({ limit: 10 }).map((e) => e.t), [2, 1])
  assert.deepEqual(t.events({ limit: 10, repo: 'a/b' }).map((e) => e.checkId), ['pr'])
  t.setWatchError('a/b', 5, 'timeout')
  t.setWatchError('a/b', 9, 'again')
  assert.deepEqual(t.watchErrors(), [{ repo: 'a/b', since: 5, error: 'again' }])
  t.clearWatchError('a/b')
  assert.deepEqual(t.watchErrors(), [])
  const k = t.hmacKey()
  assert.equal(k.length, 32)
  assert.deepEqual(t.hmacKey(), k)
  t.prune(4)
  assert.deepEqual(t.events({ limit: 10 }).map((e) => e.t), [])
  assert.equal(t.runUse('a/b#1.1'), null)
})

test('trust.db is never moved aside: a main-DB reset keeps blocks, run uses and the key', () => {
  const dir = tmp()
  const t = new TrustDb(join(dir, 'trust.db'))
  t.setBlock('a/b', 1, 'r')
  t.addRunUse('a/b#1.1', 'x-1', 'new', 1)
  const key = t.hmacKey()
  t.close()
  const raw = new DatabaseSync(join(dir, 'brokerd.db'))
  raw.exec('CREATE TABLE old (x); PRAGMA user_version = 2')
  raw.close()
  const db = new Db(join(dir, 'brokerd.db'), 99)
  assert.equal(db.movedAside, 'v2-99')
  db.close()
  const again = new TrustDb(join(dir, 'trust.db'))
  assert.ok(again.block('a/b'))
  assert.ok(again.runUse('a/b#1.1'))
  assert.deepEqual(again.hmacKey(), key)
  assert.ok(!readdirSync(dir).some((f) => f.startsWith('trust.db.')))
})

test('trust.db: an older file is upgraded in place (additive); a newer one refuses', () => {
  const dir = tmp()
  const raw = new DatabaseSync(join(dir, 'trust.db'))
  raw.exec("CREATE TABLE blocks (repo TEXT PRIMARY KEY, since INTEGER NOT NULL, reason TEXT NOT NULL); INSERT INTO blocks VALUES ('a/b', 1, 'kept'); PRAGMA user_version = 0")
  raw.close()
  const t = new TrustDb(join(dir, 'trust.db'))
  assert.equal(t.block('a/b')?.reason, 'kept')
  t.setTier('a/b', 'public', 1)
  t.close()
  const r2 = new DatabaseSync(join(dir, 'trust.db'))
  assert.equal((r2.prepare('PRAGMA user_version').get() as any).user_version, TRUST_VERSION)
  r2.exec(`PRAGMA user_version = ${TRUST_VERSION + 1}`)
  r2.close()
  assert.throws(() => new TrustDb(join(dir, 'trust.db')), /trust\.db is from a newer ci-broker/)
})
