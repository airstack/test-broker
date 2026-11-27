// Resource kinds and what the scheduler and the shard runner need from each. Order of use is fixed: local, ssh, boat,
// github. Executors: exec-local.ts, exec-ssh.ts, exec-boat.ts, exec-github.ts.
import type { ResourceKind } from '../config.ts'
import type { JobRow, ShardRow } from '../db.ts'
import type { Profile } from '../profile.ts'

export const KIND_ORDER: ResourceKind[] = ['local', 'ssh', 'boat', 'github']

/** Where a shard was placed. */
export type Placement = {
  resource: string
  kind: ResourceKind
  /** boat: the box name */
  box: string | null
  /** local: 0; boat: always 0; ssh: the host slot; github: 0 */
  slot: number
  how: string
  /** shown in receipts, e.g. "boat:cib-ub1-acme-default-x1y2z3 (reused)" */
  where: string
}

/**
 * How a shard run ended. `code: null` = no exit status. `infra` marks failures of the environment the runner saw
 * itself; the job logic adds profile `infraExitCodes`. `notStarted` = the resource never got to run it (a failed
 * create/resume): the shard goes back to the queue on the same attempt.
 */
export type Outcome = { code: number | null; infra?: 'unreachable' | 'nostatus'; reason?: string; notStarted?: boolean }

export type AbortWhy = 'cancel' | 'timeout'

export type RunCtx = {
  job: JobRow
  shard: ShardRow
  profile: Profile
  placement: Placement
  jobDir: string
  /** raw output; the runner scrubs it */
  onData: (s: string) => void
  signal: AbortSignal
  /** why the signal fired */
  why: () => AbortWhy | null
  /** add a secret value the scrubber must hide from now on */
  addSecret: (v: string) => void
}

export interface Executor {
  run(ctx: RunCtx): Promise<Outcome>
}
