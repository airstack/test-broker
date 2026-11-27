// The client's read and control commands: status, jobs, show, logs, cancel, resources, gc, drain, doctor.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { Parsed } from '../cli.ts'
import type { Config } from '../config.ts'
import { EXIT_REFUSED, type Client } from './http.ts'

type Out = (s: string) => void
const ago = (t: number | null, now = Date.now()) => (t ? `${Math.round((now - t) / 1000)}s ago` : '-')
const short = (s: string | null | undefined) => (s ?? '').slice(0, 12)

function jobLine(j: any): string {
  return `  ${j.id.padEnd(10)} ${j.state.padEnd(14)} ${j.repo} ${short(j.commit)}${j.source === 'snapshot' ? '*' : ' '} ${j.profile}/${j.mode}${j.args?.length ? ` -- ${j.args.join(' ')}` : ''}${j.label ? `  [${j.label}]` : ''}${j.waitWhy ? `\n      waiting: ${j.waitWhy}` : ''}`
}

/** The banner: only what stops work (blocks, a closed door, the public network, the docker-group warning, …). */
export function bannerLines(s: any): string {
  const b: string[] = s.trust?.banner ?? []
  return b.length ? `!! TRUST\n${b.map((l) => `   ${l}`).join('\n')}\n\n` : ''
}

export async function status(c: Client, out: Out): Promise<number> {
  const s = await c.request('GET', '/status')
  out(bannerLines(s))
  out(`ci-brokerd ${s.daemonId}${s.draining ? '  DRAINING' : ''}  up since ${new Date(s.bootAt).toISOString()}\n`)
  out(`\njobs (${s.jobs.length} active)\n`)
  for (const j of s.jobs) {
    out(jobLine(j) + '\n')
    for (const sh of j.shards) out(`      ${sh.name.padEnd(12)} ${sh.state.padEnd(9)} ${sh.attempt > 1 ? `attempt ${sh.attempt} ` : ''}${sh.where ?? ''}${sh.reason ? ` (${sh.reason})` : ''}\n`)
  }
  if (!s.jobs.length) out('  (none)\n')
  if (s.held.length) out(`  waiting for their clients after a restart: ${s.held.join(', ')}\n`)
  out('\nresources\n')
  for (const r of s.resources) out(resourceLines(r, s))
  if (s.githubRuns?.length) {
    out(`\ngithub runs in flight (${s.githubRuns.length})\n`)
    for (const g of s.githubRuns) out(`  ${g.token.padEnd(12)} ${g.resource} ${g.repo} ${g.state}${g.runId ? ` run ${g.runId}` : ''} dispatched ${ago(g.dispatchedAt)}${g.url ? `  ${g.url}` : ''}\n`)
  }
  out(`\nboat boxes (${s.boxes.length}; ${s.pendingStarts} starts pending)\n`)
  for (const b of s.boxes) out(`  ${b.name.padEnd(36)} ${b.state.padEnd(11)} ${(b.boatId ?? '').padEnd(12)} last ${b.lastRepo ?? '-'} ${ago(b.lastUsed)}${b.infraFails ? `  infra fails ${b.infraFails}` : ''}${b.reason ? `  (${b.reason})` : ''}\n`)
  if (s.starts) out(`starts left: day ${s.starts.day}, hour ${s.starts.hour}, minute ${s.starts.minute} (reserve ${s.startsReserve}; read ${ago(s.starts.at)})\n`)
  return 0
}

/** One resource: kind, profiles, what it is, its slots, and health per profile (failing, infra failures, last check). */
export function resourceLines(r: any, s: any): string {
  const what =
    r.kind === 'ssh' ? `host ${r.host}, ${r.slots} slot(s)${r.sizes?.length ? `, sizes ${r.sizes.join(',')}` : ''}${r.githubTokenCmd ? ', token over stdin' : ''}`
    : r.kind === 'github' ? `workflow ${r.workflow}, modes ${(r.modes ?? []).join(',') || '(none)'}, after ${r.afterWaitSec}s`
    : r.kind === 'boat' ? `env ${r.environment ?? '(profile)'}, maxBoxes ${r.maxBoxes}`
    : 'this machine'
  let o = `  ${r.id.padEnd(8)} ${r.kind.padEnd(7)} profiles ${r.profiles.join(',')}  (${what})\n`
  if (r.kind === 'ssh') {
    const busy = new Map<number, any>((r.slotsBusy ?? []).map((x: any) => [x.slot, x]))
    for (let i = 0; i < r.slots; i++) {
      const b = busy.get(i)
      o += `      slot ${i}: ${b ? `${b.job === 'check' ? 'check' : `job ${b.job}`} since ${ago(b.since)}` : 'free'}\n`
    }
  } else if (r.kind === 'local' && r.slotsBusy?.length) o += `      slot 0: ${r.slotsBusy[0].job === 'check' ? 'check' : `job ${r.slotsBusy[0].job}`} since ${ago(r.slotsBusy[0].since)}\n`
  for (const h of r.health)
    o += `      ${h.profile.padEnd(12)} ${h.failing ? `FAILING: ${h.reason}` : 'ok'}${h.infraFails ? `  infra fails ${h.infraFails}` : ''}${h.lastCheckAt ? `  last check ${ago(h.lastCheckAt)} ${h.lastCheckOk ? 'pass' : 'FAIL'}${h.lastCheckLog ? ` (${h.lastCheckLog})` : ''}` : '  never checked'}\n`
  if (r.kind === 'boat') for (const b of (s.boxes ?? []).filter((x: any) => x.state === 'quarantined')) o += `      quarantined ${b.name}: ${b.reason}\n`
  return o
}

export async function jobs(c: Client, out: Out, o: { repo?: string; limit?: string }): Promise<number> {
  const q = new URLSearchParams()
  if (o.repo) q.set('repo', o.repo)
  q.set('limit', o.limit ?? '20')
  const r = await c.request('GET', `/jobs?${q}`)
  for (const j of r.jobs) out(jobLine(j) + `  ${j.summary ? `${j.summary.secs}s` : ''}\n`)
  if (!r.jobs.length) out('  (no jobs)\n')
  return 0
}

export async function show(c: Client, out: Out, id: string): Promise<number> {
  const j = await c.request('GET', `/jobs/${id}`)
  out(jobLine(j) + '\n')
  out(`  key ${j.key}\n  dir ${j.dir}${j.pinned ? '\n  pinned (detached)' : ''}${j.error ? `\n  error: ${j.error}` : ''}\n\nshards\n`)
  for (const s of j.shards) out(`  ${s.name.padEnd(12)} ${s.state.padEnd(9)} attempt ${s.attempt} ${s.where ?? ''}${s.code !== null ? ` exit ${s.code}` : ''}${s.reason ? ` (${s.reason})` : ''}\n`)
  out('\nevents\n')
  for (const e of j.events) out(`  ${new Date(e.t).toISOString().slice(11, 19)} ${(e.shard ?? '').padEnd(12)} ${e.kind.padEnd(8)} ${e.message}\n`)
  if (j.summary) out(`\n${j.summary.text}\n`)
  return 0
}

export async function logs(c: Client, out: Out, id: string, o: { shard?: string; follow: boolean }, signal?: AbortSignal): Promise<number> {
  await c.stream(`/jobs/${id}/events?follow=${o.follow ? 1 : 0}&interest=0`, (e) => {
    if (e.t === 'log' && (!o.shard || e.shard === o.shard)) out(o.shard ? e.data : e.data.replace(/^(?=.)/gm, `[${e.shard}] `))
  }, signal)
  return 0
}

export async function cancel(c: Client, out: Out, id: string): Promise<number> {
  const r = await c.request('POST', `/jobs/${id}/cancel`)
  out(`job ${id}: ${r.state}\n`)
  return 0
}

export async function resources(c: Client, out: Out, args: string[]): Promise<number> {
  if (args[0] === 'reset') {
    if (!args[1]) throw new Error('usage: ci-broker resources reset <id>')
    const r = await c.request('POST', `/resources/${encodeURIComponent(args[1])}/reset`)
    out(`${args[1]}: cleared ${r.health} health row(s), ${r.boxes} box(es) out of quarantine\n`)
    return 0
  }
  const s = await c.request('GET', '/status')
  for (const r of s.resources) out(resourceLines(r, s))
  if (s.githubRuns?.length) for (const g of s.githubRuns) out(`  github run ${g.token} (${g.resource}) ${g.state}${g.runId ? ` run ${g.runId}` : ''}\n`)
  return 0
}

/** `check <resource> [<profile>] [--use-reserve]`: stream the check; exit 0 passed, 1 failed, 3 not checked. */
export async function check(c: Client, out: Out, resource: string, profile: string | undefined, useReserve: boolean, signal?: AbortSignal): Promise<number> {
  let code = 2
  const results: any[] = []
  const r = await c.stream(
    `/resources/${encodeURIComponent(resource)}/check`,
    (e) => {
      if (e.t === 'log') out(e.data.replace(/^(?=.)/gm, `[${e.resource}/${e.profile}] `))
      else if (e.t === 'result') results.push(e)
      else if (e.t === 'done') {
        code = e.code
        if (e.error) out(`ci-broker: check: ${e.error}\n`)
      }
    },
    signal,
    { profile, useReserve },
  )
  for (const x of results) out(`${x.ok === true ? 'PASS' : x.ok === false ? 'FAIL' : 'NOT CHECKED'}  ${x.resource}/${x.profile}: ${x.message}${x.report ? `\n      ${x.report}` : ''}\n`)
  if (!r.ended) return 130
  return code
}

export async function gc(c: Client, out: Out): Promise<number> {
  out(JSON.stringify(await c.request('POST', '/gc'), null, 2) + '\n')
  return 0
}

export async function drain(c: Client, out: Out): Promise<number> {
  const r = await c.request('POST', '/drain')
  out(`draining: ${r.running} shard(s) still running; the daemon exits when they end (systemd restarts it)\n`)
  return 0
}

export async function doctor(c: Client, out: Out, cfg: Config): Promise<number> {
  let bad = 0
  const line = (ok: boolean | null, what: string) => {
    if (ok === false) bad++
    out(`  ${ok === null ? 'note' : ok ? 'ok  ' : 'FAIL'} ${what}\n`)
  }
  // the daemon's own checks: only hashes cross (is its GitHub token still the operator's?)
  const tok = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 20_000 })
  const sha = tok.status === 0 && tok.stdout.trim() ? createHash('sha256').update(tok.stdout.trim()).digest('hex') : null
  try {
    const d = await c.request('GET', `/doctor${sha ? `?operatorTokenSha=${sha}` : ''}`)
    for (const l of d.lines) line(l.ok, l.text)
  } catch (e) {
    line(false, `the daemon's own checks: ${(e as Error).message}`)
  }
  const run = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 20_000, env: { ...process.env, BOAT_NO_UPDATE: '1' } })
  let s: any = null
  try {
    s = await c.request('GET', '/status')
    line(true, `daemon ${s.daemonId} answers on ${c.socket} (${c.hello?.layout ?? 'an old single daemon'})`)
  } catch (e) {
    line(false, (e as Error).message)
  }
  line(run('gh', ['auth', 'status']).status === 0, 'gh is logged in')
  // split: the daemon's own Boat login is in its lines above; the operator's boat is not what it uses
  if (c.hello?.layout !== 'split') line(existsSync(cfg.boatBin), `boat CLI at ${cfg.boatBin}`)
  if (cfg.layout !== 'split') line(null, 'single layout (no /etc/ci-broker/install.conf): runners and the public lane need split; an admin runs scripts/install.sh (README: Install)')
  const docker = run('docker', ['info', '--format', '{{.ServerVersion}}'])
  line(docker.status === 0, `docker ${docker.status === 0 ? docker.stdout.trim() : 'not reachable'}`)
  if (s) {
    for (const r of s.resources) {
      const bad = r.health.filter((h: any) => h.failing)
      line(!bad.length, `resource ${r.id} (${r.kind})${bad.length ? `: failing for ${bad.map((h: any) => `${h.profile} (${h.reason})`).join(', ')}` : ''}`)
      for (const h of r.health.filter((x: any) => x.lastCheckAt)) out(`         last check ${h.profile}: ${h.lastCheckOk ? 'pass' : 'FAIL'} ${ago(h.lastCheckAt)}${h.lastCheckLog ? ` (${h.lastCheckLog})` : ''}\n`)
      if (!r.health.some((x: any) => x.lastCheckAt)) out(`         never checked: ci-broker check ${r.id}\n`)
      if (r.kind === 'ssh') line(spawnSync(cfg.sshBin, ['-G', r.host], { encoding: 'utf8', timeout: 10_000 }).status === 0, `ssh config resolves ${r.host}`)
    }
    for (const b of s.boxes.filter((x: any) => x.state === 'quarantined')) out(`  note quarantined box ${b.name}: ${b.reason} (ci-broker resources reset boat)\n`)
    if (s.githubRuns?.length) out(`  note ${s.githubRuns.length} github run(s) in flight\n`)
    if (s.starts) line(s.starts.day > s.startsReserve, `Boat starts left today: ${s.starts.day} (reserve ${s.startsReserve})`)
  }
  return bad ? 1 : 0
}

const hm = (t: number) => new Date(t).toISOString().slice(0, 16).replace('T', ' ')

/** `ci-broker trust [log|check|unblock]` (local socket only). Exit 77 when a `check` is refused. */
export async function trust(c: Client, out: Out, a: Parsed): Promise<number> {
  const [sub, ...rest] = a.positional
  if (!sub) {
    const t = await c.request('GET', '/trust')
    const who = (l: any[]) => (l.length ? l.map((e) => (typeof e === 'string' ? `${e} (UNPINNED: never matches)` : `${e.login} (${e.id})`)).join(', ') : '(none: the GitHub door refuses everything)')
    out(`layout ${t.layout}\napproved (global): ${who(t.githubUsers)}\n`)
    for (const r of t.repos) out(`  ${r.repo}: ${r.githubUsers ? `approved ${who(r.githubUsers)} (replaces the global list)` : 'the global list'}; workflow ${r.workflow}${r.envForGithubDoor ? '; job secrets at the GitHub door' : ''}\n`)
    out('\nrepos (tier cache)\n')
    for (const x of t.tiers) out(`  ${x.repo.padEnd(36)} ${x.tier.padEnd(8)} lane ${x.lane.padEnd(8)} checked ${x.ageSec}s ago${t.runners.some((r: any) => r.repo.toLowerCase() === x.repo) ? `  runners ${t.runners.filter((r: any) => r.repo.toLowerCase() === x.repo).length}` : ''}\n`)
    if (!t.tiers.length) out('  (none checked yet)\n')
    for (const b of t.blocks) out(`\nBLOCKED ${b.repo} since ${hm(b.since)}: ${b.reason}\n`)
    for (const w of t.watchErrors) out(`watch error ${w.repo} since ${hm(w.since)}: ${w.error}\n`)
    return 0
  }
  if (sub === 'log') {
    const q = new URLSearchParams({ limit: a.flags.limit ?? '50', ...(a.flags.repo ? { repo: a.flags.repo } : {}) })
    const r = await c.request('GET', `/trust/log?${q}`)
    for (const e of r.events) out(`${hm(e.t)} ${e.door.padEnd(6)} ${e.ok === 1 ? 'ADMIT ' : e.ok === 2 ? 'OFFLN ' : 'REFUSE'} ${e.repo ?? '-'}${e.run ? ` run ${e.run}` : ''}${e.actor ? ` by ${e.actor}` : ''}${e.checkId ? ` [${e.checkId}]` : ''}: ${e.reason}${e.job ? ` → ${e.job}` : ''}\n`)
    if (!r.events.length) out('(no trust events)\n')
    return 0
  }
  if (sub === 'check') {
    const repo = rest[0]
    if (!repo) throw new Error('usage: ci-broker trust check <owner/name> | --run <owner/name> <runId> [--attempt N]')
    const body = a.flags.run ? { repo, runId: rest[1], runAttempt: a.flags.attempt ?? '1', ...(a.flags.sha ? { sha: a.flags.sha, mode: a.flags.mode ?? 'all', args: a.rest } : {}) } : { repo, ...(a.flags.mode ? { mode: a.flags.mode } : {}), ...(a.flags.profile ? { profile: a.flags.profile } : {}) }
    if (a.flags.run && !rest[1]) throw new Error('usage: ci-broker trust check --run <owner/name> <runId> [--attempt N]')
    const r = await c.request('POST', '/trust/check', body)
    for (const l of r.lines) out(`  ${l}\n`)
    if (r.ok) return 0
    out(`  ${r.refused.error} ✗\n`)
    return EXIT_REFUSED
  }
  if (sub === 'unblock') {
    if (!rest[0]) throw new Error('usage: ci-broker trust unblock <owner/name>')
    const r = await c.request('POST', '/trust/unblock', { repo: rest[0] })
    out(`${rest[0]}: unblocked${r.startCmd ? `. Start its runners again: ${r.startCmd}` : ''}\n`)
    return 0
  }
  throw new Error(`unknown trust command '${sub}'`)
}

/** `ci-broker daemon-log [-f] [-n N]`: the daemon's own log over the local socket. */
export async function daemonLog(c: Client, out: Out, o: { follow: boolean; n?: string }, signal?: AbortSignal): Promise<number> {
  await c.text(`/daemon-log?n=${encodeURIComponent(o.n ?? '200')}&follow=${o.follow ? 1 : 0}`, out, signal)
  return 0
}
