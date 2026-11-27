// The local door's routes beyond the job API: admission for submits and checks, /hello, /trust*, /doctor,
// /daemon-log, /admin/seed, and the status banner. The caller is the operator (trusted); the trust checks still run.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import type { ServerResponse } from 'node:http'
import { PROTOCOL } from '../client/http.ts'
import { serves } from '../config.ts'
import type { EnvClass, Lane } from '../db.ts'
import { lookupId } from '../install-conf.ts'
import { pinned } from './trust.ts'
import type { Daemon } from './daemon.ts'
import { readRunners } from './daemon.ts'
import { HttpError, type SubmitReq, type SubmitRes } from './jobs.ts'

const hhmm = (t: number) => new Date(t).toTimeString().slice(0, 5)

export function hello(d: Daemon) {
  return { protocol: PROTOCOL, daemonId: d.c.cfg.daemonId, layout: d.c.cfg.layout, filesTar: true }
}

/** split: root's trust/secrets and the operator's tuning apply at the next submit (a bad file refuses, naming it) */
function reload(d: Daemon, _repo: string | null) {
  d.reloadConfig('local')
}

/** POST /jobs on the local door: the admission decides lane and env class; the client's own trust fields are dropped. */
export async function submitLocal(d: Daemon, body: SubmitReq): Promise<SubmitRes> {
  const c = d.c
  reload(d, typeof body?.repo === 'string' ? body.repo : null)
  const adm = await c.trust.admitLocal({ repo: body.repo, profile: body.profile, mode: body.mode, args: body.args ?? [], sha: body.commit })
  const r: SubmitReq = {
    repo: body.repo, profile: adm.profile.name, mode: body.mode, args: body.args ?? [], commit: body.commit, tree: body.tree ?? null,
    headCandidates: Array.isArray(body.headCandidates) ? body.headCandidates.filter((x) => typeof x === 'string') : [],
    source: body.source === 'github' ? 'github' : 'local', label: typeof body.label === 'string' ? body.label.slice(0, 200) : undefined,
    detach: !!body.detach, wantStatus: !!body.wantStatus, force: !!body.force, lane: adm.lane, env: adm.env, door: 'local', ghRun: null, note: adm.note,
  }
  return c.jobs.submit(r)
}

/** POST /resources/:id/check: each profile it would check is admitted first (a public-lane repo: the local resource only). */
export async function admitCheck(d: Daemon, resourceId: string, profile?: string): Promise<Map<string, { lane: Lane; env: EnvClass }> | null> {
  const c = d.c
  const r = c.resources.find((x) => x.id === resourceId)
  if (!r) return null
  reload(d, null)
  const lanes = new Map<string, { lane: Lane; env: EnvClass }>()
  const names = profile ? [profile] : r.profiles.includes('*') ? (existsSync(c.cfg.profilesDir) ? readdirSync(c.cfg.profilesDir).filter((p) => !p.startsWith('.')) : []) : r.profiles
  for (const n of names) {
    if (!serves(r, n)) continue
    const p = (() => {
      try {
        return c.profile(n)
      } catch (e) {
        return c.trust.refuse({ check: 'profile', door: 'local', repo: null, run: null }, (e as Error).message)
      }
    })()
    const a = await c.trust.admitLocal({ repo: p.repo, profile: n, mode: p.check?.[0], args: p.check?.slice(1) ?? [] }, { resourceKind: r.kind })
    lanes.set(n, { lane: a.lane, env: a.env })
  }
  return lanes
}

/** The banner: only what stops work. */
export function banner(d: Daemon): string[] {
  const c = d.c
  const out: string[] = []
  const runners = readRunners(c.cfg.runnersJson)
  for (const b of c.tdb.blocks()) {
    const n = runners.filter((r) => r.repo.toLowerCase() === b.repo).length
    out.push(`${b.repo} BLOCKED since ${hhmm(b.since)}: ${b.reason}.${n ? ` Stop its ${n} runner(s): sudo -n ci-broker-runnerctl stop ${b.repo}` : ''}`)
    out.push(`  After review: ci-broker trust unblock ${b.repo}`)
  }
  if (c.cfg.layout === 'split' && c.githubDoor !== 'open') out.push(`GitHub door ${c.githubDoor}`)
  if (c.localDoor !== 'open') out.push(`local door ${c.localDoor}`)
  if (c.awaitSeed) out.push('the daemon is waiting for its job id seed: submits wait (ci-broker switch-to-split seeds it; on a new machine: ci-broker admin-seed 1)')
  if (c.cfg.layout === 'split' && c.netCheck && !c.netCheck.ok) out.push(`public network ${c.cfg.trust.publicNetwork} failed its check at ${hhmm(c.netCheck.at)}: ${c.netCheck.why} (public-lane jobs are refused)`)
  for (const w of c.tdb.watchErrors()) if (c.now() - w.since >= 2 * c.cfg.trust.watchSec * 1000) out.push(`watchdog can't check ${w.repo} since ${hhmm(w.since)}: ${w.error}`)
  const op = c.cfg.operator
  if (c.cfg.layout === 'split' && op && inGroup(op, 'docker'))
    out.push(`the operator ${op} is in the docker group: the daemon's keys are hidden from normal access only (docker group = root)`)
  for (const n of c.creds.secretsEqualToCredential()) out.push(`job secret ${n} equals the daemon's GitHub credential: replace it (install.sh --set-secret ${n})`)
  return out
}

export function inGroup(user: string, group: string, file = '/etc/group'): boolean {
  try {
    const line = readFileSync(file, 'utf8').split('\n').find((l) => l.split(':')[0] === group)
    return !!line && (line.split(':')[3] ?? '').split(',').includes(user)
  } catch {
    return false
  }
}

/** GET /trust: the approved lists, each known repo's tier, runners, blocks. */
export function trustView(d: Daemon) {
  const c = d.c
  const now = c.now()
  const runners = readRunners(c.cfg.runnersJson)
  const t = c.cfg.trust
  return {
    layout: c.cfg.layout,
    githubUsers: t.githubUsers,
    repos: Object.entries(t.repos).map(([repo, r]) => ({ repo, githubUsers: r.githubUsers ?? null, workflow: r.workflow ?? '.github/workflows/broker.yml', envForGithubDoor: !!r.envForGithubDoor })),
    tiers: c.tdb.tiers().map((x) => ({ ...x, ageSec: Math.round((now - x.checkedAt) / 1000), lane: x.tier === 'private' ? 'full' : x.tier === 'public' ? 'public' : 'refused' })),
    runners: runners.map((r) => ({ id: r.id, repo: r.repo, name: r.name })),
    blocks: c.tdb.blocks(),
    watchErrors: c.tdb.watchErrors(),
  }
}

/** POST /trust/check: `{ repo }` → the local-door checks now; `{ repo, runId, runAttempt, … }` → the GitHub-door replay. */
export async function trustCheck(d: Daemon, body: any) {
  const lines: string[] = []
  const trace = (l: string) => void lines.push(l)
  try {
    reload(d, typeof body?.repo === 'string' ? body.repo : null)
    if (body?.runId !== undefined) {
      const req = { repo: body.repo, runId: String(body.runId), runAttempt: String(body.runAttempt ?? 1), ...(body.ref ? { ref: body.ref } : {}), ...(body.sha ? { sha: body.sha, mode: body.mode ?? 'all', args: body.args ?? [] } : {}) } as any
      await d.c.trust.admitGithub(req, 'replay', trace)
    } else {
      const a = await d.c.trust.admitLocal({ repo: body?.repo, profile: body?.profile, mode: body?.mode }, { trace, live: body?.live === true })
      if (a.note) lines.push(a.note)
      lines.push(`→ lane ${a.lane}, env class ${a.env}`)
      return { ok: true, lines, tier: a.tier, lane: a.lane }
    }
    return { ok: true, lines }
  } catch (e) {
    const info = (e as any).info
    if (!info) throw e
    return { ok: false, lines, refused: { check: info.check, error: (e as Error).message } }
  }
}

/** GET /daemon-log?n=&follow=: the daemon's own log (already scrubbed when written). */
export function daemonLog(d: Daemon, url: URL, res: ServerResponse) {
  const file = d.c.logFile
  if (!file) throw new HttpError(404, 'this daemon keeps no log file (it logs to the journal only)')
  const n = Math.min(Math.max(Number(url.searchParams.get('n') ?? 200) || 200, 1), 5000)
  const follow = url.searchParams.get('follow') === '1'
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  res.write(lines.slice(-n).map((l) => `${l}\n`).join(''))
  if (!follow) return void res.end()
  let pos = Buffer.byteLength(text)
  const timer = setInterval(() => {
    try {
      const size = existsSync(file) ? statSync(file).size : 0
      if (size < pos) pos = 0 // rotated
      if (size === pos) return
      const fd = openSync(file, 'r')
      const buf = Buffer.alloc(size - pos)
      readSync(fd, buf, 0, buf.length, pos)
      closeSync(fd)
      pos = size
      res.write(buf)
    } catch {}
  }, 500)
  res.on('close', () => clearInterval(timer))
}

/** GET /doctor: the daemon's own checks, as lines; never a secret. */
export async function doctor(d: Daemon, operatorTokenSha: string | null) {
  const c = d.c
  const lines: { ok: boolean | null; text: string }[] = []
  const line = (ok: boolean | null, text: string) => void lines.push({ ok, text })
  line(true, `layout ${c.cfg.layout}; local door ${c.localDoor}; GitHub door ${c.githubDoor}`)
  try {
    d.reloadConfig('local', { report: false })
  } catch (e) {
    line(false, `config: ${(e as Error).message}`)
  }
  try {
    const me = await c.api.whoami()
    line(true, `GitHub credential: ${me.login} (scopes: ${me.scopes || 'none listed'})`)
  } catch (e) {
    line(false, `GitHub credential: GET /user failed (${(e as Error).message.slice(0, 120)})`)
  }
  // the model assumes nobody outside the approved list can push to a repo's default branch
  const repos = new Map<string, string>()
  for (const n of existsSync(c.cfg.profilesDir) ? readdirSync(c.cfg.profilesDir).filter((x) => !x.startsWith('.')) : []) {
    try {
      const p = c.profile(n)
      repos.set(p.repo.toLowerCase(), p.repo)
    } catch {}
  }
  for (const repo of repos.values()) {
    try {
      const info = await c.api.repo(repo)
      if (!info) continue
      const prot = await c.api.branchProtected(repo, info.defaultBranch)
      if (prot) line(true, `${repo}: ${info.defaultBranch} is protected`)
      else line(null, `${repo}: the default branch ${info.defaultBranch} is not protected: anyone who can push to it can change what the GitHub door admits (protect it: settings → branches)`)
    } catch (e) {
      line(null, `${repo}: could not read its default branch protection (${(e as Error).message.slice(0, 120)})`)
    }
  }
  if (operatorTokenSha && c.creds.tokenHash()) line(null, c.creds.tokenHash() === operatorTokenSha ? "the daemon's GitHub token is still the operator's (a copy): install.sh --set-credential github gives it its own" : "the daemon's GitHub token is its own (not the operator's)")
  const boat = await c.sys(c.cfg.boatBin, ['status'], 20, c.creds.boatEnv())
  line(boat.code === 0, `Boat: ${boat.code === 0 ? (boat.stdout.trim().split('\n')[0] ?? 'logged in') : `boat status failed (exit ${boat.code})`}`)
  for (const n of Object.keys(c.cfg.secrets)) line(c.creds.secret(n) !== null, `job secret ${n}: ${c.creds.secret(n) !== null ? 'set' : `NOT SET (install.sh --set-secret ${n})`}`)
  for (const n of c.creds.secretsEqualToCredential()) line(false, `job secret ${n} EQUALS the daemon's GitHub credential: a job would get the daemon's token`)
  const all = [c.cfg.trust.githubUsers, ...Object.values(c.cfg.trust.repos).map((r) => r.githubUsers ?? [])].flat()
  const unpinned = all.filter((e) => typeof e === 'string')
  if (unpinned.length) line(null, `unpinned approved-list entries (never match): ${[...new Set(unpinned)].join(', ')}; pin them as { "login", "id" } in root's config.json`)
  if (!pinned(c.cfg.trust.githubUsers).length) line(null, 'the global approved list has no pinned entry: the GitHub door refuses everything')
  if (c.cfg.layout === 'split') {
    const op = c.cfg.operator
    if (op && inGroup(op, 'docker')) line(null, `the operator ${op} is in the docker group (docker group = root): the daemon's keys are hidden from normal access only`)
    const cur = c.cfg.releaseFile && existsSync(c.cfg.releaseFile) ? readFileSync(c.cfg.releaseFile, 'utf8').split('\n')[0].trim() : null
    if (cur && c.ownRelease && cur !== c.ownRelease) line(null, `the current release ${cur.slice(0, 12)} is not what this daemon runs (${c.ownRelease.slice(0, 12)}): restart it (sudo -n ci-broker-runnerctl daemon restart)`)
    else if (cur) line(true, `release ${cur.slice(0, 12)}${c.ownRelease ? ' (this daemon runs it)' : ''}`)
    else line(null, 'no current release (an admin runs install.sh --release <sha>; install.sh --check)')
    // runner units enabled but not in root's runners.json
    const known = new Set(readRunners(c.cfg.runnersJson).map((r) => r.id))
    const wants = join(c.systemdDir, 'multi-user.target.wants')
    for (const f of existsSync(wants) ? readdirSync(wants) : []) {
      const m = /^ci-broker-runner@(.+)\.service$/.exec(f)
      if (m && !known.has(m[1])) line(null, `runner unit ci-broker-runner@${m[1]} is not in runners.json (sudo -n ci-broker-runnerctl rm ${m[1]})`)
    }
    // the runner units deny this machine's own addresses: the drop-in must list today's
    const drop = join(c.systemdDir, 'ci-broker-runner@.service.d', '10-host-addrs.conf')
    if (existsSync(drop)) {
      const listed = new Set((/^IPAddressDeny=(.*)$/m.exec(readFileSync(drop, 'utf8'))?.[1] ?? '').split(/\s+/).filter(Boolean).map((a) => a.replace(/\/\d+$/, '')))
      const now = Object.values(networkInterfaces()).flat().filter((a) => a && !a.internal && !/^(fe80:|169\.254\.)/i.test(a.address)).map((a) => a!.address)
      // the unit already denies the private, CGNAT, ULA and link-local ranges; only the other addresses need listing
      const ranged = (a: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|127\.|f[cd][0-9a-f]{2}:)/i.test(a)
      const missing = now.filter((a) => !listed.has(a) && !ranged(a))
      if (missing.length) line(null, `10-host-addrs.conf is out of date (${missing.join(', ')} not denied to the runners): an admin runs sudo -n ci-broker-runnerctl install-unit`)
      else line(true, 'the runners are denied this machine\'s addresses')
    }
    if (c.cfg.installConf && lookupId('group', c.cfg.installConf.OPERATOR_GROUP) === null) line(false, `no group ${c.cfg.installConf.OPERATOR_GROUP}`)
  }
  const fw = await c.sys('docker', ['info', '--format', '{{.FirewallBackend}}'], 20)
  if (fw.code === 0 && fw.stdout.trim() && c.cfg.layout === 'split') line(/iptables/.test(fw.stdout), `docker firewall backend: ${fw.stdout.trim()}${/iptables/.test(fw.stdout) ? '' : ' (the public network rules need iptables: rewrite pub-net-rules)'}`)
  if (c.cfg.layout === 'single') {
    for (const n of existsSync(c.cfg.profilesDir) ? readdirSync(c.cfg.profilesDir) : []) {
      try {
        const p = c.profile(n)
        if (p.local?.nonoProfile) {
          const r = await c.sys('nono', ['profile', 'show', p.local.nonoProfile], 20)
          line(r.code === 0, `profile ${n}: nono profile ${p.local.nonoProfile} ${r.code === 0 ? 'exists' : 'not found'} (a convenience, not a boundary)`)
        }
      } catch {}
    }
  }
  return { lines }
}

export function seed(d: Daemon, nextId: unknown) {
  if (typeof nextId !== 'number' || !Number.isInteger(nextId) || nextId < 1) throw new HttpError(400, 'nextId must be a positive integer')
  if (!d.c.db.seedNextId(nextId)) throw new HttpError(409, 'the DB already has jobs: the id seed is only for a fresh DB')
  d.c.awaitSeed = false
  rmSync(join(d.c.cfg.stateDir, 'await-seed'), { force: true })
  d.c.log(`admin: job ids continue at ${d.c.jobName(nextId)}`)
  return { ok: true, next: d.c.jobName(nextId) }
}

