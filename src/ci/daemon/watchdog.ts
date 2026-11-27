// The watchdog: every watchSec (and once after recovery) it asks GitHub about every repo we serve (every profile's
// repo, every repo with runners, every repo with an active job; the answers refresh the tier cache). A repo with
// runners or full-lane jobs that stopped qualifying (public, no push, gone, renamed, no profile) is BLOCKED: its
// GitHub-door and full-lane jobs fail, and the banner gives the operator the command that stops its runners (the
// daemon has no sudo). An API error never blocks (it records a watch error). It also re-checks the GitHub door's
// dir and socket, and probes the public network with a container (what must be blocked is, DNS and GitHub work).
// A tick and `trust unblock` share one mutex.
import { existsSync, lstatSync, readdirSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { dirname } from 'node:path'
import { ACTIVE_JOB_STATES } from '../db.ts'
import { lookupId } from '../install-conf.ts'
import type { Ctx } from './ctx.ts'
import { readRunners } from './daemon.ts'
import { ApiFail } from './github-api.ts'
import { HttpError } from './jobs.ts'
import { dirProblem } from './server.ts'

/** The probe image, pinned by digest (busybox 1.37.0). */
export const PROBE_IMAGE = 'busybox@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec'
/** The private ranges' first hosts (a probe can only show these reachable, never falsely blocked). */
export const PRIVATE_PROBES = ['10.0.0.1', '172.16.0.1', '192.168.0.1', '169.254.169.254', '100.64.0.1']

const hhmm = (t: number) => new Date(t).toTimeString().slice(0, 5)

/**
 * The probe script (busybox sh): a target is blocked when a TCP connect gets no answer within 3 s (our rules DROP);
 * an answer, even a refusal, means it is reachable. Then a DNS lookup and a TCP connect to api.github.com:443.
 */
export function probeScript(targets: string[]): string {
  return [
    't() { s=$(date +%s); if nc -z -w 3 "$1" "$2" 2>/dev/null; then echo "reached $1:$2 (open)"; else e=$(date +%s); if [ $((e - s)) -ge 2 ]; then echo "blocked $1:$2"; else echo "reached $1:$2 (refused)"; fi; fi; }',
    ...targets.map((x) => `t ${x} 22`),
    'nslookup api.github.com >/dev/null 2>&1 && echo "dns ok" || echo "dns fail"',
    'nc -z -w 5 api.github.com 443 2>/dev/null && echo "github ok" || echo "github fail"',
  ].join('\n')
}

/** The probe's verdict from its output. */
export function probeVerdict(out: string): { ok: boolean; why: string } {
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean)
  const reached = lines.filter((l) => l.startsWith('reached '))
  if (reached.length) return { ok: false, why: `${reached.map((l) => l.slice(8)).join(', ')} reachable from the public network` }
  if (!lines.includes('dns ok')) return { ok: false, why: 'DNS does not work on the public network' }
  if (!lines.includes('github ok')) return { ok: false, why: 'api.github.com:443 is not reachable from the public network' }
  if (!lines.some((l) => l.startsWith('blocked '))) return { ok: false, why: 'the probe printed nothing it checked' }
  return { ok: true, why: `${lines.filter((l) => l.startsWith('blocked ')).length} targets blocked, DNS and GitHub work` }
}

export class Watchdog {
  private c: Ctx
  private tail: Promise<unknown> = Promise.resolve()
  constructor(c: Ctx) {
    this.c = c
  }

  /** Run fn with the watchdog to itself (a tick and an unblock never interleave). */
  locked<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn)
    this.tail = next.catch(() => {})
    return next
  }

  /** The repos to watch: every profile's repo, every repo with runners, every repo with an active job. */
  repos(): { repo: string; profile: boolean }[] {
    const c = this.c
    const out = new Map<string, { repo: string; profile: boolean }>()
    const dir = c.cfg.profilesDir
    for (const n of existsSync(dir) ? readdirSync(dir).filter((x) => !x.startsWith('.')) : []) {
      try {
        const p = c.profile(n)
        out.set(p.repo.toLowerCase(), { repo: p.repo, profile: true })
      } catch {}
    }
    for (const r of readRunners(c.cfg.runnersJson)) if (!out.has(r.repo.toLowerCase())) out.set(r.repo.toLowerCase(), { repo: r.repo, profile: false })
    for (const j of c.db.jobsInStates(ACTIVE_JOB_STATES)) if (!out.has(j.repo.toLowerCase())) out.set(j.repo.toLowerCase(), { repo: j.repo, profile: false })
    return [...out.values()]
  }

  tick(): Promise<void> {
    return this.locked(async () => {
      const c = this.c
      for (const { repo, profile } of this.repos()) {
        let t
        try {
          t = await c.trust.liveTier(repo)
        } catch (e) {
          if (!(e instanceof ApiFail)) {
            c.log(`watchdog: ${repo}: ${(e as Error).message}`)
            continue
          }
          const prev = c.tdb.watchErrors().find((w) => w.repo === repo.toLowerCase())
          c.tdb.setWatchError(repo, prev?.since ?? c.now(), e.message)
          continue
        }
        c.tdb.clearWatchError(repo)
        if (t.tier === 'private' && profile) continue
        const runners = readRunners(c.cfg.runnersJson).filter((r) => r.repo.toLowerCase() === repo.toLowerCase())
        const jobs = c.db.jobsInStates(ACTIVE_JOB_STATES).filter((j) => j.repo.toLowerCase() === repo.toLowerCase() && (j.lane === 'full' || j.door === 'github'))
        if (!runners.length && !jobs.length) continue
        const what = !profile ? 'no profile here' : t.tier === 'public' ? 'public' : t.why
        const reason = `tier private → ${t.tier === 'public' ? 'public' : 'not ours'} at ${hhmm(c.now())} (${what})`
        if (!c.tdb.block(repo)) {
          c.tdb.setBlock(repo, c.now(), reason)
          c.tdb.addEvent({ t: c.now(), door: 'local', repo, run: null, actor: null, ok: 0, checkId: 'blocked', reason: `watchdog: blocked: ${reason}`, job: null })
          c.log(`TRUST blocked repo=${repo}: ${reason}${runners.length ? `; the operator stops its ${runners.length} runner(s): sudo -n ci-broker-runnerctl stop ${repo}` : ''}`)
        }
        for (const j of jobs) c.jobs.fail(j.id, `trust: ${repo} is now ${t.tier === 'public' ? 'public' : 'not ours'} (${what}); stopped`)
      }
      this.checkDoor()
    }).then(() => this.probe())
  }

  /**
   * The public network probe, outside the mutex (a container run must never hold up an unblock). Only when the
   * public lane is in use (a repo's cached tier is public) or no check has run yet.
   */
  private probing: Promise<void> | null = null
  probe(force = false): Promise<void> {
    const c = this.c
    if (c.cfg.layout !== 'split') return Promise.resolve()
    if (!force && c.netCheck && !c.tdb.tiers().some((t) => t.tier === 'public')) return Promise.resolve()
    this.probing ??= (async () => {
      const net = await this.probeNetwork().catch((e) => ({ ok: false, why: `the probe failed: ${(e as Error).message}` }))
      if (!net.ok && c.netCheck?.ok !== false) c.log(`TRUST public network check FAILED: ${net.why} (public-lane jobs are refused)`)
      c.netCheck = { ...net, at: c.now() }
    })().finally(() => (this.probing = null))
    return this.probing
  }

  /** The GitHub door: its dir (owner, group, mode) and its socket (0660). A problem closes it (the banner says why). */
  checkDoor() {
    const c = this.c
    const sock = c.cfg.githubSocketPath
    if (!sock || c.cfg.layout !== 'split' || c.githubDoor.startsWith('closed: not opened')) return
    const gid = c.cfg.installConf ? lookupId('group', c.cfg.installConf.RUNNER_USER) : null
    let why = dirProblem(dirname(sock), { uid: process.getuid!(), gid: gid ?? -1, mode: 0o2750 })
    if (!why) {
      try {
        const st = lstatSync(sock)
        if (!st.isSocket() || (st.mode & 0o777) !== 0o660) why = `${sock} is not a 0660 socket`
      } catch {
        why = `${sock} is gone`
      }
    }
    if (why && c.githubDoor === 'open') c.log(`GITHUB DOOR CLOSED: ${why}`)
    if (why) c.githubDoor = `closed: ${why}`
  }

  /** The probe: the network exists on the cib-pub0 bridge; a container on it can't reach this machine or private ranges. */
  async probeNetwork(): Promise<{ ok: boolean; why: string }> {
    const c = this.c
    const net = c.cfg.trust.publicNetwork
    const insp = await c.sys('docker', ['network', 'inspect', net, '--format', '{{index .Options "com.docker.network.bridge.name"}}'], 30)
    if (insp.code !== 0) return { ok: false, why: `docker network ${net} is missing (run scripts/install.sh)` }
    if (insp.stdout.trim() !== 'cib-pub0') return { ok: false, why: `docker network ${net} is on bridge ${insp.stdout.trim() || '(none)'}, not cib-pub0` }
    const gw = await c.sys('docker', ['network', 'inspect', 'bridge', net, '--format', '{{range .IPAM.Config}}{{.Gateway}} {{end}}'], 30)
    const host = Object.values(networkInterfaces()).flat().filter((a) => a && !a.internal && a.family === 'IPv4').map((a) => a!.address)
    const targets = [...new Set([...host, ...gw.stdout.split(/\s+/).filter((x) => /^\d+\.\d+\.\d+\.\d+$/.test(x)), ...PRIVATE_PROBES])]
    const r = await c.sys('docker', ['run', '--rm', '--network', net, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '64m', '--label', `ci-broker.daemon=${c.cfg.daemonId}`, PROBE_IMAGE, 'sh', '-c', probeScript(targets)], 180)
    if (r.code !== 0 && !r.stdout.trim()) return { ok: false, why: `the probe container failed (exit ${r.code}): ${r.stderr.trim().slice(0, 200)}` }
    return probeVerdict(r.stdout)
  }

  /** `trust unblock`: under the mutex, only once GitHub says the repo is private with push again. */
  unblock(repo: string): Promise<{ ok: true; startCmd: string | null }> {
    return this.locked(async () => {
      const c = this.c
      if (!c.tdb.block(repo)) throw new HttpError(404, `${repo} is not blocked`)
      let t
      try {
        t = await c.trust.liveTier(repo)
      } catch (e) {
        throw new HttpError(503, `could not check ${repo} on GitHub (${(e as Error).message}); it stays blocked`)
      }
      if (t.tier !== 'private') throw new HttpError(409, `${repo} is ${t.tier} (${t.why}): it stays blocked`)
      c.tdb.unblock(repo)
      c.tdb.clearWatchError(repo)
      c.log(`TRUST unblocked repo=${repo} (tier private again)`)
      const n = readRunners(c.cfg.runnersJson).filter((r) => r.repo.toLowerCase() === repo.toLowerCase()).length
      return { ok: true, startCmd: n ? `sudo -n ci-broker-runnerctl start ${repo}` : null }
    })
  }
}
