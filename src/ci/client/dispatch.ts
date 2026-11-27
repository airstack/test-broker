// `ci-broker dispatch`: start broker.yml by hand with the args bound to the run name. The run API does not return
// workflow_dispatch inputs, so the run name carries a digest of the args (`broker <mode> <sha> <argsHash>`); the
// GitHub door recomputes it from the args it receives (check 13), so a dispatched `cmd` runs exactly what was typed.
import { createHash } from 'node:crypto'
import { originRepo } from '../../core/snapshot.ts'

/** sha256 hex of the compact JSON of the args (what `jq -c` prints), `-` for none. */
export const argsDigest = (args: string[]) => (args.length ? createHash('sha256').update(JSON.stringify(args)).digest('hex') : '-')
export const DISPATCH_TITLE = /^broker (\S+) ([0-9a-f]{40}) ([0-9a-f]{64}|-)$/

export type GhCli = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>

export async function dispatch(o: { repo?: string; sha?: string; mode: string; args: string[]; cwd: string; gh: GhCli; out: (s: string) => void; workflow?: string }): Promise<number> {
  if (!o.sha || !/^[0-9a-f]{40}$/.test(o.sha)) throw new Error('usage: ci-broker dispatch [--repo R] --sha <full sha> [--mode M] [-- args…]')
  const repo = o.repo ?? (await originRepo(o.cwd))
  const b = await o.gh(['repo', 'view', repo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'])
  const branch = b.stdout.trim()
  if (b.code !== 0 || !branch) throw new Error(`cannot read ${repo}'s default branch: ${(b.stderr || b.stdout).trim().slice(0, 200)}`)
  const digest = argsDigest(o.args)
  const wf = o.workflow ?? 'broker.yml'
  // the full ref: a tag named like the branch can't be what runs (the GitHub door requires refs/heads/<default>)
  const r = await o.gh(['workflow', 'run', wf, '--repo', repo, '--ref', `refs/heads/${branch}`, '-f', `sha=${o.sha}`, '-f', `mode=${o.mode}`, '-f', `args=${JSON.stringify(o.args)}`, '-f', `argsHash=${digest}`])
  if (r.code !== 0) throw new Error(`gh workflow run failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`)
  o.out(`dispatched ${wf} on ${repo}@${branch}: broker ${o.mode} ${o.sha} ${digest}\n`)
  return 0
}
