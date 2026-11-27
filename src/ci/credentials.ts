// The daemon's own credentials (GitHub, Boat) and the job secrets, two classes never mixed. No job ever receives a
// credential. The GitHub token is read once at start (and again after a 401), kept in memory, added to the scrubber
// and handed to each child in its env: GH_TOKEN for gh, a credential helper that prints CIB_GIT_TOKEN for git over
// https. Never in an argv. In split it is only ever read from its file (no command runs to get it). Git runs with the
// daemon's own global config (just safe.directory) and no system config, so ~/.gitconfig can't reroute fetches.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from './config.ts'

export type CredDeps = {
  /** hide a value from now on (the scrubber) */
  addSecret: (v: string) => void
  /** runs a shell command for its stdout (single: tokenCmd, secret cmd) */
  sh?: (cmd: string) => string | Promise<string>
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
/** Async: a slow keyring or a hung command must not freeze the daemon. */
const realSh = (cmd: string) =>
  new Promise<string>((resolve, reject) => {
    const p = execFile('bash', ['-c', cmd], { encoding: 'utf8', timeout: 30_000 }, (e, out) => (e ? reject(e) : resolve(out)))
    p.stdin?.end()
  })

/** git asks this helper for https credentials; it prints the token from the env, never from a file or argv. */
export const GIT_HELPER = '!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$CIB_GIT_TOKEN"; }; f'

export class Credentials {
  token: string | null = null
  private cfg: Config
  private d: CredDeps
  constructor(cfg: Config, d: CredDeps) {
    this.cfg = cfg
    this.d = d
  }

  /** Read the GitHub token (split: the file; single: the file or tokenCmd). null when there is none. */
  async load(): Promise<string | null> {
    const g = this.cfg.credentials.github
    let t = ''
    try {
      if (g.file) t = existsSync(g.file) ? readFileSync(g.file, 'utf8') : ''
      else if (this.cfg.layout !== 'split' && g.tokenCmd) t = await (this.d.sh ?? realSh)(g.tokenCmd)
    } catch {
      t = ''
    }
    t = t.trim().split('\n')[0]?.trim() ?? ''
    this.token = t || null
    if (this.token) this.d.addSecret(this.token)
    return this.token
  }
  /** after a 401: read it again (a replaced credential takes effect without a restart) */
  reload = () => void this.load()

  tokenHash(): string | null {
    return this.token ? sha(this.token) : null
  }

  ghEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...base, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' }
    if (this.token) env.GH_TOKEN = this.token
    return env
  }

  /** The daemon's git config file: empty but for safe.directory. */
  gitConfigFile(): string {
    const f = join(this.cfg.stateDir, 'gitconfig')
    const want = '[safe]\n\tdirectory = *\n'
    if (!existsSync(f) || readFileSync(f, 'utf8') !== want) {
      mkdirSync(this.cfg.stateDir, { recursive: true })
      writeFileSync(f, want)
    }
    return f
  }

  gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...base, GIT_CONFIG_GLOBAL: this.gitConfigFile(), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }
    // a reset of every inherited credential.helper, then ours
    Object.assign(env, { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '', GIT_CONFIG_KEY_1: 'credential.helper', GIT_CONFIG_VALUE_1: GIT_HELPER })
    if (this.token) env.CIB_GIT_TOKEN = this.token
    else delete env.CIB_GIT_TOKEN
    return env
  }

  boatEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...base }
    if (this.cfg.credentials.boat.configHome) env.XDG_CONFIG_HOME = this.cfg.credentials.boat.configHome
    env.BOAT_NO_UPDATE = '1'
    return env
  }

  /** the last value each `cmd` secret's command gave (readSecret / refreshSecrets) */
  private cmdValues = new Map<string, string | null>()

  /**
   * A job secret's value, without waiting: a file secret is read now; a `cmd` secret (single only) is its command's
   * last answer (refreshSecrets runs them at start and on a timer). null = not set (undefined, no file, empty, or a
   * command that has not answered yet). For admission and doctor; a run reads with readSecret.
   */
  secret(name: string): string | null {
    const s = this.cfg.secrets[name]
    if (!s) return null
    if (!s.file) return s.cmd && this.cfg.layout !== 'split' ? (this.cmdValues.get(name) ?? null) : null
    try {
      const v = (existsSync(s.file) ? readFileSync(s.file, 'utf8') : '').replace(/\r?\n$/, '')
      return v || null
    } catch {
      return null
    }
  }

  /** A job secret's value, read now (a run's start): a `cmd` secret runs its command (async, 30 s limit). */
  async readSecret(name: string): Promise<string | null> {
    const s = this.cfg.secrets[name]
    if (!s || s.file || !s.cmd || this.cfg.layout === 'split') return this.secret(name)
    let v: string | null = null
    try {
      v = (await (this.d.sh ?? realSh)(s.cmd)).replace(/\r?\n$/, '') || null
    } catch {
      v = null
    }
    this.cmdValues.set(name, v)
    return v
  }

  /** Run every `cmd` secret's command, so secret() answers for them (start, then the timers). */
  async refreshSecrets(): Promise<void> {
    if (this.cfg.layout === 'split') return
    for (const [n, s] of Object.entries(this.cfg.secrets)) if (!s.file && s.cmd) await this.readSecret(n)
  }

  /** The job secrets whose value equals the daemon's GitHub credential (doctor refuses; the banner says so). */
  secretsEqualToCredential(): string[] {
    const h = this.tokenHash()
    if (!h) return []
    return Object.keys(this.cfg.secrets).filter((n) => {
      const v = this.secret(n)
      return v !== null && sha(v.trim()) === h
    })
  }
}
