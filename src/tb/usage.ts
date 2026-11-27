// Test-run usage: what each run cost, and the report `test-broker usage` prints. The data is runs.db
// (src/db.ts RunsDb); this module only does the arithmetic, so the report and (later) steering read the same numbers.
import type { BoxEventRow, LogSummary, PlanRow, RunsDb, UsageRun, UsageShard } from './runs-db.ts'
import { EARLY_STOP_REASON, EARLY_STOP_WINDOW_MS } from './warm.ts'

/** Boat bills a default box (4 CPUs) 1 plan hour an hour, a large one (8 CPUs) 2: one plan hour is 4 CPUs for an hour */
export const CPUS_PER_PLAN_HOUR = 4
/** plan hours an hour a box of each size costs while it is up */
export const SIZE_RATE: Record<string, number> = { small: 0.5, default: 1, large: 2, xlarge: 4 }
const DAY = 86_400_000
/** box states Boat bills (the box is up) */
const UP = new Set(['creating', 'resuming', 'idle', 'busy'])

/** a shard's plan hours: its CPUs (2 a unit) for its seconds */
export const shardPlanHours = (units: number, secs: number) => (units * 2 * secs) / 3600 / CPUS_PER_PLAN_HOUR

/** `resources: peak RAM 8408 MB of 15991 MB (box), CPU busy mean 94% p95 100% of 4 CPU(s), 41 samples` → numbers */
export function parseResources(log: string): Pick<UsageShard, 'peakRamMb' | 'cpuMean' | 'cpuP95' | 'cpus'> {
  const all = [...log.matchAll(/resources: peak RAM (\d+) MB of \d+ MB \(box\), CPU busy mean (\d+)% p95 (\d+)% of (\d+) CPU/g)]
  const m = all.at(-1)
  return m ? { peakRamMb: +m[1], cpuMean: +m[2], cpuP95: +m[3], cpus: +m[4] } : {}
}

/** UTC day of a time, `2026-11-18` */
const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10)

type Bucket = { runs: number; boat: number; local: number; failed: number; cpuMin: number; shardHours: number; boxHours: number }
const bucket = (): Bucket => ({ runs: 0, boat: 0, local: 0, failed: 0, cpuMin: 0, shardHours: 0, boxHours: 0 })

/**
 * Box hours per day and repo from the state changes: a box costs its size's rate while up; each up stretch goes to
 * the repo the box last ran (so the idle time before a stop counts against that repo, as Boat bills it).
 */
export function boxHours(events: BoxEventRow[], from: number, to: number): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>() // day → repo → hours
  const add = (a: number, b: number, size: string, repo: string) => {
    a = Math.max(a, from)
    b = Math.min(b, to)
    while (a < b) {
      const end = Math.min(b, (Math.floor(a / DAY) + 1) * DAY)
      const d = out.get(dayOf(a)) ?? new Map<string, number>()
      d.set(repo, (d.get(repo) ?? 0) + ((end - a) / 3_600_000) * (SIZE_RATE[size] ?? 1))
      out.set(dayOf(a), d)
      a = end
    }
  }
  const byBox = new Map<string, BoxEventRow[]>()
  for (const e of events) byBox.set(e.box, [...(byBox.get(e.box) ?? []), e])
  for (const evs of byBox.values()) {
    evs.sort((x, y) => x.t - y.t || x.id - y.id)
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i]
      if (!UP.has(e.state)) continue
      add(e.t, i + 1 < evs.length ? evs[i + 1].t : to, e.size, e.repo ?? '(none)')
    }
  }
  return out
}

/** today's target in plan hours: the hours left at the day's first snapshot (minus the reserve), over the days left
 *  in the period from then. Fixed for the day; buying hours raises the next day's. null: no snapshot yet. */
export function dayTarget(db: RunsDb, now: number, reserveHours: number): number | null {
  const dayStart = Math.floor(now / DAY) * DAY
  const first = db.plansSince(dayStart)[0] ?? db.lastPlan()
  if (!first?.periodEnd) return null
  const daysLeft = Math.max(0.5, (first.periodEnd - Math.min(first.t, now)) / DAY)
  // the wallet pays once the plan's hours are used up: both count toward what is left
  return Math.max(0, first.hoursLeft + (first.walletHours ?? 0) - reserveHours) / daysLeft
}

/** plan hours per repo in [from, to) from box up time */
export function repoBoxHours(db: RunsDb, from: number, to: number): Map<string, number> {
  const out = new Map<string, number>()
  for (const repos of boxHours(db.boxEventsSince(from), from, to).values()) for (const [r, h] of repos) out.set(r, (out.get(r) ?? 0) + h)
  return out
}

export type UsageReport = {
  from: string
  to: string
  days: { day: string; repos: Record<string, Bucket> }[]
  suites: { repo: string; suite: string; shape: string; runs: number; medianCpuMin: number | null; shardHours: number; boat: number; local: number; heavy: boolean | null }[]
  today: { day: string; boxHours: number; target: number | null; hoursLeft: number | null; walletHours: number | null; daysLeft: number | null; boatLast24h: number | null; at: number | null }
  /** steering per repo and check: advised (not run), would advise (log mode: ran), confirmed (ran on a reason) */
  steer: { repo: string; check: string; advised: number; wouldAdvise: number; confirmed: number }[]
  /** with `runs`: every run in the window, newest first (the stable per-run view for agents) */
  runs?: UsageRunView[]
  /** the Boat pool per day: the queue, box starts, and where the box hours went */
  pool: PoolDay[]
}

/**
 * One day of the Boat pool (all repos). Hours are plan hours (a large box costs 2 an hour), each stretch counted on the
 * day it began. waits: shards that waited for a busy box; startsAvoided: those that got it (no box start); gaveUp:
 * those placed again; notStartedAfterGiveUp: their runs that then ended as not started. idle: gap = idle, then busy
 * again; tail = idle, then stopped; earlyTail = the tails of boxes stopped early by the warm pool. earlyStops: those
 * stops; earlyStopsThenStart: those followed by a box start of the same size within 10 min (a stop too early).
 */
export type PoolDay = {
  day: string
  waits: number; waitMedianSec: number | null; startsAvoided: number; gaveUp: number; notStartedAfterGiveUp: number
  starts: number
  hours: { busy: number; gap: number; tail: number; earlyTail: number; starting: number; idleShare: number | null }
  earlyStops: number; earlyStopsThenStart: number
}

/** the pool's days from the runs (waits) and the box events (starts, idle stretches, early stops) */
export function poolDays(runs: UsageRun[], events: BoxEventRow[], from: number, to: number): PoolDay[] {
  const days = new Map<string, PoolDay & { w: number[] }>()
  const at = (t: number) => {
    const d = dayOf(t)
    let x = days.get(d)
    if (!x) days.set(d, (x = { day: d, waits: 0, waitMedianSec: null, startsAvoided: 0, gaveUp: 0, notStartedAfterGiveUp: 0, starts: 0, hours: { busy: 0, gap: 0, tail: 0, earlyTail: 0, starting: 0, idleShare: null }, earlyStops: 0, earlyStopsThenStart: 0, w: [] }))
    return x
  }
  for (const r of runs) {
    if (r.whereRan !== 'boat' || !r.shards) continue
    for (const s of r.shards) {
      if (s.waitSecs == null && !s.waitGaveUp) continue
      const d = at(r.startedAt)
      d.waits++
      if (s.waitSecs != null) d.w.push(s.waitSecs)
      if (s.waitGaveUp) {
        d.gaveUp++
        if (r.endedHow === 'not started') d.notStartedAfterGiveUp++
      } else d.startsAvoided++
    }
  }
  const byBox = new Map<string, BoxEventRow[]>()
  for (const e of events) byBox.set(e.box, [...(byBox.get(e.box) ?? []), e])
  // a restart records every box's state again: the same state twice in a row is one stretch
  for (const [k, evs] of byBox) byBox.set(k, evs.sort((x, y) => x.t - y.t || x.id - y.id).filter((e, i, a) => i === 0 || a[i - 1].state !== e.state))
  // `<env>-<size>-<rand6>`: the pool a box is in
  const envOf = (box: string) => box.split('-').slice(0, -2).join('-')
  const starts = events.filter((e) => (e.state === 'resuming' || e.state === 'creating') && e.t >= from && e.t < to)
  for (const e of starts) at(e.t).starts++
  for (const evs of byBox.values()) {
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i]
      const next = evs[i + 1]
      if (e.state === 'stopping' && e.reason === EARLY_STOP_REASON && e.t >= from && e.t < to) {
        const d = at(e.t)
        d.earlyStops++
        if (starts.some((x) => x.size === e.size && envOf(x.box) === envOf(e.box) && x.t > e.t && x.t - e.t <= EARLY_STOP_WINDOW_MS)) d.earlyStopsThenStart++
      }
      const a = Math.max(e.t, from)
      const b = Math.min(next ? next.t : to, to)
      if (b <= a) continue
      const h = ((b - a) / 3_600_000) * (SIZE_RATE[e.size] ?? 1)
      const d = at(a)
      if (e.state === 'busy') d.hours.busy += h
      else if (e.state === 'resuming' || e.state === 'creating') d.hours.starting += h
      else if (e.state === 'idle') {
        if (next?.state === 'busy') d.hours.gap += h
        else if (next?.state === 'stopping' && next.reason === EARLY_STOP_REASON) d.hours.earlyTail += h
        else if (next) d.hours.tail += h
        // still idle now: neither yet
        else d.hours.gap += h
      }
    }
  }
  return [...days.values()]
    .sort((a, b) => a.day.localeCompare(b.day))
    .map(({ w, ...d }) => {
      const H = d.hours
      const idle = H.gap + H.tail + H.earlyTail
      const all = idle + H.busy + H.starting
      return { ...d, waitMedianSec: median(w), hours: { busy: r2(H.busy), gap: r2(H.gap), tail: r2(H.tail), earlyTail: r2(H.earlyTail), starting: r2(H.starting), idleShare: all > 0 ? r2(idle / all) : null } }
    })
}

/** one run as `test-broker usage --runs --json` gives it: the interface agents read (keep it stable; add, don't rename) */
export type UsageRunView = {
  id: string; repo: string; worktree: string; branch: string | null; head: string | null; tree: string | null
  suite: string; shape: string; argsN: number; where: string; boatWhy: string | null
  startedAt: string; endedAt: string | null; secs: number | null; exitCode: number | null; endedHow: string | null
  cpus: number; cpuMin: number | null; planHours: number | null; heavy: boolean | null
  steer: { checks: { check: string; mode: string; message: string }[]; advised: boolean; confirm: string | null } | null
  shards: { name: string; box: string; size: string; units: number; memMb: number; secs: number | null; code: number | null; peakRamMb?: number; cpuMean?: number; cpuP95?: number; how?: string; waitSecs?: number; waitGaveUp?: boolean; log?: LogSummary }[] | null
}

const iso = (t: number | null) => (t == null ? null : new Date(t).toISOString())
export function runView(r: UsageRun): UsageRunView {
  return {
    id: r.id, repo: r.repo, worktree: r.root, branch: r.branch, head: r.head, tree: r.tree, suite: r.suite, shape: r.shape, argsN: r.argsN, where: r.whereRan, boatWhy: r.boatWhy,
    startedAt: iso(r.startedAt)!, endedAt: iso(r.endedAt), secs: r.endedAt != null ? Math.round((r.endedAt - r.startedAt) / 1000) : null, exitCode: r.exitCode, endedHow: r.endedHow,
    cpus: r.cpus, cpuMin: r.cpuMin == null ? null : r2(r.cpuMin), planHours: r.planHours == null ? null : r2(r.planHours), heavy: r.heavy,
    steer: r.steer ? { checks: r.steer.reasons, advised: r.steer.advised, confirm: r.steer.confirm } : null,
    shards: r.shards?.map((x) => ({
      name: x.name, box: x.box, size: x.size, units: x.units, memMb: x.memMb, secs: x.secs, code: x.code, ...(x.peakRamMb != null ? { peakRamMb: x.peakRamMb, cpuMean: x.cpuMean, cpuP95: x.cpuP95 } : {}),
      how: x.how, ...(x.waitSecs != null ? { waitSecs: x.waitSecs } : {}), ...(x.waitGaveUp ? { waitGaveUp: true } : {}), ...(x.log ? { log: x.log } : {}),
    })) ?? null,
  }
}

const median = (a: number[]) => {
  if (!a.length) return null
  const s = [...a].sort((x, y) => x - y)
  return s[Math.floor(s.length / 2)]
}
const r2 = (n: number) => Math.round(n * 100) / 100

export function usageReport(db: RunsDb, o: { days: number; repo?: string; now?: number; reserveHours?: number; runs?: boolean }): UsageReport {
  const now = o.now ?? Date.now()
  const from = (Math.floor(now / DAY) - (o.days - 1)) * DAY
  const want = (repo: string) => !o.repo || repo.toLowerCase() === o.repo.toLowerCase()
  const runs = db.runsSince(from).filter((r) => want(r.repo))
  const days = new Map<string, Record<string, Bucket>>()
  const at = (day: string, repo: string) => {
    const d = days.get(day) ?? {}
    days.set(day, d)
    return (d[repo] ??= bucket())
  }
  for (const r of runs) {
    const b = at(dayOf(r.startedAt), r.repo)
    b.runs++
    if (r.whereRan === 'boat') b.boat++
    else if (r.whereRan === 'local') b.local++
    if (r.exitCode != null && r.exitCode !== 0) b.failed++
    b.cpuMin += r.cpuMin ?? 0
    b.shardHours += r.planHours ?? 0
  }
  for (const [day, repos] of boxHours(db.boxEventsSince(from), from, now)) for (const [repo, h] of repos) if (want(repo)) at(day, repo).boxHours += h
  for (const d of days.values()) for (const b of Object.values(d)) Object.assign(b, { cpuMin: r2(b.cpuMin), shardHours: r2(b.shardHours), boxHours: r2(b.boxHours) })

  const keys = new Map<string, UsageRun[]>()
  for (const r of runs) {
    const k = `${r.repo}\u0000${r.suite}\u0000${r.shape}`
    keys.set(k, [...(keys.get(k) ?? []), r])
  }
  const suites = [...keys.entries()].map(([k, rs]) => {
    const [repo, suite, shape] = k.split('\u0000')
    const done = rs.filter((r) => r.cpuMin != null)
    return {
      repo, suite, shape, runs: rs.length, medianCpuMin: median(done.map((r) => r.cpuMin!)),
      shardHours: r2(rs.reduce((n, r) => n + (r.planHours ?? 0), 0)), boat: rs.filter((r) => r.whereRan === 'boat').length, local: rs.filter((r) => r.whereRan === 'local').length,
      heavy: rs.find((r) => r.heavy != null)?.heavy ?? null,
    }
  }).sort((a, b) => b.shardHours - a.shardHours || (b.medianCpuMin ?? 0) - (a.medianCpuMin ?? 0))

  const today = dayOf(now)
  const all = boxHours(db.boxEventsSince(Math.floor(now / DAY) * DAY), Math.floor(now / DAY) * DAY, now).get(today)
  const p: PlanRow | null = db.lastPlan()
  const target = dayTarget(db, now, o.reserveHours ?? 0)
  const st = new Map<string, UsageReport['steer'][number]>()
  for (const r of runs)
    for (const x of r.steer?.reasons ?? []) {
      const k = `${r.repo}\u0000${x.check}`
      const e = st.get(k) ?? { repo: r.repo, check: x.check, advised: 0, wouldAdvise: 0, confirmed: 0 }
      if (r.whereRan === 'advised') e.advised++
      else if (r.steer!.confirm) e.confirmed++
      else e.wouldAdvise++
      st.set(k, e)
    }
  return {
    ...(o.runs ? { runs: [...runs].reverse().map(runView) } : {}),
    // the pool is shared: every repo's runs and boxes (--repo does not narrow it)
    pool: poolDays(o.repo ? db.runsSince(from) : runs, db.boxEventsSince(from), from, now),
    steer: [...st.values()],
    from: dayOf(from), to: today,
    days: [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, repos]) => ({ day, repos })),
    suites,
    today: {
      day: today,
      boxHours: r2([...(all?.values() ?? [])].reduce((n, h) => n + h, 0)),
      target: target == null ? null : r2(target),
      hoursLeft: p ? r2(p.hoursLeft) : null,
      walletHours: p?.walletHours != null ? r2(p.walletHours) : null,
      daysLeft: p?.periodEnd ? r2(Math.max(0, (p.periodEnd - now) / DAY)) : null,
      boatLast24h: p?.last24hHours != null ? r2(p.last24hHours) : null,
      at: p?.t ?? null,
    },
  }
}

export function formatUsage(u: UsageReport): string {
  const L: string[] = []
  L.push(`test-broker usage ${u.from} .. ${u.to} (plan hours: 1 = a default box for an hour; large = 2/h)`)
  L.push('')
  L.push('day         repo                               runs  boat local fail  cpu-min  shard-h  box-h')
  for (const d of u.days)
    for (const [repo, b] of Object.entries(d.repos).sort(([, x], [, y]) => y.boxHours - x.boxHours))
      L.push(`${d.day}  ${repo.padEnd(34)} ${String(b.runs).padStart(4)} ${String(b.boat).padStart(5)} ${String(b.local).padStart(5)} ${String(b.failed).padStart(4)} ${b.cpuMin.toFixed(0).padStart(8)} ${b.shardHours.toFixed(1).padStart(8)} ${b.boxHours.toFixed(1).padStart(6)}`)
  L.push('')
  L.push('costliest suites (repo, suite, shape): runs, median cpu-min, shard plan hours')
  for (const s of u.suites.slice(0, 15))
    L.push(`  ${`${s.repo} ${s.suite} (${s.shape})${s.heavy ? ' heavy' : ''}`.padEnd(58)} ${String(s.runs).padStart(4)}  ${s.medianCpuMin == null ? '   -' : s.medianCpuMin.toFixed(1).padStart(6)}  ${s.shardHours.toFixed(1).padStart(6)}`)
  if (u.steer.length) {
    L.push('')
    L.push('steering: advised (not run) / would advise (log mode, ran) / confirmed (ran on a reason)')
    for (const x of u.steer) L.push(`  ${`${x.repo} ${x.check}`.padEnd(48)} ${String(x.advised).padStart(4)} ${String(x.wouldAdvise).padStart(4)} ${String(x.confirmed).padStart(4)}`)
  }
  if (u.pool.length) {
    L.push('')
    L.push('Boat pool (plan hours): starts, waits (median s, gave up), busy, idle gap / tail / early tail, idle share, early stops (then a start in 10 min)')
    for (const p of u.pool) {
      const h = p.hours
      L.push(`  ${p.day}  starts ${String(p.starts).padStart(4)}  waits ${String(p.waits).padStart(4)} (${p.waitMedianSec ?? '-'} s, ${p.gaveUp} gave up)  busy ${h.busy.toFixed(1).padStart(6)}  idle ${h.gap.toFixed(1)} / ${h.tail.toFixed(1)} / ${h.earlyTail.toFixed(1)}  ${h.idleShare == null ? '-' : `${Math.round(h.idleShare * 100)}%`}  early stops ${p.earlyStops} (${p.earlyStopsThenStart})`)
    }
  }
  const t = u.today
  L.push('')
  L.push(
    `today (${t.day} UTC): ${t.boxHours.toFixed(1)} box hours` +
      (t.target != null ? ` of a ${t.target.toFixed(1)} h daily target (${t.hoursLeft} plan h${t.walletHours != null ? ` + ${t.walletHours} wallet h` : ''} left over ${t.daysLeft} days)` : ' (no plan snapshot yet)') +
      (t.boatLast24h != null ? `; Boat's own last 24 h: ${t.boatLast24h} h` : ''),
  )
  return L.join('\n')
}

export function formatRuns(runs: UsageRunView[]): string {
  const L = ['runs, newest first: started (UTC), repo, suite (shape), where, exit, secs, cpu-min, steering, worktree']
  for (const r of runs)
    L.push(
      `  ${r.startedAt.slice(5, 16).replace('T', ' ')}  ${r.repo.padEnd(28)} ${`${r.suite} (${r.shape})${r.heavy ? ' heavy' : ''}`.padEnd(36)} ${r.where.padEnd(7)} ${String(r.exitCode ?? '-').padStart(3)} ${String(r.secs ?? '-').padStart(5)} ${(r.cpuMin == null ? '-' : r.cpuMin.toFixed(1)).padStart(7)}  ${r.steer?.checks.length ? `${r.steer.advised ? 'advised' : r.steer.confirm ? 'confirmed' : 'would advise'}:${r.steer.checks.map((c) => c.check).join(',')}` : '-'}  ${r.worktree}`,
    )
  return L.join('\n')
}
