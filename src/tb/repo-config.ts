// A repo's test-broker config: `.test-broker.json` at the worktree root, read at ask time from the caller's tree.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const REPO_CONFIG_FILE = '.test-broker.json'

/**
 * passArgs: the caller's suite args (`run <suite> [args…] --`) are appended to this shard's args.
 * units: the share of a box the shard needs, 1 unit = 2 CPUs + 4 GB (a small box holds 1, default 2, large 4). Given
 * without `size`, `size` is null and the box size is the smallest one on this machine that holds the units; given
 * without `units`, the units are the size's (`unitsOf`). With boat.packing on, shards share boxes by units.
 * memGb: the RAM the shard needs, when it is not its units' (4 GB a unit): a shard that needs much RAM but few CPUs
 * (e2e: 4 CPUs, 11 GB) asks for `units: 2, memGb: 11`, and a light one (`units: 2, memGb: 3`) leaves RAM for others.
 * memMb is always set (memGb, else 4 GB a unit). With packing, a box holds shards while both their units (CPUs) and
 * their memMb fit; the box size must hold both (`boxUnits`).
 */
/** a shard waits for a busy box at most this long by default (`boat.maxWaitSec`); the most a repo may set */
export const DEFAULT_MAX_WAIT_SEC = 60
export const MAX_WAIT_SEC = 900
export type BoatShard = { name: string; size: string | null; units: number; memMb: number; args: string[]; passArgs: boolean }
/** maxWaitSec: how long a shard may wait for a busy box that is about to free (null: the repo's, else the default) */
/** avoidSlow: never place this suite's shards on a box marked slow, even when that costs a box start */
export type SuiteBoat = { shards: BoatShard[]; maxSec: number; silentSec: number | null; maxWaitSec: number | null; avoidSlow: boolean }
export type SuiteLocal = { cpus: number; minCpus: number; memGb: number; locks: string[] }
/** heavy: a hand override of the learned heavy class; null = learned from runs.db */
export type Suite = { name: string; local: SuiteLocal; boat: SuiteBoat | null; heavy: boolean | null }
export type RepoConfig = {
  /** the worktree root it was read from */
  root: string
  /** artifacts: checkout-relative paths brought back from a box when a shard fails */
  /** pool: the shared pool this repo runs in (`shared` by default). The old per-repo `environment` key is read and
   *  ignored (an old branch's config still runs, in its pool); it is refused beside `pool`. */
  /** infraExitCodes: the remote script's exit codes that mean the box failed, not the code under test (null: none set) */
  boat: { pool: string; remoteScript: string; artifacts: string[]; extraRepos: ExtraRepo[]; maxWaitSec: number; infraExitCodes: number[] | null } | null
  suites: Record<string, Suite>
  /** the repo's advice for a steered heavy run: its own testing policy, in a few lines */
  advice: string | null
}

/**
 * Another repo the remote script needs (acme's pinned helper-service): test-broker fetches `ref` on this dev box and
 * ships it to the box as a bundle, `~/cib/extra/<name>.bundle` (`refs/cib/extra` = the commit), named to the script as
 * `CIB_EXTRA_<NAME>` (upper case, `-` → `_`). `ref` is a commit sha, or `<file>#<key.path>`: a JSON file in the commit
 * under test and the dotted key holding the sha there.
 */
export type ExtraRepo = { name: string; repo: string; ref: { sha: string } | { file: string; key: string[] } }

export class RepoConfigError extends Error {}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
/** a checkout-relative artifact path: no leading slash or dash, no shell-special characters */
const REL_RE = /^[A-Za-z0-9_.][A-Za-z0-9_./-]{0,199}$/
const LOCK_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,99}$/
const SIZES = ['small', 'default', 'large', 'xlarge']
/** units per box size: 1 unit = 2 CPUs + 4 GB */
export const SIZE_UNITS: Record<string, number> = { small: 1, default: 2, large: 4, xlarge: 8 }
/** the most units one shard may ask for */
export const MAX_SHARD_UNITS = 4
/** RAM per unit */
export const UNIT_MEM_MB = 4096

/** The units of box a shard needs: its CPU units, or more when its RAM needs them (4 GB a unit). */
export function boxUnits(s: { units: number; memMb: number }): number {
  return Math.max(s.units, Math.ceil(s.memMb / UNIT_MEM_MB))
}
const POOL_RE = /^[a-z0-9]{1,16}$/
const EXTRA_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
const GH_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/
const SHA_RE = /^[0-9a-f]{40}$/
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}(\.[A-Za-z_][A-Za-z0-9_]{0,63}){0,7}$/
const DEFAULT_MAX_SEC = 3600

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function only(o: Record<string, unknown>, keys: string[], where: string) {
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw new RepoConfigError(`${where}: unknown key "${k}" (allowed: ${keys.join(', ')})`)
}
function int(v: unknown, where: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new RepoConfigError(`${where}: must be a whole number from ${min} to ${max}`)
  return v
}

function local(v: unknown, where: string): SuiteLocal {
  if (!isObj(v)) throw new RepoConfigError(`${where}: must be an object with cpus and minCpus`)
  only(v, ['cpus', 'minCpus', 'memGb', 'locks'], where)
  const cpus = int(v.cpus, `${where}.cpus`, 1, 1024)
  const minCpus = v.minCpus === undefined ? cpus : int(v.minCpus, `${where}.minCpus`, 1, cpus)
  const memGb = v.memGb === undefined ? 0 : typeof v.memGb === 'number' && v.memGb >= 0 && v.memGb <= 4096 ? v.memGb : (() => {
    throw new RepoConfigError(`${where}.memGb: must be a number from 0 to 4096`)
  })()
  const locks = v.locks === undefined ? [] : v.locks
  if (!Array.isArray(locks) || locks.some((l) => typeof l !== 'string' || !LOCK_RE.test(l)))
    throw new RepoConfigError(`${where}.locks: must be a list of lock keys (letters, digits, _ . : / -)`)
  return { cpus, minCpus, memGb, locks: [...new Set(locks as string[])] }
}

function boat(v: unknown, where: string): SuiteBoat | null {
  if (v === undefined || v === false) return null
  if (!isObj(v)) throw new RepoConfigError(`${where}: must be false or an object with shards`)
  only(v, ['shards', 'maxSec', 'silentSec', 'maxWaitSec', 'avoidSlow'], where)
  if (v.avoidSlow !== undefined && typeof v.avoidSlow !== 'boolean') throw new RepoConfigError(`${where}.avoidSlow: must be true or false`)
  if (!Array.isArray(v.shards) || !v.shards.length) throw new RepoConfigError(`${where}.shards: must be a non-empty list`)
  const names = new Set<string>()
  const shards = v.shards.map((s, i): BoatShard => {
    const w = `${where}.shards[${i}]`
    if (!isObj(s)) throw new RepoConfigError(`${w}: must be an object with name, size or units, args`)
    only(s, ['name', 'size', 'units', 'memGb', 'args', 'passArgs'], w)
    if (typeof s.name !== 'string' || !NAME_RE.test(s.name)) throw new RepoConfigError(`${w}.name: must match ${NAME_RE}`)
    if (names.has(s.name)) throw new RepoConfigError(`${w}.name: "${s.name}" is used twice`)
    names.add(s.name)
    const size = s.size === undefined ? (s.units === undefined ? 'default' : null) : s.size
    if (size !== null && (typeof size !== 'string' || !SIZES.includes(size))) throw new RepoConfigError(`${w}.size: must be one of ${SIZES.join(', ')}`)
    const units = s.units === undefined ? SIZE_UNITS[size!] : int(s.units, `${w}.units`, 1, MAX_SHARD_UNITS)
    if (size !== null && s.units !== undefined && units > SIZE_UNITS[size]) throw new RepoConfigError(`${w}.units: ${units} unit(s) do not fit a ${size} box (${SIZE_UNITS[size]})`)
    const maxGb = MAX_SHARD_UNITS * (UNIT_MEM_MB / 1024)
    if (s.memGb !== undefined && !(typeof s.memGb === 'number' && s.memGb >= 0.5 && s.memGb <= maxGb))
      throw new RepoConfigError(`${w}.memGb: must be a number from 0.5 to ${maxGb}`)
    const memMb = s.memGb === undefined ? units * UNIT_MEM_MB : Math.ceil((s.memGb as number) * 1024)
    if (size !== null && boxUnits({ units, memMb }) > SIZE_UNITS[size])
      throw new RepoConfigError(`${w}.memGb: ${s.memGb} GB does not fit a ${size} box (${SIZE_UNITS[size] * (UNIT_MEM_MB / 1024)} GB)`)
    if (!Array.isArray(s.args) || s.args.some((a) => typeof a !== 'string')) throw new RepoConfigError(`${w}.args: must be a list of strings`)
    if (s.passArgs !== undefined && typeof s.passArgs !== 'boolean') throw new RepoConfigError(`${w}.passArgs: must be true or false`)
    return { name: s.name, size, units, memMb, args: s.args as string[], passArgs: s.passArgs === true }
  })
  return {
    shards,
    maxSec: v.maxSec === undefined ? DEFAULT_MAX_SEC : int(v.maxSec, `${where}.maxSec`, 30, 24 * 3600),
    silentSec: v.silentSec === undefined ? null : int(v.silentSec, `${where}.silentSec`, 30, 24 * 3600),
    maxWaitSec: v.maxWaitSec === undefined ? null : int(v.maxWaitSec, `${where}.maxWaitSec`, 0, MAX_WAIT_SEC),
    avoidSlow: v.avoidSlow === true,
  }
}

export function parseRepoConfig(doc: unknown, root: string, file = REPO_CONFIG_FILE): RepoConfig {
  if (!isObj(doc)) throw new RepoConfigError(`${file}: must be a JSON object`)
  only(doc, ['boat', 'suites', 'advice'], file)
  if (doc.advice !== undefined && (typeof doc.advice !== 'string' || !doc.advice.trim() || doc.advice.length > 2000)) throw new RepoConfigError(`${file}.advice: must be text, at most 2000 characters`)
  let b: RepoConfig['boat'] = null
  if (doc.boat !== undefined) {
    if (!isObj(doc.boat)) throw new RepoConfigError(`${file}.boat: must be an object with remoteScript`)
    only(doc.boat, ['pool', 'environment', 'remoteScript', 'artifacts', 'extraRepos', 'maxWaitSec', 'infraExitCodes'], `${file}.boat`)
    const { environment, remoteScript } = doc.boat
    if (environment !== undefined && (typeof environment !== 'string' || !NAME_RE.test(environment))) throw new RepoConfigError(`${file}.boat.environment: must be a Boat environment name`)
    if (doc.boat.pool !== undefined && (typeof doc.boat.pool !== 'string' || !POOL_RE.test(doc.boat.pool))) throw new RepoConfigError(`${file}.boat.pool: must be 1-16 lowercase letters or digits`)
    if (environment !== undefined && doc.boat.pool !== undefined) throw new RepoConfigError(`${file}.boat: set pool or environment, not both`)
    const pool = (doc.boat.pool as string | undefined) ?? 'shared'
    if (typeof remoteScript !== 'string' || !remoteScript || remoteScript.startsWith('/') || remoteScript.split('/').includes('..'))
      throw new RepoConfigError(`${file}.boat.remoteScript: must be a path inside the repo`)
    const artifacts = doc.boat.artifacts ?? []
    if (!Array.isArray(artifacts) || artifacts.some((a) => typeof a !== 'string' || !REL_RE.test(a) || a.split('/').includes('..')))
      throw new RepoConfigError(`${file}.boat.artifacts: must be a list of paths inside the checkout (letters, digits, _ . - /)`)
    const maxWaitSec = doc.boat.maxWaitSec === undefined ? DEFAULT_MAX_WAIT_SEC : int(doc.boat.maxWaitSec, `${file}.boat.maxWaitSec`, 0, MAX_WAIT_SEC)
    const iec = doc.boat.infraExitCodes
    if (iec !== undefined && !(Array.isArray(iec) && iec.every((x) => Number.isInteger(x) && (x as number) >= 2 && (x as number) <= 254)))
      throw new RepoConfigError(`${file}.boat.infraExitCodes: must be a list of exit codes from 2 to 254`)
    b = { pool, remoteScript, artifacts: [...new Set(artifacts as string[])], extraRepos: extraRepos(doc.boat.extraRepos, `${file}.boat.extraRepos`), maxWaitSec, infraExitCodes: iec === undefined ? null : [...new Set(iec as number[])] }
  }
  if (!isObj(doc.suites) || !Object.keys(doc.suites).length) throw new RepoConfigError(`${file}.suites: must name at least one suite`)
  const suites: Record<string, Suite> = {}
  for (const [name, s] of Object.entries(doc.suites)) {
    const w = `${file}.suites.${name}`
    if (!NAME_RE.test(name)) throw new RepoConfigError(`${w}: suite names must match ${NAME_RE}`)
    if (!isObj(s)) throw new RepoConfigError(`${w}: must be an object with local (and boat)`)
    only(s, ['local', 'boat', 'heavy'], w)
    if (s.heavy !== undefined && typeof s.heavy !== 'boolean') throw new RepoConfigError(`${w}.heavy: must be true or false (leave it out to learn it from past runs)`)
    const sb = boat(s.boat, `${w}.boat`)
    if (sb && !b) throw new RepoConfigError(`${w}.boat: needs the top-level boat (remoteScript)`)
    suites[name] = { name, local: local(s.local, `${w}.local`), boat: sb, heavy: typeof s.heavy === 'boolean' ? s.heavy : null }
  }
  return { root, boat: b, suites, advice: typeof doc.advice === 'string' ? doc.advice.trim() : null }
}

/** Read the config from a worktree root. Throws RepoConfigError when it is missing or wrong. */
export function loadRepoConfig(root: string): RepoConfig {
  const f = join(root, REPO_CONFIG_FILE)
  if (!existsSync(f)) throw new RepoConfigError(`${f}: not found (this repo has no test-broker config)`)
  let doc: unknown
  try {
    doc = JSON.parse(readFileSync(f, 'utf8'))
  } catch (e) {
    throw new RepoConfigError(`${f}: not valid JSON: ${(e as Error).message}`)
  }
  return parseRepoConfig(doc, root, f)
}

function extraRepos(v: unknown, w: string): ExtraRepo[] {
  if (v === undefined) return []
  if (!Array.isArray(v) || v.length > 8) throw new RepoConfigError(`${w}: must be a list of at most 8 { name, repo, ref }`)
  const names = new Set<string>()
  return v.map((x, i) => {
    const wi = `${w}[${i}]`
    if (!isObj(x)) throw new RepoConfigError(`${wi}: must be an object with name, repo and ref`)
    only(x, ['name', 'repo', 'ref'], wi)
    if (typeof x.name !== 'string' || !EXTRA_NAME_RE.test(x.name)) throw new RepoConfigError(`${wi}.name: must be 1-32 lowercase letters, digits or -`)
    if (names.has(x.name)) throw new RepoConfigError(`${wi}.name: ${x.name} is named twice`)
    names.add(x.name)
    if (typeof x.repo !== 'string' || !GH_REPO_RE.test(x.repo)) throw new RepoConfigError(`${wi}.repo: must be a GitHub owner/name`)
    if (typeof x.ref !== 'string') throw new RepoConfigError(`${wi}.ref: must be a commit sha or <file>#<key>`)
    let ref: ExtraRepo['ref']
    if (SHA_RE.test(x.ref)) ref = { sha: x.ref }
    else {
      const [f, k, ...rest] = x.ref.split('#')
      if (rest.length || !f || !k || !REL_RE.test(f) || f.split('/').includes('..') || !KEY_RE.test(k))
        throw new RepoConfigError(`${wi}.ref: must be a 40-hex commit sha or <file in the repo>#<dotted.key>`)
      ref = { file: f, key: k.split('.') }
    }
    return { name: x.name, repo: x.repo, ref }
  })
}
