// Runs placed shards: one background task per shard, output through the line scrubber into <shard>.log, the job's
// stream.ndjson and every follower. Cancel and timeout abort the task; the executor kills what runs remotely.
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ResourceKind } from '../config.ts'
import type { Ctx } from './ctx.ts'
import type { AbortWhy, Executor, Outcome, Placement } from './resources.ts'
import { lineScrubber } from './scrub.ts'

type Running = { ac: AbortController; why: AbortWhy | null; jobId: number; idx: number }

export class ShardRunner {
  private running = new Map<string, Running>()
  private c: Ctx
  private executors: Partial<Record<ResourceKind, Executor>>
  constructor(c: Ctx, executors: Partial<Record<ResourceKind, Executor>>) {
    this.c = c
    this.executors = executors
  }

  count(): number {
    return this.running.size
  }
  isRunning(jobId: number, idx: number) {
    return this.running.has(`${jobId}:${idx}`)
  }

  /** The shard row is already `running` with its placement; this runs it in the background. */
  start(jobId: number, idx: number, p: Placement) {
    const key = `${jobId}:${idx}`
    const r: Running = { ac: new AbortController(), why: null, jobId, idx }
    this.running.set(key, r)
    this.c.track(this.runOne(r, p))
  }

  private async runOne(r: Running, p: Placement) {
    const { c } = this
    const job = c.db.job(r.jobId)!
    const shard = c.db.shard(r.jobId, r.idx)!
    const jobDir = c.streams.dir(job.id)
    const logFile = join(jobDir, `${shard.name}.log`)
    let logFailed = false
    const scr = lineScrubber(
      () => c.secrets,
      (lines) => {
        // runs inside child-process data listeners: a throw here (disk full) would kill the daemon
        try {
          mkdirSync(jobDir, { recursive: true })
          appendFileSync(logFile, lines)
        } catch (e) {
          if (!logFailed) c.log(`${c.jobName(job.id)}/${shard.name}: writing ${logFile} failed (output is still streamed): ${(e as Error).message}`)
          logFailed = true
        }
        c.streams.append(job.id, { t: 'log', shard: shard.name, data: lines })
      },
    )
    let out: Outcome
    try {
      scr.write(`ci-broker: ${shard.name} attempt ${shard.attempt} on ${p.where}\n`)
      const ex = this.executors[p.kind]
      if (!ex) throw new Error(`no executor for resource kind ${p.kind}`)
      out = await ex.run({
        job, shard, placement: p, jobDir, profile: c.jobProfile(job),
        onData: (s) => scr.write(s), signal: r.ac.signal, why: () => r.why, addSecret: (v) => v && c.secrets.add(v),
      })
    } catch (e) {
      out = { code: null, infra: 'nostatus', reason: (e as Error).message }
    }
    if (out.reason && out.code === null) scr.write(`ci-broker: ${shard.name}: ${out.reason}\n`)
    scr.flush()
    this.running.delete(`${r.jobId}:${r.idx}`)
    c.jobs.shardEnded(r.jobId, r.idx, p, out, r.why)
  }

  /** Abort running shards of a job (all, or one). The first reason given wins. */
  abort(jobId: number, why: AbortWhy, idx?: number) {
    for (const r of this.running.values()) {
      if (r.jobId !== jobId || (idx !== undefined && r.idx !== idx)) continue
      r.why ??= why
      r.ac.abort()
    }
  }
}
