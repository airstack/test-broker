// Box speed: some Boat boxes run the same shards much slower than their peers for hours at a time (a
// slow or crowded host under the VM; a resume does not move it). Each box gets a score from runs.db: the median, over
// its recent passing shards, of the shard's time ÷ the median time of the same shard (repo, suite, shape, shard,
// args) on the OTHER boxes near that time. 1.0 = as fast as its peers; 1.5 = half again as slow. A box at or above
// speed.slowAt is `slow` (and stays slow until it falls below speed.clearAt): placement uses it only when no other box is free, a suite with `avoidSlow` never; with
// speed.mode `retire` a box slow for retireAfterMin, that ran again since it turned slow and is still slow, is drained (deleted once free, and replaced when needed).
// Drains (by the operator or by retire) live in <state>/box-flags.json.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { UsageRun, UsageShard } from './runs-db.ts'

export type SpeedMode = 'off' | 'avoid' | 'retire'
export type SpeedConfig = {
  /** off: no scores used; avoid: slow boxes go last; retire: and a box slow for retireAfterMin is drained */
  mode: SpeedMode
  /** the score at or above which a box turns slow */
  slowAt: number
  /** a slow box is normal again only below this (at most slowAt): a score near slowAt does not flip it back and forth */
  clearAt: number
  /** the fewest scored shards that make a score */
  minSamples: number
  /** a box's newest scored shards counted */
  window: number
  /** only shards from the last ageHours count */
  ageHours: number
  /** a shard is compared with other boxes' runs of its key within this many hours of it */
  nearHours: number
  /** shards shorter than this are not scored (start-up noise) */
  minSecs: number
  /** retire: a box slow this long is drained, if it ran a scored shard after it turned slow (a box that does not run
   *  is not judged on old shards: they age out and it is measured again) */
  retireAfterMin: number
  /** retire: at most this many boxes drained by retire per day (a fleet-wide slowdown must not empty the pool) */
  maxRetirePerDay: number
  /** probes (probe.ts): an idle running box is probed after each start and then at most once per probeEveryMin (0: no probes) */
  probeEveryMin: number
  /** a box is probed only once it has been idle this long (a box about to be reused is left alone) */
  probeIdleSec: number
  /** the probe's work: MB hashed per core, MB written and read back */
  probeCpuMb: number
  probeDiskMb: number
  probeTimeoutSec: number
  /** a probe finding less free disk than this charges the box */
  probeMinFreeGb: number
}
export const SPEED_DEFAULTS: SpeedConfig = { mode: 'retire', slowAt: 1.4, clearAt: 1.25, minSamples: 10, window: 40, ageHours: 24, nearHours: 12, minSecs: 20, retireAfterMin: 120, maxRetirePerDay: 2, probeEveryMin: 30, probeIdleSec: 60, probeCpuMb: 2048, probeDiskMb: 256, probeTimeoutSec: 90, probeMinFreeGb: 3 }

/** last: the start time of its newest scored shard */
export type BoxScore = { score: number; samples: number; last: number }

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y)
  const n = s.length
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2
}

/**
 * Every box's score at `now` from the runs (Boat runs with their shards). A box with fewer than minSamples scored
 * shards in the window has no score (it is treated as normal). A shard is scored only when its key has runs on at
 * least 2 other boxes (3 runs or more) within nearHours of it.
 */
export function boxScores(runs: UsageRun[], now: number, c: SpeedConfig): Map<string, BoxScore> {
  const from = now - c.ageHours * 3_600_000
  const near = c.nearHours * 3_600_000
  type S = { box: string; secs: number; t: number }
  const byKey = new Map<string, S[]>()
  for (const r of runs) {
    if (r.whereRan !== 'boat' || !r.shards || r.startedAt < from - near || r.startedAt > now) continue
    for (const s of r.shards as (UsageShard & { argsKey?: string })[]) {
      if (s.code !== 0 || s.secs == null || s.secs < c.minSecs || s.argsKey == null || !s.box) continue
      const k = `${r.repo}|${r.suite}|${r.shape}|${s.name}|${s.argsKey}`
      let a = byKey.get(k)
      if (!a) byKey.set(k, (a = []))
      a.push({ box: s.box, secs: s.secs, t: r.startedAt })
    }
  }
  const ratios = new Map<string, { t: number; r: number }[]>()
  for (const a of byKey.values()) {
    if (new Set(a.map((x) => x.box)).size < 3) continue
    for (const s of a) {
      if (s.t < from) continue
      const others = a.filter((x) => x.box !== s.box && Math.abs(x.t - s.t) <= near)
      if (others.length < 3 || new Set(others.map((x) => x.box)).size < 2) continue
      let l = ratios.get(s.box)
      if (!l) ratios.set(s.box, (l = []))
      l.push({ t: s.t, r: s.secs / median(others.map((x) => x.secs)) })
    }
  }
  const out = new Map<string, BoxScore>()
  for (const [box, l] of ratios) {
    const w = l.sort((x, y) => x.t - y.t).slice(-c.window)
    if (w.length < c.minSamples) continue
    out.set(box, { score: Math.round(median(w.map((x) => x.r)) * 100) / 100, samples: w.length, last: w[w.length - 1].t })
  }
  return out
}

export type Drain = { at: number; reason: string; by: 'operator' | 'retire' }
type FlagsDoc = { boxes: Record<string, { drain?: Drain; slowSince?: number }>; retired: number[] }

/** test-broker's own marks on boxes (boxes.db is shared with ci-brokerd): drains and when each box turned slow */
export class BoxFlags {
  private doc: FlagsDoc = { boxes: {}, retired: [] }
  private file: string | null
  private log: (m: string) => void
  constructor(file: string | null, log: (m: string) => void = () => {}) {
    this.file = file
    this.log = log
    if (file && existsSync(file))
      try {
        const d = JSON.parse(readFileSync(file, 'utf8')) as Partial<FlagsDoc>
        this.doc = { boxes: d.boxes && typeof d.boxes === 'object' ? d.boxes : {}, retired: Array.isArray(d.retired) ? d.retired.filter((x) => typeof x === 'number') : [] }
      } catch (e) {
        log(`box flags: ${file} could not be read (${(e as Error).message}); starting empty`)
      }
  }
  private save() {
    if (!this.file) return
    try {
      writeFileSync(`${this.file}.tmp`, `${JSON.stringify(this.doc, null, 1)}\n`, { mode: 0o600 })
      renameSync(`${this.file}.tmp`, this.file)
    } catch (e) {
      this.log(`box flags: could not write ${this.file}: ${(e as Error).message}`)
    }
  }
  drain(box: string): Drain | null {
    return this.doc.boxes[box]?.drain ?? null
  }
  setDrain(box: string, d: Drain) {
    this.doc.boxes[box] = { ...this.doc.boxes[box], drain: d }
    if (d.by === 'retire') this.doc.retired.push(d.at)
    this.save()
  }
  undrain(box: string): boolean {
    const e = this.doc.boxes[box]
    if (!e?.drain) return false
    delete e.drain
    // an undrained box starts its slow clock again (else retire drains it again at once)
    delete e.slowSince
    this.save()
    return true
  }
  slowSince(box: string): number | null {
    return this.doc.boxes[box]?.slowSince ?? null
  }
  /** set or clear when a box turned slow; true when it changed */
  setSlow(box: string, since: number | null): boolean {
    const e = this.doc.boxes[box] ?? {}
    if ((e.slowSince ?? null) === since) return false
    if (since == null) delete e.slowSince
    else e.slowSince = since
    this.doc.boxes[box] = e
    this.save()
    return true
  }
  /** retire drains in the last 24 h */
  retiredSince(t: number): number {
    return this.doc.retired.filter((x) => x >= t).length
  }
  /** forget boxes that are gone, and retire marks older than 2 days */
  prune(alive: Set<string>, now: number) {
    let changed = false
    for (const b of Object.keys(this.doc.boxes))
      if (!alive.has(b) || (!this.doc.boxes[b].drain && this.doc.boxes[b].slowSince == null)) {
        delete this.doc.boxes[b]
        changed = true
      }
    const keep = this.doc.retired.filter((x) => now - x < 2 * 86_400_000)
    if (keep.length !== this.doc.retired.length) {
      this.doc.retired = keep
      changed = true
    }
    if (changed) this.save()
  }
}
