// `ci-broker submit`: ask (dedupe first), bundle a snapshot if the daemon needs one, follow the job with an interest,
// print the receipt, exit 0 passed / 1 failed / 2 error / 130 cancelled / 77 refused by a trust check.
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { annotationLines, emptyArtifactsDir, failingGroups, failures, fillArtifactsDir, githubEnv, stepSummary, stopToken, writeStepSummary, type GithubEnv } from './github.ts'
import { ApiError, DaemonDown, EXIT_REFUSED, refusedAnnotation, refusedLine, TrustRefused, type Client } from './http.ts'
import { exitCode, formatReceipt, statusLine, type JobView, type ReceiptOpts, type StatusDecision } from './receipt.ts'
import { buildSnapshot, bundleStream, git, originRepo } from '../../core/snapshot.ts'

export type SubmitOpts = {
  repo?: string
  profile?: string
  mode: string
  sha?: string
  force?: boolean
  /** runner-job mode: stop-commands, failing-shard groups, annotations, step summary, artifacts dir (needs GITHUB_* env) */
  github?: boolean
  /** the env GitHub mode reads (default process.env) */
  env?: NodeJS.ProcessEnv
  noStatus?: boolean
  artifacts?: string
  label?: string
  detach?: boolean
  args: string[]
  cwd: string
  maxFileMb: number
  interestGraceSec: number
  out: (s: string) => void
  err: (s: string) => void
  /** fires like SIGINT/SIGTERM (tests); the CLI wires the real signals to it */
  signal?: AbortSignal
  /** wait between reconnects (tests pass 0) */
  reconnectMs?: number
  /** how long a signal waits for the job to reach `cancelled` (default 20 s) */
  leaveWaitMs?: number
  /** find the daemon again (the socket may move during the switch to split); default: keep the client */
  pick?: () => Promise<Client>
  /** wait between tries while the daemon drains for the switch (default 2 s; tests 0) */
  retryMs?: number
}

type Resp = { id: string; key: string; reused?: boolean; joined?: boolean; needBundle?: boolean; base?: string | null; interest?: string; status?: StatusDecision; note?: string }

/** What a submission came to: the job as it ended (null if it never got one) and the receipt's inputs. */
type Outcome = { code: number; job: JobView | null; receipt: ReceiptOpts; note?: string; files?: string | null; refused?: TrustRefused }

const isOwnerName = (s: string) => /^[\w.-]+\/[\w.-]+$/.test(s)
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((r) => {
  const t = setTimeout(r, ms)
  signal?.addEventListener('abort', () => (clearTimeout(t), r()), { once: true })
})

async function resolveTarget(o: SubmitOpts): Promise<{ repo: string; dir: string | null }> {
  if (o.repo && isOwnerName(o.repo) && !existsSync(resolve(o.cwd, o.repo))) {
    const here = await originRepo(o.cwd).catch(() => null)
    return { repo: o.repo, dir: here === o.repo ? o.cwd : null }
  }
  const dir = o.repo ? resolve(o.cwd, o.repo) : o.cwd
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`no such directory: ${dir}`)
  return { repo: await originRepo(dir), dir }
}

export async function submit(client: Client, o: SubmitOpts): Promise<number> {
  if (!o.github) return (await run({ client }, o)).code
  return submitGithub(client, o, githubEnv(o.env ?? process.env))
}

/**
 * The job's files where this client can read them: a `split` daemon's job dir is not ours to read, so its
 * `files.tar` is extracted into a temp dir (no owner or mode from the archive); a `single` daemon's dir is read as is.
 */
export async function jobFiles(client: Client, job: JobView, path = `/jobs/${job.id}/files.tar`): Promise<{ dir: string; temp: boolean }> {
  if (client.hello?.layout !== 'split') return { dir: job.dir, temp: false }
  const dir = mkdtempSync(join(tmpdir(), 'cib-files-'))
  await client.download(path, dir)
  return { dir, temp: true }
}

/** GitHub mode: everything test output can reach runs with workflow commands stopped; then groups, annotations, the
 * step summary and the artifacts dir. All of it goes to stdout so the runner sees it in order. */
async function submitGithub(client: Client, o: SubmitOpts, env: GithubEnv): Promise<number> {
  const out = o.out
  const artifactsDir = emptyArtifactsDir(env.workspace)
  const token = stopToken()
  out(`::stop-commands::${token}\n`)
  let r: Outcome
  try {
    r = await run({ client }, { ...o, err: out, label: o.label ?? env.runLabel ?? undefined, keepFiles: true } as SubmitOpts)
  } finally {
    out(`::${token}::\n`)
  }
  if (r.refused) {
    out(`${refusedAnnotation(r.refused)}\n`)
    return r.code
  }
  const job = r.job
  if (!job) return r.code
  // the files dir, or (an old single daemon) the job dir; none (the door's job dir is '', a failed fetch): read nothing
  const dir = r.files ?? (job.dir || null)
  if (!dir) {
    out('ci-broker: no job files here: groups, annotations and artifacts skipped (ci-broker logs on the daemon\'s machine)\n')
    try {
      writeStepSummary(env.summaryFile, stepSummary({ job, statusLine: statusLine(job, r.receipt), reused: !!r.receipt.reused, failures: [], runUrl: env.runUrl, note: r.note, dir: '/nonexistent' }))
    } catch {}
    return r.code
  }
  try {
    const fs = failures(job, dir)
    failingGroups(job, out, stopToken, dir)
    for (const l of annotationLines(fs)) out(`${l}\n`)
    try {
      writeStepSummary(env.summaryFile, stepSummary({ job, statusLine: statusLine(job, r.receipt), reused: !!r.receipt.reused, failures: fs, runUrl: env.runUrl, note: r.note, dir }))
    } catch (e) {
      out(`ci-broker: writing the step summary failed: ${(e as Error).message}\n`)
    }
    try {
      const n = fillArtifactsDir(dir, artifactsDir)
      if (n) out(`ci-broker: ${n} artifact entries and shard logs in ${artifactsDir}\n`)
    } catch (e) {
      out(`ci-broker: copying artifacts failed: ${(e as Error).message}\n`)
    }
  } finally {
    if (r.files && r.files !== job.dir) rmSync(r.files, { recursive: true, force: true })
  }
  return r.code
}

async function run(ref: { client: Client }, o: SubmitOpts & { keepFiles?: boolean }, resubmitted = false): Promise<Outcome> {
  const { repo, dir } = await resolveTarget(o)
  let commit: string
  let tree: string | null = null
  let headCandidates: string[] = []
  if (o.sha) {
    if (dir) {
      commit = (await git(dir, ['rev-parse', '--verify', `${o.sha}^{commit}`]).catch(() => '')).trim()
      if (commit) tree = (await git(dir, ['rev-parse', `${commit}^{tree}`])).trim()
      else if (/^[0-9a-f]{40}$/.test(o.sha)) commit = o.sha
      else throw new Error(`cannot resolve ${o.sha} in ${dir}`)
    } else if (/^[0-9a-f]{40}$/.test(o.sha)) commit = o.sha
    else throw new Error('--sha must be a full sha when there is no checkout of the repo here')
  } else {
    if (!dir) throw new Error(`no checkout of ${repo} here: run inside one, pass --repo <path>, or pass --sha`)
    const s = await buildSnapshot(dir, { maxFileMb: o.maxFileMb })
    commit = s.commit
    tree = s.tree
    headCandidates = s.headCandidates
    if (s.dirty) o.err(`ci-broker: snapshot of the working tree: ${commit.slice(0, 12)} (on ${s.head.slice(0, 12)})\n`)
  }
  const wantStatus = !o.noStatus
  const receipt0: ReceiptOpts = { args: o.args, wantStatus, commit }
  const leave = (note: string): Outcome => {
    o.err(`\nci-broker: ${note}\n`)
    return { code: 130, job: null, receipt: receipt0, note }
  }
  if (o.signal?.aborted) return leave('left before submitting')
  let r: Resp
  const body = {
    repo, profile: o.profile, mode: o.mode, args: o.args, commit, tree, headCandidates, source: o.github ? 'github' : 'local',
    label: o.label, detach: !!o.detach, wantStatus, force: !!o.force,
  }
  try {
    r = await postWaiting(ref, body, o)
  } catch (e) {
    if (e instanceof TrustRefused) {
      o.err(`${refusedLine(e)}\n`)
      return { code: EXIT_REFUSED, job: null, receipt: receipt0, refused: e }
    }
    if (!o.signal?.aborted) throw e
    // a job the daemon may still create has an interest nobody attaches: it lapses after the grace (unless detached)
    return leave(`left before the daemon answered${o.detach ? '' : `; a job it starts now is cancelled after ${o.interestGraceSec}s with nobody waiting`}`)
  }
  if (r.note) o.err(`ci-broker: ${r.note}\n`)
  const receipt: ReceiptOpts = { ...receipt0, ...(r.status ? { status: r.status } : {}) }
  const client = () => ref.client
  if (r.reused) {
    const job = await client().request<JobView>('GET', `/jobs/${r.id}`)
    receipt.reused = true
    return finish(ref, o, job, receipt)
  }
  o.err(`ci-broker: job ${r.id}${r.joined ? ' (joined: the same run was already going)' : ''}\n`)
  if (r.needBundle) {
    if (!dir) throw new Error('the daemon needs a bundle but there is no checkout here')
    o.err(`ci-broker: sending the snapshot (base ${r.base?.slice(0, 12) ?? 'none: full bundle'})\n`)
    let b: Awaited<ReturnType<typeof bundleStream>> | null = null
    try {
      if (o.signal?.aborted) throw new Error('aborted')
      b = await bundleStream(dir, commit, r.base ?? null, o.signal)
      await Promise.all([client().upload(`/jobs/${r.id}/bundle`, b.stream, o.signal), b.done])
    } catch (e) {
      if (!o.signal?.aborted) throw e
      await b?.done.catch(() => {}) // git stopped and the temp ref deleted
      // without its bundle the job can't run: withdraw our interest (the daemon cancels it when it was the only one);
      // a detached job has none, and nobody else can send its bundle: cancel it
      if (r.interest) await client().request('DELETE', `/jobs/${r.id}/interest/${r.interest}`).catch(() => {})
      else if (o.detach) await client().request('POST', `/jobs/${r.id}/cancel`).catch(() => {})
      return leave(`left job ${r.id} during the snapshot upload`)
    }
  }
  if (o.detach) {
    o.out(`ci-broker: job ${r.id} runs detached. Follow it: ci-broker logs ${r.id} -f\n`)
    return { code: 0, job: null, receipt }
  }
  let state: 'done' | 'gave-up'
  try {
    state = await follow(ref, r.id, r.interest ?? null, o)
  } catch (e) {
    // the daemon changed under us (the switch to split): it doesn't know the job; submit once more
    if (e instanceof ApiError && e.status === 404 && !resubmitted) {
      o.err(`ci-broker: the daemon no longer knows job ${r.id} (it changed); submitting again\n`)
      return run(ref, o, true)
    }
    throw e
  }
  const job = await client().request<JobView>('GET', `/jobs/${r.id}`)
  if (state === 'gave-up') {
    const note = `left job ${r.id} while it was ${job.state} (it did not reach cancelled in time)`
    o.out(`ci-broker: ${note}\n`)
    return { code: 130, job, receipt, note }
  }
  return finish(ref, o, job, receipt)
}

/** The receipt, the artifacts (`--artifacts`), and for GitHub mode the readable files dir. */
async function finish(ref: { client: Client }, o: SubmitOpts & { keepFiles?: boolean }, job: JobView, receipt: ReceiptOpts): Promise<Outcome> {
  let files: string | null = null
  let temp = false
  if (o.artifacts || o.keepFiles) {
    try {
      const f = await jobFiles(ref.client, job)
      files = f.dir
      temp = f.temp
    } catch (e) {
      o.err(`ci-broker: fetching the job's files failed: ${(e as Error).message}\n`)
    }
  }
  let dest: string | null = null
  if (o.artifacts && files && job.artifacts.length) {
    dest = resolve(o.cwd, o.artifacts)
    mkdirSync(dest, { recursive: true })
    if (existsSync(join(files, 'artifacts'))) cpSync(join(files, 'artifacts'), dest, { recursive: true })
  }
  o.out(formatReceipt(job, { ...receipt, artifactsDir: dest }))
  if (dest) o.err(`ci-broker: artifacts copied to ${dest}\n`)
  if (temp && files && !o.keepFiles) rmSync(files, { recursive: true, force: true })
  return { code: exitCode(job.state), job, receipt, files: o.keepFiles ? files : null }
}

/** POST /jobs; a daemon draining for the switch (503) is waited out, as long as it lasts, following the socket. */
async function postWaiting(ref: { client: Client }, body: unknown, o: SubmitOpts): Promise<Resp> {
  let waiting = false
  for (;;) {
    try {
      return await ref.client.request<Resp>('POST', '/jobs', body, o.signal)
    } catch (e) {
      const drain = e instanceof ApiError && e.status === 503 && /draining for switch/.test(e.message)
      if (!drain && !(waiting && e instanceof DaemonDown)) throw e
      if (o.signal?.aborted) throw e
      if (!waiting) o.err('ci-broker: the daemon is draining for the switch to the split layout; waiting until the new one answers\n')
      waiting = true
      await sleep(o.retryMs ?? 2000, o.signal)
      if (o.pick) ref.client = await o.pick().catch(() => ref.client)
    }
  }
}

/** Print the job's output until `done`. Reconnects with the interest token within the grace; a signal withdraws the
 * interest and waits ≤ 20 s for the job to end. */
async function follow(ref: { client: Client }, id: string, token: string | null, o: SubmitOpts): Promise<'done' | 'gave-up'> {
  let from = 0
  let done = false
  let stopping = false
  let deadline = 0
  let withdrawn: Promise<unknown> = Promise.resolve()
  const ac = new AbortController()
  const onEvent = (e: any) => {
    if (typeof e.seq === 'number') from = e.seq
    if (e.t === 'log') o.out(e.data.replace(/^(?=.)/gm, `[${e.shard}] `))
    else if (e.t === 'state' && e.shard && e.state !== 'running') o.err(`ci-broker: ${e.shard} ${e.state}${e.message ? `: ${e.message}` : ''}\n`)
    else if (e.t === 'state' && !e.shard && e.state === 'cancelling') o.err(`ci-broker: job cancelling${e.message ? `: ${e.message}` : ''}\n`)
    else if (e.t === 'done') done = true
  }
  const stop = () => {
    if (stopping) return
    stopping = true
    const wait = o.leaveWaitMs ?? 20_000
    deadline = Date.now() + wait
    o.err(`\nci-broker: leaving job ${id}\n`)
    if (token) withdrawn = ref.client.request('DELETE', `/jobs/${id}/interest/${token}`).catch(() => {})
    setTimeout(() => ac.abort(), wait).unref()
  }
  if (o.signal?.aborted) stop()
  o.signal?.addEventListener('abort', stop, { once: true })
  let droppedAt = 0
  let saidDown = false
  while (!done) {
    await ref.client
      .stream(`/jobs/${id}/events?follow=1&from=${from}&interest=${stopping || !token ? 0 : token}`, (e) => ((droppedAt = 0), (saidDown = false), onEvent(e)), ac.signal)
      .catch((e) => {
        if (stopping) return { ended: false }
        // the daemon restarting (socket gone, refused, reset) is a drop like any other: reconnect within the grace
        if (e instanceof DaemonDown || ['ECONNRESET', 'EPIPE', 'ECONNREFUSED', 'ENOENT'].includes((e as NodeJS.ErrnoException).code ?? '')) {
          if (!saidDown) o.err(`ci-broker: the daemon is not answering (restarting?); reconnecting to job ${id} for up to ${o.interestGraceSec}s\n`)
          saidDown = true
          return { ended: false }
        }
        throw e
      })
    if (done) break
    if (stopping && (ac.signal.aborted || Date.now() > deadline)) {
      await withdrawn
      return 'gave-up'
    }
    droppedAt ||= Date.now()
    if (Date.now() - droppedAt > o.interestGraceSec * 1000) throw new Error(`lost the daemon for over ${o.interestGraceSec}s; the job may have been cancelled`)
    await new Promise((r) => setTimeout(r, o.reconnectMs ?? 1000))
    if (o.pick) ref.client = await o.pick().catch(() => ref.client)
  }
  return 'done'
}
