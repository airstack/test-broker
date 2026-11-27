// Steering heavy test runs. At an ask, from runs.db: is this run heavy (learned from its key's past
// cost), and is it worth its cost now? Three checks, each `off`, `log` (recorded, never blocks) or `advise` (the ask is
// answered with the repo's advice, exit 76, unless the caller gives a reason to run it anyway):
//   sameTree    this exact tree already passed this suite recently
//   perWorktree this worktree has run heavy suites too often in the last hour
//   budget      today's Boat use is near the shared daily target, and this repo is using more than its fair share
//               while other repos are testing too (a repo alone on Boat may use the budget; above the target, every
//               heavy run is advised)
import type { RunsDb, UsageSteer } from './runs-db.ts'
import type { SteerCheck, SteerConfig, SteerMode } from './machine-config.ts'
import type { Suite } from './repo-config.ts'
import { dayTarget, repoBoxHours } from './usage.ts'

const H = 3_600_000
const DAY = 86_400_000
/** a reason to run a steered run anyway must say something */
export const CONFIRM_MIN = 15

/** argsKey: the hash of the suite args (argsKey in eta.ts; '-': none): "already passed" needs the same args */
export type SteerAsk = { repo: string; root: string; suite: Suite; shape: 'whole' | 'narrowed'; argsKey: string; head: string | null; now: number; confirm?: string | null }
export type SteerVerdict = UsageSteer & { heavy: boolean | null }

const median = (a: number[]) => {
  if (!a.length) return null
  const s = [...a].sort((x, y) => x - y)
  return s[Math.floor(s.length / 2)]
}
const hhmm = (t: number) => new Date(t).toISOString().slice(11, 16)
const pct = (x: number) => `${Math.round(x * 100)}%`

/** the effective mode of a check: the per-check mode, never above the overall one */
export function checkMode(cfg: SteerConfig, c: SteerCheck): SteerMode {
  if (cfg.mode === 'off') return 'off'
  const m = cfg.checks[c] ?? cfg.mode
  return cfg.mode === 'log' && m === 'advise' ? 'log' : m
}

/**
 * The heavy class: a hand override on the suite, else the median CPU-minutes of the key's last runs against
 * heavyCpuMin. A key with no finished run is not heavy (one unchecked first run is cheap).
 */
export function heavyClass(db: RunsDb, cfg: SteerConfig, q: Pick<SteerAsk, 'repo' | 'suite' | 'shape'>): { heavy: boolean; medianCpuMin: number | null } {
  const m = median(db.lastRuns(q.repo, q.suite.name, q.shape, cfg.heavyRuns).map((r) => r.cpuMin ?? 0))
  if (q.suite.heavy != null) return { heavy: q.suite.heavy, medianCpuMin: m }
  return { heavy: m != null && m >= cfg.heavyCpuMin, medianCpuMin: m }
}

/**
 * Judge one ask. `tree` is asked for only when a run at this HEAD passed recently (working it out copies the index).
 * Never throws for a missing tree or snapshot: that check just has nothing to say.
 */
export async function judge(db: RunsDb, cfg: SteerConfig, q: SteerAsk, tree: () => Promise<string | null>): Promise<SteerVerdict> {
  const none: SteerVerdict = { heavy: null, medianCpuMin: null, reasons: [], advised: false, confirm: null }
  if (cfg.mode === 'off') return none
  const { heavy, medianCpuMin } = heavyClass(db, cfg, q)
  const v: SteerVerdict = { ...none, heavy, medianCpuMin }
  if (!heavy) return v
  const cost = medianCpuMin != null ? ` (about ${Math.round(medianCpuMin)} CPU-minutes a run)` : ''

  if (checkMode(cfg, 'sameTree') !== 'off' && q.head && db.passedAtHead(q.repo, q.suite.name, q.head, q.now - cfg.sameTreeHours * H)) {
    const t = await tree().catch(() => null)
    const hit = t ? db.passedOnTree(q.repo, q.suite.name, t, q.now - cfg.sameTreeHours * H, q.argsKey) : null
    if (hit)
      v.reasons.push({
        check: 'sameTree', mode: checkMode(cfg, 'sameTree'),
        message: `This exact code already passed \`${q.suite.name}\`${q.argsKey !== '-' ? ' with the same args' : ''}${cost} at ${hhmm(hit.endedAt!)} UTC (${hit.id}, ${hit.whereRan}${hit.root !== q.root ? `, from ${hit.root}` : ''}). Running it again tests nothing new.`,
      })
  }

  if (checkMode(cfg, 'perWorktree') !== 'off') {
    const n = db.heavyFrom(q.root, q.now - H)
    if (n >= cfg.heavyPerWorktreePerHour)
      v.reasons.push({
        check: 'perWorktree', mode: checkMode(cfg, 'perWorktree'),
        message: `This worktree has run ${n} heavy suite(s) in the last hour; \`${q.suite.name}\` is heavy too${cost}.`,
      })
  }

  if (checkMode(cfg, 'budget') !== 'off') {
    const target = dayTarget(db, q.now, cfg.reserveHours)
    if (target != null && target > 0) {
      const dayStart = Math.floor(q.now / DAY) * DAY
      const today = [...repoBoxHours(db, dayStart, q.now).values()].reduce((a, b) => a + b, 0)
      const pressure = today / target
      const win = repoBoxHours(db, q.now - cfg.fairWindowHours * H, q.now)
      const winTotal = [...win.values()].reduce((a, b) => a + b, 0)
      const active = new Set(db.runsSince(q.now - cfg.fairWindowHours * H).map((r) => r.repo.toLowerCase()))
      active.add(q.repo.toLowerCase())
      const mine = [...win.entries()].filter(([r]) => r.toLowerCase() === q.repo.toLowerCase()).reduce((a, [, h]) => a + h, 0)
      const share = winTotal > 0 ? mine / winTotal : 0
      const fair = 1 / active.size
      const others = [...win.entries()].filter(([r]) => r.toLowerCase() !== q.repo.toLowerCase()).sort((a, b) => b[1] - a[1])
      const facts = `Today's shared Boat budget: ${today.toFixed(1)} of ${target.toFixed(1)} plan hours used (${pct(pressure)}). In the last ${cfg.fairWindowHours} h, ${q.repo} used ${pct(share)} of Boat${others.length ? `; ${others.slice(0, 3).map(([r, h]) => `${r} ${pct(h / winTotal)}`).join(', ')}` : ''}.`
      if (pressure >= 1)
        v.reasons.push({ check: 'budget', mode: checkMode(cfg, 'budget'), message: `${facts} The day's budget is spent: every heavy run now takes hours from tomorrow, for every repo.` })
      else if (pressure >= cfg.softAt && active.size > 1 && share > fair)
        v.reasons.push({
          check: 'budget', mode: checkMode(cfg, 'budget'),
          message: `${facts} ${active.size} repos are testing, so a fair share is about ${pct(fair)}. At this rate the shared budget runs out early today for all of them.`,
        })
    }
  }

  const confirmed = !!q.confirm && q.confirm.trim().length >= CONFIRM_MIN
  v.confirm = confirmed ? q.confirm!.trim() : null
  v.advised = !confirmed && v.reasons.some((r) => r.mode === 'advise')
  return v
}

/** the answer an advised run prints: the facts, the repo's own advice, then how to run it anyway */
export function adviceText(v: SteerVerdict, repoAdvice: string | null, suite: string): string {
  const L = [`test-broker: \`${suite}\` was not run. It is a heavy suite, and:`]
  for (const r of v.reasons.filter((x) => x.mode === 'advise')) L.push(`  - ${r.message}`)
  L.push('')
  L.push(repoAdvice ?? 'Consider whether this full run is needed: the tests your change touches, plus CI at landing, usually are enough.')
  L.push('')
  L.push(`If this run is needed, run the same command again with TEST_BROKER_CONFIRM set to why (at least ${CONFIRM_MIN} characters), e.g.`)
  L.push(`  TEST_BROKER_CONFIRM="the fix changes the shared runner; the changed tests cannot cover it" <same command>`)
  L.push('The reason is recorded.')
  return L.join('\n')
}
