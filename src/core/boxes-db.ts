// The Boat boxes a broker owns: one row per box. BoxTable runs the queries on any open SQLite file (ci-brokerd keeps
// the table in its own state DB); BoxesDb opens a file that holds just this table (test-broker's boxes.db). Rows
// come back camelCase.
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type BoxState = 'creating' | 'resuming' | 'idle' | 'busy' | 'stopping' | 'stopped' | 'quarantined'
export const TRANSITIONAL: BoxState[] = ['creating', 'resuming', 'stopping']

export type BoxRow = {
  name: string
  boatId: string | null
  env: string
  size: string
  state: BoxState
  since: number
  lastRepo: string | null
  lastUsed: number
  infraFails: number
  reason: string | null
  createdAt: number
  /** made for this repo's public lane: it ran (or may have run) public code. Set once, never cleared. */
  pubRepo?: string | null
  /** the environment version Boat first listed the box at (public lane: it must never change) */
  envVersion?: number | null
}
export type BoxPatch = Partial<Omit<BoxRow, 'name' | 'env' | 'size' | 'createdAt'>>

/** What the Boat pool needs from its store. */
export interface BoxStore {
  insertBox(b: BoxRow): void
  box(name: string): BoxRow | null
  boxes(): BoxRow[]
  updateBox(name: string, patch: BoxPatch): void
  /** The public-lane mark: set once (the first repo stays), never cleared. */
  markBoxPublic(name: string, repo: string): void
  deleteBox(name: string): void
}

export const BOXES_SCHEMA = `
CREATE TABLE IF NOT EXISTS boxes (
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
`

type R = Record<string, any>

const toBox = (r: R): BoxRow => ({
  name: r.name, boatId: r.boat_id, env: r.env, size: r.size, state: r.state, since: r.since, lastRepo: r.last_repo,
  lastUsed: r.last_used, infraFails: r.infra_fails, reason: r.reason, createdAt: r.created_at, pubRepo: r.pub_repo ?? null, envVersion: r.env_version ?? null,
})

// camelCase patch keys → columns
const BOX_COLS: Record<string, string> = {
  boatId: 'boat_id', state: 'state', since: 'since', lastRepo: 'last_repo', lastUsed: 'last_used', infraFails: 'infra_fails', reason: 'reason',
  envVersion: 'env_version',
}

export class BoxTable implements BoxStore {
  private readonly db: DatabaseSync
  constructor(db: DatabaseSync) {
    this.db = db
  }
  insertBox(b: BoxRow) {
    this.db.prepare(
      'INSERT INTO boxes (name, boat_id, env, size, state, since, last_repo, last_used, infra_fails, reason, created_at, pub_repo, env_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(b.name, b.boatId, b.env, b.size, b.state, b.since, b.lastRepo, b.lastUsed, b.infraFails, b.reason, b.createdAt, b.pubRepo ?? null, b.envVersion ?? null)
  }
  box(name: string): BoxRow | null {
    const r = this.db.prepare('SELECT * FROM boxes WHERE name = ?').get(name) as R | undefined
    return r ? toBox(r) : null
  }
  boxes(): BoxRow[] {
    return (this.db.prepare('SELECT * FROM boxes ORDER BY name').all() as R[]).map(toBox)
  }
  updateBox(name: string, patch: BoxPatch) {
    const sets: string[] = []
    const vals: any[] = []
    for (const [k, v] of Object.entries(patch)) {
      const c = BOX_COLS[k]
      if (!c) throw new Error(`db: unknown boxes field ${k}`)
      sets.push(`${c} = ?`)
      vals.push(v === undefined ? null : v)
    }
    if (sets.length) this.db.prepare(`UPDATE boxes SET ${sets.join(', ')} WHERE name = ?`).run(...vals, name)
  }
  markBoxPublic(name: string, repo: string) {
    this.db.prepare('UPDATE boxes SET pub_repo = ? WHERE name = ? AND pub_repo IS NULL').run(repo.toLowerCase(), name)
  }
  deleteBox(name: string) {
    this.db.prepare('DELETE FROM boxes WHERE name = ?').run(name)
  }
}

/** A file with just the boxes table. A file an older build wrote (it held ci-brokerd's whole schema) opens as is:
 *  the other tables are left alone, the boxes table gains any missing column. */
export class BoxesDb extends BoxTable {
  readonly raw: DatabaseSync
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    const db = new DatabaseSync(path)
    db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
    db.exec(BOXES_SCHEMA)
    const cols = new Set((db.prepare('PRAGMA table_info(boxes)').all() as R[]).map((c) => c.name as string))
    if (!cols.has('pub_repo')) db.exec('ALTER TABLE boxes ADD COLUMN pub_repo TEXT')
    if (!cols.has('env_version')) db.exec('ALTER TABLE boxes ADD COLUMN env_version INTEGER')
    super(db)
    this.raw = db
  }
  close() {
    this.raw.close()
  }
}
