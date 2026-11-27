// ci-brokerd's state: one SQLite file. With core/boxes-db.ts and tb/runs-db.ts, the only modules that import
// node:sqlite (a Bun port swaps these files).
// Every query the daemon makes lives here, behind typed helpers; rows come back camelCase.
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { randomBytes } from 'node:crypto'
import { BoxTable, type BoxPatch, type BoxRow, type BoxStore } from '../core/boxes-db.ts'

export const SCHEMA_VERSION = 4

const SCHEMA = `
CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  repo TEXT NOT NULL,
  profile TEXT NOT NULL,
  profile_hash TEXT NOT NULL,
  mode TEXT NOT NULL,
  args TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  tree TEXT NOT NULL,
  source TEXT NOT NULL,
  base TEXT,
  label TEXT,
  state TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  placement TEXT,
  wait_why TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  summary TEXT,
  error TEXT,
  lane TEXT NOT NULL,
  env TEXT NOT NULL,
  door TEXT NOT NULL,
  gh_run TEXT,
  profile_dir TEXT NOT NULL DEFAULT ''
);
CREATE INDEX jobs_key ON jobs (key, state);
CREATE TABLE shards (
  job_id INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  name TEXT NOT NULL,
  size TEXT NOT NULL,
  args TEXT NOT NULL,
  state TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  resource TEXT,
  box TEXT,
  slot INTEGER,
  where_text TEXT,
  avoid TEXT NOT NULL DEFAULT '[]',
  first_infra TEXT,
  code INTEGER,
  reason TEXT,
  queued_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  PRIMARY KEY (job_id, idx)
);
CREATE TABLE job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  t INTEGER NOT NULL,
  job_id INTEGER,
  shard TEXT,
  kind TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE INDEX job_events_job ON job_events (job_id);
CREATE TABLE interests (
  token TEXT PRIMARY KEY,
  job_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  disconnected_since INTEGER,
  withdrawn INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE status_targets (
  job_id INTEGER NOT NULL,
  sha TEXT NOT NULL,
  context TEXT NOT NULL,
  state TEXT,
  posted_at INTEGER,
  error TEXT,
  PRIMARY KEY (job_id, sha, context)
);
CREATE TABLE boxes (
  name TEXT PRIMARY KEY,
  boat_id TEXT,
  env TEXT NOT NULL,
  size TEXT NOT NULL,
  state TEXT NOT NULL,
  since INTEGER NOT NULL,
  last_repo TEXT,
  last_used INTEGER NOT NULL,
  infra_fails INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  created_at INTEGER NOT NULL,
  pub_repo TEXT,
  env_version INTEGER
);
CREATE TABLE slots (
  resource TEXT NOT NULL,
  slot INTEGER NOT NULL,
  job_id INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  since INTEGER NOT NULL,
  PRIMARY KEY (resource, slot)
);
CREATE TABLE health (
  resource TEXT NOT NULL,
  profile TEXT NOT NULL,
  failing INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  infra_fails INTEGER NOT NULL DEFAULT 0,
  last_check_at INTEGER,
  last_check_ok INTEGER,
  last_check_log TEXT,
  PRIMARY KEY (resource, profile)
);
CREATE TABLE gh_runs (
  token TEXT PRIMARY KEY,
  resource TEXT NOT NULL,
  repo TEXT NOT NULL,
  workflow TEXT NOT NULL,
  job_id INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  run_id INTEGER,
  url TEXT,
  state TEXT NOT NULL,
  conclusion TEXT,
  dispatched_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`

export type JobState = 'waiting-bundle' | 'queued' | 'running' | 'passed' | 'failed' | 'cancelling' | 'cancelled' | 'error'
export type ShardState = 'queued' | 'running' | 'passed' | 'failed' | 'cancelled' | 'error'
export const ACTIVE_JOB_STATES: JobState[] = ['waiting-bundle', 'queued', 'running', 'cancelling']
export const isTerminal = (s: JobState) => !ACTIVE_JOB_STATES.includes(s)

export type JobSummary = { state: JobState; text: string; markdown: string; json: unknown; secs: number }

export type JobRow = {
  id: number
  key: string
  repo: string
  profile: string
  profileHash: string
  mode: string
  args: string[]
  commit: string
  tree: string
  source: 'pushed' | 'snapshot'
  base: string | null
  label: string | null
  state: JobState
  pinned: boolean
  placement: 'local' | 'sharded' | 'github' | null
  waitWhy: string | null
  createdAt: number
  startedAt: number | null
  endedAt: number | null
  summary: JobSummary | null
  error: string | null
  /** 'full' | 'public' */
  lane: Lane
  /** 'env': the run may get the profile's job secrets */
  env: EnvClass
  door: Door
  /** GitHub door: '<runId>.<attempt> <event> <actor login>' */
  ghRun: string | null
  /** the profile dir the job was admitted with (split: the daemon's snapshot); '' = load by name */
  profileDir: string
}

/** The first infra failure of a shard, kept for attribution when attempt 2 ends. */
export type FirstInfra = { resource: string; box: string | null; code: number | null; kind: 'exit' | 'unreachable' | 'nostatus'; charged: boolean }

export type ShardRow = {
  jobId: number
  idx: number
  name: string
  size: string
  args: string[]
  state: ShardState
  attempt: number
  resource: string | null
  box: string | null
  slot: number | null
  where: string | null
  avoid: string[]
  firstInfra: FirstInfra | null
  code: number | null
  reason: string | null
  queuedAt: number
  startedAt: number | null
  endedAt: number | null
}

export { TRANSITIONAL, type BoxRow, type BoxState } from '../core/boxes-db.ts'

export type HealthRow = {
  resource: string
  profile: string
  failing: boolean
  reason: string | null
  infraFails: number
  lastCheckAt: number | null
  lastCheckOk: boolean | null
  lastCheckLog: string | null
}

/** A workflow run dispatched to a github resource. `token` (`<daemonId>-<job>[.<attempt>]`) is in its run-name. */
export type GhRunState = 'dispatched' | 'running' | 'done' | 'cancelled'
export type GhRunRow = {
  token: string
  resource: string
  repo: string
  workflow: string
  jobId: number
  idx: number
  attempt: number
  runId: number | null
  url: string | null
  state: GhRunState
  conclusion: string | null
  dispatchedAt: number
  endedAt: number | null
}

export type InterestRow = { token: string; jobId: number; createdAt: number; disconnectedSince: number | null; withdrawn: boolean }
export type EventRow = { id: number; t: number; jobId: number | null; shard: string | null; kind: string; message: string }
export type SlotRow = { resource: string; slot: number; jobId: number; idx: number; since: number }
export type StatusTargetRow = { jobId: number; sha: string; context: string; state: string | null; postedAt: number | null; error: string | null }

export type Lane = 'full' | 'public'
export type EnvClass = 'env' | 'noenv'
export type Door = 'local' | 'github'

type R = Record<string, any>
const json = <T>(s: unknown, d: T): T => (typeof s === 'string' ? (JSON.parse(s) as T) : d)

const toJob = (r: R): JobRow => ({
  id: r.id, key: r.key, repo: r.repo, profile: r.profile, profileHash: r.profile_hash, mode: r.mode, args: json(r.args, []),
  commit: r.commit_sha, tree: r.tree, source: r.source, base: r.base, label: r.label, state: r.state, pinned: !!r.pinned,
  placement: r.placement, waitWhy: r.wait_why, createdAt: r.created_at, startedAt: r.started_at, endedAt: r.ended_at,
  summary: json(r.summary, null), error: r.error, lane: r.lane, env: r.env, door: r.door, ghRun: r.gh_run, profileDir: r.profile_dir ?? '',
})
const toShard = (r: R): ShardRow => ({
  jobId: r.job_id, idx: r.idx, name: r.name, size: r.size, args: json(r.args, []), state: r.state, attempt: r.attempt,
  resource: r.resource, box: r.box, slot: r.slot, where: r.where_text, avoid: json(r.avoid, []), firstInfra: json(r.first_infra, null),
  code: r.code, reason: r.reason, queuedAt: r.queued_at, startedAt: r.started_at, endedAt: r.ended_at,
})
const toHealth = (r: R): HealthRow => ({
  resource: r.resource, profile: r.profile, failing: !!r.failing, reason: r.reason, infraFails: r.infra_fails,
  lastCheckAt: r.last_check_at, lastCheckOk: r.last_check_ok === null ? null : !!r.last_check_ok, lastCheckLog: r.last_check_log,
})
const toGhRun = (r: R): GhRunRow => ({
  token: r.token, resource: r.resource, repo: r.repo, workflow: r.workflow, jobId: r.job_id, idx: r.idx, attempt: r.attempt, runId: r.run_id,
  url: r.url, state: r.state, conclusion: r.conclusion, dispatchedAt: r.dispatched_at, endedAt: r.ended_at,
})
const toInterest = (r: R): InterestRow => ({ token: r.token, jobId: r.job_id, createdAt: r.created_at, disconnectedSince: r.disconnected_since, withdrawn: !!r.withdrawn })
const toEvent = (r: R): EventRow => ({ id: r.id, t: r.t, jobId: r.job_id, shard: r.shard, kind: r.kind, message: r.message })

// camelCase patch keys → columns
const JOB_COLS: Record<string, string> = {
  state: 'state', pinned: 'pinned', placement: 'placement', waitWhy: 'wait_why', startedAt: 'started_at', endedAt: 'ended_at',
  summary: 'summary', error: 'error', base: 'base', tree: 'tree',
}
const SHARD_COLS: Record<string, string> = {
  state: 'state', attempt: 'attempt', resource: 'resource', box: 'box', slot: 'slot', where: 'where_text', avoid: 'avoid',
  firstInfra: 'first_infra', code: 'code', reason: 'reason', queuedAt: 'queued_at', startedAt: 'started_at', endedAt: 'ended_at',
}

function sqlValue(v: unknown): any {
  if (v === undefined) return null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (v !== null && typeof v === 'object') return JSON.stringify(v)
  return v
}

export class Db implements BoxStore {
  readonly raw: DatabaseSync
  private readonly boxTable: BoxTable

  /** Opens (or creates) the DB. A file with another schema version is moved aside and a fresh one started. */
  readonly path: string
  /** the suffix (`v<old>-<now>`) the old file was moved aside under, or null; the daemon moves jobs/ aside with it */
  readonly movedAside: string | null = null
  constructor(path: string, now = Date.now()) {
    this.path = path
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    let db = new DatabaseSync(path)
    const v = (db.prepare('PRAGMA user_version').get() as R).user_version as number
    const hasTables = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' LIMIT 1").get()
    // v3 → v4 in place (jobs kept): the boxes' public-lane mark and first-seen environment version
    if (hasTables && v === 3) {
      db.exec('ALTER TABLE boxes ADD COLUMN pub_repo TEXT; ALTER TABLE boxes ADD COLUMN env_version INTEGER; PRAGMA user_version = 4;')
    } else if (hasTables && v !== SCHEMA_VERSION) {
      db.close()
      this.movedAside = `v${v}-${now}`
      const aside = `${path}.${this.movedAside}`
      renameSync(path, aside)
      for (const ext of ['-wal', '-shm']) if (existsSync(path + ext)) renameSync(path + ext, aside + ext)
      db = new DatabaseSync(path)
    }
    db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
    if (!hasTables || (v !== SCHEMA_VERSION && v !== 3)) {
      db.exec(SCHEMA)
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    }
    this.raw = db
    this.boxTable = new BoxTable(db)
  }

  close() {
    this.raw.close()
  }

  private run(sql: string, ...p: any[]) {
    return this.raw.prepare(sql).run(...p)
  }
  private get(sql: string, ...p: any[]): R | undefined {
    return this.raw.prepare(sql).get(...p) as R | undefined
  }
  private all(sql: string, ...p: any[]): R[] {
    return this.raw.prepare(sql).all(...p) as R[]
  }
  private update(table: string, cols: Record<string, string>, where: string, whereArgs: any[], patch: Record<string, unknown>) {
    const sets: string[] = []
    const vals: any[] = []
    for (const [k, v] of Object.entries(patch)) {
      const c = cols[k]
      if (!c) throw new Error(`db: unknown ${table} field ${k}`)
      sets.push(`${c} = ?`)
      vals.push(sqlValue(v))
    }
    if (sets.length) this.run(`UPDATE ${table} SET ${sets.join(', ')} WHERE ${where}`, ...vals, ...whereArgs)
  }
  tx<T>(fn: () => T): T {
    this.raw.exec('BEGIN')
    try {
      const r = fn()
      this.raw.exec('COMMIT')
      return r
    } catch (e) {
      this.raw.exec('ROLLBACK')
      throw e
    }
  }

  /** Job ids continue above `nextId - 1` (the switch to split): only while the DB has no job. */
  seedNextId(nextId: number): boolean {
    if (this.get('SELECT 1 FROM jobs LIMIT 1') || !Number.isInteger(nextId) || nextId < 1) return false
    this.run("DELETE FROM sqlite_sequence WHERE name = 'jobs'")
    this.run("INSERT INTO sqlite_sequence (name, seq) VALUES ('jobs', ?)", nextId - 1)
    return true
  }
  maxJobId(): number {
    return (this.get('SELECT MAX(id) AS m FROM jobs')?.m as number) ?? 0
  }

  // ---- meta
  meta(key: string): string | null {
    return (this.get('SELECT value FROM meta WHERE key = ?', key)?.value as string) ?? null
  }
  setMeta(key: string, value: string) {
    this.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value)
  }

  // ---- jobs
  insertJob(j: Omit<JobRow, 'id' | 'pinned' | 'placement' | 'waitWhy' | 'startedAt' | 'endedAt' | 'summary' | 'error' | 'profileDir'> & { pinned: boolean; profileDir?: string }): number {
    const r = this.run(
      `INSERT INTO jobs (key, repo, profile, profile_hash, mode, args, commit_sha, tree, source, base, label, state, pinned, created_at, lane, env, door, gh_run, profile_dir)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      j.key, j.repo, j.profile, j.profileHash, j.mode, JSON.stringify(j.args), j.commit, j.tree, j.source, j.base, j.label, j.state, j.pinned ? 1 : 0, j.createdAt, j.lane, j.env, j.door, j.ghRun, j.profileDir ?? '',
    )
    return Number(r.lastInsertRowid)
  }
  job(id: number): JobRow | null {
    const r = this.get('SELECT * FROM jobs WHERE id = ?', id)
    return r ? toJob(r) : null
  }
  updateJob(id: number, patch: Partial<Pick<JobRow, 'state' | 'pinned' | 'placement' | 'waitWhy' | 'startedAt' | 'endedAt' | 'summary' | 'error' | 'base' | 'tree'>>) {
    this.update('jobs', JOB_COLS, 'id = ?', [id], patch)
  }
  jobsInStates(states: JobState[]): JobRow[] {
    return this.all(`SELECT * FROM jobs WHERE state IN (${states.map(() => '?').join(',')}) ORDER BY id`, ...states).map(toJob)
  }
  recentJobs(o: { repo?: string; limit: number }): JobRow[] {
    return (o.repo
      ? this.all('SELECT * FROM jobs WHERE repo = ? ORDER BY id DESC LIMIT ?', o.repo, o.limit)
      : this.all('SELECT * FROM jobs ORDER BY id DESC LIMIT ?', o.limit)
    ).map(toJob)
  }
  passedJobWithKey(key: string, since: number, pushedOnly = false): JobRow | null {
    const r = this.get(`SELECT * FROM jobs WHERE key = ? AND state = 'passed' AND ended_at >= ?${pushedOnly ? " AND source = 'pushed'" : ''} ORDER BY id DESC LIMIT 1`, key, since)
    return r ? toJob(r) : null
  }
  /** A job that may be joined: queued or running (or waiting for its bundle), never cancelling. */
  joinableJobWithKey(key: string, pushedOnly = false): JobRow | null {
    const r = this.get(`SELECT * FROM jobs WHERE key = ? AND state IN ('waiting-bundle','queued','running')${pushedOnly ? " AND source = 'pushed'" : ''} ORDER BY id DESC LIMIT 1`, key)
    return r ? toJob(r) : null
  }
  /** the profile dirs jobs still name (snapshot pruning keeps these) */
  profileDirs(): Set<string> {
    return new Set(this.all("SELECT DISTINCT profile_dir FROM jobs WHERE profile_dir != ''").map((r) => r.profile_dir as string))
  }
  jobIds(): Set<number> {
    return new Set(this.all('SELECT id FROM jobs').map((r) => r.id as number))
  }
  jobsEndedBefore(t: number): JobRow[] {
    return this.all("SELECT * FROM jobs WHERE ended_at IS NOT NULL AND ended_at < ?", t).map(toJob)
  }
  deleteJob(id: number) {
    this.tx(() => {
      for (const t of ['shards', 'job_events', 'interests', 'status_targets', 'gh_runs']) this.run(`DELETE FROM ${t} WHERE job_id = ?`, id)
      this.run('DELETE FROM jobs WHERE id = ?', id)
    })
  }

  // ---- shards
  insertShard(s: Pick<ShardRow, 'jobId' | 'idx' | 'name' | 'size' | 'args' | 'state' | 'queuedAt'>) {
    this.run('INSERT INTO shards (job_id, idx, name, size, args, state, queued_at) VALUES (?, ?, ?, ?, ?, ?, ?)', s.jobId, s.idx, s.name, s.size, JSON.stringify(s.args), s.state, s.queuedAt)
  }
  shards(jobId: number): ShardRow[] {
    return this.all('SELECT * FROM shards WHERE job_id = ? ORDER BY idx', jobId).map(toShard)
  }
  shard(jobId: number, idx: number): ShardRow | null {
    const r = this.get('SELECT * FROM shards WHERE job_id = ? AND idx = ?', jobId, idx)
    return r ? toShard(r) : null
  }
  updateShard(jobId: number, idx: number, patch: Partial<Omit<ShardRow, 'jobId' | 'idx' | 'name' | 'size' | 'args'>>) {
    this.update('shards', SHARD_COLS, 'job_id = ? AND idx = ?', [jobId, idx], patch)
  }
  deleteShards(jobId: number) {
    this.run('DELETE FROM shards WHERE job_id = ?', jobId)
  }
  shardsInState(state: ShardState): ShardRow[] {
    return this.all('SELECT * FROM shards WHERE state = ? ORDER BY job_id, idx', state).map(toShard)
  }

  // ---- events
  addEvent(e: Omit<EventRow, 'id'>) {
    this.run('INSERT INTO job_events (t, job_id, shard, kind, message) VALUES (?, ?, ?, ?, ?)', e.t, e.jobId, e.shard, e.kind, e.message)
  }
  events(jobId: number): EventRow[] {
    return this.all('SELECT * FROM job_events WHERE job_id = ? ORDER BY id', jobId).map(toEvent)
  }

  // ---- interests
  insertInterest(token: string, jobId: number, now: number) {
    this.run('INSERT INTO interests (token, job_id, created_at, disconnected_since) VALUES (?, ?, ?, ?)', token, jobId, now, now)
  }
  interest(token: string): InterestRow | null {
    const r = this.get('SELECT * FROM interests WHERE token = ?', token)
    return r ? toInterest(r) : null
  }
  interests(jobId: number): InterestRow[] {
    return this.all('SELECT * FROM interests WHERE job_id = ?', jobId).map(toInterest)
  }
  setInterest(token: string, patch: { disconnectedSince?: number | null; withdrawn?: boolean }) {
    this.update('interests', { disconnectedSince: 'disconnected_since', withdrawn: 'withdrawn' }, 'token = ?', [token], patch)
  }
  /** On boot no stream is connected: every open interest counts as dropped at `now`. */
  disconnectAllInterests(now: number) {
    this.run('UPDATE interests SET disconnected_since = ? WHERE withdrawn = 0', now)
  }

  // ---- status targets: one (sha, context) per submission that asked for a commit status
  addStatusTarget(jobId: number, sha: string, context: string) {
    this.run('INSERT OR IGNORE INTO status_targets (job_id, sha, context) VALUES (?, ?, ?)', jobId, sha, context)
  }
  statusTargets(jobId: number): StatusTargetRow[] {
    return this.all('SELECT * FROM status_targets WHERE job_id = ?', jobId).map((r) => ({ jobId: r.job_id, sha: r.sha, context: r.context, state: r.state, postedAt: r.posted_at, error: r.error }))
  }
  /** the outcome of a post: `state` + `postedAt` when it went through, `error` when it didn't */
  setStatusTarget(jobId: number, sha: string, context: string, patch: { state: string | null; postedAt: number | null; error: string | null }) {
    this.run('UPDATE status_targets SET state = ?, posted_at = ?, error = ? WHERE job_id = ? AND sha = ? AND context = ?', patch.state, patch.postedAt, patch.error, jobId, sha, context)
  }

  // ---- boxes (the table lives in core/boxes-db.ts; ci-brokerd keeps it in its own file)
  insertBox(b: BoxRow) {
    this.boxTable.insertBox(b)
  }
  box(name: string): BoxRow | null {
    return this.boxTable.box(name)
  }
  boxes(): BoxRow[] {
    return this.boxTable.boxes()
  }
  updateBox(name: string, patch: BoxPatch) {
    this.boxTable.updateBox(name, patch)
  }
  markBoxPublic(name: string, repo: string) {
    this.boxTable.markBoxPublic(name, repo)
  }
  deleteBox(name: string) {
    this.boxTable.deleteBox(name)
  }

  // ---- github runs
  insertGhRun(g: Pick<GhRunRow, 'token' | 'resource' | 'repo' | 'workflow' | 'jobId' | 'idx' | 'attempt' | 'dispatchedAt'>) {
    this.run(
      "INSERT OR REPLACE INTO gh_runs (token, resource, repo, workflow, job_id, idx, attempt, state, dispatched_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'dispatched', ?)",
      g.token, g.resource, g.repo, g.workflow, g.jobId, g.idx, g.attempt, g.dispatchedAt,
    )
  }
  ghRun(token: string): GhRunRow | null {
    const r = this.get('SELECT * FROM gh_runs WHERE token = ?', token)
    return r ? toGhRun(r) : null
  }
  updateGhRun(token: string, patch: Partial<Pick<GhRunRow, 'runId' | 'url' | 'state' | 'conclusion' | 'endedAt'>>) {
    this.update('gh_runs', { runId: 'run_id', url: 'url', state: 'state', conclusion: 'conclusion', endedAt: 'ended_at' }, 'token = ?', [token], patch)
  }
  /** runs not known to have ended */
  ghRunsInFlight(): GhRunRow[] {
    return this.all("SELECT * FROM gh_runs WHERE state IN ('dispatched','running') ORDER BY dispatched_at").map(toGhRun)
  }

  // ---- slots (local, ssh; checks hold one with job_id 0)
  takeSlot(s: SlotRow): boolean {
    return this.run('INSERT OR IGNORE INTO slots (resource, slot, job_id, idx, since) VALUES (?, ?, ?, ?, ?)', s.resource, s.slot, s.jobId, s.idx, s.since).changes > 0
  }
  freeSlot(resource: string, slot: number) {
    this.run('DELETE FROM slots WHERE resource = ? AND slot = ?', resource, slot)
  }
  slots(): SlotRow[] {
    return this.all('SELECT * FROM slots ORDER BY resource, slot').map((r) => ({ resource: r.resource, slot: r.slot, jobId: r.job_id, idx: r.idx, since: r.since }))
  }
  clearSlots() {
    this.run('DELETE FROM slots')
  }

  // ---- health
  health(resource: string, profile: string): HealthRow {
    const r = this.get('SELECT * FROM health WHERE resource = ? AND profile = ?', resource, profile)
    return r ? toHealth(r) : { resource, profile, failing: false, reason: null, infraFails: 0, lastCheckAt: null, lastCheckOk: null, lastCheckLog: null }
  }
  allHealth(): HealthRow[] {
    return this.all('SELECT * FROM health ORDER BY resource, profile').map(toHealth)
  }
  setHealth(resource: string, profile: string, patch: Partial<Omit<HealthRow, 'resource' | 'profile'>>) {
    this.run('INSERT OR IGNORE INTO health (resource, profile) VALUES (?, ?)', resource, profile)
    this.update(
      'health',
      { failing: 'failing', reason: 'reason', infraFails: 'infra_fails', lastCheckAt: 'last_check_at', lastCheckOk: 'last_check_ok', lastCheckLog: 'last_check_log' },
      'resource = ? AND profile = ?',
      [resource, profile],
      patch,
    )
  }
  resetHealth(resource: string) {
    this.run('UPDATE health SET failing = 0, reason = NULL, infra_fails = 0 WHERE resource = ?', resource)
  }
}

// ---------------------------------------------------------------- trust.db
// A separate file that is never moved aside: its changes are additive (CREATE TABLE IF NOT EXISTS, ADD COLUMN) under
// its own user_version. A newer file than the code refuses. So a main-DB reset loses jobs, never blocks, refusals,
// run uses or the ticket key.

export const TRUST_VERSION = 1

const TRUST_SCHEMA = `
CREATE TABLE IF NOT EXISTS blocks (repo TEXT PRIMARY KEY, since INTEGER NOT NULL, reason TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tiers (repo TEXT PRIMARY KEY, tier TEXT NOT NULL, checked_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS run_uses (run TEXT PRIMARY KEY, job TEXT NOT NULL, how TEXT NOT NULL, t INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  t INTEGER NOT NULL,
  door TEXT NOT NULL,
  repo TEXT, run TEXT, actor TEXT,
  ok INTEGER NOT NULL,
  check_id TEXT,
  reason TEXT NOT NULL,
  job TEXT
);
CREATE INDEX IF NOT EXISTS events_t ON events (t);
CREATE TABLE IF NOT EXISTS watch (repo TEXT PRIMARY KEY, since INTEGER NOT NULL, error TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`

export type Tier = 'private' | 'public' | 'none'
export type BlockRow = { repo: string; since: number; reason: string }
export type TierRow = { repo: string; tier: Tier; checkedAt: number }
export type RunUseRow = { run: string; job: string; how: 'new' | 'joined' | 'reused'; t: number }
/** ok: 1 admitted (GitHub door), 0 refused, 2 offline fallback (local door) */
export type TrustEventRow = { id: number; t: number; door: Door; repo: string | null; run: string | null; actor: string | null; ok: 0 | 1 | 2; checkId: string | null; reason: string; job: string | null }
export type WatchRow = { repo: string; since: number; error: string }

/** repo keys are stored lowercased (GitHub names are case-insensitive) */
const rk = (repo: string) => repo.toLowerCase()

export class TrustDb {
  readonly raw: DatabaseSync
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    const db = new DatabaseSync(path)
    const v = (db.prepare('PRAGMA user_version').get() as R).user_version as number
    if (v > TRUST_VERSION) {
      db.close()
      throw new Error(`trust.db is from a newer ci-broker (version ${v}, this code knows ${TRUST_VERSION}); refusing to start`)
    }
    db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
    db.exec(TRUST_SCHEMA)
    if (v !== TRUST_VERSION) db.exec(`PRAGMA user_version = ${TRUST_VERSION}`)
    this.raw = db
  }
  close() {
    this.raw.close()
  }
  private run(sql: string, ...p: any[]) {
    return this.raw.prepare(sql).run(...p)
  }
  private get(sql: string, ...p: any[]): R | undefined {
    return this.raw.prepare(sql).get(...p) as R | undefined
  }
  private all(sql: string, ...p: any[]): R[] {
    return this.raw.prepare(sql).all(...p) as R[]
  }

  block(repo: string): BlockRow | null {
    const r = this.get('SELECT * FROM blocks WHERE repo = ?', rk(repo))
    return r ? { repo: r.repo, since: r.since, reason: r.reason } : null
  }
  blocks(): BlockRow[] {
    return this.all('SELECT * FROM blocks ORDER BY repo').map((r) => ({ repo: r.repo, since: r.since, reason: r.reason }))
  }
  setBlock(repo: string, since: number, reason: string) {
    this.run('INSERT OR IGNORE INTO blocks (repo, since, reason) VALUES (?, ?, ?)', rk(repo), since, reason)
  }
  unblock(repo: string) {
    this.run('DELETE FROM blocks WHERE repo = ?', rk(repo))
  }

  tier(repo: string): TierRow | null {
    const r = this.get('SELECT * FROM tiers WHERE repo = ?', rk(repo))
    return r ? { repo: r.repo, tier: r.tier, checkedAt: r.checked_at } : null
  }
  tiers(): TierRow[] {
    return this.all('SELECT * FROM tiers ORDER BY repo').map((r) => ({ repo: r.repo, tier: r.tier, checkedAt: r.checked_at }))
  }
  setTier(repo: string, tier: Tier, at: number) {
    this.run('INSERT INTO tiers (repo, tier, checked_at) VALUES (?, ?, ?) ON CONFLICT(repo) DO UPDATE SET tier = excluded.tier, checked_at = excluded.checked_at', rk(repo), tier, at)
  }

  runUse(run: string): RunUseRow | null {
    const r = this.get('SELECT * FROM run_uses WHERE run = ?', run)
    return r ? { run: r.run, job: r.job, how: r.how, t: r.t } : null
  }
  /** false: this run attempt already has a row */
  addRunUse(run: string, job: string, how: RunUseRow['how'], t: number): boolean {
    return this.run('INSERT OR IGNORE INTO run_uses (run, job, how, t) VALUES (?, ?, ?, ?)', run, job, how, t).changes > 0
  }

  addEvent(e: Omit<TrustEventRow, 'id'>) {
    this.run('INSERT INTO events (t, door, repo, run, actor, ok, check_id, reason, job) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', e.t, e.door, e.repo, e.run, e.actor, e.ok, e.checkId, e.reason, e.job)
  }
  events(o: { limit: number; repo?: string }): TrustEventRow[] {
    const rows = o.repo
      ? this.all('SELECT * FROM events WHERE lower(repo) = ? ORDER BY id DESC LIMIT ?', rk(o.repo), o.limit)
      : this.all('SELECT * FROM events ORDER BY id DESC LIMIT ?', o.limit)
    return rows.map((r) => ({ id: r.id, t: r.t, door: r.door, repo: r.repo, run: r.run, actor: r.actor, ok: r.ok, checkId: r.check_id, reason: r.reason, job: r.job }))
  }

  watchErrors(): WatchRow[] {
    return this.all('SELECT * FROM watch ORDER BY repo').map((r) => ({ repo: r.repo, since: r.since, error: r.error }))
  }
  /** keeps the first `since` while the error goes on */
  setWatchError(repo: string, since: number, error: string) {
    this.run('INSERT INTO watch (repo, since, error) VALUES (?, ?, ?) ON CONFLICT(repo) DO UPDATE SET error = excluded.error', rk(repo), since, error)
  }
  clearWatchError(repo: string) {
    this.run('DELETE FROM watch WHERE repo = ?', rk(repo))
  }

  meta(key: string): string | null {
    return (this.get('SELECT value FROM meta WHERE key = ?', key)?.value as string) ?? null
  }
  setMeta(key: string, value: string) {
    this.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value)
  }
  /** The tickets' HMAC key: 32 random bytes, made once. */
  hmacKey(): Buffer {
    const have = this.meta('hmacKey')
    if (have) return Buffer.from(have, 'base64')
    const k = randomBytes(32)
    this.run('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)', 'hmacKey', k.toString('base64'))
    return Buffer.from(this.meta('hmacKey')!, 'base64')
  }

  /** events and run uses older than `before` (the hourly timer passes now - 90 days) */
  prune(before: number) {
    this.run('DELETE FROM events WHERE t < ?', before)
    this.run('DELETE FROM run_uses WHERE t < ?', before)
  }
}
