// How long a Boat shard takes, learned from its passing runs.
// The queue asks it two things: when will a busy box's holder be done, and what does a box start (resume or create)
// cost a shard, against a warm box.
import { createHash } from 'node:crypto'
import type { RunsDb, UsageShard } from './runs-db.ts'

/** a shard's key: what its time depends on */
export type EtaKey = { repo: string; suite: string; shape: string; shard: string; argsKey: string }

/** the args that reach a shard, as a short hash; '-' for none */
export function argsKey(args: string[]): string {
  return args.length ? createHash('sha1').update(JSON.stringify(args)).digest('hex').slice(0, 10) : '-'
}

/** samples kept per key, and the fewest that make an estimate */
const KEEP = 20
const KEEP_ALL = 60
const MIN_SAMPLES = 5
/** what a box start costs a shard with no history (measured 2026-11-19: about 40 s) */
export const DEFAULT_START_COST_SEC = 40
const WARM = new Set(['reused', 'shared'])
const COLD = new Set(['resumed', 'created'])

const q = (a: number[], p: number) => {
  const s = [...a].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]
}

export class EtaModel {
  /** full key → secs (newest last) */
  private byKey = new Map<string, number[]>()
  /** key without args → secs over every args */
  private byShard = new Map<string, number[]>()
  /** key without args → secs on a warm box / on a box that had to start */
  private warm = new Map<string, number[]>()
  private cold = new Map<string, number[]>()

  private static full(k: EtaKey) {
    return `${k.repo}|${k.suite}|${k.shape}|${k.shard}|${k.argsKey}`
  }
  private static shardOf(k: Omit<EtaKey, 'argsKey'>) {
    return `${k.repo}|${k.suite}|${k.shape}|${k.shard}`
  }
  private static push(m: Map<string, number[]>, k: string, v: number, keep: number) {
    const a = m.get(k) ?? []
    a.push(v)
    if (a.length > keep) a.splice(0, a.length - keep)
    m.set(k, a)
  }

  /** a passing shard's time. `argsKey` null (a row from before keys were kept) counts toward the per-shard figures only */
  add(k: Omit<EtaKey, 'argsKey'> & { argsKey: string | null }, secs: number, how: string) {
    if (!(secs > 0)) return
    const sk = EtaModel.shardOf(k)
    if (k.argsKey != null) EtaModel.push(this.byKey, EtaModel.full(k as EtaKey), secs, KEEP)
    EtaModel.push(this.byShard, sk, secs, KEEP_ALL)
    if (WARM.has(how)) EtaModel.push(this.warm, sk, secs, KEEP)
    else if (COLD.has(how)) EtaModel.push(this.cold, sk, secs, KEEP)
  }

  /** p75 and p90 of the key's passing times: its own args if it has enough, else over all args; null: no history */
  estimate(k: EtaKey): { p75: number; p90: number } | null {
    let a = this.byKey.get(EtaModel.full(k))
    if (!a || a.length < MIN_SAMPLES) {
      const all = this.byShard.get(EtaModel.shardOf(k))
      if (all && (all.length >= MIN_SAMPLES || !a?.length)) a = all
    }
    if (!a?.length) return null
    return { p75: q(a, 0.75), p90: q(a, 0.9) }
  }

  /**
   * Seconds until a holder that started `elapsed` s ago is done: its p75 less the time it ran (at least 5 s). Past its
   * p90 it may be stuck: 1.5 × p75 less elapsed, at least 15 s. Null: no history (do not wait for it).
   */
  remaining(k: EtaKey, elapsed: number): number | null {
    const e = this.estimate(k)
    if (!e) return null
    if (elapsed > e.p90) return Math.max(15, e.p75 * 1.5 - elapsed)
    return Math.max(5, e.p75 - elapsed)
  }

  /** what a box start adds to this shard: p50 on a started box less p50 on a warm one (default 40 s) */
  startCost(k: Omit<EtaKey, 'argsKey'>): number {
    const sk = EtaModel.shardOf(k)
    const w = this.warm.get(sk)
    const c = this.cold.get(sk)
    if (!w || w.length < MIN_SAMPLES || !c || c.length < 3) return DEFAULT_START_COST_SEC
    return Math.max(10, q(c, 0.5) - q(w, 0.5))
  }

  /** learn from runs.db: the passing Boat shards since `t` */
  load(db: RunsDb, t: number) {
    for (const r of db.runsSince(t)) {
      if (r.whereRan !== 'boat' || !r.shards) continue
      for (const s of r.shards as (UsageShard & { argsKey?: string })[]) {
        if (s.code !== 0 || !s.secs) continue
        this.add({ repo: r.repo, suite: r.suite, shape: r.shape, shard: s.name, argsKey: s.argsKey ?? (r.argsN ? null : '-') }, s.secs, s.how)
      }
    }
  }
}
