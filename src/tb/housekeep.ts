// The state dir's disk use: run logs compressed after a day and deleted after keepDays, failed shards' artifacts the
// same way (their text files compressed), and the seed bundles cut to the newest few per repo. Async and in small
// steps: a big pass must not stall the daemon's live runs.
import { createReadStream, createWriteStream, existsSync, readFileSync, statSync } from 'node:fs'
import { readdir, rename, rm, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import * as zlib from 'node:zlib'

/** zstd when this Node has it (smaller: a 7.5 MB acme log is 227 KB, against 400 KB with gzip), else gzip */
const ZSTD = typeof (zlib as { createZstdCompress?: unknown }).createZstdCompress === 'function'
export const LOG_EXT = ZSTD ? '.zst' : '.gz'
/** text artifacts worth compressing: logs only, and none inside a report dir (a Playwright report links its files) */
const TEXT_ARTIFACT = /\.(log|txt)$/
const REPORT_DIR = /report/i
const MIN_ARTIFACT_BYTES = 64 * 1024
/** seed bundles kept per repo (the newest by last use) */
export const SEEDS_KEPT = 3
/** a seed build's leftover (.tmp, .repo) this old is removed */
const STALE_TMP_MS = 3600_000
/** files handled per pass before the pass yields to the event loop */
const YIELD_EVERY = 20

const tick = () => new Promise<void>((r) => setImmediate(r))

/** compress `f` to `f + ext` with the same mtime (so its age still counts from the run), then remove `f` */
async function compress(f: string, ext = LOG_EXT): Promise<void> {
  const st = await stat(f)
  // a name of its own: a second pass on the same file (never two in the daemon) cannot write into this one
  const tmp = `${f}${ext}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.part`
  const z = ext === '.zst' ? (zlib as unknown as { createZstdCompress: () => NodeJS.ReadWriteStream }).createZstdCompress() : zlib.createGzip({ level: 6 })
  try {
    await pipeline(createReadStream(f), z, createWriteStream(tmp, { mode: 0o600 }))
    await utimes(tmp, st.atime, st.mtime)
    await rename(tmp, `${f}${ext}`)
    await rm(f, { force: true })
  } catch (e) {
    await rm(tmp, { force: true })
    throw e
  }
}

export type TidyReport = { compressed: number; deleted: number; errors: string[] }

/**
 * One pass over `runs/`: an entry older than keepDays is deleted; a run log (`<run>.log`) older than compressAfterMs
 * is compressed, as are the big text files of an artifacts dir that old. `live` holds the run ids still running
 * (never touched). A file gone meanwhile (a run cleaning up its own dir) is not an error.
 */
export async function tidyRuns(dir: string, o: { now: number; keepDays: number; compressAfterMs: number; live: Set<string> }): Promise<TidyReport> {
  const rep: TidyReport = { compressed: 0, deleted: 0, errors: [] }
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return rep
  }
  const cut = o.now - o.keepDays * 86_400_000
  const old = o.now - o.compressAfterMs
  let n = 0
  for (const name of names) {
    if (++n % YIELD_EVERY === 0) await tick()
    const id = name.split('.')[0]
    if (o.live.has(id)) continue
    const f = join(dir, name)
    try {
      const st = await stat(f)
      if (st.mtimeMs < cut) {
        await rm(f, { recursive: true, force: true }).catch(async () => {
          // a dir an archive left read-only
          const { execFile } = await import('node:child_process')
          await new Promise<void>((r) => execFile('chmod', ['-R', 'u+rwX', f], () => r()))
          await rm(f, { recursive: true, force: true })
        })
        rep.deleted++
      } else if (st.mtimeMs < old && name.endsWith('.log')) {
        await compress(f)
        rep.compressed++
      } else if (st.mtimeMs < old && st.isDirectory() && name.endsWith('.artifacts')) {
        rep.compressed += await compressTree(f)
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') rep.errors.push(`${f}: ${(e as Error).message}`)
    }
  }
  return rep
}

/** the big text files under `dir`, compressed (gzip: they are read with ordinary tools); returns how many */
async function compressTree(dir: string): Promise<number> {
  let n = 0
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const f = join(dir, e.name)
    if (e.isDirectory()) n += REPORT_DIR.test(e.name) ? 0 : await compressTree(f)
    else if (e.isFile() && TEXT_ARTIFACT.test(e.name) && (await stat(f)).size >= MIN_ARTIFACT_BYTES) {
      await compress(f, '.gz')
      n++
      await tick()
    }
  }
  return n
}

/** a log bigger than this (raw, or compressed × 20) is not read into the daemon: the answer names the file */
const MAX_READ_BYTES = 32 << 20

/** a run's log as text: `<run>.log`, else its compressed copy; null when there is none (or the id is not a run id) */
export function readRunLog(dir: string, id: string): string | null {
  if (!/^tb-[0-9a-z-]+$/.test(id)) return null
  const f = join(dir, `${id}.log`)
  const tooBig = (file: string, x: number) => `test-broker: ${file} is too big to send (${Math.round((statSync(file).size * x) / 1048576)} MB or more); read it there${file.endsWith('.zst') ? ' with zstdcat' : file.endsWith('.gz') ? ' with zcat' : ''}\n`
  if (existsSync(f)) return statSync(f).size > MAX_READ_BYTES ? tooBig(f, 1) : readFileSync(f, 'utf8')
  for (const ext of ['.zst', '.gz']) {
    const z = `${f}${ext}`
    if (!existsSync(z)) continue
    if (statSync(z).size * 20 > MAX_READ_BYTES) return tooBig(z, 20)
    const buf = readFileSync(z)
    if (ext === '.gz') return zlib.gunzipSync(buf).toString('utf8')
    const dec = (zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer }).zstdDecompressSync
    return dec ? dec(buf).toString('utf8') : null
  }
  return null
}

/**
 * Seeds: keep the newest SEEDS_KEPT per repo (a seed's mtime is its last use), and every seed in `inUse` (an upload
 * reads it now). Leftovers of a build that died are removed after an hour.
 */
export async function pruneSeeds(dir: string, o: { now: number; inUse: (f: string) => boolean; keep?: number }): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const removed: string[] = []
  const byRepo = new Map<string, { f: string; t: number }[]>()
  for (const name of names) {
    const f = join(dir, name)
    try {
      const st = await stat(f)
      if (!name.endsWith('.bundle')) {
        if ((name.endsWith('.tmp') || name.endsWith('.repo')) && o.now - st.mtimeMs > STALE_TMP_MS) {
          await rm(f, { recursive: true, force: true })
          removed.push(f)
        }
        continue
      }
      // `<owner__name>-<base12>.bundle`
      const repo = name.slice(0, name.lastIndexOf('-'))
      byRepo.set(repo, [...(byRepo.get(repo) ?? []), { f, t: st.mtimeMs }])
    } catch {}
  }
  for (const list of byRepo.values()) {
    list.sort((a, b) => b.t - a.t)
    for (const x of list.slice(o.keep ?? SEEDS_KEPT)) {
      // checked again just before the rm: a run may have taken the seed up (and refreshed it) since the listing
      try {
        if (o.inUse(x.f) || (await stat(x.f)).mtimeMs > x.t) continue
        if (o.inUse(x.f)) continue
        await rm(x.f, { force: true })
        removed.push(x.f)
      } catch {}
    }
  }
  return removed
}
