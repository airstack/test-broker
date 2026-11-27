// Daemon start: the socket is already open; this puts the state left by the previous process right.
// 1. Running shards → re-queued as their next attempt (attempt 2 → error). Their jobs wait (held) until pinned or an
//    interest comes back within interestGraceSec of boot; the interest sweep cancels the rest.
// 2. Busy boxes → kill the slot-0 process group, then idle (lastUsed = now). Busy ssh slots → kill that slot's process
//    group. Slot rows are cleared only once every kill and the worktree sweep are done. The scheduler places nothing
//    while this runs (Ctx.recovering) and is woken at the end.
// 3. Containers labelled with this daemonId → removed; worktrees under the work root → removed.
// 4. GitHub runs still in flight → cancelled: after step 1 no job has a running shard (a re-queued one dispatches anew).
// 5. Terminal jobs whose stream has no `done` (a crash after the state update, or while statuses were being posted)
//    → statuses posted if pending, then `done` appended.
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { killCommand } from '../../core/boat-commands.ts'
import { removeTree } from './exec-local.ts'
import type { Ctx } from './ctx.ts'

export async function recover(c: Ctx): Promise<void> {
  const now = c.now()
  c.db.disconnectAllInterests(now)
  const sshSlots = c.db.slots().filter((s) => c.resources.find((r) => r.id === s.resource)?.kind === 'ssh')
  for (const job of c.db.jobsInStates(['waiting-bundle'])) c.jobs.fail(job.id, 'the daemon restarted before the snapshot bundle arrived')
  for (const s of c.db.shardsInState('running')) {
    const job = c.db.job(s.jobId)
    if (job?.state === 'cancelling') {
      c.db.updateShard(s.jobId, s.idx, { state: 'cancelled', reason: 'cancelled (daemon restarted)', endedAt: now })
      continue
    }
    if (s.attempt >= 2) {
      c.db.updateShard(s.jobId, s.idx, { state: 'error', reason: 'daemon restarted', endedAt: now })
      c.jobs.event(s.jobId, s.name, 'error', 'daemon restarted during attempt 2')
    } else {
      c.db.updateShard(s.jobId, s.idx, { state: 'queued', attempt: s.attempt + 1, queuedAt: now, startedAt: null, resource: null, box: null, slot: null, where: null, reason: 'daemon restarted' })
      c.jobs.event(s.jobId, s.name, 'requeue', `daemon restarted: attempt ${s.attempt + 1}`)
    }
  }
  for (const job of c.db.jobsInStates(['queued', 'running', 'cancelling'])) {
    if (job.state !== 'cancelling' && !job.pinned) c.held.add(job.id)
    c.jobs.maybeFinish(job.id)
  }
  // every terminal job's stream ends with `done` (posting its statuses first if they never went out)
  for (const job of c.db.jobsInStates(['passed', 'failed', 'error', 'cancelled'])) c.jobs.ensureDone(job.id)

  const kills: Promise<unknown>[] = []
  for (const b of c.pool?.boxes() ?? []) {
    if (b.state !== 'busy') continue
    kills.push(
      (b.boatId ? c.boat.exec(b.boatId, killCommand(0), { timeoutSec: c.cfg.boatCallTimeoutSec }).catch(() => {}) : Promise.resolve()).then(() =>
        // lastUsed = now: an old lastUsed would have the next sweep stop the box at once (a start wasted on resume)
        c.cfg.infraFailLimit > 0 && b.infraFails >= c.cfg.infraFailLimit
          ? c.pool!.quarantine(b.name, 'infra failures (deferred quarantine, applied after restart)')
          : c.pool!.setState(b.name, 'idle', { reason: 'daemon restarted', lastUsed: c.now() }),
      ),
    )
  }
  for (const s of sshSlots) {
    if (!c.sshExec) break
    kills.push(
      c.sshExec.killSlot(s.resource, s.slot).then(
        (code) => c.log(`recovery: ssh ${s.resource} slot ${s.slot}: killed leftovers${code === 0 ? '' : ` (ssh exit ${code})`}`),
        (e) => c.log(`recovery: ssh ${s.resource} slot ${s.slot}: kill failed: ${(e as Error).message}`),
      ),
    )
  }
  for (const g of c.db.ghRunsInFlight()) {
    const gh = c.githubExec
    if (!gh) break
    kills.push(
      (async () => {
        const runId = g.runId ?? (await gh.find(g.repo, g.workflow, g.token))?.databaseId ?? null
        const ok = runId !== null && (await gh.cancel(g.repo, runId))
        c.db.updateGhRun(g.token, { state: 'cancelled', endedAt: c.now(), ...(runId !== null ? { runId } : {}) })
        c.log(`recovery: github run ${g.token}${runId !== null ? ` (${runId})` : ''}: ${ok ? 'cancelled' : runId === null ? 'not found; marked cancelled' : 'cancel failed'}`)
      })().catch((e) => c.log(`recovery: github run ${g.token}: ${(e as Error).message}`)),
    )
  }

  try {
    await sweepLocal(c)
  } catch (e) {
    c.log(`recovery: local sweep failed: ${(e as Error).message}`)
  } finally {
    await Promise.allSettled(kills)
    // slots are free only now, after their leftovers are killed and the worktrees swept; also when the sweep threw
    c.db.clearSlots()
    c.log(`recovery: done (${c.held.size} job(s) waiting for their clients)`)
    c.scheduler.wake()
  }
}

async function sweepLocal(c: Ctx) {
  const ps = await c.sys('docker', ['ps', '-aq', '--filter', `label=ci-broker.daemon=${c.cfg.daemonId}`], 30)
  const ids = ps.code === 0 ? ps.stdout.split('\n').filter(Boolean) : []
  if (ids.length) {
    await c.sys('docker', ['rm', '-f', ...ids], 60)
    c.log(`recovery: removed ${ids.length} container(s)`)
  }
  const work = c.mirror.workRoot
  if (existsSync(work)) {
    for (const d of readdirSync(work, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.endsWith('.git')) continue
      // .probe-* / .bundle-* scratch dirs belong to in-flight submits (accepted during recovery) or a dead process
      if (d.name.startsWith('.')) continue
      // a run's clone left by the previous process: chmod -R u+rwX + rm -rf, never git in it
      for (const w of readdirSync(join(work, d.name))) await removeTree(join(work, d.name, w))
    }
  }
}
