// A profile says how to run one repo's suites: its shard plan for Boat, the script that runs a shard on a box, and the
// commands for a whole-mode local run. Profiles live in <profilesDir>/<name>/profile.json. In `split` they are the
// operator's files: every file is opened with O_NOFOLLOW and must be a regular file the operator owns, and the daemon
// works from its own snapshot of the dir (so nothing it later reads or uploads can be swapped for a link).
import { createHash } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isRepoName, SECRET_NAME, type Layout } from './config.ts'
import { q } from '../core/shell.ts'

/** `requireArgs`: the usage shown when the mode is submitted with no args (a passArgs shard that would pass vacuously) */
export type Shard = { name: string; size: string; args: string[]; passArgs?: boolean; requireArgs?: string }

export type Profile = {
  name: string
  repo: string
  /** default: the boat resource's `environment` */
  boatEnvironment?: string
  remoteScript: string
  /** checkout-relative paths collected after each shard/local run if they exist */
  artifacts?: string[]
  /** remote-script exit codes meaning "the environment failed, not necessarily the tests" */
  infraExitCodes?: number[]
  /** shard args for the health check */
  check?: string[]
  /** false turns off commit statuses for this profile */
  status?: boolean
  /** GitHub door: the mode a pull_request run runs (none → PR runs are refused) */
  github?: { prMode?: string }
  local?: {
    where: 'container' | 'host'
    image?: string
    nono?: string[] | false
    /** single, host mode: wrap the command in `nono run -s --profile <p>` (a convenience, not a boundary) */
    nonoProfile?: string
    /** full lane only: ["caps"] drops --cap-drop ALL */
    dockerRelax?: 'caps'[]
    /** run before every local command, in the fresh checkout */
    setup?: string
    /** env var -> a job secret's name; passed by name (-e VAR), never on a command line */
    env?: Record<string, string>
    /** container only: checkout-relative dirs mounted as tmpfs (scratch state a file watcher must see as a real dir) */
    tmpfs?: string[]
    /** mode -> shell command; {args} = the user args shell-quoted, {cmd} = one arg as is, several each quoted */
    commands: Record<string, string>
  }
  /** mode -> shards, or "a + b" to combine other modes */
  modes: Record<string, Shard[] | string>
  /** set by loadProfile */
  dir: string
}

export const PROFILES_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'ci', 'profiles')

/** profile and mode names: never `.`, `..` or a path */
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

export class ProfileError extends Error {}

const TOP = new Set(['name', 'repo', 'boatEnvironment', 'remoteScript', 'artifacts', 'infraExitCodes', 'check', 'status', 'github', 'local', 'modes'])
const LOCAL = new Set(['where', 'image', 'nono', 'nonoProfile', 'dockerRelax', 'setup', 'env', 'tmpfs', 'commands'])
const relPath = (s: unknown) => typeof s === 'string' && s !== '' && !s.startsWith('/') && !s.split('/').includes('..')

/** The key rules. Throws a ProfileError naming the key. */
export function validateProfile(p: any, layout: Layout) {
  const bad = (m: string) => {
    throw new ProfileError(`profile ${p?.name ?? '?'}: ${m}`)
  }
  if (!p || typeof p !== 'object' || Array.isArray(p)) bad('profile.json must be an object')
  for (const k of Object.keys(p)) if (!TOP.has(k)) bad(`unknown key ${k}`)
  if (typeof p.name !== 'string' || !NAME_RE.test(p.name)) bad('name: bad profile name')
  if (!isRepoName(p.repo)) bad('repo: must be owner/name')
  if (typeof p.remoteScript !== 'string' || !NAME_RE.test(p.remoteScript)) bad('remoteScript: a file name in the profile dir')
  if (p.artifacts !== undefined && !(Array.isArray(p.artifacts) && p.artifacts.every(relPath))) bad('artifacts: checkout-relative paths only')
  if (!p.modes || typeof p.modes !== 'object') bad('modes: missing')
  const strs = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string')
  for (const [m, v] of Object.entries<any>(p.modes)) {
    if (!NAME_RE.test(m)) bad(`modes.${m}: bad mode name`)
    if (typeof v === 'string') {
      for (const part of v.split('+').map((x) => x.trim())) if (!(part in p.modes) || part === m) bad(`modes.${m}: unknown mode ${part}`)
      continue
    }
    if (!Array.isArray(v) || !v.length) bad(`modes.${m}: a list of shards or "a + b"`)
    v.forEach((sh: any, i: number) => {
      const at = `modes.${m}[${i}]`
      // a shard name becomes <job dir>/<name>.log and an artifacts dir: never a path; the daemon's own names are reserved
      if (typeof sh?.name !== 'string' || !NAME_RE.test(sh.name)) bad(`${at}.name: bad shard name`)
      if (sh.name === 'local' || sh.name === 'hosted') bad(`${at}.name: '${sh.name}' is reserved (the daemon's whole-mode shard)`)
      if (typeof sh.size !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(sh.size)) bad(`${at}.size: a Boat size (small, default, large, …)`)
      if (!strs(sh.args)) bad(`${at}.args: a list of strings`)
      if (sh.passArgs !== undefined && typeof sh.passArgs !== 'boolean') bad(`${at}.passArgs: true or false`)
      if (sh.requireArgs !== undefined && typeof sh.requireArgs !== 'string') bad(`${at}.requireArgs: a usage string`)
    })
  }
  if (p.boatEnvironment !== undefined && !(typeof p.boatEnvironment === 'string' && NAME_RE.test(p.boatEnvironment))) bad('boatEnvironment: a Boat environment name')
  if (p.check !== undefined && !strs(p.check)) bad('check: a list of strings')
  if (p.infraExitCodes !== undefined && !(Array.isArray(p.infraExitCodes) && p.infraExitCodes.every((x: unknown) => Number.isInteger(x)))) bad('infraExitCodes: a list of exit codes')
  if (p.github !== undefined) {
    for (const k of Object.keys(p.github)) if (k !== 'prMode') bad(`unknown key github.${k}`)
    if (p.github.prMode !== undefined && !(typeof p.github.prMode === 'string' && p.github.prMode in p.modes)) bad('github.prMode: must be one of the modes')
  }
  const l = p.local
  if (l === undefined) return
  for (const k of Object.keys(l)) {
    if (k === 'envForGithubDoor') bad("local.envForGithubDoor is gone: root's trust.repos.<repo>.envForGithubDoor decides it")
    if (!LOCAL.has(k)) bad(`unknown key local.${k}`)
  }
  if (l.where !== 'container' && l.where !== 'host') bad('local.where: container or host')
  if (l.nonoProfile !== undefined && layout === 'split') bad('local.nonoProfile is single-only (no host mode in split)')
  if (l.nonoProfile !== undefined && !(typeof l.nonoProfile === 'string' && NAME_RE.test(l.nonoProfile))) bad('local.nonoProfile: a nono profile name')
  if (l.dockerRelax !== undefined && !(Array.isArray(l.dockerRelax) && l.dockerRelax.every((x: unknown) => x === 'caps'))) bad('local.dockerRelax: only ["caps"]')
  for (const [k, v] of Object.entries(l.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k)) bad(`local.env.${k}: bad variable name`)
    if (typeof v !== 'string' || !SECRET_NAME.test(v)) bad(`local.env.${k}: must be a job secret's name (no commands)`)
  }
  // a tmpfs entry goes into `--tmpfs <dir>:<options>`: no `:` or `,` of its own
  if (l.tmpfs !== undefined && !(Array.isArray(l.tmpfs) && l.tmpfs.every((t: unknown) => relPath(t) && /^[A-Za-z0-9_./-]+$/.test(t as string)))) bad('local.tmpfs: checkout-relative paths (letters, digits, _ . - /) only')
  // the image is a positional `docker run` arg: never a flag
  if (l.image !== undefined && !(typeof l.image === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/.test(l.image))) bad('local.image: a Docker image reference')
  if (l.where === 'container' && !l.image) bad('local.image: a container run needs an image')
  if (!l.commands || typeof l.commands !== 'object') bad('local.commands: missing')
}

export type LoadOpts = {
  layout?: Layout
  /** split: operator files must be owned by this uid (null = no owner check, as in single) */
  ownerUid?: number | null
  /** split: where the daemon keeps its snapshots of profile dirs */
  snapshotDir?: string
}

/** Read one operator file: O_NOFOLLOW, regular, owned by uid. Errors never carry the content. */
function readStrict(path: string, rel: string, uid: number, name: string): Buffer {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    throw new ProfileError(`profile ${name}: ${rel}: ${code === 'ELOOP' ? 'is a symlink (refused)' : code === 'ENOENT' ? 'missing' : `cannot be opened (${code})`}`)
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) throw new ProfileError(`profile ${name}: ${rel}: not a regular file`)
    if (st.uid !== uid) throw new ProfileError(`profile ${name}: ${rel}: not owned by the operator`)
    return readFileSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Every file under dir (relative path → content), refusing links and anything not a regular file or a dir. */
function readTree(dir: string, uid: number, name: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  const walk = (d: string) => {
    const st = lstatSync(d)
    if (st.isSymbolicLink()) throw new ProfileError(`profile ${name}: ${relative(dir, d) || '.'}: is a symlink (refused)`)
    if (st.uid !== uid) throw new ProfileError(`profile ${name}: ${relative(dir, d) || '.'}: not owned by the operator`)
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      const rel = relative(dir, p)
      if (e.isSymbolicLink()) throw new ProfileError(`profile ${name}: ${rel}: is a symlink (refused)`)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) out.set(rel, readStrict(p, rel, uid, name))
      else throw new ProfileError(`profile ${name}: ${rel}: not a regular file`)
    }
  }
  walk(dir)
  return out
}

const hashFiles = (files: Map<string, Buffer>) => {
  const h = createHash('sha256')
  for (const rel of [...files.keys()].sort()) h.update(rel).update('\u0000').update(files.get(rel)!).update('\u0000')
  return h.digest('hex').slice(0, 12)
}

export function loadProfile(name: string, root = PROFILES_ROOT, o: LoadOpts = {}): Profile {
  if (!NAME_RE.test(name)) throw new ProfileError(`profile name '${String(name).slice(0, 80)}' is not valid`)
  const dir = join(root, name)
  const layout = o.layout ?? 'single'
  if (o.ownerUid === undefined || o.ownerUid === null) {
    if (!existsSync(join(dir, 'profile.json'))) throw new ProfileError(`no profile '${name}' in ${root}`)
    let p: any
    try {
      p = JSON.parse(readFileSync(join(dir, 'profile.json'), 'utf8'))
    } catch {
      throw new ProfileError(`profile ${name}: profile.json is not valid JSON`)
    }
    validateProfile(p, layout)
    if (p.name !== name) throw new ProfileError(`profile ${name}: name is '${p.name}', not the dir name`)
    return { ...p, dir }
  }
  if (!existsSync(dir)) throw new ProfileError(`no profile '${name}' in ${root}`)
  const files = readTree(dir, o.ownerUid, name)
  const raw = files.get('profile.json')
  if (!raw) throw new ProfileError(`profile ${name}: profile.json: missing`)
  let p: any
  try {
    p = JSON.parse(raw.toString('utf8'))
  } catch {
    throw new ProfileError(`profile ${name}: profile.json: not valid JSON`)
  }
  validateProfile(p, layout)
  if (p.name !== name) throw new ProfileError(`profile ${name}: name is '${p.name}', not the dir name`)
  if (!files.has(p.remoteScript)) throw new ProfileError(`profile ${name}: remoteScript ${p.remoteScript}: missing`)
  const snapRoot = o.snapshotDir ?? join(root, '..', '.snapshots')
  const snap = join(snapRoot, `${name}-${hashFiles(files)}`)
  if (existsSync(snap)) {
    // in use again: the prune (unused and older than an hour) must not take it during this submit
    const now = new Date()
    try {
      utimesSync(snap, now, now)
    } catch {}
  } else {
    mkdirSync(snapRoot, { recursive: true, mode: 0o700 })
    const tmp = `${snap}.tmp-${process.pid}`
    rmSync(tmp, { recursive: true, force: true })
    for (const [rel, buf] of files) {
      mkdirSync(dirname(join(tmp, rel)), { recursive: true })
      writeFileSync(join(tmp, rel), buf, { mode: rel === p.remoteScript ? 0o700 : 0o600 })
    }
    try {
      renameSync(tmp, snap)
    } catch {
      rmSync(tmp, { recursive: true, force: true }) // another submit made it first
    }
  }
  return { ...p, dir: snap }
}

/** A profile from a dir the daemon owns (a job's pinned snapshot): read and validated, no owner rules. */
export function loadProfileDir(dir: string, layout: Layout = 'single'): Profile {
  let p: any
  try {
    p = JSON.parse(readFileSync(join(dir, 'profile.json'), 'utf8'))
  } catch {
    throw new ProfileError(`the job's profile snapshot ${dir} is missing or not JSON`)
  }
  validateProfile(p, layout)
  return { ...p, dir }
}

export function shardsFor(p: Profile, mode: string, args: string[]): Shard[] {
  const m = p.modes[mode]
  if (m === undefined) throw new Error(`unknown mode '${mode}' for profile ${p.name} (modes: ${Object.keys(p.modes).join(', ')})`)
  if (typeof m === 'string') return m.split('+').flatMap((x) => shardsFor(p, x.trim(), args))
  const need = !args.length && m.find((s) => s.passArgs && s.requireArgs)
  if (need) throw new Error(`mode ${mode} needs args: ${need.requireArgs}`)
  return m.map((s) => ({ ...s, args: s.passArgs ? [...s.args, ...args] : [...s.args] }))
}

/** `{args}`: every arg quoted. `{cmd}`: one arg as is (a shell command on purpose), several args each quoted. */
export function localCommand(p: Profile, mode: string, args: string[]): string | null {
  const c = p.local?.commands[mode]
  if (!c) return null
  const cmd = args.length === 1 ? args[0] : args.map(q).join(' ')
  return c.replaceAll('{args}', args.map(q).join(' ')).replaceAll('{cmd}', cmd)
}

export const argsHash = (args: string[]) => (args.length ? createHash('sha256').update(args.join('\u0000')).digest('hex').slice(0, 8) : '-')

export type Lane = 'full' | 'public'
export type EnvClass = 'env' | 'noenv'

/**
 * `<repo> <profile> <profileHash> <mode> <tree> <argsHash|-> <lane> <env|noenv>`: a pass is only reused for exactly the
 * same request. A public-lane pass never serves a full-lane request; a `noenv` request never joins or reuses a run that
 * had the profile's job secrets (its output could carry one the scrubber missed).
 */
export function jobKey(o: { repo: string; profile: string; profileHash: string; mode: string; tree: string; args: string[]; lane: Lane; env: EnvClass }): string {
  return `${o.repo} ${o.profile} ${o.profileHash} ${o.mode} ${o.tree} ${argsHash(o.args)} ${o.lane} ${o.env}`
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)]))
}

/** sha256 over every file in the profile dir (paths + contents): editing a shard plan or the script never reuses a pass. */
export function profileHash(p: Pick<Profile, 'dir'>): string {
  const h = createHash('sha256')
  for (const f of filesUnder(p.dir).sort()) h.update(relative(p.dir, f)).update('\u0000').update(readFileSync(f)).update('\u0000')
  return h.digest('hex').slice(0, 12)
}
