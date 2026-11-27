// runs.db: test-broker's usage record. The only test-broker module that imports node:sqlite.
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

type R = Record<string, any>

// One row per test run test-broker admits, the Boat boxes' state changes (Boat bills a box while it is up) and
// snapshots of `boat limits`. Additive only (CREATE IF NOT EXISTS, ADD COLUMN) under its own user_version; a newer
// file than the code refuses. Times are ms since the epoch.

export const RUNS_VERSION = 4

/** runs that ended with nothing (or not all) of the suite run for a reason of test-broker's or Boat's: a Boat run that
 *  never started (exit 3), a broker error (exit 2), a run cut by a daemon restart. Steering never counts them as heavy
 *  runs, nor learns a suite's cost from them. An advised ask (where_ran 'advised') ran nothing either. */
const NOT_RUN = `where_ran <> 'advised' AND coalesce(ended_how, '') NOT IN ('not started', 'error', 'daemon restart')`

const RUNS_SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  root TEXT NOT NULL,
  branch TEXT, head TEXT, tree TEXT,
  suite TEXT NOT NULL,
  shape TEXT NOT NULL,
  args_n INTEGER NOT NULL,
  where_ran TEXT NOT NULL,
  boat_why TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  exit_code INTEGER,
  ended_how TEXT,
  cpus INTEGER NOT NULL,
  cpu_min REAL,
  plan_hours REAL,
  shards TEXT
);
CREATE INDEX IF NOT EXISTS runs_t ON runs (started_at);
CREATE INDEX IF NOT EXISTS runs_key ON runs (repo, suite, shape, started_at);
CREATE TABLE IF NOT EXISTS box_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  t INTEGER NOT NULL,
  box TEXT NOT NULL,
  size TEXT NOT NULL,
  state TEXT NOT NULL,
  repo TEXT,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS box_events_t ON box_events (t);
CREATE TABLE IF NOT EXISTS box_probes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  t INTEGER NOT NULL,
  box TEXT NOT NULL,
  size TEXT NOT NULL,
  secs REAL,
  cpu1 REAL, cpu_n REAL, write REAL, read REAL,
  repo_secs REAL, repo_mb REAL, free_gb REAL, mem_mb REAL, io_some REAL, load1 REAL,
  ok INTEGER NOT NULL,
  faults TEXT
);
CREATE INDEX IF NOT EXISTS box_probes_t ON box_probes (t);
CREATE TABLE IF NOT EXISTS plan (
  t INTEGER PRIMARY KEY,
  hours_left REAL NOT NULL,
  period_end INTEGER,
  last24h_hours REAL,
  starts_used INTEGER,
  active INTEGER,
  wallet_hours REAL
);
`

/** one shard of a Boat run, as stored (JSON) in runs.shards */
export type UsageShard = {
  name: string; box: string; size: string; slot: number; how: string; units: number; memMb: number
  secs: number | null; code: number | null; started: boolean
  peakRamMb?: number; cpuMean?: number; cpuP95?: number; cpus?: number
  /** the hash of the args that reached the shard ('-': none), for its time estimate */
  argsKey?: string
  /** seconds it waited for a busy box before it got one (the queue); secs counts from then */
  waitSecs?: number
  /** its wait gave up (the holders were slower than their estimate): it was placed again, with no wait */
  waitGaveUp?: boolean
  /** what its output held, summed up as it came in: kept when the log file is compressed or deleted */
  log?: LogSummary
}
/** a shard's output in short (src/tb/logsum.ts) */
export type LogSummary = {
  /** bytes and lines of output */
  bytes: number; lines: number
  /** the remote script's timed steps (`=== [Ns] <step>`): each step's name and seconds, in order */
  phases: { name: string; secs: number }[]
  /** the last test count line (vitest, pytest, playwright): null when there was none */
  tests: { passed: number; failed: number; skipped: number } | null
  /** the failing tests it named (at most 20) */
  failing: string[]
  /** where the bytes came from: vitest's `stdout | <file>` / `stderr | <file>` blocks, the biggest first (at most 5),
   *  and the rest */
  sources: { source: string; bytes: number }[]
}
export type UsageRun = {
  id: string; repo: string; root: string; branch: string | null; head: string | null; tree: string | null
  suite: string; shape: 'whole' | 'narrowed'; argsN: number; whereRan: 'boat' | 'local' | 'advised'; boatWhy: string | null
  startedAt: number; endedAt: number | null; exitCode: number | null; endedHow: string | null
  cpus: number; cpuMin: number | null; planHours: number | null; shards: UsageShard[] | null
  /** the hash of its suite args ('-': none; argsKey in eta.ts); null on rows from before it was kept */
  argsKey?: string | null
  /** the learned (or configured) heavy class at the ask; null = not judged */
  heavy: boolean | null
  /** the steering verdict at the ask: what it advised or would have, and an override's reason */
  steer: UsageSteer | null
}
export type UsageSteer = { reasons: { check: string; mode: string; message: string }[]; advised: boolean; confirm: string | null; medianCpuMin: number | null }
export type BoxEventRow = { id: number; t: number; box: string; size: string; state: string; repo: string | null; reason?: string | null }
/** one probe of a box (src/tb/probe.ts); secs: the whole probe; ok: no fault; faults: what charged the box */
export type BoxProbeRow = {
  t: number; box: string; size: string; secs: number | null
  cpu1: number | null; cpuN: number | null; write: number | null; read: number | null
  repoSecs: number | null; repoMb: number | null; freeGb: number | null; memMb: number | null; ioSome: number | null; load1: number | null
  ok: boolean; faults: string[]
}
export type PlanRow = { t: number; hoursLeft: number; periodEnd: number | null; last24hHours: number | null; startsUsed: number | null; active: number | null; walletHours?: number | null }

const usageRow = (x: R): UsageRun => ({
  id: x.id as string, repo: x.repo as string, root: x.root as string, branch: x.branch as string | null, head: x.head as string | null, tree: x.tree as string | null,
  suite: x.suite as string, shape: x.shape as 'whole' | 'narrowed', argsN: x.args_n as number, whereRan: x.where_ran as UsageRun['whereRan'], boatWhy: x.boat_why as string | null,
  startedAt: x.started_at as number, endedAt: x.ended_at as number | null, exitCode: x.exit_code as number | null, endedHow: x.ended_how as string | null,
  cpus: x.cpus as number, cpuMin: x.cpu_min as number | null, planHours: x.plan_hours as number | null, shards: x.shards ? JSON.parse(x.shards as string) : null,
  heavy: x.heavy == null ? null : !!x.heavy, steer: x.steer ? JSON.parse(x.steer as string) : null, argsKey: (x.args_key as string | null) ?? null,
})

export class RunsDb {
  readonly raw: DatabaseSync
  constructor(path: string, o: { readOnly?: boolean } = {}) {
    if (!o.readOnly && path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    const db = new DatabaseSync(path, o.readOnly ? { readOnly: true } : {})
    const v = (db.prepare('PRAGMA user_version').get() as R).user_version as number
    if (v > RUNS_VERSION) {
      db.close()
      throw new Error(`runs.db is from a newer test-broker (version ${v}, this code knows ${RUNS_VERSION})`)
    }
    if (!o.readOnly) {
      db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
      db.exec(RUNS_SCHEMA)
      // v2: the steering verdict per run; a v1 file gains the columns, a new file has them from RUNS_SCHEMA
      const cols = new Set((db.prepare('PRAGMA table_info(runs)').all() as R[]).map((c) => c.name as string))
      if (!cols.has('heavy')) db.exec('ALTER TABLE runs ADD COLUMN heavy INTEGER')
      if (!cols.has('steer')) db.exec('ALTER TABLE runs ADD COLUMN steer TEXT')
      // the hash of the suite args a run got ('-': none; null: a row from before it was kept): "already passed" needs
      // the same args, not only the same tree
      if (!cols.has('args_key')) db.exec('ALTER TABLE runs ADD COLUMN args_key TEXT')
      // v3: the wallet's hours next to the plan's (they pay once the plan is used up)
      const pcols = new Set((db.prepare('PRAGMA table_info(plan)').all() as R[]).map((c) => c.name as string))
      if (!pcols.has('wallet_hours')) db.exec('ALTER TABLE plan ADD COLUMN wallet_hours REAL')
      // v4: why a box stopped (the warm pool's early stops: 'idle (past the warm target)')
      const ecols = new Set((db.prepare('PRAGMA table_info(box_events)').all() as R[]).map((c) => c.name as string))
      if (!ecols.has('reason')) db.exec('ALTER TABLE box_events ADD COLUMN reason TEXT')
      if (v !== RUNS_VERSION) db.exec(`PRAGMA user_version = ${RUNS_VERSION}`)
    }
    this.raw = db
  }
  close() {
    this.raw.close()
  }
  startRun(r: Pick<UsageRun, 'id' | 'repo' | 'root' | 'suite' | 'shape' | 'argsN' | 'whereRan' | 'boatWhy' | 'startedAt' | 'cpus' | 'shards' | 'argsKey'>) {
    this.raw.prepare(`INSERT OR REPLACE INTO runs (id, repo, root, suite, shape, args_n, where_ran, boat_why, started_at, cpus, shards, args_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(r.id, r.repo, r.root, r.suite, r.shape, r.argsN, r.whereRan, r.boatWhy, r.startedAt, r.cpus, r.shards ? JSON.stringify(r.shards) : null, r.argsKey ?? null)
  }
  setGit(id: string, g: { branch?: string | null; head?: string | null; tree?: string | null }) {
    this.raw.prepare('UPDATE runs SET branch = coalesce(?, branch), head = coalesce(?, head), tree = coalesce(?, tree) WHERE id = ?').run(g.branch ?? null, g.head ?? null, g.tree ?? null, id)
  }
  endRun(id: string, e: { endedAt: number; exitCode: number | null; endedHow: string; cpuMin: number; planHours: number; shards?: UsageShard[] }) {
    this.raw.prepare('UPDATE runs SET ended_at = ?, exit_code = ?, ended_how = ?, cpu_min = ?, plan_hours = ?, shards = coalesce(?, shards) WHERE id = ?')
      .run(e.endedAt, e.exitCode, e.endedHow, e.cpuMin, e.planHours, e.shards ? JSON.stringify(e.shards) : null, id)
  }
  /** at daemon start: a run still open was cut by the restart (its lease or Boat run is gone); returns how many */
  closeOpen(now: number): number {
    return Number(this.raw.prepare(`UPDATE runs SET ended_at = ?, ended_how = 'daemon restart' WHERE ended_at IS NULL`).run(now).changes)
  }
  setSteer(id: string, heavy: boolean | null, steer: UsageSteer | null) {
    this.raw.prepare('UPDATE runs SET heavy = ?, steer = ? WHERE id = ?').run(heavy == null ? null : heavy ? 1 : 0, steer ? JSON.stringify(steer) : null, id)
  }
  /** the last `n` finished runs of a key (repo + suite + shape) that ran, newest first (NOT_RUN: an advised ask or a
   *  run cut short costs little and would make a heavy suite look light) */
  lastRuns(repo: string, suite: string, shape: string, n: number): UsageRun[] {
    const ids = (this.raw.prepare(`SELECT id FROM runs WHERE repo = ? AND suite = ? AND shape = ? AND cpu_min IS NOT NULL AND ${NOT_RUN}
      ORDER BY started_at DESC LIMIT ?`).all(repo, suite, shape, n) as R[]).map((x) => x.id as string)
    return this.byIds(ids)
  }
  /** a run of this repo + suite on this tree that passed since `t`, newest first */
  /** the newest run of repo + suite on this tree with these args (argsKey; '-': none) that passed since `t`. A row from
   *  before args were kept counts only when it had no args and none are asked for. */
  passedOnTree(repo: string, suite: string, tree: string, t: number, argsKey: string): UsageRun | null {
    const x = this.raw.prepare(`SELECT id FROM runs WHERE repo = ? AND suite = ? AND tree = ? AND exit_code = 0 AND ended_at >= ?
      AND (args_key = ? OR (args_key IS NULL AND args_n = 0 AND ? = '-')) ORDER BY ended_at DESC LIMIT 1`).get(repo, suite, tree, t, argsKey, argsKey) as R | undefined
    return x ? this.byIds([x.id as string])[0] : null
  }
  /** did any run of this repo + suite at this HEAD pass since `t`? (cheap: decides whether the tree is worth working out) */
  passedAtHead(repo: string, suite: string, head: string, t: number): boolean {
    return !!this.raw.prepare('SELECT 1 FROM runs WHERE repo = ? AND suite = ? AND head = ? AND exit_code = 0 AND ended_at >= ? LIMIT 1').get(repo, suite, head, t)
  }
  /** heavy runs from a worktree since `t`: runs that ran (or run now), not NOT_RUN ones (the caller runs those again) */
  heavyFrom(root: string, t: number): number {
    return (this.raw.prepare(`SELECT count(*) AS n FROM runs WHERE root = ? AND heavy = 1 AND started_at >= ? AND ${NOT_RUN}`).get(root, t) as R).n as number
  }
  private byIds(ids: string[]): UsageRun[] {
    if (!ids.length) return []
    const rows = (this.raw.prepare(`SELECT * FROM runs WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as R[]).map(usageRow)
    const m = new Map(rows.map((r) => [r.id, r]))
    return ids.map((i) => m.get(i)).filter((r): r is UsageRun => !!r)
  }
  boxProbe(p: BoxProbeRow) {
    this.raw.prepare(`INSERT INTO box_probes (t, box, size, secs, cpu1, cpu_n, write, read, repo_secs, repo_mb, free_gb, mem_mb, io_some, load1, ok, faults)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(p.t, p.box, p.size, p.secs, p.cpu1, p.cpuN, p.write, p.read, p.repoSecs, p.repoMb, p.freeGb, p.memMb, p.ioSome, p.load1, p.ok ? 1 : 0, p.faults.length ? JSON.stringify(p.faults) : null)
  }
  boxProbesSince(t: number): BoxProbeRow[] {
    return (this.raw.prepare('SELECT * FROM box_probes WHERE t >= ? ORDER BY t, id').all(t) as R[]).map((x) => ({
      t: x.t as number, box: x.box as string, size: x.size as string, secs: x.secs as number | null,
      cpu1: x.cpu1 as number | null, cpuN: x.cpu_n as number | null, write: x.write as number | null, read: x.read as number | null,
      repoSecs: x.repo_secs as number | null, repoMb: x.repo_mb as number | null, freeGb: x.free_gb as number | null, memMb: x.mem_mb as number | null, ioSome: x.io_some as number | null, load1: x.load1 as number | null,
      ok: !!x.ok, faults: x.faults ? JSON.parse(x.faults as string) : [],
    }))
  }
  boxEvent(e: Omit<BoxEventRow, 'id'>) {
    this.raw.prepare('INSERT INTO box_events (t, box, size, state, repo, reason) VALUES (?, ?, ?, ?, ?, ?)').run(e.t, e.box, e.size, e.state, e.repo, e.reason ?? null)
  }
  plan(p: PlanRow) {
    this.raw.prepare('INSERT OR REPLACE INTO plan (t, hours_left, period_end, last24h_hours, starts_used, active, wallet_hours) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(p.t, p.hoursLeft, p.periodEnd, p.last24hHours, p.startsUsed, p.active, p.walletHours ?? null)
  }
  runsSince(t: number): UsageRun[] {
    return (this.raw.prepare('SELECT * FROM runs WHERE started_at >= ? ORDER BY started_at').all(t) as R[]).map(usageRow)
  }
  /** box events since t, plus each box's last event before t (so a box up at t counts from t) */
  boxEventsSince(t: number): BoxEventRow[] {
    const before = this.raw.prepare('SELECT * FROM box_events WHERE id IN (SELECT max(id) FROM box_events WHERE t < ? GROUP BY box)').all(t) as R[]
    const after = this.raw.prepare('SELECT * FROM box_events WHERE t >= ? ORDER BY t, id').all(t) as R[]
    return [...before, ...after].map((x) => ({ id: x.id as number, t: x.t as number, box: x.box as string, size: x.size as string, state: x.state as string, repo: x.repo as string | null, reason: (x.reason as string | null) ?? null }))
  }
  plansSince(t: number): PlanRow[] {
    return (this.raw.prepare('SELECT * FROM plan WHERE t >= ? ORDER BY t').all(t) as R[]).map((x) => ({
      t: x.t as number, hoursLeft: x.hours_left as number, periodEnd: x.period_end as number | null, last24hHours: x.last24h_hours as number | null, startsUsed: x.starts_used as number | null, active: x.active as number | null,
      walletHours: (x.wallet_hours as number | null) ?? null,
    }))
  }
  lastPlan(): PlanRow | null {
    return this.plansSince(0).at(-1) ?? null
  }
  prune(before: number) {
    this.raw.prepare('DELETE FROM runs WHERE started_at < ?').run(before)
    this.raw.prepare('DELETE FROM box_events WHERE t < ? AND id NOT IN (SELECT max(id) FROM box_events GROUP BY box)').run(before)
    this.raw.prepare('DELETE FROM plan WHERE t < ?').run(before)
    this.raw.prepare('DELETE FROM box_probes WHERE t < ?').run(before)
  }
}
