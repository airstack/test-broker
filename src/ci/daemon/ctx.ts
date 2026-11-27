// What the daemon's parts share. Everything time- or process-dependent is injected here so tests drive it.
import type { Boat } from '../../core/boat.ts'
import type { Config, ResourceCfg } from '../config.ts'
import type { Credentials } from '../credentials.ts'
import type { Db, TrustDb } from '../db.ts'
import type { Profile } from '../profile.ts'
import type { GithubApi } from './github-api.ts'
import type { Trust } from './trust.ts'
import type { Slot } from '../local.ts'
import type { BoatPool } from '../../core/boatpool.ts'
import type { Checks } from './checks.ts'
import type { GithubExecutor } from './exec-github.ts'
import type { SshExecutor } from './exec-ssh.ts'
import type { Jobs } from './jobs.ts'
import type { Mirror } from '../../core/mirror.ts'
import type { Scheduler } from './scheduler.ts'
import type { ShardRunner } from './shard.ts'
import type { Statuses } from './statuses.ts'
import type { JobStreams } from './stream.ts'

/** Runs an external command with a timeout; never throws (look at `code`). */
export type Sys = (cmd: string, args: string[], timeoutSec?: number, env?: NodeJS.ProcessEnv) => Promise<{ code: number; stdout: string; stderr: string }>

export type Ctx = {
  cfg: Config
  resources: ResourceCfg[]
  db: Db
  boat: Boat
  streams: JobStreams
  mirror: Mirror
  /** null when no boat resource is configured */
  pool: BoatPool | null
  jobs: Jobs
  /** null when no ssh / github resource is configured */
  sshExec: SshExecutor | null
  githubExec: GithubExecutor | null
  checks: Checks
  scheduler: Scheduler
  shards: ShardRunner
  now: () => number
  log: (msg: string) => void
  load: () => { load1: number; nproc: number }
  /** try to take this machine's local slot (the flock shared with `ci-broker local-lock`) */
  localLock: () => Promise<Slot | null>
  sys: Sys
  /** runs `gh <args>` (commit statuses, github resources); tests inject a fake */
  gh: (args: string[], timeoutSec?: number) => ReturnType<Sys>
  statuses: Statuses
  /** values the scrubber hides */
  secrets: Set<string>
  /** hide the secrets (and token shapes) in text bound for the DB, a stream or the log */
  scrub: (s: string) => string
  /** remember a background promise (idle() waits for them) */
  track: (p: Promise<unknown>) => void
  /** job ids recovered at boot that wait for a pin or an interest before they may run */
  held: Set<number>
  bootAt: number
  /** restart recovery is running: the scheduler places nothing and checks take no capacity until it is done */
  recovering: boolean
  draining: boolean
  /** called once a drain has nothing left running */
  onDrained: () => void
  /** `<daemonId>-<n>` */
  jobName: (id: number) => string
  tdb: TrustDb
  trust: Trust
  api: GithubApi
  creds: Credentials
  /** load a profile by name (split: an operator file, read into the daemon's own snapshot). Throws ProfileError. */
  profile: (name: string) => Profile
  /** a job's profile: the snapshot it was admitted with (its row's profileDir), else by name */
  jobProfile: (job: { profile: string; profileDir: string }) => Profile
  /** the watchdog's last check of the public network (null: not checked yet) */
  netCheck: { ok: boolean; why: string; at: number } | null
  /** the GitHub door: 'open', or 'closed: <why>' (single: 'none') */
  githubDoor: string
  /** the local door's dir check failed (split): why */
  localDoor: string
  /** a drain for the switch to split: new submits get 503 "draining for switch", placed work goes on */
  switchDrain: boolean
  /** a fresh split state takes no job until /admin/seed (the switch puts job ids above the old daemon's) */
  awaitSeed: boolean
  /** the release this daemon's code came from (its RELEASE file), null for a checkout */
  ownRelease: string | null
  /** where the system units live (doctor reads the runner units and the host-address drop-in) */
  systemdDir: string
  /** this machine's network addresses (doctor checks the host-address drop-in against them) */
  hostAddrs: () => string[]
  /** the daemon's own log file (GET /daemon-log); null = not teed */
  logFile: string | null
}
