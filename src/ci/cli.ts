// ci-broker: the client of ci-brokerd (see README.md). A thin CLI over the daemon's unix socket.
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { defaultConfigPath, defaults, loadConfig, type Config } from './config.ts'
import * as cmd from './client/commands.ts'
import { admit } from './client/admit.ts'
import { dispatch } from './client/dispatch.ts'
import { ApiError, Client, DaemonDown, EXIT_REFUSED, GhDoorClient, ghRunClaims, pickClient, refusedLine, TrustRefused } from './client/http.ts'
import { realSys } from './daemon/daemon.ts'
import { submit } from './client/submit.ts'
import { derivePaths, readInstallConf } from './install-conf.ts'
import { waitLocalSlot } from './local.ts'

const BOOL = new Set(['cancel', 'dry-run', 'json', 'help', 'force', 'github', 'no-status', 'detach', 'f', 'follow', 'use-reserve', 'token-stdin', 'run', 'verify', 'finish', 'wait'])

/**
 * The client's view of the layout. split (install.conf, no CI_BROKER_CONFIG): the sockets and the lock from install.conf,
 * then single's as the fallback while the old daemon still answers; single: the operator's config as before.
 */
/** `submit --github` with CI_BROKER_GITHUB_SOCKET in the env (the new runners): the GitHub door. Unset (the old
 * runners during the migration): null, the local socket. */
export function githubClient(a: Parsed, env: NodeJS.ProcessEnv): GhDoorClient | null {
  const sock = a.cmd === 'submit' && a.flags.github ? env.CI_BROKER_GITHUB_SOCKET : undefined
  return sock ? new GhDoorClient(sock, ghRunClaims(env)) : null
}

export function clientConfig(env: NodeJS.ProcessEnv = process.env): { cfg: Config; sockets: string[]; splitLock: string | null; githubSocket: string | null } {
  const single = loadConfig(defaultConfigPath(env), env)
  const ic = env.CI_BROKER_CONFIG ? null : readInstallConf(env)
  if (!ic) return { cfg: single, sockets: [single.socketPath], splitLock: null, githubSocket: null }
  const p = derivePaths(ic)
  return { cfg: { ...defaults(env), ...single, layout: 'split', releaseFile: p.releaseFile, operator: ic.OPERATOR, installConf: ic }, sockets: [p.socketPath, single.socketPath], splitLock: p.localLockPath, githubSocket: p.githubSocketPath }
}

export type Parsed = { cmd: string; flags: Record<string, string>; positional: string[]; rest: string[] }

/** the commands that talk to the daemon (the client looks for its socket only for these) */
export const DAEMON_CMDS = new Set(['admin-seed', 'submit', 'status', 'jobs', 'show', 'logs', 'cancel', 'resources', 'check', 'drain', 'gc', 'doctor', 'trust', 'daemon-log', 'local-lock', 'runner', 'switch-to-split', 'update'])

/** the flags of the commands that start a run (any other flag refuses before the config or a socket is read) */
export const START_FLAGS: Record<string, Set<string>> = {
  submit: new Set(['repo', 'profile', 'mode', 'sha', 'force', 'github', 'no-status', 'artifacts', 'label', 'detach']),
  dispatch: new Set(['repo', 'sha', 'mode']),
}

export function parseArgs(argv: string[]): Parsed {
  const out: Parsed = { cmd: argv[0] ?? 'help', flags: {}, positional: [], rest: [] }
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') {
      out.rest = argv.slice(i + 1)
      break
    }
    if (a.startsWith('-') && a.length > 1) {
      const name = a.replace(/^--?/, '')
      const eq = name.indexOf('=')
      if (eq > 0) out.flags[name.slice(0, eq)] = name.slice(eq + 1)
      else if (BOOL.has(name)) out.flags[name] = 'true'
      else out.flags[name] = argv[++i] ?? ''
    } else out.positional.push(a)
  }
  return out
}

const USAGE = `ci-broker — run a repo's test suites through this machine's ci-brokerd (local slot, ssh hosts, Boat boxes, GitHub-hosted)

  ci-broker submit [--repo <path|owner/name>] [--profile P] [--mode M] [--sha S] [--force] [--no-status]
                   [--github] [--artifacts <dir>] [--label <text>] [--detach] [-- args…]
                                          run the working tree (or --sha), stream it, print the receipt;
                                          exit 0 passed, 1 failed, 2 error, 130 cancelled. --github (in a workflow
                                          step, run with exec): annotations, step summary, ci-broker-artifacts/
  ci-broker status                        queue, running jobs, resources, slots, health, boxes, github runs, starts left
  ci-broker jobs [--repo R] [--limit N]   recent jobs
  ci-broker show <job>                    one job: shards, placements and why, receipt
  ci-broker logs <job> [--shard S] [-f]   output; -f follows
  ci-broker cancel <job>
  ci-broker check <resource> [<profile>] [--use-reserve]
                                          run the profile's check on a resource (every declared profile when none
                                          is given): pass clears failing, fail sets it; exit 0 pass, 1 fail, 3 not
                                          checked (e.g. no Boat budget above the reserve, unless --use-reserve)
  ci-broker resources [reset <id>]        health; reset clears failing flags and quarantine
  ci-broker drain                         stop starting shards; the daemon exits when none run
  ci-broker gc                            run the timers' work now (Boat reconcile, idle stop, prune)
  ci-broker doctor                        daemon (its own checks), gh, boat, docker, resources
  ci-broker local-lock -- <cmd…>          run a command holding this machine's local test slot
  ci-broker trust                         approved lists, known repos' tiers and lanes, runners, blocks
  ci-broker trust log [--limit N] [--repo R]
                                          refusals, GitHub-door admissions and offline fallbacks, newest first
  ci-broker trust check <owner/name>      the local-door checks now, one line per check
  ci-broker trust check --run <owner/name> <runId> [--attempt N] [--sha S --mode M] [-- args…]
                                          replay the GitHub-door checks against the live API (records nothing)
  ci-broker trust unblock <owner/name>    after review: lift a watchdog block (the repo must be private again)
  ci-broker dispatch [--repo R] --sha S [--mode M] [-- args…]
                                          gh workflow run broker.yml with the args digest in the run name
  ci-broker admit                         the runner's pre-job hook (GitHub door)
  ci-broker daemon-log [-f] [-n N]        the daemon's own log (scrubbed)
  ci-broker admin-seed <n>                a fresh split daemon's first job id (the switch does it; once)
  ci-broker runner add <owner/name> [--count N] --token-stdin | runner ls | runner rm <owner/name>|<id>
  ci-broker runner migrate --token-stdin | --verify | --finish
                                          single's user-unit runners → the runner user's (spec Rollout 6, 7, 9)
  ci-broker drain [--wait | --cancel]     stop starting shards (exit when none run); --wait: refuse new submits
                                          (they wait), let placed and queued jobs finish, return when idle;
                                          --cancel: end a --wait drain (submits go through again)
  ci-broker update                        split: print the admin's install.sh --release command; single: wait for
                                          idle, rewrite the user unit, restart on this checkout
  ci-broker switch-to-split --checkout <dir>
                                          the rollout's drained window: single's daemon off, the split one on, ids seeded
  ci-broker install                       single: ~/.local/bin/ci-broker{,d} + the ci-brokerd user service

  Exit 77: refused by a trust check (the reason is printed; never a test's own exit code).
`

export async function main(argv: string[]): Promise<number> {
  const a = parseArgs(argv)
  const out0 = (s: string) => void process.stdout.write(s)
  // --help on any command prints the usage and stops: `submit --help` must never submit (args after -- are the job's)
  if (a.flags.help) return out0(USAGE), 0
  // the commands that start work take only their own flags: a stray one (`submit --dry-run`) is a mistake, not a run
  const known = START_FLAGS[a.cmd]
  const stray = known ? Object.keys(a.flags).filter((f) => !known.has(f)) : []
  if (stray.length) {
    process.stderr.write(`ci-broker ${a.cmd}: unknown flag --${stray[0]} (nothing was started; ci-broker --help)\n`)
    return 2
  }
  // nor a bare word: `submit cmd -- x` would run mode all (the mode is --mode; the job's args go after --)
  if (known && a.positional.length) {
    process.stderr.write(`ci-broker ${a.cmd}: unexpected '${a.positional[0]}' (nothing was started; the mode is --mode ${a.positional[0]}, the job's args go after --)\n`)
    return 2
  }
  // the pre-job hook: the GitHub socket only, nothing from the operator's config
  if (a.cmd === 'admit') return admit(process.env, { out: out0 })
  const cc = clientConfig()
  const cfg = cc.cfg
  const pick = () => pickClient(cc.sockets)
  // a runner job (`submit --github`) with the GitHub door in its env talks only to it; without, the local socket
  const gh = githubClient(a, process.env)
  const ghSock = gh?.socket
  // only a command that talks to the daemon looks for it (help, dispatch, install never touch a socket)
  const client: Client = gh ?? (DAEMON_CMDS.has(a.cmd) ? await pick() : new Client(cc.sockets[0]))
  const out = (s: string) => void process.stdout.write(s)
  const err = (s: string) => void process.stderr.write(s)
  const need = (i: number, what: string) => {
    if (!a.positional[i]) throw new Error(`usage: ci-broker ${a.cmd} <${what}>`)
    return a.positional[i]
  }
  try {
    switch (a.cmd) {
      case 'submit': {
        const ac = new AbortController()
        for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => ac.abort())
        return await submit(client, {
          repo: a.flags.repo, profile: a.flags.profile, mode: a.flags.mode ?? 'all', sha: a.flags.sha, force: !!a.flags.force,
          github: !!a.flags.github, noStatus: !!a.flags['no-status'], artifacts: a.flags.artifacts, label: a.flags.label, detach: !!a.flags.detach,
          args: a.rest, cwd: process.cwd(), maxFileMb: cfg.snapshotMaxFileMb, interestGraceSec: cfg.interestGraceSec, out, err, signal: ac.signal, pick: ghSock ? undefined : pick,
        })
      }
      case 'status':
        return await cmd.status(client, out)
      case 'jobs':
        return await cmd.jobs(client, out, { repo: a.flags.repo, limit: a.flags.limit })
      case 'show':
        return await cmd.show(client, out, need(0, 'job'))
      case 'logs': {
        const ac = new AbortController()
        process.on('SIGINT', () => ac.abort())
        return await cmd.logs(client, out, need(0, 'job'), { shard: a.flags.shard, follow: !!(a.flags.f || a.flags.follow) }, ac.signal)
      }
      case 'cancel':
        return await cmd.cancel(client, out, need(0, 'job'))
      case 'resources':
        return await cmd.resources(client, out, a.positional)
      case 'check': {
        const ac = new AbortController()
        process.on('SIGINT', () => ac.abort())
        return await cmd.check(client, out, need(0, 'resource'), a.positional[1], !!a.flags['use-reserve'], ac.signal)
      }
      case 'drain':
        if (a.flags.cancel) {
          await client.request('POST', '/drain', { cancel: true })
          out('drain cancelled: submits are accepted again\n')
          return 0
        }
        if (a.flags.wait) {
          const { drainWait } = await import('./runner.ts')
          await drainWait(client, out)
          return 0
        }
        return await cmd.drain(client, out)
      case 'gc':
        return await cmd.gc(client, out)
      case 'doctor':
        return await cmd.doctor(client, out, cfg)
      case 'trust':
        return await cmd.trust(client, out, a)
      case 'admin-seed': {
        const n = Number(a.positional[0])
        if (!Number.isInteger(n) || n < 1) throw new Error('usage: ci-broker admin-seed <next job id> (once, on a fresh split daemon)')
        const r = await client.request('POST', '/admin/seed', { nextId: n })
        out(`job ids continue at ${r.next}\n`)
        return 0
      }
      case 'dispatch':
        return await dispatch({ repo: a.flags.repo, sha: a.flags.sha, mode: a.flags.mode ?? 'all', args: a.rest, cwd: process.cwd(), out, gh: (args) => realSys('gh', args, 60) })
      case 'daemon-log': {
        const ac = new AbortController()
        process.on('SIGINT', () => ac.abort())
        return await cmd.daemonLog(client, out, { follow: !!(a.flags.f || a.flags.follow), n: a.flags.n }, ac.signal)
      }
      case 'local-lock': {
        if (!a.rest.length) throw new Error('usage: ci-broker local-lock -- <cmd…>')
        // the lock of the daemon that answers: split's shared one, or single's in the state dir
        const slot = await waitLocalSlot(client.hello?.layout === 'split' && cc.splitLock ? cc.splitLock : join(cfg.stateDir, 'local.lock'))
        const code = await new Promise<number>((res) => spawn(a.rest[0], a.rest.slice(1), { stdio: 'inherit' }).on('close', (c) => res(c ?? 1)))
        await slot.release()
        return code
      }
      case 'runner':
      case 'install':
      case 'update':
      case 'switch-to-split': {
        const r = await import('./runner.ts')
        return await r.runnerCli(a, cfg, client, cc.sockets)
      }
      default:
        out(USAGE)
        return a.cmd === 'help' || a.flags.help ? 0 : 2
    }
  } catch (e) {
    if (e instanceof TrustRefused) {
      err(`${refusedLine(e)}\n`)
      return EXIT_REFUSED
    }
    if (e instanceof DaemonDown || e instanceof ApiError) {
      err(`ci-broker: ${e.message}\n`)
      return 2
    }
    throw e
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`ci-broker: ${(e as Error).message}\n`)
      process.exit(2)
    },
  )
}
