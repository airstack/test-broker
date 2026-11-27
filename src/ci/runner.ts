// `ci-broker runner …`, `update`, `switch-to-split`, `install` (single). In split the runners are system units of the
// runner user; every root step goes through `sudo -n ci-broker-runnerctl` (the operator's one sudoers rule). The
// daemon never calls it. Tokens come only from stdin or a tty prompt, never argv.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, hostname, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Parsed } from './cli.ts'
import { shortHost, type Config } from './config.ts'
import { EXIT_REFUSED, pickClient, type Client } from './client/http.ts'
import { argsDigest } from './client/dispatch.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SHARE = join(homedir(), '.local/share/ci-broker')
const UNITS = join(homedir(), '.config/systemd/user')
const RUNNERCTL = '/usr/local/sbin/ci-broker-runnerctl'

export type Proc = { code: number; stdout: string; stderr: string }
export type RunnerDeps = {
  /** `sudo -n ci-broker-runnerctl <args>` with `stdin` (a token, or nothing) */
  runnerctl: (args: string[], stdin?: string) => Promise<Proc>
  /** any other command (pgrep, systemctl --user, git, gh) */
  sys: (cmd: string, args: string[]) => Promise<Proc>
  /** the local door */
  client: Client
  out: (s: string) => void
  err: (s: string) => void
  /** the registration/removal token: stdin (--token-stdin) or a tty prompt with echo off */
  readToken: () => Promise<string>
  host?: string
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** single's old runners (migration): their dirs and user units */
  oldRunnersDir?: string
  unitsDir?: string
  user?: string
}

const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/
export const instanceName = (repo: string, i: number) => `${repo.replace('/', '__')}-${i}`
export const runnerName = (host: string, repo: string, i: number) => `${host}-${repo.split('/')[1]}-r${i}`

class Exit extends Error {
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

async function ctl(d: RunnerDeps, args: string[], stdin = ''): Promise<string> {
  const r = await d.runnerctl(args, stdin)
  if (r.code === 0) return r.stdout
  if (r.code === 1 && /a password is required|not allowed|command not found|no such file|sudo: /i.test(r.stderr))
    throw new Exit(2, `no sudoers rule or runnerctl here (${r.stderr.trim().split('\n')[0]}): an admin must run scripts/install.sh first (README: Install)`)
  throw new Exit(r.code || 1, `ci-broker-runnerctl ${args[0]} failed: ${(r.stderr || r.stdout).trim().slice(0, 400)}`)
}

/** The live tier through the local door; refused (77) unless private with push. */
async function needPrivate(d: RunnerDeps, repo: string) {
  const r = await d.client.request('POST', '/trust/check', { repo, live: true })
  if (!r.ok) throw new Exit(EXIT_REFUSED, `${r.refused.error}: no runners for it`)
  if (r.tier !== 'private') throw new Exit(EXIT_REFUSED, `refused (trust/repo-tier): ${repo} is ${r.tier}: runners serve private repos only (a public repo's runner would run fork PRs here)`)
  const t = await d.client.request('GET', '/trust')
  const list = t.repos.find((x: any) => x.repo.toLowerCase() === repo.toLowerCase())?.githubUsers ?? t.githubUsers
  if (!list.some((e: any) => typeof e === 'object')) d.err(`ci-broker: warning: the approved list for ${repo} has no pinned entry: its runners would refuse every job\n`)
}

/** `runner add <repo> [--count N] --token-stdin`: one token registers several runners within its hour. */
export async function add(d: RunnerDeps, repo: string, count: number): Promise<number> {
  if (!REPO.test(repo)) throw new Exit(2, 'usage: ci-broker runner add <owner/name> [--count N] --token-stdin')
  await needPrivate(d, repo)
  const versions = (await ctl(d, ['versions'])).trim().split('\n').filter(Boolean)
  const v = versions.at(-1)
  if (!v) throw new Exit(1, 'runnerctl lists no runner version')
  await ctl(d, ['dist', v])
  const have = new Set<string>(JSON.parse((await ctl(d, ['list'])) || '[]').map((r: any) => r.id))
  const token = (await d.readToken()).trim()
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) throw new Exit(2, 'the token (stdin) does not look like a runner registration token')
  const host = d.host ?? shortHost()
  let added = 0
  for (let i = 1; i <= count; i++) {
    const id = instanceName(repo, i)
    if (have.has(id)) {
      d.out(`${id}: already registered\n`)
      continue
    }
    d.out(await ctl(d, ['add', repo, String(i), runnerName(host, repo, i), `ci-broker,${host}`, v], `${token}\n`))
    added++
  }
  d.out(`${added} runner(s) added for ${repo} (as the runner user, system units ci-broker-runner@<id>)\n`)
  return 0
}

/** `runner rm`: the units stopped and the dirs deleted as root; runnerctl prints where to delete them on GitHub. */
export async function rm(d: RunnerDeps, what: string): Promise<number> {
  const rows: any[] = JSON.parse((await ctl(d, ['list'])) || '[]')
  const ids = REPO.test(what) ? rows.filter((r) => r.repo.toLowerCase() === what.toLowerCase()).map((r) => r.id) : [what]
  if (!ids.length) throw new Exit(1, `no runners for ${what}`)
  for (const id of ids) d.out(await ctl(d, ['rm', id], ''))
  return 0
}

export async function ls(d: RunnerDeps): Promise<number> {
  const rows: any[] = JSON.parse((await ctl(d, ['list'])) || '[]')
  const t = await d.client.request('GET', '/trust').catch(() => ({ blocks: [] }))
  for (const r of rows) d.out(`  ${r.id.padEnd(32)} ${String(r.active).padEnd(9)} ${r.name}  ${r.repo}\n`)
  if (!rows.length) d.out('  (no runners)\n')
  for (const b of t.blocks ?? []) d.out(`BLOCKED ${b.repo}: ${b.reason} (sudo -n ci-broker-runnerctl stop ${b.repo})\n`)
  return 0
}

// ------------------------------------------------------------------ the migration from single's user-unit runners

/** An old runner (the operator's own) works a job now. pgrep: 0 found, 1 none; anything else is an error, never "none". */
async function oldWorkerBusy(d: RunnerDeps): Promise<boolean> {
  const user = d.user ?? userInfo().username
  const r = await d.sys('pgrep', ['-u', user, '-f', 'Runner.Worker'])
  if (r.code === 0) return true
  if (r.code === 1) return false
  throw new Exit(1, `pgrep failed (exit ${r.code}: ${r.stderr.trim().slice(0, 200)}): can't tell whether an old runner works a job; nothing changed`)
}

type OldRunner = { id: string; repo: string; name: string | null; dir: string }
export function oldRunners(dir: string): OldRunner[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .map((id) => {
      const m = /^([A-Za-z0-9_.-]+)__([A-Za-z0-9_.-]+)-(\d+)$/.exec(id)
      if (!m) return null
      let name: string | null = null
      try {
        name = JSON.parse(readFileSync(join(dir, id, '.runner'), 'utf8').replace(/^﻿/, '')).agentName ?? null
      } catch {}
      return { id, repo: `${m[1]}/${m[2]}`, name, dir: join(dir, id) }
    })
    .filter((x): x is OldRunner => !!x)
}

/** `runner migrate --token-stdin`: the new runners (runnersPerRepo each) next to the old ones. */
export async function migrate(d: RunnerDeps, cfg: Config): Promise<number> {
  const old = oldRunners(d.oldRunnersDir ?? join(SHARE, 'runners'))
  const repos = [...new Set(old.map((r) => r.repo))]
  if (!repos.length) throw new Exit(1, 'no old runners to migrate')
  for (const r of repos) await add(d, r, cfg.runnersPerRepo)
  d.out(`next, once no old runner works a job: ci-broker runner migrate --verify\n`)
  return 0
}

/**
 * `runner migrate --verify`: when no old runner works a job, disable (not delete) the old user units, dispatch
 * `cmd -- true` on the default branch head and wait for it to pass on a new runner (through the hook and the door).
 * Any failure re-enables the old units at once.
 */
export async function verify(d: RunnerDeps, o: { timeoutMs?: number; pollMs?: number } = {}): Promise<number> {
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = d.now ?? Date.now
  const old = oldRunners(d.oldRunnersDir ?? join(SHARE, 'runners'))
  const repo = old[0]?.repo
  if (!repo) throw new Exit(1, 'no old runners: nothing to verify')
  for (let said = false; await oldWorkerBusy(d); said = true) {
    if (!said) d.out('waiting until no old runner works a job (pgrep Runner.Worker)\n')
    await sleep(o.pollMs ?? 10_000)
  }
  const units = old.map((r) => `ci-broker-runner@${r.id}.service`)
  const back = async (why: string) => {
    for (const u of units) await d.sys('systemctl', ['--user', 'enable', '--now', u])
    d.err(`ci-broker: verify FAILED: ${why}; the old runners are back (${units.length})\n`)
    return 1
  }
  for (const u of units) await d.sys('systemctl', ['--user', 'disable', '--now', u])
  d.out(`old runners disabled for the check (${units.length})\n`)
  try {
    // gh repo view's defaultBranchRef holds the name only (no target): the head comes from the commits API
    const branch = (await d.sys('gh', ['repo', 'view', repo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'])).stdout.trim()
    if (!branch) return back(`cannot read ${repo}'s default branch`)
    const head = await d.sys('gh', ['api', `repos/${repo}/commits/${encodeURIComponent(branch)}`, '--jq', '.sha'])
    const sha = head.stdout.trim()
    if (head.code !== 0 || !/^[0-9a-f]{40}$/.test(sha)) return back(`cannot read ${repo}'s default branch head`)
    const start = now()
    const disp = await d.sys('gh', ['workflow', 'run', 'broker.yml', '--repo', repo, '--ref', `refs/heads/${branch}`, '-f', `sha=${sha}`, '-f', 'mode=cmd', '-f', 'args=["true"]', '-f', `argsHash=${argsDigest(['true'])}`])
    if (disp.code !== 0) return back(`gh workflow run failed: ${disp.stderr.trim().slice(0, 200)}`)
    d.out(`dispatched cmd -- true on ${repo}@${branch} ${sha.slice(0, 12)}; waiting for the GitHub-door job\n`)
    for (;;) {
      const r = await d.client.request('GET', `/jobs?repo=${encodeURIComponent(repo)}&limit=50`)
      const j = r.jobs.find((x: any) => x.door === 'github' && x.mode === 'cmd' && x.commit === sha && JSON.stringify(x.args) === '["true"]' && x.createdAt >= start - 5000)
      if (j && j.state === 'passed') {
        d.out(`verified: job ${j.id} passed on a new runner (${j.label})\n`)
        return 0
      }
      if (j && ['failed', 'error', 'cancelled'].includes(j.state)) return back(`job ${j.id} ${j.state}`)
      if (now() - start > (o.timeoutMs ?? 30 * 60_000)) return back('no GitHub-door job passed within 30 minutes (look at the run page: the hook refuses with an annotation)')
      await sleep(o.pollMs ?? 10_000)
    }
  } catch (e) {
    return back((e as Error).message)
  }
}

/** `runner migrate --finish`: remove the old runner dirs (they hold registration credentials) and user units. */
export async function finish(d: RunnerDeps): Promise<number> {
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const dir = d.oldRunnersDir ?? join(SHARE, 'runners')
  const units = d.unitsDir ?? UNITS
  const old = oldRunners(dir)
  // never leave a repo with no runner: each repo with old runners needs an active new one first
  const rows: any[] = JSON.parse((await ctl(d, ['list'])) || '[]')
  for (const repo of new Set(old.map((r) => r.repo)))
    if (!rows.some((x) => x.repo.toLowerCase() === repo.toLowerCase() && x.active === 'active')) throw new Exit(1, `no active new runner for ${repo}: ci-broker runner migrate --token-stdin first (nothing removed)`)
  // and no old runner works a job (disable --now would cut it)
  for (let said = false; await oldWorkerBusy(d); said = true) {
    if (!said) d.out('waiting until no old runner works a job (pgrep Runner.Worker)\n')
    await sleep(10_000)
  }
  for (const r of old) {
    await d.sys('systemctl', ['--user', 'disable', '--now', `ci-broker-runner@${r.id}.service`])
    await d.sys('chmod', ['-R', 'u+rwX', r.dir])
    rmSync(r.dir, { recursive: true, force: true })
  }
  for (const f of ['ci-broker-runner@.service', 'ci-brokerd.service']) rmSync(join(units, f), { force: true })
  await d.sys('systemctl', ['--user', 'daemon-reload'])
  d.out(`removed ${old.length} old runner dir(s) and the old user units. Delete these runners on GitHub (our token can't):\n`)
  for (const r of old) d.out(`  ${r.name ?? r.id}  https://github.com/${r.repo}/settings/actions/runners\n`)
  return 0
}

// ------------------------------------------------------------------ update, switch-to-split, install (single)

/** split: code updates are root's. Print the admin's two commands with origin/main's sha and the diffstat. */
export async function updateSplit(d: RunnerDeps, cfg: Config, checkout: string): Promise<number> {
  const ls = await d.sys('env', ['GIT_TERMINAL_PROMPT=0', 'git', '-C', checkout, 'ls-remote', 'origin', 'refs/heads/main'])
  const sha = ls.stdout.split(/\s+/)[0]
  if (ls.code !== 0 || !/^[0-9a-f]{40}$/.test(sha)) throw new Exit(1, 'cannot read origin/main of airstack/test-broker')
  const rel = cfg.releaseFile && existsSync(cfg.releaseFile) ? readFileSync(cfg.releaseFile, 'utf8').split('\n')[0].trim() : null
  d.out(`running release: ${rel ?? '(none)'}\norigin/main: ${sha}\n`)
  if (rel === sha) return (d.out('up to date\n'), 0)
  if (rel) {
    await d.sys('git', ['-C', checkout, 'fetch', '--quiet', 'origin'])
    const st = await d.sys('git', ['-C', checkout, 'diff', '--stat', rel, sha])
    if (st.code === 0) d.out(st.stdout)
  }
  const D = `/root/ci-broker-${sha}`
  d.out(`\nFrom an admin account (compare the printed tree with: gh api repos/airstack/test-broker/commits/${sha} --jq .commit.tree.sha):\n`)
  d.out(`  S=${sha} D=${D}; sudo sh -c "rm -rf $D && mkdir -m 0700 $D && runuser -u ${cfg.operator ?? 'dev'} -- git -C ${checkout} -c tar.umask=022 archive $S | tar -x --no-same-owner -C $D && cd $D && git init -q && git add -Af && echo sha $S tree \\$(git write-tree) && rm -rf .git"\n`)
  d.out(`  sudo bash ${D}/scripts/install.sh --release ${sha}\n`)
  return 0
}

/** A drain that waits for idle: new submits wait (503 "draining for switch"), placed and queued work finishes. */
export async function drainWait(c: Client, out: (s: string) => void, o: { pollMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<{ maxJobId: number }> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const r = await c.request('POST', '/drain', { forSwitch: true })
  let said = -1
  for (;;) {
    const s = await c.request('GET', '/status')
    if (!s.jobs.length) break
    if (s.jobs.length !== said) out(`draining: ${s.jobs.length} active job(s) left (${s.jobs.map((j: any) => j.id).join(', ')})\n`)
    said = s.jobs.length
    await sleep(o.pollMs ?? 5000)
  }
  out('drained: no active job\n')
  return { maxJobId: r.maxJobId ?? 0 }
}

export type SwitchDeps = RunnerDeps & { single: Client; split: () => Promise<Client>; checkout: string }

/**
 * `switch-to-split` (spec Rollout step 4): drain the old daemon (no time cap), wait for zero active jobs, stop and
 * disable its user unit, pull the live checkout, start the split daemon, wait for /hello, seed the job ids.
 */
export async function switchToSplit(d: SwitchDeps, o: { pollMs?: number } = {}): Promise<number> {
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const git = (args: string[]) => d.sys('env', ['GIT_TERMINAL_PROMPT=0', 'git', '-C', d.checkout, ...args])
  // 1. before anything changes: the pull must fast-forward to code with split support (the agents' client on PATH
  //    runs from this checkout, and must find the split daemon afterwards)
  const f = await git(['fetch', '--quiet', 'origin'])
  if (f.code !== 0) throw new Exit(1, `git fetch in ${d.checkout} failed: ${f.stderr.trim().slice(0, 200)}`)
  if ((await git(['merge-base', '--is-ancestor', 'HEAD', 'origin/main'])).code !== 0) throw new Exit(1, `${d.checkout} can't fast-forward to origin/main (local commits?): fix the checkout first`)
  const proto = Number(/^export const PROTOCOL = (\d+)/m.exec((await git(['show', 'origin/main:src/client/http.ts'])).stdout)?.[1] ?? 0)
  if ((await git(['cat-file', '-e', 'origin/main:src/install-conf.ts'])).code !== 0 || proto < 2)
    throw new Exit(1, `origin/main in ${d.checkout} has no split support (merge the trust layer first): nothing changed`)
  // 2. drain (or, an old daemon without the switch drain: wait for idle; a submit in the gap fails: re-run it)
  const hello = await d.single.sayHello().catch(() => null)
  let maxJobId = 0
  if (hello) maxJobId = (await drainWait(d.single, d.out, { pollMs: o.pollMs, sleep })).maxJobId
  else {
    d.err('ci-broker: the old daemon has no switch drain (older code): waiting for idle, then stopping it\n')
    for (;;) {
      const s = await d.single.request('GET', '/status')
      if (!s.jobs.length) break
      await sleep(o.pollMs ?? 5000)
    }
  }
  if (!maxJobId) {
    const j = await d.single.request('GET', '/jobs?limit=1').catch(() => ({ jobs: [] }))
    maxJobId = j.jobs[0]?.num ?? Number(String(j.jobs[0]?.id ?? '0').split('-').pop())
  }
  // 3. the old daemon off, for sure (two daemons must never run)
  const off = await d.sys('systemctl', ['--user', 'disable', '--now', 'ci-brokerd.service'])
  if (off.code !== 0) throw new Exit(1, `systemctl --user disable --now ci-brokerd.service failed (exit ${off.code}: ${off.stderr.trim().slice(0, 200)}): the old daemon may still run; nothing started`)
  let gone = false
  for (let i = 0; i < 60 && !gone; i++) {
    gone = await d.single.sayHello().then(() => false, (e) => e instanceof Error && e.constructor.name === 'DaemonDown')
    if (!gone) await sleep(o.pollMs ?? 1000)
  }
  if (!gone) throw new Exit(1, 'the old daemon still answers on its socket after disable --now: nothing started (look at systemctl --user status ci-brokerd)')
  d.out(`old daemon stopped (highest job id ${maxJobId})\n`)
  // 4. the live checkout (the agents' client): a failed pull brings the old daemon back
  const pull = await git(['pull', '--ff-only', '--quiet'])
  if (pull.code !== 0) {
    const back = await d.sys('systemctl', ['--user', 'enable', '--now', 'ci-brokerd.service'])
    if (back.code !== 0)
      throw new Exit(1, `git pull --ff-only in ${d.checkout} failed: ${pull.stderr.trim().slice(0, 200)}; and could NOT bring the old daemon back (${back.stderr.trim().slice(0, 200)}): no daemon runs. Start it: systemctl --user enable --now ci-brokerd.service`)
    throw new Exit(1, `git pull --ff-only in ${d.checkout} failed: ${pull.stderr.trim().slice(0, 200)}; the old daemon is back`)
  }
  // 5. the split daemon, and the ids
  const stuck = (why: string) =>
    new Exit(1, `${why}: no daemon runs now. Either start it and seed it: sudo -n ci-broker-runnerctl daemon start, then ci-broker admin-seed ${maxJobId + 1}; or the rollback (the plan, stage H): the live checkout back at its old sha, an admin runs install.sh --uninstall, systemctl --user enable --now ci-brokerd.service`)
  try {
    await ctl(d, ['daemon', 'start'])
  } catch (e) {
    throw stuck(`the split daemon did not start (${(e as Error).message.slice(0, 200)})`)
  }
  let split: Client | null = null
  for (let i = 0; i < 120; i++) {
    const c = await d.split()
    if (c.hello?.layout === 'split') {
      split = c
      break
    }
    await sleep(o.pollMs ?? 1000)
  }
  if (!split) throw stuck('the split daemon did not answer /hello (sudo -n ci-broker-runnerctl daemon status; ci-broker daemon-log)')
  let seeded: { next: string }
  try {
    seeded = await split.request('POST', '/admin/seed', { nextId: maxJobId + 1 })
  } catch (e) {
    if ((e as { status?: number }).status === 409) throw new Exit(1, `the split daemon already has jobs, so its ids can't be seeded above ${maxJobId}: job ids may repeat old ones (look at ci-broker jobs)`)
    throw e
  }
  d.out(`split daemon up; job ids continue at ${seeded.next}\nCheck: ci-broker status (only the docker-group warning in the banner), a snapshot job, the Boat boxes adopted, a commit status.\n`)
  return 0
}

/** The daemon as a systemd user service (single). Restart=always: a drain exits it for updates. */
export function daemonUnit(o: { bin: string; path: string }): string {
  return `[Unit]
Description=ci-brokerd: this machine's test broker (queue, local slot, Boat pool)
After=network-online.target

[Service]
ExecStart=${o.bin}
Environment=PATH=${o.path}
Restart=always
RestartSec=5
# running shards are re-queued by the next start's recovery
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=default.target
`
}

const systemctl = (...a: string[]) => spawnSync('systemctl', ['--user', ...a], { stdio: 'inherit' }).status ?? 1

function install(): number {
  if (existsSync('/etc/ci-broker/install.conf')) throw new Exit(2, 'this machine has a split install: ci-broker install is the single layout only')
  const binDir = join(homedir(), '.local/bin')
  mkdirSync(binDir, { recursive: true })
  for (const name of ['ci-broker', 'ci-brokerd']) {
    const bin = join(binDir, name)
    if (existsSync(bin)) unlinkSync(bin)
    symlinkSync(join(ROOT, 'bin', name), bin)
  }
  mkdirSync(UNITS, { recursive: true })
  writeFileSync(join(UNITS, 'ci-brokerd.service'), daemonUnit({ bin: join(ROOT, 'bin/ci-brokerd'), path: `${join(ROOT, 'bin')}:${process.env.PATH}` }))
  systemctl('daemon-reload')
  systemctl('enable', '--now', 'ci-brokerd.service')
  systemctl('restart', 'ci-brokerd.service')
  console.log(`installed ${binDir}/ci-broker{,d} and ci-brokerd.service. So it keeps running when you log out: loginctl enable-linger ${process.env.USER ?? ''}`)
  return 0
}

/** single's update: wait until idle (a drain), rewrite the user unit, restart from the operator's checkout. */
async function updateSingle(c: Client): Promise<number> {
  await drainWait(c, (s) => void process.stdout.write(s))
  writeFileSync(join(UNITS, 'ci-brokerd.service'), daemonUnit({ bin: join(ROOT, 'bin/ci-brokerd'), path: `${join(ROOT, 'bin')}:${process.env.PATH}` }))
  systemctl('daemon-reload')
  systemctl('restart', 'ci-brokerd.service')
  console.log('ci-brokerd restarted on this checkout')
  return 0
}

const realProc = (cmd: string, args: string[], stdin?: string): Promise<Proc> =>
  new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (b: Buffer) => (stdout += b))
    p.stderr.on('data', (b: Buffer) => (stderr += b))
    p.on('error', (e) => resolve({ code: 127, stdout, stderr: e.message }))
    p.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
    p.stdin.on('error', () => {})
    p.stdin.end(stdin ?? '')
  })

/** a token: stdin with --token-stdin, else a tty prompt with echo off; never an argv */
async function readTokenFrom(a: Parsed): Promise<string> {
  if (a.flags.token !== undefined) throw new Exit(2, '--token is gone (argv shows in the process list): pass it on stdin with --token-stdin')
  if (a.flags['token-stdin'] || !process.stdin.isTTY) {
    let s = ''
    for await (const c of process.stdin) {
      s += c
      if (s.includes('\n') || s.length > 1024) break
    }
    return s.split('\n')[0]
  }
  process.stderr.write('registration token (not echoed): ')
  spawnSync('stty', ['-echo'], { stdio: 'inherit' })
  try {
    const s = await new Promise<string>((r) => process.stdin.once('data', (b) => r(String(b))))
    return s.split('\n')[0]
  } finally {
    spawnSync('stty', ['echo'], { stdio: 'inherit' })
    process.stderr.write('\n')
  }
}

export async function runnerCli(a: Parsed, cfg: Config, client: Client, splitSockets: string[] = []): Promise<number> {
  const deps: RunnerDeps = {
    runnerctl: (args, stdin) => realProc('sudo', ['-n', RUNNERCTL, ...args], stdin),
    sys: (cmd, args) => realProc(cmd, args),
    client,
    out: (s) => void process.stdout.write(s),
    err: (s) => void process.stderr.write(s),
    readToken: () => readTokenFrom(a),
    host: shortHost() || hostname(),
  }
  try {
    if (a.cmd === 'install') return install()
    if (a.cmd === 'update') {
      if (!(cfg.layout === 'split' || client.hello?.layout === 'split')) return await updateSingle(client)
      // a release has no .git: name the checkout whose origin/main is the update
      const checkout = a.flags.checkout ?? (existsSync(join(ROOT, '.git')) ? ROOT : null)
      if (!checkout) throw new Exit(2, 'usage: ci-broker update --checkout <your ci-broker checkout> (this client runs from a release)')
      return await updateSplit(deps, cfg, checkout)
    }
    if (a.cmd === 'switch-to-split') {
      if (!a.flags.checkout) throw new Exit(2, 'usage: ci-broker switch-to-split --checkout <the live checkout dir>')
      const singleSock = join(homedir(), '.local/state/ci-broker/brokerd.sock')
      const { Client: C } = await import('./client/http.ts')
      return await switchToSplit({ ...deps, single: new C(singleSock), split: () => pickClient(splitSockets.slice(0, 1)), checkout: a.flags.checkout })
    }
    const [sub, what] = a.positional
    if (cfg.layout !== 'split' && client.hello?.layout !== 'split') throw new Exit(2, 'runners need the split layout (a runner user, system units, runnerctl): an admin must run scripts/install.sh first (README: Install)')
    if (sub === 'ls') return await ls(deps)
    if (sub === 'add') {
      if (a.flags.token !== undefined) throw new Exit(2, '--token is gone (argv shows in the process list): pass it on stdin with --token-stdin')
      return await add(deps, what ?? '', Number(a.flags.count ?? cfg.runnersPerRepo))
    }
    if (sub === 'rm') {
      if (a.flags['token-stdin'] || a.flags.token !== undefined) throw new Exit(2, 'runner rm takes no token: it never runs anything from a runner dir; delete the runner on GitHub at the URL it prints')
      return await rm(deps, what ?? '')
    }
    if (sub === 'migrate') {
      if (a.flags.verify) return await verify(deps)
      if (a.flags.finish) return await finish(deps)
      return await migrate(deps, cfg)
    }
    throw new Exit(2, `unknown runner command '${sub ?? ''}' (add, rm, ls, migrate)`)
  } catch (e) {
    if (e instanceof Exit) {
      process.stderr.write(`ci-broker: ${e.message}\n`)
      return e.code
    }
    throw e
  }
}

export { Exit }
