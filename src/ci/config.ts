// Config. `single` (no install.conf): one file the operator owns, ~/.config/ci-broker/config.json, as before.
// `split` (install.conf present): root's /etc/ci-broker/config.json (trust, credentials, job secrets, resources,
// everything) plus the operator's tuning.json (an allowlist of keys that shape only what the operator can run
// anyway). In split every path comes from install.conf; neither file may hold a path key.
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { derivePaths, lookupId, readInstallConf, type InstallConf } from './install-conf.ts'

export type ResourceKind = 'local' | 'boat' | 'ssh' | 'github'

/** One entry of `resources`. Fields beyond id/kind/profiles belong to one kind. */
export type ResourceCfg = {
  id: string
  kind: ResourceKind
  /** the profiles this resource is set up for; "*" = any */
  profiles: string[]
  /** boat: the Boat environment (default: each profile's boatEnvironment) */
  environment?: string
  /** boat: the cap on this daemon's boxes, running or stopped */
  maxBoxes?: number
  /** ssh: the ssh destination (a Host of ~/.ssh/config); default: the id */
  host?: string
  /** ssh: how many shards run on the host at once (each in ~/cib/<slot>/); default 1 */
  slots?: number
  /** ssh: the shard sizes the host takes; none = any */
  sizes?: string[]
  /** ssh (single only): a local command whose stdout is a token handed to the remote script over stdin (never argv); no default */
  githubTokenCmd?: string
  /** ssh: a job secret's name handed to the remote script over stdin (split's form of githubTokenCmd) */
  secret?: string
  /** github: the consumer repo's workflow file (template ci/workflows/ci-broker-hosted.yml) */
  workflow?: string
  /** github: the modes it may run (none listed = none) */
  modes?: string[]
  /** github: how long a pushed job waits for other resources before it may be dispatched; default 900 */
  afterWaitSec?: number
}

/** An approved account: pinned by id. A plain string is an unpinned entry: kept, never matches. */
export type ApprovedEntry = { login: string; id: number } | string

export type TrustRepoCfg = {
  githubUsers?: ApprovedEntry[]
  workflow?: string
  envForGithubDoor?: boolean
  profile?: string
  /** a public repo's lane may use Boat in this environment: one that injects nothing, used by this repo's public lane only */
  publicBoat?: string
}

export type TrustCfg = {
  githubUsers: ApprovedEntry[]
  repos: Record<string, TrustRepoCfg>
  watchSec: number
  localOfflineMaxAgeSec: number
  githubDoorPerMin: number
  githubDoorCallsPerHour: number
  githubDoorMaxJobs: number
  /** the GitHub door's ceilings over all repos (the per-repo limits don't isolate repos: one runner uid, one socket) */
  githubDoorPerMinTotal: number
  githubDoorCallsPerHourTotal: number
  publicNetwork: string
  /** the public lane's boxes, over all its environments */
  publicBoatMaxBoxes: number
}

export type CredentialsCfg = {
  /** split: { file } only; single: { tokenCmd } (default `gh auth token`) or { file } */
  github: { file?: string; tokenCmd?: string }
  /** XDG_CONFIG_HOME for every boat call (none = the daemon's own) */
  boat: { configHome?: string }
}
/** A job secret: a file (root's 0640 file in split); `cmd` only in single */
export type SecretCfg = { file?: string; cmd?: string }

export type Layout = 'single' | 'split'

export type Config = {
  layout: Layout
  /** names this daemon's Boat boxes (cib-<daemonId>-…) and its job ids (<daemonId>-<n>) */
  daemonId: string
  /** null = the default: local + boat for every profile */
  resources: ResourceCfg[] | null
  boatBin: string
  /** gh for the daemon's own calls (split: the pinned one in TOOLS_DIR) */
  ghBin: string
  /** the ssh and scp binaries for ssh resources (the machine's ~/.ssh/config applies) */
  sshBin: string
  scpBin: string
  /** timeout for short ssh/scp calls (upload, kill, artifacts, the check report) */
  sshCallTimeoutSec: number
  /** github resources: how often a dispatched run is polled */
  githubPollSec: number
  /** github resources: a dispatched run not found in `gh run list` after this long → infra failure */
  githubFindSec: number
  /** Clone URL for the mirrors; {repo} = owner/name. */
  gitUrl: string
  /** where profiles/<name>/profile.json live */
  profilesDir: string
  runnersPerRepo: number
  /** Run locally only while the 1-min load average is below this × nproc. */
  localMaxLoadFactor: number
  /** Never resume or create a Boat box when this many starts or fewer would be left in the rolling day. */
  startsReserve: number
  /** Timeout for short Boat calls (stop, delete, kill, artifacts). */
  boatCallTimeoutSec: number
  stateDir: string
  /** default: <stateDir>/brokerd.sock */
  socketPath: string
  /** split: the GitHub door's socket; null in single */
  githubSocketPath: string | null
  /** the local slot's flock (shared with `ci-broker local-lock`) */
  localLockPath: string
  /** the one-daemon flock */
  daemonLockPath: string
  /** split: the runners root writes (`runnerctl`); null in single */
  runnersJson: string | null
  /** split: /opt/ci-broker/current/RELEASE */
  releaseFile: string | null
  /** split: root's config.json and the operator's tuning.json (re-read at every submit) */
  rootConfigPath: string | null
  tuningPath: string | null
  /** split: the operator's uid (operator files must be theirs) and name */
  operatorUid: number | null
  operator: string | null
  installConf: InstallConf | null
  queueTimeoutSec: number
  shardTimeoutSec: number
  interestGraceSec: number
  infraFailLimit: number
  retentionDays: number
  artifactsMaxMb: number
  snapshotMaxFileMb: number
  /** a snapshot job whose bundle hasn't arrived after this long → error */
  bundleWaitSec: number
  tickSec: number
  reconcileSec: number
  pruneSec: number
  /** timeout for git calls on a mirror (fetch, clone, bundle) */
  gitTimeoutSec: number
  pool: {
    idleStopSec: number
    /** "HH:MM-HH:MM" local time: keep the last running box of each size warm inside it. */
    warmHours: string | null
    deleteAfterDays: number
    ttlSec: number
  }
  local: { cpus: number; memory: string }
  trust: TrustCfg
  credentials: CredentialsCfg
  secrets: Record<string, SecretCfg>
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.CI_BROKER_CONFIG ?? join(env.XDG_CONFIG_HOME ?? join(env.HOME ?? '', '.config'), 'ci-broker', 'config.json')
}

export const shortHost = () => hostname().split('.')[0].toLowerCase().replace(/[^a-z0-9]/g, '') || 'host'

/** the pool keys tuning.json may set (own keys only: never `__proto__`) */
const TRUST_POOL_KEYS = { idleStopSec: 1, warmHours: 1, deleteAfterDays: 1, ttlSec: 1 }

export const TRUST_DEFAULTS: TrustCfg = {
  githubUsers: [],
  repos: {},
  watchSec: 300,
  localOfflineMaxAgeSec: 86400,
  githubDoorPerMin: 30,
  githubDoorCallsPerHour: 1000,
  githubDoorMaxJobs: 20,
  githubDoorPerMinTotal: 60,
  githubDoorCallsPerHourTotal: 2000,
  publicNetwork: 'ci-broker-pub',
  publicBoatMaxBoxes: 4,
}

export function defaults(env: NodeJS.ProcessEnv = process.env): Config {
  const home = env.HOME ?? ''
  const stateDir = join(home, '.local/state/ci-broker')
  return {
    layout: 'single',
    daemonId: shortHost(),
    resources: null,
    boatBin: join(home, '.local/bin/boat'),
    ghBin: 'gh',
    sshBin: 'ssh',
    scpBin: 'scp',
    sshCallTimeoutSec: 120,
    githubPollSec: 30,
    githubFindSec: 300,
    gitUrl: 'https://github.com/{repo}.git',
    profilesDir: join(ROOT, 'ci', 'profiles'),
    runnersPerRepo: 8,
    localMaxLoadFactor: 0.5,
    startsReserve: 20,
    boatCallTimeoutSec: 60,
    stateDir,
    socketPath: '',
    githubSocketPath: null,
    localLockPath: '',
    daemonLockPath: '',
    runnersJson: null,
    releaseFile: null,
    rootConfigPath: null,
    tuningPath: null,
    operatorUid: null,
    operator: null,
    installConf: null,
    queueTimeoutSec: 3600,
    shardTimeoutSec: 7200,
    interestGraceSec: 30,
    infraFailLimit: 2,
    retentionDays: 14,
    artifactsMaxMb: 200,
    snapshotMaxFileMb: 50,
    bundleWaitSec: 120,
    tickSec: 15,
    reconcileSec: 60,
    pruneSec: 3600,
    gitTimeoutSec: 600,
    pool: { idleStopSec: 1200, warmHours: null, deleteAfterDays: 7, ttlSec: 43200 },
    local: { cpus: 6, memory: '20g' },
    trust: structuredClone(TRUST_DEFAULTS),
    credentials: { github: { tokenCmd: 'gh auth token' }, boat: {} },
    secrets: {},
  }
}

function merge<T>(base: T, over: unknown): T {
  if (over === null || typeof over !== 'object' || Array.isArray(over)) return base
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(over)) {
    const b = out[k]
    // trust.repos and secrets are maps: replaced per key, never merged into the defaults' (empty) maps' entries
    out[k] = b && typeof b === 'object' && !Array.isArray(b) ? merge(b, v) : v
  }
  return out as T
}

export class ConfigError extends Error {}

const LOGIN = /^[A-Za-z0-9-]{1,39}$/
const SEG = /^[A-Za-z0-9_.-]{1,100}$/
export const isRepoName = (s: unknown): s is string => typeof s === 'string' && s.split('/').length === 2 && s.split('/').every((x) => SEG.test(x) && x !== '.' && x !== '..')
export const SECRET_NAME = /^[A-Za-z0-9_.-]{1,64}$/

function checkEntries(list: unknown, where: string) {
  if (!Array.isArray(list)) throw new ConfigError(`${where}: must be a list`)
  list.forEach((e, i) => {
    if (typeof e === 'string') {
      if (!LOGIN.test(e)) throw new ConfigError(`${where}[${i}]: bad login`)
      return
    }
    if (!e || typeof e !== 'object' || Object.keys(e).some((k) => k !== 'login' && k !== 'id')) throw new ConfigError(`${where}[${i}]: an entry is { "login", "id" }`)
    const { login, id } = e as any
    if (typeof login !== 'string' || !LOGIN.test(login)) throw new ConfigError(`${where}[${i}].login: bad login`)
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) throw new ConfigError(`${where}[${i}].id: must be a positive integer`)
  })
}

/** Validation on load: logins, ids, repo keys, workflow paths, numbers. */
export function validateTrust(t: TrustCfg) {
  checkEntries(t.githubUsers, 'trust.githubUsers')
  if (!t.repos || typeof t.repos !== 'object' || Array.isArray(t.repos)) throw new ConfigError('trust.repos: must be an object')
  for (const [repo, r] of Object.entries(t.repos)) {
    if (!isRepoName(repo)) throw new ConfigError(`trust.repos: '${repo}' is not owner/name`)
    for (const k of Object.keys(r ?? {})) if (!['githubUsers', 'workflow', 'envForGithubDoor', 'profile', 'publicBoat'].includes(k)) throw new ConfigError(`trust.repos.${repo}.${k}: unknown key`)
    if (r.profile !== undefined && !(typeof r.profile === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(r.profile))) throw new ConfigError(`trust.repos.${repo}.profile: a profile name`)
    if (r.githubUsers !== undefined) checkEntries(r.githubUsers, `trust.repos.${repo}.githubUsers`)
    if (r.workflow !== undefined && !(typeof r.workflow === 'string' && /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(r.workflow)))
      throw new ConfigError(`trust.repos.${repo}.workflow: must be a file under .github/workflows/`)
    if (r.envForGithubDoor !== undefined && typeof r.envForGithubDoor !== 'boolean') throw new ConfigError(`trust.repos.${repo}.envForGithubDoor: must be true or false`)
    if (r.publicBoat !== undefined && !(typeof r.publicBoat === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(r.publicBoat)))
      throw new ConfigError(`trust.repos.${repo}.publicBoat: a Boat environment name`)
  }
  const keys = new Map<string, string>()
  for (const repo of Object.keys(t.repos)) {
    const other = keys.get(repo.toLowerCase())
    if (other) throw new ConfigError(`trust.repos: '${repo}' and '${other}' are one repo (GitHub names ignore case)`)
    keys.set(repo.toLowerCase(), repo)
  }
  const owner = new Map<string, string>()
  for (const [repo, r] of Object.entries(t.repos)) {
    if (r.publicBoat === undefined) continue
    const other = owner.get(r.publicBoat)
    if (other) throw new ConfigError(`trust.repos.${repo}.publicBoat: ${r.publicBoat} is ${other}'s already (a public environment serves one repo)`)
    owner.set(r.publicBoat, repo)
  }
  for (const k of ['watchSec', 'localOfflineMaxAgeSec', 'githubDoorPerMin', 'githubDoorCallsPerHour', 'githubDoorMaxJobs', 'githubDoorPerMinTotal', 'githubDoorCallsPerHourTotal', 'publicBoatMaxBoxes'] as const)
    if (typeof t[k] !== 'number' || !(t[k] > 0)) throw new ConfigError(`trust.${k}: must be a positive number`)
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(t.publicNetwork)) throw new ConfigError('trust.publicNetwork: bad network name')
}

function validateCommon(c: Config) {
  if (!/^[a-z0-9]+$/.test(c.daemonId)) throw new ConfigError(`daemonId '${c.daemonId}' must be lowercase letters and digits`)
  validateTrust(c.trust)
  for (const [name, s] of Object.entries(c.secrets ?? {})) {
    if (!SECRET_NAME.test(name)) throw new ConfigError(`secrets: bad secret name '${name}'`)
    for (const k of Object.keys(s ?? {})) if (k !== 'file' && k !== 'cmd') throw new ConfigError(`secrets.${name}.${k}: unknown key`)
  }
}

export function loadConfig(path = defaultConfigPath(), env: NodeJS.ProcessEnv = process.env): Config {
  const base = defaults(env)
  const c = existsSync(path) ? merge(base, JSON.parse(readFileSync(path, 'utf8'))) : base
  validateCommon(c)
  if (!c.socketPath) c.socketPath = join(c.stateDir, 'brokerd.sock')
  if (!c.localLockPath) c.localLockPath = join(c.stateDir, 'local.lock')
  if (!c.daemonLockPath) c.daemonLockPath = existsSync('/run/lock/ci-brokerd.lock') ? '/run/lock/ci-brokerd.lock' : join(c.stateDir, 'daemon.lock')
  return c
}

/** split: no key in either file may name a path (they come from install.conf). */
export const SPLIT_PATH_KEYS = ['stateDir', 'socketPath', 'profilesDir', 'boatBin', 'ghBin', 'sshBin', 'scpBin', 'githubSocketPath', 'localLockPath', 'daemonLockPath', 'runnersJson', 'releaseFile', 'layout']
const ROOT_KEYS = new Set([
  'daemonId', 'resources', 'sshCallTimeoutSec', 'githubPollSec', 'githubFindSec', 'gitUrl', 'runnersPerRepo', 'localMaxLoadFactor', 'startsReserve',
  'boatCallTimeoutSec', 'queueTimeoutSec', 'shardTimeoutSec', 'interestGraceSec', 'infraFailLimit', 'retentionDays', 'artifactsMaxMb', 'snapshotMaxFileMb',
  'bundleWaitSec', 'tickSec', 'reconcileSec', 'pruneSec', 'gitTimeoutSec', 'pool', 'local', 'trust', 'credentials', 'secrets',
])
/** tuning.json: the operator's allowlist (dotted). `pool.*` = any pool key. */
export const TUNING_KEYS = ['local.cpus', 'local.memory', 'pool.*', 'boat.maxBoxes', 'runnersPerRepo', 'queueTimeoutSec', 'shardTimeoutSec', 'retentionDays', 'artifactsMaxMb', 'localMaxLoadFactor']

const flatKeys = (o: unknown, pre = ''): string[] =>
  o && typeof o === 'object' && !Array.isArray(o) ? Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length ? flatKeys(v, `${pre}${k}.`) : [`${pre}${k}`])) : []

/**
 * An operator-owned file: opened with O_NOFOLLOW, a regular file owned by `uid`, JSON. Errors name the file and what
 * failed, never the content (a planted link to a key file must not print the key).
 */
export function readOperatorJson(path: string, uid: number | null, what = path): unknown {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    throw new ConfigError(`${what}: ${code === 'ELOOP' ? 'is a symlink (refused)' : code === 'ENOENT' ? 'missing' : `cannot be opened (${code})`}`)
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) throw new ConfigError(`${what}: not a regular file`)
    if (uid !== null && st.uid !== uid) throw new ConfigError(`${what}: not owned by the operator (uid ${st.uid})`)
    if (st.size > 1 << 20) throw new ConfigError(`${what}: over 1 MB`)
    const text = readFileSync(fd, 'utf8')
    try {
      return JSON.parse(text)
    } catch {
      throw new ConfigError(`${what}: not valid JSON`)
    }
  } finally {
    closeSync(fd)
  }
}

/** Root's config.json: a regular root-owned file not writable by group or other. */
function readRootJson(path: string, rootUid: number): unknown {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new ConfigError(`${path}: cannot be opened (${(e as NodeJS.ErrnoException).code})`)
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.uid !== rootUid || st.mode & 0o022) throw new ConfigError(`${path}: must be a regular file owned by root, not group/other-writable`)
    try {
      return JSON.parse(readFileSync(fd, 'utf8'))
    } catch {
      throw new ConfigError(`${path}: not valid JSON`)
    }
  } finally {
    closeSync(fd)
  }
}

/** Apply tuning.json onto a config (in place: the daemon's parts read `cfg` live). Throws naming a refused key. */
export function applyTuning(c: Config, t: unknown, where = 'tuning.json') {
  if (t === undefined || t === null) return
  if (typeof t !== 'object' || Array.isArray(t)) throw new ConfigError(`${where}: must be an object`)
  for (const k of flatKeys(t)) {
    const ok = TUNING_KEYS.some((a) => (a.endsWith('.*') ? k.startsWith(a.slice(0, -1)) : a === k))
    if (!ok) throw new ConfigError(`${where}: key ${k} is not allowed here (root's config.json only, or unknown)`)
  }
  const o = t as any
  const pos = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0
  if (o.local) {
    if (o.local.cpus !== undefined && !pos(o.local.cpus)) throw new ConfigError(`${where}: local.cpus must be a positive number`)
    if (o.local.memory !== undefined && !(typeof o.local.memory === 'string' && /^[0-9]+(\.[0-9]+)?[bkmg]?$/.test(o.local.memory))) throw new ConfigError(`${where}: local.memory must be like "20g"`)
    if (o.local.cpus !== undefined) c.local.cpus = o.local.cpus
    if (o.local.memory !== undefined) c.local.memory = o.local.memory
  }
  if (o.pool) {
    const known = TRUST_POOL_KEYS
    for (const k of Object.keys(o.pool)) {
      if (!Object.hasOwn(known, k)) throw new ConfigError(`${where}: key pool.${k} is unknown`)
      const v = o.pool[k]
      if (k === 'warmHours' ? !(v === null || (typeof v === 'string' && /^\d\d:\d\d-\d\d:\d\d$/.test(v))) : !pos(v)) throw new ConfigError(`${where}: pool.${k} has a bad value`)
    }
    for (const k of Object.keys(o.pool)) (c.pool as any)[k] = o.pool[k]
  }
  for (const k of ['runnersPerRepo', 'queueTimeoutSec', 'shardTimeoutSec', 'retentionDays', 'artifactsMaxMb', 'localMaxLoadFactor'] as const) {
    if (o[k] === undefined) continue
    if (typeof o[k] !== 'number' || !(o[k] > 0)) throw new ConfigError(`${where}: ${k} must be a positive number`)
    c[k] = o[k]
  }
  if (o.boat?.maxBoxes !== undefined) {
    if (!Number.isInteger(o.boat.maxBoxes) || o.boat.maxBoxes < 0) throw new ConfigError(`${where}: boat.maxBoxes must be a whole number`)
    ;(c as any).tunedMaxBoxes = o.boat.maxBoxes
  }
}

function checkRootSplit(raw: any, path: string) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError(`${path}: must be an object`)
  for (const k of Object.keys(raw)) {
    if (SPLIT_PATH_KEYS.includes(k)) throw new ConfigError(`${path}: ${k} is a path key; in split every path comes from install.conf`)
    if (!ROOT_KEYS.has(k)) throw new ConfigError(`${path}: unknown key ${k}`)
  }
  if (raw.credentials?.github?.tokenCmd !== undefined) throw new ConfigError(`${path}: credentials.github.tokenCmd is single-only (split reads the token file)`)
  for (const [n, s] of Object.entries<any>(raw.secrets ?? {})) if (s?.cmd !== undefined) throw new ConfigError(`${path}: secrets.${n}.cmd is single-only (split: a file)`)
  for (const r of raw.resources ?? []) if (r?.githubTokenCmd !== undefined) throw new ConfigError(`${path}: resource ${r.id}: githubTokenCmd is single-only (split: "secret": "<name>")`)
}

export type SplitDeps = { rootUid?: number; uidOf?: (user: string) => number | null }

/** The split config: install.conf's paths, root's config.json, the operator's tuning.json. */
export function loadSplitConfig(ic: InstallConf, d: SplitDeps = {}): Config {
  const c = loadSplitRoot(ic, d)
  applySplitTuning(c, d)
  return c
}

function applySplitTuning(c: Config, d: SplitDeps) {
  const p = derivePaths(c.installConf!)
  if (existsSync(p.tuningPath) || isLink(p.tuningPath)) applyTuning(c, readOperatorJson(p.tuningPath, c.operatorUid, 'tuning.json'))
}

/** install.conf's paths and root's config.json, without the operator's tuning. */
export function loadSplitRoot(ic: InstallConf, d: SplitDeps = {}): Config {
  const p = derivePaths(ic)
  const env = { HOME: p.daemonHome }
  const raw = readRootJson(p.rootConfigPath, d.rootUid ?? 0) as any
  checkRootSplit(raw, p.rootConfigPath)
  const base = defaults(env)
  base.credentials = { github: { file: join(p.daemonHome, 'github-token') }, boat: { configHome: join(p.daemonHome, '.config') } }
  const c: Config = merge(base, raw)
  if (raw.credentials?.github) c.credentials.github = { file: raw.credentials.github.file ?? join(p.daemonHome, 'github-token') }
  for (const [n, s] of Object.entries(c.secrets)) c.secrets[n] = { file: s.file ?? join(p.secretsDir, n) }
  const operatorUid = (d.uidOf ?? ((u) => lookupId('user', u)))(ic.OPERATOR)
  if (operatorUid === null) throw new ConfigError(`install.conf: no user ${ic.OPERATOR}`)
  Object.assign(c, {
    layout: 'split', installConf: ic, operator: ic.OPERATOR, operatorUid,
    stateDir: p.stateDir, socketPath: p.socketPath, githubSocketPath: p.githubSocketPath, localLockPath: p.localLockPath,
    daemonLockPath: '/run/lock/ci-brokerd.lock', profilesDir: p.profilesDir, runnersJson: p.runnersJson, releaseFile: p.releaseFile,
    rootConfigPath: p.rootConfigPath, tuningPath: p.tuningPath, boatBin: p.boatBin, ghBin: p.ghBin, sshBin: '/usr/bin/ssh', scpBin: '/usr/bin/scp',
  })
  validateCommon(c)
  return c
}

const isLink = (path: string) => {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/** single without CI_BROKER_CONFIG and with install.conf present → split; else single. */
export function loadAnyConfig(env: NodeJS.ProcessEnv = process.env, d: SplitDeps = {}): Config {
  const ic = env.CI_BROKER_CONFIG ? null : readInstallConf(env)
  return ic ? loadSplitConfig(ic, d) : loadConfig(defaultConfigPath(env), env)
}

/**
 * The parts of the config that may change without a restart, read again at every submit in split: root's trust and
 * secrets, and the operator's tuning. Mutates `c`; throws ConfigError naming the file and key.
 */
export function reloadLive(c: Config, d: SplitDeps = {}, o: { tuning?: 'throw' | 'ignore'; log?: (m: string) => void } = {}) {
  if (c.layout !== 'split' || !c.installConf) return
  // root's file first and on its own: a bad tuning.json can't hold back root's changes
  const fresh = loadSplitRoot(c.installConf, d)
  c.trust = fresh.trust
  c.secrets = fresh.secrets
  try {
    applySplitTuning(fresh, d)
  } catch (e) {
    if (o.tuning === 'ignore') {
      o.log?.(`config: ${(e as Error).message} (ignored at the GitHub door)`)
      return
    }
    throw e
  }
  Object.assign(c.local, fresh.local)
  Object.assign(c.pool, fresh.pool)
  for (const k of ['runnersPerRepo', 'queueTimeoutSec', 'shardTimeoutSec', 'retentionDays', 'artifactsMaxMb', 'localMaxLoadFactor'] as const) c[k] = fresh[k]
  // undefined when tuning.json no longer sets it: back to root's value
  ;(c as any).tunedMaxBoxes = (fresh as any).tunedMaxBoxes
}

/** The public lane's Boat environment for a repo (root's trust.repos.<repo>.publicBoat), or null. */
export function publicBoatEnv(t: TrustCfg, repo: string): string | null {
  const k = Object.keys(t.repos).find((x) => x.toLowerCase() === repo.toLowerCase())
  return (k && t.repos[k].publicBoat) || null
}

/** Every public-lane environment: a full-lane job never uses one (its boxes ran public code). */
export function publicBoatEnvs(t: TrustCfg): Set<string> {
  return new Set(Object.values(t.repos).flatMap((r) => (r.publicBoat ? [r.publicBoat] : [])))
}

/** A boat resource's cap: tuning.json's `boat.maxBoxes`, else root's resource entry, else 10. */
export function boatMaxBoxes(c: Config, r: { id: string; maxBoxes?: number }): number {
  return (c as any).tunedMaxBoxes ?? c.resources?.find((x) => x.id === r.id)?.maxBoxes ?? r.maxBoxes ?? 10
}

/**
 * After reloadLive: the daemon's resolved resources (the Boat pool holds the same objects) take the cap now, not
 * at the next restart.
 */
export function applyLiveCaps(c: Config, resources: ResourceCfg[]) {
  for (const r of resources) if (r.kind === 'boat') r.maxBoxes = boatMaxBoxes(c, { id: r.id })
}

/** The configured resources with defaults filled in. No `resources` key → local + boat for every profile. */
export function resolveResources(c: Config): ResourceCfg[] {
  const list = c.resources ?? [
    { id: 'local', kind: 'local', profiles: ['*'] },
    { id: 'boat', kind: 'boat', profiles: ['*'] },
  ]
  return list.map((r) => {
    const out: ResourceCfg = { ...r, profiles: r.profiles ?? ['*'] }
    if (r.kind === 'boat') out.maxBoxes = boatMaxBoxes(c, r)
    if (r.kind === 'ssh') {
      out.host = r.host ?? r.id
      out.slots = Math.max(1, Math.floor(r.slots ?? 1))
    }
    if (r.kind === 'github') {
      if (!r.workflow) throw new Error(`resource ${r.id}: a github resource needs a workflow`)
      out.modes = r.modes ?? []
      out.afterWaitSec = r.afterWaitSec ?? 900
    }
    return out
  })
}

export const serves = (r: ResourceCfg, profile: string) => r.profiles.includes('*') || r.profiles.includes(profile)
