// A whole mode on GitHub-hosted CI: `gh workflow run <workflow> --ref <default branch> -f sha -f mode -f args -f job`,
// find the run by its run-name (`ci-broker <token> …`, token = `<daemonId>-<job>[.<attempt>]`), poll it, then
// `gh run view --log` into the shard log and `gh run download` into artifacts. Cancel → `gh run cancel`. Opt-in,
// pushed jobs only, last in the resource order: it costs money and needs the consumer's workflow on the default branch.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Config, ResourceCfg } from '../config.ts'
import type { Db } from '../db.ts'
import type { Ctx } from './ctx.ts'
import type { Executor, Outcome, RunCtx } from './resources.ts'

type Gh = Ctx['gh']
type RunInfo = { databaseId: number; displayTitle: string; status: string; conclusion: string; url?: string }

/** The token in a dispatch's run-name; attempt 1 is the bare job name. */
export const runToken = (jobName: string, attempt: number) => (attempt > 1 ? `${jobName}.${attempt}` : jobName)

/** The token a run-name carries (`ci-broker <token> …`), or null. */
export const tokenOf = (title: string) => /(?:^|\s)ci-broker\s+(\S+)/.exec(title)?.[1] ?? null

/** success → 0, failure → 1; anything else (cancelled, timed out, startup failure …) has no test result. */
export function conclusionCode(c: string): number | null {
  if (c === 'success') return 0
  if (c === 'failure') return 1
  return null
}

const firstLines = (s: string) => s.trim().split('\n').filter(Boolean).slice(0, 3).join('; ')

export type GithubDeps = {
  cfg: Config
  db: Db
  resources: ResourceCfg[]
  gh: Gh
  now: () => number
  jobName: (id: number) => string
  /** waits between polls (tests make it immediate) */
  wait?: (ms: number, signal: AbortSignal) => Promise<void>
}

const realWait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const t = setTimeout(done, ms)
    function done() {
      clearTimeout(t)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })

export class GithubExecutor implements Executor {
  private branches = new Map<string, string>()
  private d: GithubDeps
  private wait: (ms: number, signal: AbortSignal) => Promise<void>
  constructor(d: GithubDeps) {
    this.d = d
    this.wait = d.wait ?? realWait
  }

  private res(id: string): ResourceCfg {
    const r = this.d.resources.find((x) => x.id === id && x.kind === 'github')
    if (!r) throw new Error(`no github resource ${id}`)
    return r
  }

  /** The repo's default branch (cached). Throws when gh can't say. */
  async defaultBranch(repo: string): Promise<string> {
    const had = this.branches.get(repo)
    if (had) return had
    const r = await this.d.gh(['repo', 'view', repo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'], 30)
    const b = r.stdout.trim()
    if (r.code !== 0 || !b) throw new Error(`gh repo view ${repo}: ${firstLines(r.stderr || r.stdout) || `exit ${r.code}`}`)
    this.branches.set(repo, b)
    return b
  }

  /** The workflow file exists on the default branch (`gh workflow view --yaml --ref`). Dispatching would cost money. */
  async workflowExists(resourceId: string, repo: string): Promise<{ ok: boolean; message: string }> {
    const r = this.res(resourceId)
    let branch: string
    try {
      branch = await this.defaultBranch(repo)
    } catch (e) {
      return { ok: false, message: (e as Error).message }
    }
    const v = await this.d.gh(['workflow', 'view', r.workflow!, '--repo', repo, '--ref', branch, '--yaml'], 30)
    if (v.code !== 0) return { ok: false, message: `workflow ${r.workflow} not found on ${repo}@${branch}: ${firstLines(v.stderr || v.stdout)}` }
    if (!/workflow_dispatch/.test(v.stdout)) return { ok: false, message: `workflow ${r.workflow} on ${repo}@${branch} has no workflow_dispatch trigger` }
    const missing = ['sha', 'mode', 'args', 'job'].filter((i) => !new RegExp(`^\\s+${i}:`, 'm').test(v.stdout))
    if (missing.length) return { ok: false, message: `workflow ${r.workflow} on ${repo}@${branch} lacks the inputs ${missing.join(', ')}` }
    return { ok: true, message: `workflow ${r.workflow} is on ${repo}@${branch} with workflow_dispatch (sha, mode, args, job)` }
  }

  private async list(repo: string, workflow: string): Promise<RunInfo[] | null> {
    const r = await this.d.gh(['run', 'list', '--repo', repo, '--workflow', workflow, '--event', 'workflow_dispatch', '--limit', '50', '--json', 'databaseId,displayTitle,status,conclusion,url'], 30)
    if (r.code !== 0) return null
    try {
      return JSON.parse(r.stdout) as RunInfo[]
    } catch {
      return null
    }
  }

  /** Look the run up by its token once. */
  async find(repo: string, workflow: string, token: string): Promise<RunInfo | null> {
    return (await this.list(repo, workflow))?.find((x) => tokenOf(x.displayTitle) === token) ?? null
  }

  async cancel(repo: string, runId: number): Promise<boolean> {
    return (await this.d.gh(['run', 'cancel', String(runId), '--repo', repo], 30)).code === 0
  }

  async run(ctx: RunCtx): Promise<Outcome> {
    const { job, shard } = ctx
    const r = this.res(ctx.placement.resource)
    const workflow = r.workflow!
    const token = runToken(this.d.jobName(job.id), shard.attempt)
    const say = (s: string) => ctx.onData(`ci-broker: ${s}\n`)
    let branch: string
    try {
      branch = await this.defaultBranch(job.repo)
    } catch (e) {
      return { code: null, infra: 'unreachable', reason: (e as Error).message }
    }
    if (ctx.signal.aborted) return { code: null, reason: ctx.why() ?? 'cancel' }
    const disp = await this.d.gh(
      ['workflow', 'run', workflow, '--repo', job.repo, '--ref', branch, '-f', `sha=${job.commit}`, '-f', `mode=${job.mode}`, '-f', `args=${JSON.stringify(job.args)}`, '-f', `job=${token}`],
      60,
    )
    if (disp.code !== 0) return { code: null, infra: 'unreachable', reason: `gh workflow run ${workflow}: ${firstLines(disp.stderr || disp.stdout) || `exit ${disp.code}`}` }
    const t0 = this.d.now()
    this.d.db.insertGhRun({ token, resource: r.id, repo: job.repo, workflow, jobId: job.id, idx: shard.idx, attempt: shard.attempt, dispatchedAt: t0 })
    say(`dispatched ${workflow} on ${job.repo}@${branch} (run-name token ${token})`)
    const pollMs = this.d.cfg.githubPollSec * 1000
    let run: RunInfo | null = null
    const cancelRun = async (): Promise<Outcome> => {
      run ??= await this.find(job.repo, workflow, token)
      if (run) {
        const ok = await this.cancel(job.repo, run.databaseId)
        say(`${ok ? 'cancelled' : 'could not cancel'} run ${run.databaseId}`)
      }
      this.d.db.updateGhRun(token, { state: 'cancelled', endedAt: this.d.now(), ...(run ? { runId: run.databaseId } : {}) })
      return { code: null, reason: ctx.why() ?? 'cancel' }
    }
    // find it
    while (!run) {
      if (ctx.signal.aborted) return cancelRun()
      run = await this.find(job.repo, workflow, token)
      if (run) break
      if (this.d.now() - t0 > this.d.cfg.githubFindSec * 1000) {
        this.d.db.updateGhRun(token, { state: 'done', conclusion: 'not-found', endedAt: this.d.now() })
        return { code: null, infra: 'unreachable', reason: `no run named "ci-broker ${token}" within ${this.d.cfg.githubFindSec}s of the dispatch (is the workflow's run-name right?)` }
      }
      await this.wait(pollMs, ctx.signal)
    }
    this.d.db.updateGhRun(token, { runId: run.databaseId, url: run.url ?? null, state: 'running' })
    say(`run ${run.databaseId}${run.url ? ` ${run.url}` : ''}`)
    // poll it
    let status = run.status
    let conclusion = run.conclusion
    let lastStatus = ''
    while (status !== 'completed') {
      if (ctx.signal.aborted) return cancelRun()
      await this.wait(pollMs, ctx.signal)
      if (ctx.signal.aborted) return cancelRun()
      const v = await this.d.gh(['run', 'view', String(run.databaseId), '--repo', job.repo, '--json', 'status,conclusion'], 30)
      if (v.code !== 0) continue // a blip; the next poll tries again
      try {
        const x = JSON.parse(v.stdout) as { status: string; conclusion: string }
        status = x.status
        conclusion = x.conclusion
      } catch {
        continue
      }
      if (status !== lastStatus) say(`run ${run.databaseId}: ${status}`)
      lastStatus = status
    }
    this.d.db.updateGhRun(token, { state: 'done', conclusion, endedAt: this.d.now() })
    const log = await this.d.gh(['run', 'view', String(run.databaseId), '--repo', job.repo, '--log'], 300)
    if (log.code === 0) ctx.onData(log.stdout.endsWith('\n') || !log.stdout ? log.stdout : `${log.stdout}\n`)
    else say(`gh run view --log failed: ${firstLines(log.stderr || log.stdout)}`)
    const dest = join(ctx.jobDir, 'artifacts', shard.name)
    mkdirSync(dest, { recursive: true })
    const dl = await this.d.gh(['run', 'download', String(run.databaseId), '--repo', job.repo, '--dir', dest], 600)
    if (dl.code !== 0 && !/no (valid )?artifacts/i.test(dl.stderr + dl.stdout)) say(`artifacts: gh run download failed: ${firstLines(dl.stderr || dl.stdout)}`)
    say(`run ${run.databaseId} ${conclusion}`)
    const code = conclusionCode(conclusion)
    if (code === null) return { code: null, reason: `GitHub run ${conclusion || 'ended with no conclusion'}` }
    return { code }
  }
}
