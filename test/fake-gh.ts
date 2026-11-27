// An in-process `gh` for tests, behind the daemon's injected `gh` runner (the same argv the real CLI gets): commit
// statuses (`api`), `repo view` (default branch), `workflow run|view`, `run list|view|download|cancel`. Dispatched runs
// appear in `run list` at once as `queued` with the run-name the consumer template gives (`ci-broker <job> <mode> <sha>`);
// the test ends them with `complete()`.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type FakeRun = { databaseId: number; displayTitle: string; status: string; conclusion: string; url: string; workflow: string; repo: string; inputs: Record<string, string>; ref: string }
type Res = { code: number; stdout: string; stderr: string }

const flag = (args: string[], name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

export const HOSTED_YAML = `on:\n  workflow_dispatch:\n    inputs:\n      sha:\n        required: true\n      mode:\n        required: true\n      args:\n        default: '[]'\n      job:\n        required: true\n`

export class FakeGh {
  calls: string[][] = []
  runs: FakeRun[] = []
  /** `<repo> <workflow>` → the file on the default branch */
  workflows = new Map<string, string>()
  branch = 'main'
  /** the next `workflow run` calls fail with this */
  failDispatch: string | null = null
  /** the run-name the fake workflow produces (a broken template drops the token) */
  title = (inputs: Record<string, string>) => `ci-broker ${inputs.job} ${inputs.mode} ${(inputs.sha ?? '').slice(0, 12)}`
  /** files `run download` writes (none = "no artifacts") */
  artifacts: Record<string, string> = { 'ci-artifacts/report.txt': 'hosted report\n' }
  private n = 9000

  run = (id: number) => {
    const r = this.runs.find((x) => x.databaseId === id)
    if (!r) throw new Error(`no run ${id}`)
    return r
  }
  complete(id: number, conclusion = 'success') {
    const r = this.run(id)
    r.status = 'completed'
    r.conclusion = conclusion
  }
  dispatches = () => this.calls.filter((c) => c[0] === 'workflow' && c[1] === 'run')

  handle = async (args: string[]): Promise<Res> => {
    this.calls.push(args)
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' })
    const fail = (stderr: string) => ({ code: 1, stdout: '', stderr })
    const [a, b] = args
    const repo = flag(args, '--repo') ?? ''
    if (a === 'api') return ok('{}')
    if (a === 'repo' && b === 'view') return ok(`${this.branch}\n`)
    if (a === 'workflow' && b === 'view') {
      const y = this.workflows.get(`${repo} ${args[2]}`)
      return y ? ok(y) : fail(`could not find any workflows named ${args[2]}`)
    }
    if (a === 'workflow' && b === 'run') {
      if (this.failDispatch) return fail(this.failDispatch)
      const inputs: Record<string, string> = {}
      args.forEach((x, i) => {
        if (x === '-f') {
          const kv = args[i + 1]
          inputs[kv.slice(0, kv.indexOf('='))] = kv.slice(kv.indexOf('=') + 1)
        }
      })
      const id = ++this.n
      this.runs.push({ databaseId: id, displayTitle: this.title(inputs), status: 'queued', conclusion: '', url: `https://github.com/${repo}/actions/runs/${id}`, workflow: args[2], repo, inputs, ref: flag(args, '--ref') ?? '' })
      return ok(`Created workflow_dispatch event for ${args[2]} at ${flag(args, '--ref')}\n`)
    }
    if (a === 'run' && b === 'list') {
      const wf = flag(args, '--workflow')
      return ok(JSON.stringify(this.runs.filter((r) => r.repo === repo && r.workflow === wf).reverse().map(({ databaseId, displayTitle, status, conclusion, url }) => ({ databaseId, displayTitle, status, conclusion, url }))))
    }
    if (a === 'run' && b === 'view') {
      const r = this.run(Number(args[2]))
      if (args.includes('--log')) return ok(`hosted\tSet up job\tline one of run ${r.databaseId}\nhosted\tRun mode\t${r.inputs.mode} ${r.inputs.args}\n`)
      return ok(JSON.stringify({ status: r.status, conclusion: r.conclusion }))
    }
    if (a === 'run' && b === 'download') {
      const dir = flag(args, '--dir')!
      if (!Object.keys(this.artifacts).length) return fail('no valid artifacts found to download')
      for (const [f, c] of Object.entries(this.artifacts)) {
        mkdirSync(join(dir, f, '..'), { recursive: true })
        writeFileSync(join(dir, f), c)
      }
      return ok()
    }
    if (a === 'run' && b === 'cancel') {
      const r = this.run(Number(args[2]))
      if (r.status === 'completed') return fail('Cannot cancel a workflow run that is completed')
      r.status = 'completed'
      r.conclusion = 'cancelled'
      return ok()
    }
    return fail(`fake gh: unknown command ${args.join(' ')}`)
  }
}
