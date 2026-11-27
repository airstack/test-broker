// A daemon in a temp dir for tests: temp state dir + profiles + local bare "origins", FakeBoat, a test clock, a fake
// local lock and load, and helpers to make commits and wait for conditions.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaults, type Config, type ResourceCfg } from '../src/ci/config.ts'
import { Daemon, type DaemonDeps } from '../src/ci/daemon/daemon.ts'
import type { LocalRun } from '../src/ci/local.ts'
import { FakeBoat, ShardControl } from './fake-boat.ts'
import { FakeGithubApi, SIMPLE10, VU } from './fake-github-api.ts'

import './tmp-root.ts'
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_NOSYSTEM = '1'

export const tmp = (p = 'cib-t-') => mkdtempSync(join(tmpdir(), p))

export function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}
const ident = ['-c', 'user.email=t@t', '-c', 'user.name=t']

/** A bare origin at <root>/<owner>/<name>.git with one commit on main; returns the commit. */
export function makeOrigin(root: string, repo: string, files: Record<string, string> = { 'f.txt': 'v1\n' }): { bare: string; sha: string; work: string } {
  const bare = join(root, `${repo}.git`)
  mkdirSync(bare, { recursive: true })
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare])
  const work = tmp('cib-work-')
  execFileSync('git', ['clone', '-q', bare, work], { stdio: 'ignore' })
  sh(work, 'checkout', '-q', '-b', 'main')
  for (const [f, c] of Object.entries(files)) writeFileSync(join(work, f), c)
  sh(work, 'add', '-A')
  sh(work, ...ident, 'commit', '-qm', 'one')
  sh(work, 'push', '-q', 'origin', 'main')
  return { bare, sha: sh(work, 'rev-parse', 'HEAD'), work }
}

/** Commit a change in a clone and push it; returns the sha. */
export function pushCommit(work: string, file: string, content: string): string {
  writeFileSync(join(work, file), content)
  sh(work, 'add', '-A')
  sh(work, ...ident, 'commit', '-qm', `edit ${file}`)
  sh(work, 'push', '-q', 'origin', 'HEAD:main')
  return sh(work, 'rev-parse', 'HEAD')
}

export const TEST_PROFILE = {
  name: 'app',
  repo: 'me/app',
  boatEnvironment: 'acme',
  remoteScript: 'remote.sh',
  infraExitCodes: [89, 90, 91, 92, 93, 96],
  artifacts: ['out'],
  local: { where: 'host', commands: { cmd: '{cmd}', 'test-all': 'echo local-test-all' } },
  modes: {
    'test-all': [
      { name: 'a', size: 'default', args: ['a'] },
      { name: 'b', size: 'default', args: ['b'] },
      { name: 'c', size: 'default', args: ['c'] },
    ],
    e2e: [{ name: 'e2e', size: 'large', args: ['e2e'], passArgs: true }],
    one: [{ name: 'one', size: 'default', args: ['one'] }],
    cmd: [{ name: 'cmd', size: 'default', args: ['cmd'], passArgs: true, requireArgs: "ci-broker submit --mode cmd -- '<shell command>'" }],
  },
}

export type Harness = {
  d: Daemon
  boat: FakeBoat
  ctl: ShardControl
  cfg: Config
  root: string
  origins: string
  logs: string[]
  clock: { t: number }
  advance: (ms: number) => void
  local: { busy: boolean; load: number; runs: (LocalRun & { finish: (code: number) => void })[] }
  /** the fake `gh`: every call's args; `fail` makes the next calls exit 1 with that stderr */
  gh: { calls: string[][]; fail: string | null }
  /** the fake GitHub REST API behind the trust layer (every repo private with push unless set) */
  github: FakeGithubApi
  submit: (o: { repo?: string; mode?: string; args?: string[]; sha: string; detach?: boolean; force?: boolean; profile?: string; wantStatus?: boolean; tree?: string }) => Promise<any>
  /** run a scheduler pass and wait until nothing runs in the background (shards held by `ctl` never end: use pass) */
  settle: () => Promise<void>
  /** wake the scheduler and wait for its passes to finish */
  pass: () => Promise<void>
}

export function harness(o: { resources?: ResourceCfg[] | null; cfg?: Partial<Config>; profile?: any; deps?: Partial<DaemonDeps>; boat?: FakeBoat; root?: string } = {}): Harness {
  const root = o.root ?? tmp('cib-d-')
  const origins = join(root, 'origins')
  const profiles = join(root, 'profiles')
  const p = o.profile ?? TEST_PROFILE
  mkdirSync(join(profiles, p.name), { recursive: true })
  writeFileSync(join(profiles, p.name, 'profile.json'), JSON.stringify(p))
  writeFileSync(join(profiles, p.name, 'remote.sh'), 'echo "remote $*"; mkdir -p "$HOME/cib/$CIB_SLOT/me__app/out" && echo art > "$HOME/cib/$CIB_SLOT/me__app/out/a.txt"\n')
  const cfg: Config = {
    ...defaults({ HOME: root }),
    daemonId: 'tst',
    stateDir: join(root, 'state'),
    socketPath: join(root, 'state', 'brokerd.sock'),
    gitUrl: `${origins}/{repo}.git`,
    profilesDir: profiles,
    resources: o.resources === undefined ? [{ id: 'boat', kind: 'boat', profiles: ['*'], maxBoxes: 4 }] : o.resources,
    localLockPath: join(root, 'state', 'local.lock'),
    daemonLockPath: join(root, 'state', 'daemon.lock'),
    ...o.cfg,
  }
  cfg.trust = { ...cfg.trust, githubUsers: [SIMPLE10, VU], ...o.cfg?.trust }
  const github = new FakeGithubApi()
  github.everyRepo = { private: true, push: true }
  const boat = o.boat ?? new FakeBoat()
  const ctl = new ShardControl()
  boat.onCommand = ctl.handle
  const logs: string[] = []
  const clock = { t: 1_700_000_000_000 }
  const local: Harness['local'] = { busy: false, load: 0, runs: [] }
  const gh: Harness['gh'] = { calls: [], fail: null }
  const d = new Daemon({
    cfg, boat,
    now: () => clock.t,
    log: (m) => logs.push(m),
    load: () => ({ load1: local.load, nproc: 8 }),
    localLock: async () => {
      if (local.busy) return null
      local.busy = true
      return { release: async () => void (local.busy = false) }
    },
    sys: async () => ({ code: 0, stdout: '', stderr: '' }),
    ghApi: github.run,
    apiSleep: async () => {},
    gh: async (args) => {
      gh.calls.push(args)
      return gh.fail ? { code: 1, stdout: '', stderr: gh.fail } : { code: 0, stdout: '{}', stderr: '' }
    },
    runLocal: (r) =>
      new Promise<number>((resolve) => {
        const run = Object.assign(r, { finish: (code: number) => resolve(code) })
        local.runs.push(run)
        r.signal?.addEventListener('abort', () => resolve(130), { once: true })
      }),
    ...o.deps,
  })
  const h: Harness = {
    d, boat, ctl, cfg, root, origins, logs, clock, local, gh, github,
    advance: (ms) => void (clock.t += ms),
    submit: (s) => d.c.jobs.submit({ repo: s.repo ?? 'me/app', profile: s.profile ?? 'app', mode: s.mode ?? 'test-all', args: s.args ?? [], commit: s.sha, detach: s.detach ?? true, force: s.force, wantStatus: s.wantStatus, tree: s.tree }),
    pass: async () => {
      d.c.scheduler.wake()
      await d.c.scheduler.idle()
    },
    settle: async () => {
      d.c.scheduler.wake()
      await d.idle()
    },
  }
  return h
}

/** Wait for a condition by yielding to the event loop (no fixed sleeps). */
export async function until(cond: () => boolean, what = 'condition', maxMs = 10_000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > maxMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setImmediate(r))
  }
}

export const idOf = (s: string) => Number(s.split('-').pop())
