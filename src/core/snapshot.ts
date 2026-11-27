// The working tree as a commit, without touching the user's index or branches: a copy of the index, `git add -A` into
// it, `git write-tree`, `git commit-tree -p HEAD` with a fixed identity (works in worktrees and without a git
// identity). A clean tree is HEAD itself. Then, if the daemon asks, a bundle of it against a base the daemon has.
import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'

type GitOpts = { env?: Record<string, string>; input?: string }

export function git(dir: string, args: string[], o: GitOpts = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = execFile('git', ['-C', dir, ...args], { env: { ...process.env, ...o.env }, maxBuffer: 1 << 26, timeout: 300_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args[0]}: ${String(stderr).trim() || err.message}`))
      else resolve(String(stdout))
    })
    if (o.input !== undefined) p.stdin?.end(o.input)
  })
}

const IDENTITY = {
  GIT_AUTHOR_NAME: 'ci-broker', GIT_AUTHOR_EMAIL: 'ci-broker@localhost',
  GIT_COMMITTER_NAME: 'ci-broker', GIT_COMMITTER_EMAIL: 'ci-broker@localhost',
}

/** owner/name from a remote URL (https, ssh, scp-like or a local path). */
export function repoFromUrl(url: string): string | null {
  const m = /([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim())
  return m ? `${m[1]}/${m[2]}` : null
}

export async function originRepo(dir: string): Promise<string> {
  const url = (await git(dir, ['remote', 'get-url', 'origin']).catch(() => '')).trim()
  const r = url && repoFromUrl(url)
  if (!r) throw new Error(`cannot tell the repo from origin (${url || 'no origin remote'}); pass --repo owner/name`)
  return r
}

export type Snapshot = {
  /** the snapshot commit, or HEAD when the tree is clean */
  commit: string
  tree: string
  head: string
  /** false = the tree is HEAD's */
  dirty: boolean
  /** up to 50 first-parent ancestors of HEAD, then merge-base HEAD origin/<default> */
  headCandidates: string[]
}

async function headCandidates(dir: string): Promise<string[]> {
  const list = (await git(dir, ['rev-list', '--first-parent', '-n', '50', 'HEAD'])).split('\n').filter(Boolean)
  let def = (await git(dir, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']).catch(() => '')).trim().replace(/^refs\/remotes\//, '')
  if (!def) for (const b of ['origin/main', 'origin/master']) if (await git(dir, ['rev-parse', '--verify', '--quiet', b]).then(() => true, () => false)) {
    def = b
    break
  }
  if (def) {
    const mb = (await git(dir, ['merge-base', 'HEAD', def]).catch(() => '')).trim()
    if (mb && !list.includes(mb)) list.push(mb)
  }
  return list
}

export async function buildSnapshot(dir: string, o: { maxFileMb: number }): Promise<Snapshot> {
  const top = (await git(dir, ['rev-parse', '--show-toplevel'])).trim()
  const head = (await git(top, ['rev-parse', '--verify', 'HEAD']).catch(() => {
    throw new Error('the repo has no commit yet')
  })).trim()
  const index = (await git(top, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])).trim()
  const tmp = mkdtempSync(join(tmpdir(), 'cib-snap-'))
  try {
    const tmpIndex = join(tmp, 'index')
    if (existsSync(index)) copyFileSync(index, tmpIndex)
    const env = { GIT_INDEX_FILE: tmpIndex }
    await git(top, ['add', '-A'], { env })
    const tree = (await git(top, ['write-tree'], { env })).trim()
    const changed = (await git(top, ['diff', '--cached', '--name-only', '--diff-filter=AM', '-z', 'HEAD'], { env })).split('\0').filter(Boolean)
    const max = o.maxFileMb * 1024 * 1024
    const big = changed.filter((f) => {
      try {
        return statSync(join(top, f)).size > max
      } catch {
        return false
      }
    })
    if (big.length) throw new Error(`files over snapshotMaxFileMb (${o.maxFileMb}) would go into the snapshot: ${big.join(', ')}. Ignore or remove them, or commit + push and use --sha.`)
    const headTree = (await git(top, ['rev-parse', 'HEAD^{tree}'])).trim()
    const cands = await headCandidates(top)
    if (tree === headTree) return { commit: head, tree, head, dirty: false, headCandidates: cands }
    const commit = (await git(top, ['commit-tree', tree, '-p', 'HEAD', '-m', 'ci-broker snapshot'], { env: IDENTITY })).trim()
    return { commit, tree, head, dirty: true, headCandidates: cands }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/**
 * A bundle of `commit` (minus `base`) as a readable stream, through a random temp ref that is deleted when the stream
 * ends, fails, or the process gets SIGINT/SIGTERM.
 */
export async function bundleStream(dir: string, commit: string, base: string | null, signal?: AbortSignal): Promise<{ stream: Readable; done: Promise<void> }> {
  const ref = `refs/ci-broker/snap-${randomBytes(4).toString('hex')}`
  await git(dir, ['update-ref', ref, commit])
  const drop = () => {
    try {
      spawn('git', ['-C', dir, 'update-ref', '-d', ref], { stdio: 'ignore' })
    } catch {}
  }
  const onSig = () => drop()
  process.once('SIGINT', onSig)
  process.once('SIGTERM', onSig)
  const p = spawn('git', ['-C', dir, 'bundle', 'create', '--quiet', '-', ref, ...(base ? ['--not', base] : [])], { stdio: ['ignore', 'pipe', 'pipe'] })
  let err = ''
  p.stderr.on('data', (d) => (err += d))
  // Ctrl-C (the client's signal): stop git; the close handler below deletes the temp ref
  const onAbort = () => p.kill('SIGTERM')
  if (signal?.aborted) onAbort()
  signal?.addEventListener('abort', onAbort, { once: true })
  const done = new Promise<void>((resolve, reject) => {
    p.on('close', async (code) => {
      signal?.removeEventListener('abort', onAbort)
      process.off('SIGINT', onSig)
      process.off('SIGTERM', onSig)
      await git(dir, ['update-ref', '-d', ref]).catch(() => {})
      if (code === 0) resolve()
      else reject(new Error(`git bundle create failed (${code}): ${err.trim()}`))
    })
  })
  return { stream: p.stdout, done }
}
