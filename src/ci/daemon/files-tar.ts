// GET …/files.tar: a job's artifacts and shard logs for a client that can't read the job dir (split: the operator,
// a runner). The list comes from our own walk (regular files and directories only: a link, FIFO, socket or device is
// left out at any depth) and tar gets it with --no-recursion, so tar itself never follows or adds anything else.
import { spawn } from 'node:child_process'
import { existsSync, lstatSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { ServerResponse } from 'node:http'

/** The entries to send, relative to the job dir: `artifacts/**`, `*.log`, `summary.json`. */
export function tarList(dir: string): string[] {
  const out: string[] = []
  if (!existsSync(dir)) return out
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e)
      const st = lstatSync(p)
      if (st.isDirectory()) {
        out.push(relative(dir, p))
        walk(p)
      } else if (st.isFile()) out.push(relative(dir, p))
    }
  }
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    const st = lstatSync(p)
    if (e === 'artifacts' && st.isDirectory()) {
      out.push('artifacts')
      walk(p)
    } else if (st.isFile() && (e.endsWith('.log') || e === 'summary.json')) out.push(e)
  }
  return out
}

/** Stream the tar to the response (200 + application/x-tar); an empty list is an empty archive. */
export function sendFilesTar(dir: string, res: ServerResponse) {
  const list = tarList(dir)
  res.writeHead(200, { 'content-type': 'application/x-tar' })
  const p = spawn('/usr/bin/tar', ['-c', '-f', '-', '--null', '--no-recursion', '-C', existsSync(dir) ? dir : '/nonexistent', '-T', '-'], { stdio: ['pipe', 'pipe', 'ignore'] })
  p.stdout.pipe(res)
  p.on('error', () => res.end())
  res.on('close', () => p.kill('SIGTERM'))
  p.stdin.on('error', () => {})
  p.stdin.end(list.map((f) => `${f}\0`).join(''))
}
