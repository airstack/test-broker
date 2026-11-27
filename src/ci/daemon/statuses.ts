// Commit statuses (sign-off): `ci-broker/<mode>` on each status target of a job, posted with `gh api` when the job ends
// (or at once for a reused job). A failed post is logged and recorded on the target; it never changes the job result.
import type { JobRow, JobState, ShardRow } from '../db.ts'
import type { Ctx } from './ctx.ts'

export type StatusState = 'success' | 'failure' | 'error'

/** Why a submission gets no status (null = it asked for one). */
export type NoStatusWhy = 'no-status' | 'args' | 'disabled' | 'snapshot'
export type StatusDecision = { asked: true } | { asked: false; why: NoStatusWhy }

export const MAX_DESCRIPTION = 140

export const statusState = (s: JobState): StatusState | null => (s === 'passed' ? 'success' : s === 'failed' ? 'failure' : s === 'error' ? 'error' : null)

/** 42s, 7m08s, 1h02m */
export function duration(secs: number): string {
  const s = Math.max(0, Math.round(secs))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}

/** `<what> (job <name>)[ (public lane)]`, cutting `what` so the whole fits GitHub's 140 characters. */
function fit(what: string, name: string, lane: string = 'full'): string {
  const tail = ` (job ${name})${lane === 'public' ? ' (public lane)' : ''}`
  const room = MAX_DESCRIPTION - tail.length
  const w = what.replace(/\s+/g, ' ').trim()
  return (w.length > room ? `${w.slice(0, room - 1)}…` : w) + tail
}

/** e.g. `10/10 shards passed in 7m08s (job ub1-41)`; for an error, its reason. */
export function describe(job: Pick<JobRow, 'error'>, shards: Pick<ShardRow, 'state' | 'reason'>[], state: JobState, secs: number, name: string, lane: string = 'full'): string {
  const passed = shards.filter((s) => s.state === 'passed').length
  const counts = `${passed}/${shards.length} shards passed`
  if (state === 'error') {
    const why = job.error ?? shards.find((s) => s.state === 'error' && s.reason)?.reason ?? counts
    return fit(`error: ${why}`, name, lane)
  }
  return fit(`${counts} in ${duration(secs)}`, name, lane)
}

export const reusedDescription = (name: string) => `reused job ${name} (same tree)`.slice(0, MAX_DESCRIPTION)

export class Statuses {
  private c: Ctx
  constructor(c: Ctx) {
    this.c = c
  }

  /** POST repos/<repo>/statuses/<sha>. Returns the error, or null when it was posted. */
  async post(repo: string, sha: string, context: string, state: StatusState, description: string): Promise<string | null> {
    let r: { code: number; stdout: string; stderr: string }
    try {
      r = await this.c.gh(['api', '-X', 'POST', `repos/${repo}/statuses/${sha}`, '-f', `state=${state}`, '-f', `context=${context}`, '-f', `description=${description}`], 30)
    } catch (e) {
      r = { code: 1, stdout: '', stderr: (e as Error).message }
    }
    if (r.code === 0) return null
    const msg = (r.stderr || r.stdout).trim().split('\n').filter(Boolean).slice(0, 3).join('; ')
    return this.c.scrub(`gh api exited ${r.code}${msg ? `: ${msg}` : ''}`).slice(0, 300)
  }

  /** Post one target and record the outcome on its row. */
  async postTarget(jobId: number, repo: string, sha: string, context: string, state: StatusState, description: string): Promise<boolean> {
    const { c } = this
    const err = await this.post(repo, sha, context, state, description)
    c.db.setStatusTarget(jobId, sha, context, err ? { state: null, postedAt: null, error: err } : { state, postedAt: c.now(), error: null })
    c.jobs.event(jobId, null, 'status', `${context} ${state} on ${repo}@${sha.slice(0, 12)}: ${err ? `NOT posted (${err})` : `posted (${description})`}`)
    return !err
  }

  /** At the end of a job: post every target not posted yet. Nothing for a cancelled job. */
  async postJobEnd(jobId: number): Promise<void> {
    const { c } = this
    const job = c.db.job(jobId)
    if (!job) return
    const state = statusState(job.state)
    if (!state) return
    const description = describe(job, c.db.shards(jobId), job.state, job.summary?.secs ?? 0, c.jobName(jobId), job.lane)
    const todo = c.db.statusTargets(jobId).filter((t) => t.postedAt === null && t.error === null)
    await Promise.all(todo.map((t) => this.postTarget(jobId, job.repo, t.sha, t.context, state, description)))
  }

  /** Targets a job's end would post (so the end waits for them before it sends `done`). A failed post is not retried. */
  pending(jobId: number): number {
    const job = this.c.db.job(jobId)
    if (!job || !statusState(job.state)) return 0
    return this.c.db.statusTargets(jobId).filter((t) => t.postedAt === null && t.error === null).length
  }
}
