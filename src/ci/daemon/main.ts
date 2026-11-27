// ci-brokerd entry: take the one-daemon lock, open the socket(s) at once, recover in the background, start the timers.
// `--warm-mirrors`: clone every profile repo's mirror and exit (split, before the switch; takes the same lock).
import { chmodSync, closeSync, constants, existsSync, openSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CliBoat } from '../../core/boat.ts'
import { loadAnyConfig, type Config } from '../config.ts'
import { INSTALL_CONF, lookupId } from '../install-conf.ts'
import { tryLock, type Slot } from '../local.ts'
import { Daemon } from './daemon.ts'
import { openGithubDoor } from './gh-door.ts'
import { DoorClosed, listen } from './server.ts'

/**
 * Last-resort handlers. A rejected promise nobody awaited is a lost result, not broken state: log it and keep running.
 * An uncaught exception means a synchronous path threw half-way (the in-memory running set, slot locks and the DB may
 * now disagree): log it loudly and exit, so systemd restarts the daemon and recovery puts the state right from the DB
 * (running shards are re-queued). The known throw sites (output callbacks, the tick) catch their own errors.
 */
export function crashHandlers(log: (m: string) => void, exit: (code: number) => void) {
  return {
    unhandledRejection: (e: unknown) => log(`unhandled rejection (still running): ${(e as Error)?.stack ?? e}`),
    uncaughtException: (e: unknown) => {
      log(`FATAL uncaught exception; exiting for a restart + recovery: ${(e as Error)?.stack ?? e}`)
      exit(1)
    },
  }
}

/** Why this daemon may not start, or null. `single` never runs while a split install exists. */
export function startProblem(cfg: Config, env: NodeJS.ProcessEnv = process.env): string | null {
  const ic = env.CI_BROKER_INSTALL_CONF || INSTALL_CONF
  if (cfg.layout === 'single' && existsSync(ic)) return `${ic} exists: this machine runs the split daemon (the system unit ci-brokerd.service); a single daemon refuses to start`
  if (cfg.layout === 'split' && cfg.installConf) {
    const uid = lookupId('user', cfg.installConf.DAEMON_USER)
    if (uid !== process.getuid!()) return `split: the daemon runs as ${cfg.installConf.DAEMON_USER} (sudo -n ci-broker-runnerctl daemon start), not as uid ${process.getuid!()}`
  }
  return null
}

/** split: the local slot's lock file exists from the start, 0660 (the operator's group from the setgid dir): the
 * operator can't create it in the 2750 dir, and `ci-broker local-lock` needs it before the first local job. */
export function ensureLocalLock(path: string) {
  closeSync(openSync(path, constants.O_RDONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o660))
  chmodSync(path, 0o660)
}

/** The one-daemon flock (both layouts). null: another daemon holds it. */
export async function takeDaemonLock(cfg: Config): Promise<Slot | null> {
  return tryLock(cfg.daemonLockPath)
}

export function newDaemon(cfg: Config, extra: Partial<ConstructorParameters<typeof Daemon>[0]> = {}) {
  let d: Daemon
  const boat = new CliBoat(cfg.boatBin, cfg.boatCallTimeoutSec, () => d.c.creds.boatEnv())
  d = new Daemon({ cfg, boat, logFile: join(cfg.stateDir, 'daemon.log'), ...extra })
  return d
}

/** `--warm-mirrors`: every profile repo's mirror, cloned/fetched. */
export async function warmMirrors(d: Daemon): Promise<number> {
  const c = d.c
  const dir = c.cfg.profilesDir
  let bad = 0
  for (const n of existsSync(dir) ? readdirSync(dir).filter((x) => !x.startsWith('.')) : []) {
    try {
      const p = c.profile(n)
      await c.mirror.ensure(p.repo)
      c.log(`warm: ${p.repo} (profile ${n}) mirrored`)
    } catch (e) {
      bad++
      c.log(`warm: profile ${n}: ${(e as Error).message}`)
    }
  }
  return bad ? 1 : 0
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const cfg = loadAnyConfig()
  const why = startProblem(cfg)
  if (why) throw new Error(why)
  const lock = await takeDaemonLock(cfg)
  if (!lock) throw new Error(`another ci-brokerd holds ${cfg.daemonLockPath}; refusing to start a second one`)
  if (argv.includes('--warm-mirrors')) {
    const d = newDaemon(cfg)
    await d.c.creds.load()
    const code = await warmMirrors(d)
    await lock.release()
    process.exit(code)
  }
  const servers: { close(): void }[] = []
  const exit = (code: number) => {
    for (const s of servers) s.close()
    process.exit(code)
  }
  const d = newDaemon(cfg, { onDrained: () => (d.c.log('drain: nothing running; exiting'), exit(0)) })
  const crash = crashHandlers((m) => d.c.log(m), exit)
  process.on('unhandledRejection', crash.unhandledRejection)
  process.on('uncaughtException', crash.uncaughtException)
  if (cfg.layout === 'split') {
    // the token is a file read: before the socket opens, so the first GitHub call has it
    await d.c.creds.load()
    const gid = lookupId('group', cfg.installConf!.OPERATOR_GROUP)
    try {
      servers.push(await listen(d, cfg.socketPath, { dirCheck: { uid: process.getuid!(), gid: gid ?? -1, mode: 0o2750 }, sockMode: 0o660 }))
    } catch (e) {
      if (!(e instanceof DoorClosed)) throw e
      d.c.localDoor = `closed: ${e.message}`
      d.c.log(`LOCAL DOOR CLOSED: ${e.message}`)
    }
    if (d.c.localDoor === 'open') ensureLocalLock(cfg.localLockPath)
    servers.push(...(await openGithubDoor(d)))
  } else {
    servers.push(await listen(d, cfg.socketPath))
    // `gh auth token` can take seconds: read after the socket is open; the scrubber hides it from then on
    d.c.creds.load().then((t) => !t && d.c.log('GitHub credential: none (tokenCmd failed or empty); only token patterns are scrubbed'))
    // `cmd` job secrets: run once now (async), so admission and doctor see them; the timers refresh them
    void d.c.creds.refreshSecrets()
  }
  d.c.log(`ci-brokerd ${cfg.daemonId} (${cfg.layout}): listening on ${cfg.socketPath}${cfg.githubSocketPath ? ` and ${cfg.githubSocketPath} (GitHub door ${d.c.githubDoor})` : ''} (state ${cfg.stateDir}; resources ${d.c.resources.map((r) => `${r.id}:${r.kind}`).join(', ')})`)
  if (cfg.releaseFile) {
    const cur = existsSync(cfg.releaseFile) ? readFileSync(cfg.releaseFile, 'utf8').split('\n')[0].trim() : null
    if (cur && d.c.ownRelease && cur !== d.c.ownRelease) d.c.log(`WARNING: the current release is ${cur.slice(0, 12)}, this daemon runs ${d.c.ownRelease.slice(0, 12)} (restart it)`)
  }
  d.recover().catch((e) => d.c.log(`recovery failed: ${(e as Error).stack ?? e}`))
  d.timers.start()
  for (const sig of ['SIGTERM', 'SIGINT'] as const)
    process.on(sig, () => {
      // running shards are re-queued by the next start's recovery
      d.c.log(`${sig}: exiting`)
      exit(0)
    })
}

if (import.meta.main) {
  main().catch((e) => {
    process.stderr.write(`ci-brokerd: ${(e as Error).message}\n`)
    process.exit(1)
  })
}
