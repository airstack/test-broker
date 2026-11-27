// `ci-broker check <resource> [<profile>] [--use-reserve]`: runs the profile's `check` shard on that resource (every
// declared profile when none is given) and streams it. Pass → clears `failing` (and the box's infra failures); fail →
// sets `failing`. Also reports free disk and, for ssh, passwordless sudo and RAM per slot. Boat: an idle running box
// first, else a stopped or new one only within the start budget; at the reserve the check is "not checked" (exit 3)
// and changes nothing, unless useReserve. GitHub: only that the workflow is on the default branch (a dispatch costs
// money). A check holds the capacity it uses like a shard (a slot row with job 0, a busy box).
import { existsSync, mkdirSync, readdirSync, statfsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { publicBoatEnv, publicBoatEnvs, serves, type ResourceCfg } from '../config.ts'
import type { BoxFilter } from '../../core/boatpool.ts'
import type { EnvClass, JobRow, Lane, ShardRow } from '../db.ts'
import type { Profile } from '../profile.ts'
import type { Ctx } from './ctx.ts'
import { REPORT_SCRIPT, parseReport } from './exec-ssh.ts'
import type { LocalExecutor } from './exec-local.ts'
import type { Executor, Outcome, Placement } from './resources.ts'
import { lineScrubber } from './scrub.ts'

export type CheckResult = {
  resource: string
  profile: string
  /** true pass, false fail, null not checked (nothing changed) */
  ok: boolean | null
  code: number | null
  message: string
  report: string | null
}
export type CheckEvent = { t: 'log'; resource: string; profile: string; data: string } | ({ t: 'result' } & CheckResult) | { t: 'done'; code: number }

/** 0 every check passed, 1 any failed, 3 none failed but some weren't checked. */
export const checkExit = (rs: CheckResult[]) => (rs.some((r) => r.ok === false) ? 1 : rs.some((r) => r.ok === null) ? 3 : 0)

const gb = (n: number) => `${Math.round(n * 10) / 10} GB`

export class Checks {
  private c: Ctx
  private executors: Partial<Record<string, Executor>>
  private local: LocalExecutor
  constructor(c: Ctx, executors: Partial<Record<string, Executor>>, local: LocalExecutor) {
    this.c = c
    this.executors = executors
    this.local = local
  }

  /** The profiles a resource declares ("*" = every profile in profilesDir). */
  private declared(r: ResourceCfg): string[] {
    if (!r.profiles.includes('*')) return r.profiles
    const dir = this.c.cfg.profilesDir
    return existsSync(dir) ? readdirSync(dir).filter((p) => existsSync(join(dir, p, 'profile.json'))).sort() : []
  }

  /** `lanes`: each profile's admission (the local door's); a profile without one is not checked. None given (tests,
   * internal callers): the full lane. */
  async run(resourceId: string, o: { profile?: string; useReserve?: boolean; lanes?: Map<string, { lane: Lane; env: EnvClass }> }, emit: (e: CheckEvent) => void, signal?: AbortSignal): Promise<number> {
    const r = this.c.resources.find((x) => x.id === resourceId)
    if (!r) throw new Error(`no resource ${resourceId}`)
    if (o.profile && !serves(r, o.profile)) throw new Error(`resource ${r.id} is not set up for profile ${o.profile} (profiles: ${r.profiles.join(', ')})`)
    const profiles = o.profile ? [o.profile] : this.declared(r)
    const results: CheckResult[] = []
    for (const p of profiles) {
      if (signal?.aborted) break
      const adm = o.lanes ? o.lanes.get(p) : { lane: 'full' as const, env: 'noenv' as const }
      const res = adm ? await this.one(r, p, !!o.useReserve, emit, signal, adm) : { resource: r.id, profile: p, ok: null, code: null, message: 'not checked: not admitted', report: null }
      results.push(res)
      emit({ t: 'result', ...res })
    }
    const code = checkExit(results)
    emit({ t: 'done', code })
    return code
  }

  private async one(r: ResourceCfg, profileName: string, useReserve: boolean, emit: (e: CheckEvent) => void, outer: AbortSignal | undefined, adm: { lane: Lane; env: EnvClass }): Promise<CheckResult> {
    const { c } = this
    const base = { resource: r.id, profile: profileName, report: null as string | null }
    let profile: Profile
    try {
      profile = c.profile(profileName)
    } catch {
      return { ...base, ok: null, code: null, message: `not checked: no profile ${profileName}` }
    }
    const logDir = join(c.cfg.stateDir, 'checks')
    mkdirSync(logDir, { recursive: true })
    const logFile = join(logDir, `${r.id}__${profileName}.log`)
    let text = ''
    const scr = lineScrubber(
      () => c.secrets,
      (lines) => {
        text += lines
        // runs inside child-process data listeners: never let a throw out
        try {
          emit({ t: 'log', resource: r.id, profile: profileName, data: lines })
        } catch (e) {
          c.log(`check ${r.id}/${profileName}: streaming output failed: ${(e as Error).message}`)
        }
      },
    )
    const say = (s: string) => scr.write(`ci-broker: ${s}\n`)
    const finish = (ok: boolean | null, code: number | null, message: string, report: string | null, box?: string | null): CheckResult => {
      message = c.scrub(message) // may carry gh/ssh/boat output; it is stored on the health row
      if (report) say(report)
      say(ok === null ? message : `check ${ok ? 'passed' : 'FAILED'}: ${message}`)
      scr.flush()
      if (ok !== null) {
        try {
          writeFileSync(logFile, text)
        } catch (e) {
          c.log(`check ${r.id}/${profileName}: writing ${logFile} failed: ${(e as Error).message}`)
        }
        const at = c.now()
        if (ok) {
          c.db.setHealth(r.id, profileName, { failing: false, reason: null, infraFails: 0, lastCheckAt: at, lastCheckOk: true, lastCheckLog: logFile })
          if (box) c.pool?.resetFails(box)
        } else c.db.setHealth(r.id, profileName, { failing: true, reason: `check failed: ${message}`, lastCheckAt: at, lastCheckOk: false, lastCheckLog: logFile })
        c.log(`check ${r.id}/${profileName}: ${ok ? 'pass' : `FAIL (${message})`}`)
        c.scheduler.wake()
      } else c.log(`check ${r.id}/${profileName}: ${message}`)
      return { ...base, ok, code, message, report }
    }

    if (r.kind === 'github') {
      if (!c.githubExec) return finish(null, null, 'not checked: no github executor', null)
      say(`checking that ${r.workflow} is on ${profile.repo}'s default branch`)
      const w = await c.githubExec.workflowExists(r.id, profile.repo)
      return finish(w.ok, w.ok ? 0 : 1, w.message, null)
    }
    if (!profile.check?.length) return finish(null, null, `not checked: profile ${profileName} has no check`, null)
    if (c.recovering) return finish(null, null, 'not checked: the daemon is still recovering from its restart', null)

    let head: { branch: string; sha: string }
    try {
      await c.mirror.ensure(profile.repo)
      head = await c.mirror.remoteHead(profile.repo)
    } catch (e) {
      return finish(null, null, `not checked: cannot read ${profile.repo} from origin: ${(e as Error).message}`, null)
    }

    // take capacity
    let placement: Placement
    let release: () => void
    if (r.kind === 'local') {
      if (c.db.slots().some((s) => s.resource === r.id)) return finish(null, null, 'not checked: the local slot is busy', null)
      const lock = await c.localLock()
      if (!lock) return finish(null, null, 'not checked: the local slot is busy', null)
      if (!c.db.takeSlot({ resource: r.id, slot: 0, jobId: 0, idx: 0, since: c.now() })) {
        await lock.release()
        return finish(null, null, 'not checked: the local slot is busy', null)
      }
      this.local.locks.set('0:0', lock)
      placement = { resource: r.id, kind: 'local', box: null, slot: 0, how: 'local', where: `local-${profile.local?.where ?? 'host'}` }
      release = () => c.db.freeSlot(r.id, 0)
    } else if (r.kind === 'ssh') {
      const taken = new Set(c.db.slots().filter((s) => s.resource === r.id).map((s) => s.slot))
      let slot = -1
      for (let i = 0; i < (r.slots ?? 1); i++) if (!taken.has(i) && c.db.takeSlot({ resource: r.id, slot: i, jobId: 0, idx: 0, since: c.now() })) {
        slot = i
        break
      }
      if (slot < 0) return finish(null, null, `not checked: all ${r.slots ?? 1} slot(s) of ${r.id} are busy`, null)
      placement = { resource: r.id, kind: 'ssh', box: null, slot, how: 'slot', where: `ssh:${r.id}/${slot}` }
      release = () => c.db.freeSlot(r.id, slot)
    } else {
      const pool = c.pool
      const trust = c.cfg.trust
      const pub = adm.lane === 'public'
      const env = pub ? publicBoatEnv(trust, profile.repo) : (r.environment ?? profile.boatEnvironment)
      if (!pool || pool.id !== r.id) return finish(null, null, 'not checked: no Boat pool', null)
      if (!env) return finish(null, null, pub ? `not checked: ${profile.repo} is public and root gave it no public environment (trust.repos.${profile.repo}.publicBoat)` : `not checked: no Boat environment for ${profileName}`, null)
      let only: BoxFilter | undefined
      if (pub) {
        const g = await pool.publicGate(env, profile.repo, { envs: publicBoatEnvs(trust), max: trust.publicBoatMaxBoxes })
        if ('none' in g) return finish(null, null, `not checked: ${g.none}`, null)
        only = g
      } else if (publicBoatEnvs(trust).has(env)) return finish(null, null, `not checked: ${env} is a public-lane environment: never a full-lane job`, null)
      const got = await pool.placeForCheck(env, profile.repo, useReserve, only)
      if ('none' in got) return finish(null, null, got.noBudget ? `not checked: no Boat budget (${got.none})${useReserve ? '' : '; --use-reserve spends the reserve'}` : `not checked: ${got.none}`, null)
      placement = { resource: r.id, kind: 'boat', box: got.box, slot: 0, how: got.how, where: `boat:${got.box} (${got.how})` }
      release = () => pool.release(got.box, profile.repo)
    }

    const ex = this.executors[r.kind]
    const ac = new AbortController()
    const onOuter = () => ac.abort()
    outer?.addEventListener('abort', onOuter, { once: true })
    const timer = setTimeout(() => ac.abort(), c.cfg.shardTimeoutSec * 1000)
    const jobDir = join(logDir, `${r.id}__${profileName}`)
    const now = c.now()
    const job: JobRow = {
      id: 0, key: 'check', repo: profile.repo, profile: profileName, profileHash: '-', mode: profile.check[0], args: profile.check.slice(1),
      commit: head.sha, tree: '-', source: 'pushed', base: null, label: 'check', state: 'running', pinned: true, placement: null, waitWhy: null,
      createdAt: now, startedAt: now, endedAt: null, summary: null, error: null, lane: adm.lane, env: adm.env, door: 'local', ghRun: null, profileDir: profile.dir,
    }
    const shard: ShardRow = {
      jobId: 0, idx: 0, name: 'check', size: '-', args: profile.check, state: 'running', attempt: 1, resource: r.id, box: placement.box, slot: placement.slot,
      where: placement.where, avoid: [], firstInfra: null, code: null, reason: null, queuedAt: now, startedAt: now, endedAt: null,
    }
    say(`check ${profileName} on ${placement.where}: ${profile.repo}@${head.branch} ${head.sha.slice(0, 12)}: ${profile.check.join(' ')}`)
    let out: Outcome
    try {
      if (!ex) throw new Error(`no executor for ${r.kind}`)
      out = await ex.run({ job, shard, profile, placement, jobDir, onData: (s) => scr.write(s), signal: ac.signal, why: () => (outer?.aborted ? 'cancel' : 'timeout'), addSecret: (v) => v && c.secrets.add(v) })
    } catch (e) {
      out = { code: null, infra: 'nostatus', reason: (e as Error).message }
    } finally {
      clearTimeout(timer)
      outer?.removeEventListener('abort', onOuter)
    }
    let report: string | null = null
    try {
      report = await this.report(r, placement, out)
    } catch (e) {
      report = `report failed: ${(e as Error).message}`
    }
    release()
    if (out.notStarted) {
      if (placement.box && placement.how === 'resumed') c.pool?.charge(placement.box, out.reason ?? 'resume failed')
      return finish(null, null, `not checked: ${out.reason ?? 'the resource did not start'}`, report)
    }
    if (ac.signal.aborted && outer?.aborted) return finish(null, null, 'not checked: the check was cancelled', report)
    const ok = out.code === 0
    const message = out.code === null ? `no exit status${out.reason ? ` (${out.reason})` : ''}` : `exit ${out.code}${ok ? '' : out.reason ? ` (${out.reason})` : ''}`
    return finish(ok, out.code, message, report, placement.box)
  }

  /** Free disk; for ssh also passwordless sudo and RAM per slot. */
  private async report(r: ResourceCfg, p: Placement, out: Outcome): Promise<string | null> {
    const { c } = this
    if (r.kind === 'local') {
      const s = statfsSync(c.cfg.stateDir)
      return `report: free disk ${gb((s.bavail * s.bsize) / 1024 ** 3)} (${c.cfg.stateDir})`
    }
    if (out.infra === 'unreachable' || out.notStarted) return null
    if (r.kind === 'ssh' && c.sshExec) {
      const x = await c.sshExec.report(r.id)
      if (x.code !== 0) return `report: ssh exit ${x.code}`
      const h = x.report
      return `report: free disk ${h.diskFreeGb ?? '?'} GB; sudo -n true: ${h.sudo === null ? '?' : h.sudo ? 'works' : 'NO (one-time installs need passwordless sudo)'}; RAM ${h.memGb ?? '?'} GB (${h.memPerSlotGb ?? '?'} GB per slot, ${r.slots ?? 1} slot(s)); ${h.nproc ?? '?'} cpus`
    }
    if (r.kind === 'boat' && p.box) {
      const id = c.db.box(p.box)?.boatId
      if (!id) return null
      const x = await c.boat.exec(id, REPORT_SCRIPT, { timeoutSec: c.cfg.boatCallTimeoutSec })
      const h = parseReport(x.out, 1)
      return `report: free disk ${h.diskFreeGb ?? '?'} GB on ${p.box}; RAM ${h.memGb ?? '?'} GB; ${h.nproc ?? '?'} cpus`
    }
    return null
  }
}
