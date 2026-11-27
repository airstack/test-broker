// One bare mirror per repo under <stateDir>/work/<owner>__<name>.git. It fetches only +refs/heads/*:refs/heads/*
// with --prune (which never touches refs/cib/*). Commits not on a branch are fetched by sha into refs/cib/sha/<sha>;
// snapshot bundles land in refs/cib/snap/<job>. All git work on one mirror is serialized by a per-repo mutex.
//
// Hardened: the URL is never read from the mirror's config (every fetch passes it); every call runs with
// core.hooksPath=/dev/null, core.fsmonitor=false and gc.auto=0; gc runs only from the prune timer, and only while the
// repo has no active job (a run's clone reads the mirror's objects through its alternates). Local runs get their own
// --shared clone (cloneForRun): no job ever has write access to a mirror, and git never runs in a dir a job had.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type GitResult = { stdout: string; stderr: string; code: number }
/** Runs git; never throws on a non-zero exit (look at `code`). */
export type GitRunner = (args: string[], o?: { cwd?: string; timeoutSec?: number }) => Promise<GitResult>

export function realGit(defaultTimeoutSec: number, env: () => NodeJS.ProcessEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: '0' })): GitRunner {
  return (args, o = {}) =>
    new Promise((resolve) => {
      execFile(
        'git',
        args,
        { cwd: o.cwd, timeout: (o.timeoutSec ?? defaultTimeoutSec) * 1000, maxBuffer: 1 << 26, env: env() },
        (err, stdout, stderr) => {
          const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0
          resolve({ stdout: String(stdout), stderr: String(stderr) || (err && !stderr ? err.message : ''), code })
        },
      )
    })
}

export const repoDir = (repo: string) => repo.replace('/', '__')
const SHA = /^[0-9a-f]{40}$/
/** on every git call the daemon makes: nothing a repo's config or hooks say runs */
export const SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'gc.auto=0']

export class Mirror {
  private locks = new Map<string, Promise<unknown>>()
  readonly workRoot: string
  private urlFor: (repo: string) => string
  private git: GitRunner
  constructor(workRoot: string, urlFor: (repo: string) => string, git: GitRunner) {
    this.workRoot = workRoot
    this.urlFor = urlFor
    this.git = git
  }

  path(repo: string) {
    return join(this.workRoot, `${repoDir(repo)}.git`)
  }

  /** Run fn with this repo's mirror to itself. */
  lock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(repo) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    const tail = next.catch(() => {})
    this.locks.set(repo, tail)
    void tail.then(() => this.locks.get(repo) === tail && this.locks.delete(repo))
    return next
  }

  private g(repo: string, args: string[], timeoutSec?: number) {
    return this.git([...SAFE, '--git-dir', this.path(repo), ...args], { timeoutSec })
  }
  private url(repo: string) {
    return this.urlFor(repo)
  }
  private async ok(repo: string, args: string[]): Promise<string> {
    const r = await this.g(repo, args)
    if (r.code !== 0) throw new Error(`git ${args[0]}: ${(r.stderr || r.stdout).trim().slice(-400)}`)
    return r.stdout
  }

  /** Clone if missing, then fetch the branches. Throws when origin can't be reached. */
  ensure(repo: string): Promise<void> {
    return this.lock(repo, async () => {
      const p = this.path(repo)
      if (!existsSync(join(p, 'HEAD'))) {
        mkdirSync(this.workRoot, { recursive: true })
        rmSync(p, { recursive: true, force: true })
        const r = await this.git([...SAFE, 'init', '--quiet', '--bare', p])
        if (r.code !== 0) throw new Error(`git init ${p}: ${r.stderr.trim()}`)
        await this.ok(repo, ['config', 'gc.auto', '0'])
      }
      await this.ok(repo, ['fetch', '--quiet', '--prune', '--no-tags', this.url(repo), '+refs/heads/*:refs/heads/*'])
    })
  }

  private hasNoLock(repo: string, sha: string) {
    return this.g(repo, ['cat-file', '-e', `${sha}^{commit}`]).then((r) => r.code === 0)
  }
  /** The objects are in the mirror (from origin or from a snapshot bundle). Not the same as "on origin". */
  has(repo: string, sha: string): Promise<boolean> {
    return this.lock(repo, () => this.hasNoLock(repo, sha))
  }

  /**
   * Origin has the commit as far as the mirror knows: it is reachable from a branch (refs/heads/*) or from a commit
   * fetched from origin by sha (refs/cib/sha/*). Never from refs/cib/snap/*: snapshot bundles came from a client.
   */
  private async onOriginNoLock(repo: string, sha: string): Promise<boolean> {
    if (!(await this.hasNoLock(repo, sha))) return false
    const r = await this.g(repo, ['for-each-ref', '--count=1', '--format=%(refname)', '--contains', sha, 'refs/heads/', 'refs/cib/sha/'])
    return r.code === 0 && r.stdout.trim() !== ''
  }

  /**
   * Ask origin whether it has a commit the mirror already holds (from a bundle). A fetch by sha into the mirror would
   * not ask: git sees the objects locally and "succeeds" without origin. So fetch that one commit (no trees, depth 1)
   * into a scratch repo that has nothing.
   */
  private async originHas(repo: string, sha: string): Promise<boolean> {
    mkdirSync(this.workRoot, { recursive: true })
    const tmp = mkdtempSync(join(this.workRoot, '.probe-'))
    try {
      const run = (args: string[]) => this.git([...SAFE, '--git-dir', tmp, ...args])
      if ((await run(['init', '--quiet', '--bare'])).code !== 0) return false
      return (await run(['fetch', '--quiet', '--no-tags', '--depth=1', '--filter=tree:0', this.url(repo), `${sha}:refs/probe`])).code === 0
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }

  /** The commit is on origin (see onOriginNoLock), or fetchable from origin by sha (then kept under refs/cib/sha/<sha>). */
  hasOrFetch(repo: string, sha: string): Promise<boolean> {
    if (!SHA.test(sha)) return Promise.resolve(false)
    return this.lock(repo, async () => {
      if (await this.onOriginNoLock(repo, sha)) return true
      if (await this.hasNoLock(repo, sha)) {
        // only a snapshot holds it: keep it under refs/cib/sha only if origin really has it
        if (!(await this.originHas(repo, sha))) return false
        await this.g(repo, ['update-ref', `refs/cib/sha/${sha}`, sha])
      } else await this.g(repo, ['fetch', '--quiet', '--no-tags', this.url(repo), `${sha}:refs/cib/sha/${sha}`])
      return this.onOriginNoLock(repo, sha)
    })
  }

  /** The first candidate that is on origin (the bundle base: a box fetches it from origin by sha), or null. */
  firstPresent(repo: string, candidates: string[]): Promise<string | null> {
    return this.lock(repo, async () => {
      for (const c of candidates) if (SHA.test(c) && (await this.onOriginNoLock(repo, c))) return c
      return null
    })
  }

  /** origin's default branch and its head (`git ls-remote --symref origin HEAD`). Throws when origin can't say. */
  remoteHead(repo: string): Promise<{ branch: string; sha: string }> {
    return this.lock(repo, async () => {
      const out = await this.ok(repo, ['ls-remote', '--symref', this.url(repo), 'HEAD'])
      const branch = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(out)?.[1]
      const sha = /^([0-9a-f]{40})\s+HEAD$/m.exec(out)?.[1]
      if (!branch || !sha) throw new Error(`origin of ${repo} names no default branch`)
      return { branch, sha }
    })
  }

  /**
   * Check 14 of the GitHub door: after a fetch from origin that must succeed, is the sha an ancestor of
   * refs/heads/<branch>? Throws when the fetch fails (the caller refuses).
   */
  isMerged(repo: string, sha: string, branch: string): Promise<boolean> {
    if (!SHA.test(sha) || !/^[A-Za-z0-9_./-]{1,200}$/.test(branch) || branch.includes('..')) return Promise.resolve(false)
    return this.ensureFetched(repo).then(() =>
      this.lock(repo, async () => {
        if (!(await this.hasNoLock(repo, sha))) return false
        return (await this.g(repo, ['merge-base', '--is-ancestor', sha, `refs/heads/${branch}`])).code === 0
      }),
    )
  }
  /** ensure() but the fetch must succeed (ensure throws when origin can't be reached) */
  private ensureFetched(repo: string) {
    return this.ensure(repo)
  }

  treeOf(repo: string, sha: string): Promise<string> {
    return this.lock(repo, async () => (await this.ok(repo, ['rev-parse', `${sha}^{tree}`])).trim())
  }

  /** Fetch a client bundle into refs/cib/snap/<job>; returns the commit it holds. Throws on a bad bundle. */
  fetchBundle(repo: string, file: string, jobId: number): Promise<string> {
    return this.lock(repo, async () => {
      const heads = (await this.ok(repo, ['bundle', 'list-heads', file])).trim().split('\n').filter(Boolean)
      if (heads.length !== 1) throw new Error(`bundle must hold exactly one ref, has ${heads.length}`)
      const ref = heads[0].split(/\s+/)[1]
      await this.ok(repo, ['fetch', '--quiet', file, `+${ref}:refs/cib/snap/${jobId}`])
      return (await this.ok(repo, ['rev-parse', `refs/cib/snap/${jobId}`])).trim()
    })
  }

  /**
   * The bundle a remote resource gets: the job's snapshot under the fixed name refs/cib/snap, minus `base`. Built in a
   * scratch repo that borrows the mirror's objects (alternates), so nothing is copied and the mirror's refs stay put.
   */
  remoteBundle(repo: string, jobId: number, base: string | null, out: string): Promise<void> {
    return this.lock(repo, async () => {
      const sha = (await this.ok(repo, ['rev-parse', `refs/cib/snap/${jobId}`])).trim()
      const tmp = mkdtempSync(join(this.workRoot, '.bundle-'))
      try {
        const run = async (args: string[]) => {
          const r = await this.git([...SAFE, '--git-dir', tmp, ...args])
          if (r.code !== 0) throw new Error(`git ${args[0]}: ${r.stderr.trim().slice(-400)}`)
        }
        await run(['init', '--quiet', '--bare'])
        writeFileSync(join(tmp, 'objects/info/alternates'), join(this.path(repo), 'objects') + '\n')
        await run(['update-ref', 'refs/cib/snap', sha])
        await run(['bundle', 'create', '--quiet', out, 'refs/cib/snap', ...(base ? ['--not', base] : [])])
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    })
  }

  /**
   * A run's own checkout: `clone --shared --no-checkout` (its .git/objects/info/alternates → the mirror's objects; its
   * config, hooks, index and new objects are the job's), then a detached checkout of the sha. The only git calls in
   * `dir`, while it is fresh. `dir` must not exist yet.
   */
  cloneForRun(repo: string, sha: string, dir: string): Promise<void> {
    if (!SHA.test(sha)) return Promise.reject(new Error('cloneForRun: not a full sha'))
    return this.lock(repo, async () => {
      const c = await this.git([...SAFE, 'clone', '--quiet', '--shared', '--no-checkout', '--no-tags', this.path(repo), dir])
      if (c.code !== 0) throw new Error(`git clone: ${(c.stderr || c.stdout).trim().slice(-400)}`)
      const k = await this.git([...SAFE, '-C', dir, 'checkout', '--quiet', '--detach', sha])
      if (k.code !== 0) throw new Error(`git checkout ${sha.slice(0, 12)}: ${(k.stderr || k.stdout).trim().slice(-400)}`)
    })
  }

  /** gc, under the repo's mutex, only when `busy()` (an active job of the repo) is false. Returns whether it ran. */
  gc(repo: string, busy: () => boolean): Promise<boolean> {
    return this.lock(repo, async () => {
      if (!existsSync(this.path(repo)) || busy()) return false
      await this.g(repo, ['gc', '--quiet'], 1800)
      return true
    })
  }

  /** Drop refs/cib/snap/<job> and refs/cib/sha/<sha> refs nobody keeps any more. */
  pruneRefs(repo: string, keep: () => { jobs: Set<number>; shas: Set<string> }): Promise<number> {
    return this.lock(repo, async () => {
      if (!existsSync(this.path(repo))) return 0
      // read under the lock: a snapshot ref is only made under it, after its job row exists
      const { jobs: keepJobs, shas: keepShas } = keep()
      const refs = (await this.g(repo, ['for-each-ref', '--format=%(refname)', 'refs/cib/'])).stdout.split('\n').filter(Boolean)
      let n = 0
      for (const ref of refs) {
        const m = /^refs\/cib\/(snap|sha)\/(.+)$/.exec(ref)
        if (!m) continue
        const keep = m[1] === 'snap' ? keepJobs.has(Number(m[2])) : keepShas.has(m[2])
        if (keep) continue
        await this.g(repo, ['update-ref', '-d', ref])
        n++
      }
      return n
    })
  }
}
