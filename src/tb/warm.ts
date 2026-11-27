// The warm pool: how many units of boxes a pool
// keeps up on the long idle stop (the warm target), and which idle boxes past it stop sooner. Pure arithmetic plus the
// agents' activity (runs and hints); BoatRuns feeds it and applies it in its sweep.
import type { RunsDb } from './runs-db.ts'

const MIN = 60_000
/** a worktree with a test run this recent is an active agent */
export const ACTIVE_MS = 30 * MIN
/** D_recent: the units busy or claimed, sampled once a minute over this window */
export const RECENT_MS = 20 * MIN
/** units per agent: learned over this window */
const LEARN_MS = 24 * 3600_000
/** the starts guard: every box gets the long idle stop when the starts left (less the reserve) are this share of the
 *  day's limit (less the reserve) or less */
export const STARTS_GUARD = 0.25
/** an early stop that drew a box start within this long was too early (`test-broker usage`) */
export const EARLY_STOP_WINDOW_MS = 10 * MIN
/** a box stopped for being past the warm target has this stop reason (box_events.reason) */
export const EARLY_STOP_REASON = 'idle (past the warm target)'

export const p90 = (a: number[]): number | null => {
  if (!a.length) return null
  const s = [...a].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.9))]
}

/** One worktree's activity: its last test run, and an agent's hint that tests are likely soon. */
type Agent = { repo: string; env: string; lastRun: number | null; hintUntil: number | null; ttlMs: number | null }

/**
 * Who is working, per pool: the worktrees with a test run in the last 30 min, and the worktrees hinted (`test-broker
 * hint`) whose hint has not run out. A run refreshes the worktree's hint; `gone` ends it. In memory only: hints are
 * hints, and runs are learned again from the next asks.
 */
export class Activity {
  private agents = new Map<string, Agent>()

  /** a test run (or a try of one) from `root` */
  run(root: string, repo: string, env: string, now: number) {
    const a = this.agents.get(root)
    if (a) Object.assign(a, { repo, env, lastRun: now, hintUntil: a.ttlMs != null ? now + a.ttlMs : a.hintUntil })
    else this.agents.set(root, { repo, env, lastRun: now, hintUntil: null, ttlMs: null })
  }

  /** an agent works in `root`: tests are likely within `ttlMs` */
  hint(root: string, repo: string, env: string, ttlMs: number, now: number) {
    const a = this.agents.get(root)
    if (a) Object.assign(a, { repo, env, hintUntil: now + ttlMs, ttlMs })
    else this.agents.set(root, { repo, env, lastRun: null, hintUntil: now + ttlMs, ttlMs })
  }

  /** the worktree is gone */
  gone(root: string): boolean {
    return this.agents.delete(root)
  }

  /** the active agents now: worktree, repo, pool and why it counts (`runs` wins over `hint`) */
  active(now: number): { root: string; repo: string; env: string; source: 'runs' | 'hint' }[] {
    const out: { root: string; repo: string; env: string; source: 'runs' | 'hint' }[] = []
    for (const [root, a] of this.agents) {
      if (a.lastRun != null && now - a.lastRun <= ACTIVE_MS) out.push({ root, repo: a.repo, env: a.env, source: 'runs' })
      else if (a.hintUntil != null && a.hintUntil >= now) out.push({ root, repo: a.repo, env: a.env, source: 'hint' })
      else if ((a.lastRun ?? 0) < now - 2 * 3600_000 && (a.hintUntil ?? 0) < now) this.agents.delete(root)
    }
    return out
  }

  /** did any repo of `env` run a test in the last 30 min? */
  ranRecently(env: string, now: number): boolean {
    for (const a of this.agents.values()) if (a.env === env && a.lastRun != null && now - a.lastRun <= ACTIVE_MS) return true
    return false
  }
}

/**
 * Units per active agent for `repo`, learned from runs.db: the mean of the units its Boat shards held over the mean of
 * its active worktrees (a run in the last 30 min), both sampled every 5 min over the last 24 h. Null: no history.
 */
export function unitsPerAgent(db: RunsDb, repo: string, now: number): number | null {
  const from = now - LEARN_MS
  const runs = db.runsSince(from - ACTIVE_MS).filter((r) => r.repo === repo)
  if (!runs.length) return null
  const spans: { a: number; b: number; units: number }[] = []
  for (const r of runs)
    for (const s of r.whereRan === 'boat' ? (r.shards ?? []) : []) {
      if (!s.secs || !s.started) continue
      const a = r.startedAt + (s.waitSecs ?? 0) * 1000
      spans.push({ a, b: a + s.secs * 1000, units: s.units })
    }
  let units = 0
  let agents = 0
  for (let t = from; t < now; t += 5 * MIN) {
    units += spans.reduce((n, x) => n + (x.a <= t && x.b > t ? x.units : 0), 0)
    const roots = new Set<string>()
    for (const r of runs) if (r.startedAt <= t && t - r.startedAt <= ACTIVE_MS) roots.add(r.root)
    agents += roots.size
  }
  return agents > 0 ? units / agents : null
}

/** the starts guard: few starts left today, so every box keeps the long idle stop (a resume costs more than idle time) */
export function startsGuard(s: { day: number; dayLimit?: number } | null, reserve: number): boolean {
  if (!s || s.dayLimit == null) return false
  const limit = s.dayLimit - reserve
  return limit > 0 && s.day - reserve <= STARTS_GUARD * limit
}

export type WarmBox = { name: string; state: string; size: string; lastUsed: number }

/**
 * The warm target of one pool, in units: max(D_recent, D_agents), at least one box's worth while any repo of the pool
 * ran a test in the last 30 min, else 0.
 */
export function warmUnits(o: { dRecent: number | null; dAgents: number; active: boolean; boxUnits: number }): number {
  const want = Math.max(o.dRecent ?? 0, o.dAgents)
  return o.active ? Math.max(want, o.boxUnits) : want
}

/**
 * The idle boxes of one pool past its warm target (they stop after shortIdleMin). The boxes in use (busy or starting)
 * count first, then the idle ones used most recently, until their units reach the target; every idle box after that
 * is past it.
 */
export function pastTarget(boxes: WarmBox[], targetUnits: number, unitsOf: (size: string) => number): string[] {
  let have = 0
  for (const b of boxes) if (b.state === 'busy' || b.state === 'resuming' || b.state === 'creating') have += unitsOf(b.size)
  const out: string[] = []
  for (const b of boxes.filter((x) => x.state === 'idle').sort((x, y) => y.lastUsed - x.lastUsed)) {
    if (have >= targetUnits) out.push(b.name)
    else have += unitsOf(b.size)
  }
  return out
}
