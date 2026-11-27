// The Boat outage pause. Box starts that fail fast (a 500 on resume, an upload that times out) cost each run up to
// the start deadline before it falls back to running here. When several fail close together, on more than one box,
// Boat is likely down: skip it for a while, then let one ask try it again. A start that works ends the pause.

export type OutageCfg = { outageFails: number; outageWindowMin: number; outagePauseMin: number }
export type OutageView = { paused: boolean; until: number | null; probing: boolean; recentFails: number; last: string | null }

const hhmm = (t: number) => new Date(t).toISOString().slice(11, 16)

export class OutagePause {
  private fails: { t: number; box: string }[] = []
  private until = 0
  /** the pause ran out: asks try Boat again, and the next start failure pauses it again at once */
  private probing = false
  private last: string | null = null

  private cfg: () => OutageCfg
  private now: () => number
  private log: (m: string) => void
  constructor(cfg: () => OutageCfg, now: () => number, log: (m: string) => void) {
    this.cfg = cfg
    this.now = now
    this.log = log
  }

  /** Null: try Boat. Else why Boat is skipped now (the ask then runs here). */
  check(): string | null {
    const c = this.cfg()
    if (c.outageFails <= 0) return null
    const now = this.now()
    if (this.until && now < this.until) return `Boat paused until ${hhmm(this.until)} UTC: box starts kept failing (last: ${this.last}); test-broker tries Boat again then`
    if (this.until) {
      this.until = 0
      this.probing = true
      this.log('boat: outage pause over; trying Boat again')
    }
    return null
  }

  /** A box start (create, resume, upload) failed. */
  failed(box: string, why: string) {
    const c = this.cfg()
    if (c.outageFails <= 0) return
    const now = this.now()
    this.last = why.split('\n')[0].slice(0, 200)
    if (this.until && now < this.until) return
    if (this.probing) return this.pause(now, 'the first start after the pause failed too')
    this.fails = this.fails.filter((f) => now - f.t < c.outageWindowMin * 60_000)
    this.fails.push({ t: now, box })
    const boxes = new Set(this.fails.map((f) => f.box)).size
    if (this.fails.length >= c.outageFails && boxes >= 2) this.pause(now, `${this.fails.length} box starts failed in ${c.outageWindowMin} min on ${boxes} boxes`)
  }

  /** A box started and a shard ran there: Boat works. */
  ok() {
    if (this.probing) this.log('boat: a box started; outage pause cleared')
    this.fails = []
    this.probing = false
    this.until = 0
  }

  view(): OutageView {
    const now = this.now()
    const paused = !!this.until && now < this.until
    return { paused, until: paused ? this.until : null, probing: this.probing, recentFails: this.fails.length, last: this.last }
  }

  private pause(now: number, why: string) {
    this.until = now + this.cfg().outagePauseMin * 60_000
    this.probing = false
    this.fails = []
    this.log(`boat: paused until ${hhmm(this.until)} UTC: ${why} (last: ${this.last}); runs go local meanwhile`)
  }
}
