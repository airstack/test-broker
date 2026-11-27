// /etc/ci-broker/install.conf: the one place (with install.sh's flags) that names the `split` layout's users and
// paths. Strict like the bash reader in scripts/ (same fixtures): one KEY=value per line, known keys only, no
// duplicates, values ^[A-Za-z0-9_./-]{1,200}$, user/group names ^[a-z_][a-z0-9_-]{0,31}$, paths absolute without
// `..`. Parsed, never sourced. No file = the `single` layout.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const INSTALL_CONF = '/etc/ci-broker/install.conf'

export const NAME_KEYS = ['OPERATOR', 'OPERATOR_GROUP', 'DAEMON_USER', 'RUNNER_USER'] as const
export const PATH_KEYS = ['OPT_DIR', 'STATE_DIR', 'ETC_DIR', 'TOOLS_DIR'] as const
type Key = (typeof NAME_KEYS)[number] | (typeof PATH_KEYS)[number]
export type InstallConf = Record<Key, string>

export function parseInstallConf(text: string): InstallConf {
  const out: Partial<InstallConf> = {}
  const keys = new Set<string>([...NAME_KEYS, ...PATH_KEYS])
  text.split('\n').forEach((line, i) => {
    if (line === '') return
    const m = /^([A-Z_]+)=(.*)$/.exec(line)
    if (!m) throw new Error(`install.conf line ${i + 1}: not KEY=value`)
    const [, k, v] = m
    if (!keys.has(k)) throw new Error(`install.conf line ${i + 1}: unknown key ${k}`)
    if (k in out) throw new Error(`install.conf line ${i + 1}: ${k} given twice`)
    if (!/^[A-Za-z0-9_./-]{1,200}$/.test(v)) throw new Error(`install.conf: ${k} has a bad value`)
    if ((NAME_KEYS as readonly string[]).includes(k) && !/^[a-z_][a-z0-9_-]{0,31}$/.test(v)) throw new Error(`install.conf: ${k} is not a user or group name`)
    if ((PATH_KEYS as readonly string[]).includes(k) && (!v.startsWith('/') || v.split('/').includes('..'))) throw new Error(`install.conf: ${k} must be an absolute path`)
    out[k as Key] = v
  })
  for (const k of keys) if (!(k in out)) throw new Error(`install.conf: ${k} is missing`)
  return out as InstallConf
}

/** The daemon and the client accept CI_BROKER_INSTALL_CONF (they never run as root); root scripts never do. */
export function readInstallConf(env: NodeJS.ProcessEnv = process.env): InstallConf | null {
  const path = env.CI_BROKER_INSTALL_CONF || INSTALL_CONF
  if (!existsSync(path)) return null
  return parseInstallConf(readFileSync(path, 'utf8'))
}

/** Every `split` path, derived (the config files have no path keys). */
export function derivePaths(ic: InstallConf) {
  const s = ic.STATE_DIR
  return {
    daemonHome: join(s, 'admin'),
    stateDir: join(s, 'admin', 'state'),
    localDir: join(s, 'local'),
    socketPath: join(s, 'local', 'brokerd.sock'),
    localLockPath: join(s, 'local', 'local.lock'),
    sockDir: join(s, 'sock'),
    githubSocketPath: join(s, 'sock', 'github.sock'),
    operatorDir: join(s, 'operator'),
    profilesDir: join(s, 'operator', 'profiles'),
    tuningPath: join(s, 'operator', 'tuning.json'),
    runnersJson: join(s, 'runners.json'),
    rootConfigPath: join(ic.ETC_DIR, 'config.json'),
    secretsDir: join(ic.ETC_DIR, 'secrets'),
    ghBin: join(ic.TOOLS_DIR, 'gh'),
    boatBin: join(ic.TOOLS_DIR, 'boat'),
    nodeBin: join(ic.TOOLS_DIR, 'node', 'bin', 'node'),
    releaseFile: join(ic.OPT_DIR, 'current', 'RELEASE'),
    runnerctl: '/usr/local/sbin/ci-broker-runnerctl',
  }
}
export type SplitPaths = ReturnType<typeof derivePaths>

/** uid/gid of a user or group from /etc/passwd and /etc/group (no exec). */
export function lookupId(kind: 'user' | 'group', name: string, files = { passwd: '/etc/passwd', group: '/etc/group' }): number | null {
  try {
    for (const l of readFileSync(kind === 'user' ? files.passwd : files.group, 'utf8').split('\n')) {
      const f = l.split(':')
      if (f[0] === name && /^\d+$/.test(f[2] ?? '')) return Number(f[2])
    }
  } catch {}
  return null
}
