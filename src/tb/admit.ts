// The local half of an ask, as a pure function: locks first (correctness), then load (capacity). The Boat half is the
// daemon's (it reserves boxes, a side effect); this decides only "run here" or "busy".
import type { Suite } from './repo-config.ts'

export type Lease = {
  id: string
  repo: string
  /** the caller's worktree */
  root: string
  suite: string
  pid: number | null
  cpus: number
  locks: string[]
  since: number
}

export type Box = { nproc: number; load1: number; memAvailGb: number }
/** confirm: the caller's reason to run a steered heavy run anyway (TEST_BROKER_CONFIRM) */
export type AskFlags = { cpus?: number; noBoat?: boolean; forceLoad?: boolean; confirm?: string }

export type BusyReason =
  | { kind: 'lock'; key: string; holder: string; since: string; etaSec: number | null }
  | { kind: 'load'; freeCpus: number; needCpus: number }
  | { kind: 'memory'; memAvailGb: number; needGb: number }

export type LocalAnswer = { decision: 'local'; cpus: number; locks: string[] } | { decision: 'busy'; reasons: BusyReason[]; retryAfterSec: number }

/** how long a caller should wait before asking again when only load (not a lock) is short */
export const LOAD_RETRY_SEC = 30

export const leasedCpus = (leases: Lease[]) => leases.reduce((n, l) => n + l.cpus, 0)

/** CPUs a new run may take: the budget minus the larger of what is leased and what load1 shows (never below 0). */
export function freeCpus(box: Box, leases: Lease[], budgetFactor: number): number {
  const budget = Math.floor(box.nproc * budgetFactor)
  return Math.max(0, Math.floor(budget - Math.max(leasedCpus(leases), box.load1)))
}

export function holderOf(l: Lease): string {
  const wt = l.root.split('/').filter(Boolean).slice(-1)[0] ?? l.root
  return `${l.repo} ${wt} (${l.suite}${l.pid ? `, pid ${l.pid}` : ''})`
}

export function admitLocal(o: {
  suite: Suite
  leases: Lease[]
  box: Box
  budgetFactor: number
  flags: AskFlags
  now: number
  /** expected seconds left for a lease (from past durations); null = unknown */
  eta: (l: Lease) => number | null
}): LocalAnswer {
  const { suite, leases, box, flags } = o
  const reasons: BusyReason[] = []
  for (const key of suite.local.locks) {
    const h = leases.find((l) => l.locks.includes(key))
    if (h) reasons.push({ kind: 'lock', key, holder: holderOf(h), since: new Date(h.since).toISOString(), etaSec: o.eta(h) })
  }
  const want = Math.max(1, Math.min(flags.cpus ?? suite.local.cpus, suite.local.cpus))
  const need = Math.min(suite.local.minCpus, want)
  const free = freeCpus(box, leases, o.budgetFactor)
  if (!flags.forceLoad) {
    if (free < need) reasons.push({ kind: 'load', freeCpus: free, needCpus: need })
    if (suite.local.memGb > 0 && box.memAvailGb < suite.local.memGb) reasons.push({ kind: 'memory', memAvailGb: Math.round(box.memAvailGb * 10) / 10, needGb: suite.local.memGb })
  }
  if (reasons.length) {
    const etas = reasons.flatMap((r) => (r.kind === 'lock' ? [r.etaSec ?? LOAD_RETRY_SEC] : [LOAD_RETRY_SEC]))
    return { decision: 'busy', reasons, retryAfterSec: Math.max(5, ...etas) }
  }
  return { decision: 'local', cpus: flags.forceLoad ? want : Math.min(want, free), locks: suite.local.locks }
}
