// The daemon's clocks: a scheduler tick (timeouts, interest grace, a pass), Boat reconcile + idle stop + delete, and
// retention pruning. Tests call the tick functions directly instead of starting the intervals.
import type { Ctx } from './ctx.ts'
import type { Watchdog } from './watchdog.ts'

export class Timers {
  private handles: NodeJS.Timeout[] = []
  private c: Ctx
  private watchdog: Watchdog | null
  constructor(c: Ctx, watchdog: Watchdog | null = null) {
    this.c = c
    this.watchdog = watchdog
  }

  async watch(): Promise<unknown> {
    try {
      await this.watchdog?.tick()
      return { ok: true }
    } catch (e) {
      this.c.log(`watchdog failed: ${(e as Error).message}`)
      return { error: (e as Error).message }
    }
  }

  /** Each step on its own: one that throws (disk full, a bad row) is logged and the others still run. */
  tick() {
    const steps: [string, () => void][] = [
      ['timeouts', () => this.c.jobs.timeouts()],
      ['interests', () => this.c.jobs.sweepInterests()],
      ['wake', () => this.c.scheduler.wake()],
    ]
    for (const [name, fn] of steps) {
      try {
        fn()
      } catch (e) {
        this.c.log(`tick: ${name} failed: ${(e as Error).stack ?? e}`)
      }
    }
  }

  async boat(): Promise<unknown> {
    const pool = this.c.pool
    if (!pool) return null
    try {
      const r = await pool.reconcile()
      const s = await pool.sweep()
      this.c.scheduler.wake()
      return { ...r, ...s }
    } catch (e) {
      this.c.log(`boat: reconcile failed: ${(e as Error).message}`)
      return { error: (e as Error).message }
    }
  }

  async prune(): Promise<unknown> {
    try {
      return await this.c.jobs.prune()
    } catch (e) {
      this.c.log(`prune failed: ${(e as Error).message}`)
      return { error: (e as Error).message }
    }
  }

  /** `ci-broker gc`: the timers' work, now. */
  async all() {
    this.tick()
    return { boat: await this.boat(), prune: await this.prune() }
  }

  start() {
    const every = (sec: number, fn: () => unknown) => this.handles.push(setInterval(() => void fn(), sec * 1000))
    every(this.c.cfg.tickSec, () => this.tick())
    every(this.c.cfg.reconcileSec, () => this.boat())
    every(this.c.cfg.pruneSec, () => this.prune())
    every(this.c.cfg.trust.watchSec, () => this.watch())
    // `cmd` job secrets (single): admission and doctor read their last answer
    every(300, () => this.c.creds.refreshSecrets())
  }
  stop() {
    for (const h of this.handles) clearInterval(h)
    this.handles = []
  }
}
