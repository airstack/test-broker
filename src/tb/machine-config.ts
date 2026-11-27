// test-broker's machine settings: ~/.config/test-broker/config.json over defaults. Paths for its state and socket.
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { SPEED_DEFAULTS, type SpeedConfig } from './boxspeed.ts'

export const BOX_SIZES = ['small', 'default', 'large', 'xlarge'] as const
export type BoxSize = (typeof BOX_SIZES)[number]

export type MachineConfig = {
  /** the share of nproc test-broker grants to local runs */
  budgetFactor: number
  boatBin: string
  boat: {
    maxBoxes: number
    /** Boat starts per day kept back for the operator */
    startsReserve: number
    /** every shard must be running within this long of the answer, else the run is cancelled */
    startDeadlineSec: number
    /** default no-output limit per shard (a suite may set its own) */
    silentSec: number
    /** an idle running box is stopped after this long */
    idleStopMin: number
    /** an idle box past its pool's warm target is stopped after this long (the warm pool; at idleStopMin or more: off) */
    shortIdleMin: number
    /** an agent's hint (`test-broker hint`) counts this long with no test run */
    hintTtlMin: number
    /** the most a shard waits for a busy box (caps the repos' and suites' maxWaitSec; 0: no shard waits) */
    maxWaitSec: number
    /** a stopped box is deleted after this long unused */
    stoppedDeleteHours: number
    /**
     * Boat outage pause: this many box starts that fail (a create, resume or upload) within outageWindowMin, on at
     * least 2 boxes, pause Boat for outagePauseMin. Runs go local meanwhile; then one ask tries Boat again, and a
     * failure there pauses it again at once. 0: never pause.
     */
    outageFails: number
    outageWindowMin: number
    outagePauseMin: number
    /** box TTL given to `boat new` / extended on use */
    ttlSec: number
    /** a failed shard's artifacts larger than this (compressed) are not brought back */
    artifactsMaxMb: number
    /** the box sizes this machine may use; a suite with a shard of another size runs locally */
    sizes: BoxSize[]
    /** GitHub owners whose private repos may run on Boat; [] = none */
    owners: string[]
    /** names this dev box's pools on the Boat account (`tbx-<hostId>-<pool>…`): unique per dev box */
    hostId: string
    /** per repo (owner/name): its remote script's infra exit codes, for a repo whose .test-broker.json sets none */
    infraExitCodes: Record<string, number[]>
    /**
     * Shards share boxes by units (1 unit = 2 CPUs + 4 GB; small 1, default 2, large 4) and RAM (a shard's memGb, else 4 GB a unit): each shard gets its own slot
     * on the box, its own CPUs (taskset) and CIB_SLOT/CIB_UNITS/CIB_CPUS/CIB_CPUSET/CIB_MEM_MB. Off: one shard per box,
     * as before. Turn it on only when every repo's remote script keeps its slots apart (ports, dirs).
     */
    packing: boolean
    /** box speed: slow boxes go last, or are retired; see boxspeed.ts */
    speed: SpeedConfig
  }
  /** run logs and artifacts in the state dir are deleted after this many days */
  keepDays: number
  /** run logs (and big text artifacts) older than this are compressed */
  compressAfterHours: number
  /** steering of heavy test runs, from runs.db */
  steer: SteerConfig
}

/**
 * Steering: when to answer a heavy run with the repo's advice (exit 76) instead of running it. `log` records the advice
 * it would give (test-broker usage shows it) and runs everything; `advise` answers with it; per check, `checks` may
 * hold some at `log` while others advise.
 */
export type SteerMode = 'off' | 'log' | 'advise'
export type SteerConfig = {
  mode: SteerMode
  /** per check, a mode below `mode` (e.g. budget: 'log' while same-tree advises) */
  checks: Partial<Record<SteerCheck, SteerMode>>
  /** a run is heavy when the median CPU-minutes of its key's last `heavyRuns` runs is at least this */
  heavyCpuMin: number
  heavyRuns: number
  /** a heavy run whose tree already passed this suite within this many hours */
  sameTreeHours: number
  /** heavy runs per worktree per hour before advice */
  heavyPerWorktreePerHour: number
  /** today's box hours ÷ the daily target at which a repo above its fair share is advised (above 1: every heavy run) */
  softAt: number
  /** the window for fair share and for "other repos are active" */
  fairWindowHours: number
  /** plan hours kept back from the daily target (for the period's last days) */
  reserveHours: number
}
export const STEER_CHECKS = ['sameTree', 'perWorktree', 'budget'] as const
export type SteerCheck = (typeof STEER_CHECKS)[number]

export const MACHINE_DEFAULTS: MachineConfig = {
  budgetFactor: 1,
  boatBin: 'boat',
  boat: { maxBoxes: 12, startsReserve: 20, startDeadlineSec: 90, silentSec: 600, idleStopMin: 15, shortIdleMin: 2, hintTtlMin: 60, maxWaitSec: 180, stoppedDeleteHours: 48, outageFails: 3, outageWindowMin: 5, outagePauseMin: 5, ttlSec: 7 * 24 * 3600, artifactsMaxMb: 200, sizes: [...BOX_SIZES], owners: [], hostId: defaultHostId(), packing: false, infraExitCodes: {}, speed: { ...SPEED_DEFAULTS } },
  keepDays: 14,
  compressAfterHours: 24,
  steer: { mode: 'log', checks: {}, heavyCpuMin: 15, heavyRuns: 8, sameTreeHours: 12, heavyPerWorktreePerHour: 2, softAt: 0.7, fairWindowHours: 3, reserveHours: 0 },
}

export class MachineConfigError extends Error {}

/**
 * The short hostname (lowercased, only [a-z0-9], at most 11 characters) and 4 hex digits of /etc/machine-id: two dev
 * boxes with the same hostname on one Boat account still get different pool names. '' when neither is there
 * (pools then refuse: set boat.hostId).
 */
export function defaultHostId(h = hostname(), machineId = readMachineId()): string {
  const host = h.split('.')[0].toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 11)
  const id = machineId ? createHash('sha256').update(machineId.trim()).digest('hex').slice(0, 4) : ''
  return host && id ? host + id : host
}
function readMachineId(): string {
  try {
    return readFileSync('/etc/machine-id', 'utf8')
  } catch {
    return ''
  }
}

export function configDir(env = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'test-broker')
}
export function stateDir(env = process.env): string {
  return env.TEST_BROKER_STATE || join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'test-broker')
}
export function socketPath(env = process.env): string {
  if (env.TEST_BROKER_SOCKET) return env.TEST_BROKER_SOCKET
  return env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, 'test-broker.sock') : join(stateDir(env), 'test-broker.sock')
}

const num = (v: unknown, where: string, min: number, max: number): number => {
  if (typeof v !== 'number' || !(v >= min && v <= max)) throw new MachineConfigError(`${where}: must be a number from ${min} to ${max}`)
  return v
}

export function parseMachineConfig(doc: unknown, where = 'config.json'): MachineConfig {
  if (doc === undefined) return structuredClone(MACHINE_DEFAULTS)
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new MachineConfigError(`${where}: must be a JSON object`)
  const d = doc as Record<string, any>
  for (const k of Object.keys(d)) if (!['budgetFactor', 'boatBin', 'boat', 'keepDays', 'compressAfterHours', 'steer'].includes(k)) throw new MachineConfigError(`${where}: unknown key "${k}"`)
  const c = structuredClone(MACHINE_DEFAULTS)
  if (d.budgetFactor !== undefined) c.budgetFactor = num(d.budgetFactor, `${where}.budgetFactor`, 0.1, 4)
  if (d.keepDays !== undefined) c.keepDays = num(d.keepDays, `${where}.keepDays`, 1, 365)
  if (d.compressAfterHours !== undefined) c.compressAfterHours = num(d.compressAfterHours, `${where}.compressAfterHours`, 1, 24 * 365)
  if (d.boatBin !== undefined) {
    if (typeof d.boatBin !== 'string' || !d.boatBin) throw new MachineConfigError(`${where}.boatBin: must be a path or command name`)
    c.boatBin = d.boatBin
  }
  if (d.boat !== undefined) {
    if (!d.boat || typeof d.boat !== 'object') throw new MachineConfigError(`${where}.boat: must be an object`)
    const lim: Record<Exclude<keyof MachineConfig['boat'], 'sizes' | 'owners' | 'hostId' | 'packing' | 'infraExitCodes' | 'speed'>, [number, number]> = {
      maxBoxes: [0, 20], startsReserve: [0, 10000], startDeadlineSec: [5, 600], silentSec: [30, 86400],
      idleStopMin: [1, 1440], shortIdleMin: [1, 1440], hintTtlMin: [1, 1440], maxWaitSec: [0, 900], stoppedDeleteHours: [1, 24 * 30], outageFails: [0, 100], outageWindowMin: [1, 120], outagePauseMin: [1, 120], ttlSec: [3600, 30 * 86400], artifactsMaxMb: [1, 2048],
    }
    for (const [k, v] of Object.entries(d.boat)) {
      if (k === 'sizes') {
        if (!Array.isArray(v) || !v.every((x) => (BOX_SIZES as readonly unknown[]).includes(x))) throw new MachineConfigError(`${where}.boat.sizes: must be a list of ${BOX_SIZES.join(', ')}`)
        c.boat.sizes = [...new Set(v as BoxSize[])]
        continue
      }
      if (k === 'infraExitCodes') {
        const ok = v && typeof v === 'object' && !Array.isArray(v) && Object.entries(v).every(([r, c]) => /^[\w.-]+\/[\w.-]+$/.test(r) && Array.isArray(c) && c.every((x) => Number.isInteger(x) && x >= 2 && x <= 254))
        if (!ok) throw new MachineConfigError(`${where}.boat.infraExitCodes: must map owner/name to a list of exit codes from 2 to 254`)
        c.boat.infraExitCodes = Object.fromEntries(Object.entries(v as Record<string, number[]>).map(([r, x]) => [r.toLowerCase(), [...new Set(x)]]))
        continue
      }
      if (k === 'speed') {
        c.boat.speed = parseSpeed(v, `${where}.boat.speed`)
        continue
      }
      if (k === 'packing') {
        if (typeof v !== 'boolean') throw new MachineConfigError(`${where}.boat.packing: must be true or false`)
        c.boat.packing = v
        continue
      }
      if (k === 'hostId') {
        if (typeof v !== 'string' || !/^[a-z0-9]{1,16}$/.test(v)) throw new MachineConfigError(`${where}.boat.hostId: must be 1-16 lowercase letters or digits`)
        c.boat.hostId = v
        continue
      }
      if (k === 'owners') {
        if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(x))) throw new MachineConfigError(`${where}.boat.owners: must be a list of GitHub owner names`)
        c.boat.owners = [...new Set((v as string[]).map((x) => x.toLowerCase()))]
        continue
      }
      if (!(k in lim)) throw new MachineConfigError(`${where}.boat: unknown key "${k}"`)
      const [lo, hi] = lim[k as keyof typeof lim]
      c.boat[k as keyof typeof lim] = num(v, `${where}.boat.${k}`, lo, hi)
    }
  }
  if (d.steer !== undefined) {
    if (!d.steer || typeof d.steer !== 'object' || Array.isArray(d.steer)) throw new MachineConfigError(`${where}.steer: must be an object`)
    const modes = ['off', 'log', 'advise']
    const lim: Record<Exclude<keyof SteerConfig, 'mode' | 'checks'>, [number, number]> = {
      heavyCpuMin: [0, 10000], heavyRuns: [1, 100], sameTreeHours: [0, 24 * 14], heavyPerWorktreePerHour: [1, 100], softAt: [0.05, 10], fairWindowHours: [0.5, 48], reserveHours: [0, 10000],
    }
    for (const [k, v] of Object.entries(d.steer as Record<string, unknown>)) {
      if (k === 'mode') {
        if (!modes.includes(v as string)) throw new MachineConfigError(`${where}.steer.mode: must be one of ${modes.join(', ')}`)
        c.steer.mode = v as SteerMode
        continue
      }
      if (k === 'checks') {
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new MachineConfigError(`${where}.steer.checks: must be an object`)
        for (const [ck, cv] of Object.entries(v)) {
          if (!(STEER_CHECKS as readonly string[]).includes(ck)) throw new MachineConfigError(`${where}.steer.checks: unknown check "${ck}" (${STEER_CHECKS.join(', ')})`)
          if (!modes.includes(cv as string)) throw new MachineConfigError(`${where}.steer.checks.${ck}: must be one of ${modes.join(', ')}`)
          c.steer.checks[ck as SteerCheck] = cv as SteerMode
        }
        continue
      }
      if (!(k in lim)) throw new MachineConfigError(`${where}.steer: unknown key "${k}"`)
      const [lo, hi] = lim[k as keyof typeof lim]
      c.steer[k as keyof typeof lim] = num(v, `${where}.steer.${k}`, lo, hi)
    }
  }
  return c
}

function parseSpeed(v: unknown, where: string): SpeedConfig {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new MachineConfigError(`${where}: must be an object`)
  const c = { ...SPEED_DEFAULTS }
  const lim: Record<Exclude<keyof SpeedConfig, 'mode'>, [number, number]> = {
    slowAt: [1.05, 10], clearAt: [1, 10], minSamples: [3, 1000], window: [3, 1000], ageHours: [1, 24 * 14], nearHours: [0.5, 24 * 7], minSecs: [0, 3600], retireAfterMin: [5, 24 * 60 * 7], maxRetirePerDay: [0, 100],
    probeEveryMin: [0, 24 * 60], probeIdleSec: [0, 3600], probeCpuMb: [1, 8192], probeDiskMb: [1, 4096], probeTimeoutSec: [10, 600], probeMinFreeGb: [0, 1000],
  }
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (k === 'mode') {
      if (!['off', 'avoid', 'retire'].includes(x as string)) throw new MachineConfigError(`${where}.mode: must be one of off, avoid, retire`)
      c.mode = x as SpeedConfig['mode']
      continue
    }
    if (!(k in lim)) throw new MachineConfigError(`${where}: unknown key "${k}"`)
    const [lo, hi] = lim[k as keyof typeof lim]
    c[k as keyof typeof lim] = num(x, `${where}.${k}`, lo, hi)
  }
  if ((v as Record<string, unknown>).clearAt === undefined) c.clearAt = Math.min(c.clearAt, c.slowAt)
  else if (c.clearAt > c.slowAt) throw new MachineConfigError(`${where}.clearAt: must not be more than slowAt (${c.slowAt})`)
  if (c.minSamples > c.window) throw new MachineConfigError(`${where}.minSamples: must not be more than window (${c.window})`)
  return c
}

export function loadMachineConfig(env = process.env): MachineConfig {
  const f = join(configDir(env), 'config.json')
  if (!existsSync(f)) return structuredClone(MACHINE_DEFAULTS)
  let doc: unknown
  try {
    doc = JSON.parse(readFileSync(f, 'utf8'))
  } catch (e) {
    throw new MachineConfigError(`${f}: not valid JSON: ${(e as Error).message}`)
  }
  return parseMachineConfig(doc, f)
}
