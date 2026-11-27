// The receipt the client prints when a job ends (or is reused), and its exit code. GitHub mode (github.ts) builds the
// step summary, annotations and failing-shard groups from the same inputs.
export type ShardView = { name: string; size: string; state: string; code: number | null; where: string | null; reason: string | null; startedAt: number | null; endedAt: number | null }

export type JobView = {
  id: string
  repo: string
  profile: string
  mode: string
  args: string[]
  commit: string
  source: 'pushed' | 'snapshot'
  state: string
  summary: { state: string; text: string; markdown: string; json: any; secs: number } | null
  error: string | null
  dir: string
  artifacts: string[]
  statusTargets: { sha: string; context: string; state: string | null; postedAt: number | null; error: string | null }[]
  /** GET /jobs/:id has them */
  shards?: ShardView[]
}

/** The daemon's answer on a submission's commit status (see daemon/statuses.ts). */
export type StatusDecision = { asked: true } | { asked: false; why: 'no-status' | 'args' | 'disabled' | 'snapshot' }

export const EXIT: Record<string, number> = { passed: 0, failed: 1, error: 2, cancelled: 130 }
export const exitCode = (state: string) => EXIT[state] ?? 2

export type ReceiptOpts = { reused?: boolean; args: string[]; wantStatus: boolean; commit?: string; status?: StatusDecision; artifactsDir?: string | null }

const WHY: Record<string, string> = {
  'no-status': 'status: not requested (--no-status)',
  args: 'status: none (a run with args never signs off a mode)',
  disabled: 'status: none (turned off for this profile)',
  snapshot: 'status: none (a snapshot has no commit on origin to mark)',
}

/** Whether a commit status went with this submission, and why not when it didn't. */
export function statusLine(job: JobView, o: ReceiptOpts): string {
  const s: StatusDecision = o.status ?? (o.wantStatus ? { asked: true } : { asked: false, why: 'no-status' })
  if (!s.asked) return WHY[s.why] ?? `status: none (${s.why})`
  const ctx = `ci-broker/${job.mode}`
  const sha = o.commit ?? job.commit
  const t = job.statusTargets.find((x) => x.sha === sha && x.context === ctx)
  if (t?.error) return `status: ${ctx} on ${sha.slice(0, 12)} NOT posted: ${t.error}`
  if (t?.postedAt) return `status: ${ctx} ${t.state} posted on ${sha.slice(0, 12)}`
  if (job.state === 'cancelled') return `status: ${ctx} not posted (the job was cancelled)`
  return `status: ${ctx} on ${sha.slice(0, 12)} not posted`
}

export function formatReceipt(job: JobView, o: ReceiptOpts): string {
  const head = `================ ci-broker ${job.id}: ${job.repo} ${job.commit.slice(0, 12)}${job.source === 'snapshot' ? ' (snapshot)' : ''} ${job.profile}/${job.mode}${job.args.length ? ` -- ${job.args.join(' ')}` : ''} ================`
  const lines = [head]
  if (o.reused) lines.push(`reused job ${job.id} (same tree, profile and args already passed)`)
  lines.push(job.summary?.text ?? `RESULT: ${job.state.toUpperCase()}${job.error ? ` (${job.error})` : ''}`)
  // never the job dir: in split the client can't read it (the logs route and files.tar can)
  if (job.summary) lines.push(`job ${job.id}: ${job.state} in ${job.summary.secs}s; logs: ci-broker logs ${job.id}`)
  if (job.artifacts.length) lines.push(`artifacts: ${job.artifacts.join(', ')}${o.artifactsDir ? ` in ${o.artifactsDir}` : ' (copy them with --artifacts <dir>)'}`)
  lines.push(statusLine(job, o))
  return lines.join('\n') + '\n'
}
