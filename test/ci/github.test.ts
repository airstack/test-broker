import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Server } from 'node:http'
import { Client } from '../../src/ci/client/http.ts'
import { annotationLines, failingGroups, failures, MAX_ANNOTATIONS, stepSummary, SUMMARY_CAP } from '../../src/ci/client/github.ts'
import type { JobView } from '../../src/ci/client/receipt.ts'
import { submit, type SubmitOpts } from '../../src/ci/client/submit.ts'
import { listen } from '../../src/ci/daemon/server.ts'
import { harness, makeOrigin, tmp, until, type Harness } from '../harness.ts'

const FX = fileURLToPath(new URL('../fixtures/', import.meta.url))

type T = { h: Harness; server: Server; client: Client; out: string[]; err: string[]; ws: string; summary: string; env: NodeJS.ProcessEnv }

/** A daemon on a temp socket; shards a/b/c of test-all run the real wrapper: a prints a vitest failure, b a Playwright
 * failure (plus lines that try to run workflow commands), c passes. */
async function up(o: { real?: boolean } = {}): Promise<T> {
  const h = harness()
  if (o.real !== false) h.boat.onCommand = undefined
  writeFileSync(
    join(h.root, 'profiles', 'app', 'remote.sh'),
    [
      'echo "remote $*"',
      'mkdir -p "$HOME/cib/$CIB_SLOT/me__app/out" && echo "art $2" > "$HOME/cib/$CIB_SLOT/me__app/out/a.txt"',
      'echo "::error::injected by the test"',
      'echo "::add-mask::nope"',
      `case "$2" in a) cat ${FX}vitest-fail.log; exit 1;; b) cat ${FX}playwright-fail.log; echo "::warning::also injected"; exit 1;; esac`,
      'echo fine',
    ].join('\n') + '\n',
  )
  const server = await listen(h.d, h.cfg.socketPath)
  const ws = tmp('cib-ws-')
  const summary = join(ws, '..', `${ws.split('/').pop()}-summary.md`)
  const env = { GITHUB_STEP_SUMMARY: summary, GITHUB_WORKSPACE: ws, GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'me/app', GITHUB_RUN_ID: '77', GITHUB_RUN_ATTEMPT: '1', GITHUB_WORKFLOW: 'broker' }
  return { h, server, client: new Client(h.cfg.socketPath), out: [], err: [], ws, summary, env }
}
const opts = (t: T, o: Partial<SubmitOpts>): SubmitOpts => ({
  mode: 'test-all', args: [], cwd: '.', maxFileMb: 50, interestGraceSec: t.h.cfg.interestGraceSec, out: (s) => void t.out.push(s), err: (s) => void t.err.push(s),
  reconnectMs: 0, profile: 'app', github: true, env: t.env, ...o,
})

/** What the runner does with the output: the workflow commands it would run (commands stopped by a token are text). */
function runnerCommands(out: string): string[] {
  const cmds: string[] = []
  let stopped: string | null = null
  for (const l of out.split('\n')) {
    if (stopped) {
      if (l === `::${stopped}::`) stopped = null
      continue
    }
    const m = /^::stop-commands::(.+)$/.exec(l)
    if (m) stopped = m[1]
    else if (l.startsWith('::')) cmds.push(l)
  }
  assert.equal(stopped, null, 'commands are resumed at the end')
  return cmds
}

test('--github, a failing job: commands stopped around test output, failing shards in groups, annotations, summary, artifacts dir, status', async () => {
  const t = await up()
  try {
    const o = makeOrigin(t.h.origins, 'me/app')
    mkdirSync(join(t.ws, 'ci-broker-artifacts', 'stale'), { recursive: true })
    const code = await submit(t.client, opts(t, { cwd: o.work }))
    assert.equal(code, 1)
    assert.deepEqual(t.err, [], 'GitHub mode writes everything to stdout, in order')
    const out = t.out.join('')
    assert.match(out.split('\n')[0], /^::stop-commands::[0-9a-f]{32}$/)
    assert.match(out, /^\[a\] remote [0-9a-f]{40} a$/m)
    assert.match(out, /^\[b\] ::error::injected by the test$/m)
    const cmds = runnerCommands(out)
    assert.deepEqual(cmds.filter((c) => !c.startsWith('::error ')), ['::group::a', '::endgroup::', '::group::b', '::endgroup::'])
    const errors = cmds.filter((c) => c.startsWith('::error '))
    assert.equal(errors.length, 5) // 2 vitest + 3 Playwright (3 flaky ones are not failures)
    assert.equal(errors[0], '::error file=src/math.unit.test.ts,line=5,col=19,title=[a] math > subtracts::math > subtracts%0AAssertionError: expected 1 to be 2 // Object.is equality')
    assert.match(errors[2], /^::error file=e2e\/tests\/browser\/signup\.spec\.ts,line=35,col=3,title=\[b\] @core browser /)
    // the group holds the shard's log, with commands still stopped inside
    const group = out.slice(out.indexOf('::group::b'), out.indexOf('::endgroup::', out.indexOf('::group::b')))
    assert.match(group, /^::warning::also injected$/m)
    assert.match(group, /3 flaky/)
    // the summary
    const md = readFileSync(t.summary, 'utf8')
    assert.match(md, /^### ❌ ci-broker: FAILED — app\/test-all/)
    assert.match(md, /\| ✅ \| c \|/)
    assert.match(md, /#### Failing tests \(5\)/)
    assert.match(md, /<details><summary>a failures<\/summary>/)
    assert.match(md, new RegExp(`\\*\\*status: ci-broker/test-all failure posted on ${o.sha.slice(0, 12)}\\*\\*`))
    assert.match(md, /\[run\]\(https:\/\/github\.com\/me\/app\/actions\/runs\/77\)/)
    // the artifacts dir: emptied first, then the job's artifacts + shard logs
    assert.deepEqual(readdirSync(join(t.ws, 'ci-broker-artifacts')).sort(), ['a', 'a.log', 'b', 'b.log', 'c', 'c.log'])
    assert.equal(readFileSync(join(t.ws, 'ci-broker-artifacts', 'b', 'out', 'a.txt'), 'utf8'), 'art b\n')
    // the status: failure, posted once; the label names the run
    assert.deepEqual(t.h.gh.calls.map((c) => [c[3], c[5], c[7]]), [[`repos/me/app/statuses/${o.sha}`, 'state=failure', 'context=ci-broker/test-all']])
    assert.equal(t.h.gh.calls[0][9], 'description=1/3 shards passed in 0s (job tst-1)')
    assert.equal(t.h.d.c.db.job(1)!.label, 'github run 77 (broker)')
  } finally {
    t.server.close()
  }
})

test('--github, a passing job then a reused one: the reuse fills the artifacts dir from the old job and posts at once', async () => {
  const t = await up()
  try {
    const o = makeOrigin(t.h.origins, 'me/app')
    assert.equal(await submit(t.client, opts(t, { cwd: o.work, mode: 'one' })), 0)
    assert.deepEqual(runnerCommands(t.out.join('')), [])
    assert.match(readFileSync(t.summary, 'utf8'), /### ✅ ci-broker: PASSED — app\/one/)
    // a second pushed commit with the same tree (an empty commit): the pass is reused and its status posted on it
    const { execFileSync } = await import('node:child_process')
    execFileSync('git', ['-C', o.work, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'empty'])
    execFileSync('git', ['-C', o.work, 'push', '-q', 'origin', 'HEAD:main'])
    const sha2 = execFileSync('git', ['-C', o.work, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    t.out.length = 0
    writeFileSync(t.summary, '')
    assert.equal(await submit(t.client, opts(t, { cwd: o.work, mode: 'one' })), 0)
    const out = t.out.join('')
    assert.match(out, /reused job tst-1/)
    assert.match(out, new RegExp(`status: ci-broker/one success posted on ${sha2.slice(0, 12)}`))
    assert.deepEqual(runnerCommands(out), [])
    assert.match(readFileSync(t.summary, 'utf8'), /Reused job `tst-1`/)
    assert.deepEqual(readdirSync(join(t.ws, 'ci-broker-artifacts')).sort(), ['one', 'one.log'])
    assert.deepEqual(t.h.gh.calls.map((c) => [c[3], c[9]]), [
      [`repos/me/app/statuses/${o.sha}`, 'description=1/1 shards passed in 0s (job tst-1)'],
      [`repos/me/app/statuses/${sha2}`, 'description=reused job tst-1 (same tree)'],
    ])
  } finally {
    t.server.close()
  }
})

test('--github joining a running job: same output and one status post for the shared target', async () => {
  const t = await up({ real: false })
  try {
    const o = makeOrigin(t.h.origins, 'me/app')
    const t2 = { ...t, out: [] as string[], err: [] as string[] }
    const first = submit(t.client, { ...opts(t, { cwd: o.work, mode: 'one', github: false }), out: () => {}, err: () => {} })
    await until(() => t.h.ctl.pending.length === 1)
    const second = submit(t.client, opts(t2, { cwd: o.work, mode: 'one' }))
    await until(() => t.h.d.c.db.events(1).some((e) => e.kind === 'joined'))
    t.h.ctl.finish(1, undefined, ' FAIL  src/x.test.ts > x > fails\nError: no\n')
    assert.equal(await first, 1)
    assert.equal(await second, 1)
    const out = t2.out.join('')
    assert.match(out, /^\[one\]  FAIL  src\/x\.test\.ts > x > fails$/m)
    assert.deepEqual(runnerCommands(out), ['::group::one', '::endgroup::', '::error file=src/x.test.ts,title=[one] x > fails::x > fails%0AError: no'])
    assert.equal(t.h.gh.calls.length, 1)
  } finally {
    t.server.close()
  }
})

test('--github: SIGINT withdraws the interest, the job is cancelled, exit 130, summary says so, no status', async () => {
  const t = await up({ real: false })
  try {
    const o = makeOrigin(t.h.origins, 'me/app')
    const ac = new AbortController()
    const p = submit(t.client, opts(t, { cwd: o.work, mode: 'one', signal: ac.signal }))
    await until(() => t.h.ctl.pending.length === 1)
    ac.abort()
    assert.equal(await p, 130)
    assert.equal(t.h.d.c.db.job(1)!.state, 'cancelled')
    const out = t.out.join('')
    assert.match(out, /leaving job tst-1/)
    assert.match(out, /status: ci-broker\/one not posted \(the job was cancelled\)/)
    assert.deepEqual(runnerCommands(out), [], 'a cancelled shard is not a failing one: no group')
    assert.match(readFileSync(t.summary, 'utf8'), /### ⏹️ ci-broker: CANCELLED/)
    assert.equal(t.h.gh.calls.length, 0)
  } finally {
    t.server.close()
  }
})

test('--github: a job that does not reach cancelled in the wait → exit 130 anyway, commands resumed, summary notes it', async () => {
  const t = await up({ real: false })
  try {
    t.h.ctl.ignoreAbort = true // the run ignores its kill: the job sits in cancelling
    const o = makeOrigin(t.h.origins, 'me/app')
    const ac = new AbortController()
    const p = submit(t.client, opts(t, { cwd: o.work, mode: 'one', signal: ac.signal, leaveWaitMs: 0 }))
    await until(() => t.h.ctl.pending.length === 1)
    ac.abort()
    assert.equal(await p, 130)
    assert.equal(t.h.d.c.db.job(1)!.state, 'cancelling')
    runnerCommands(t.out.join(''))
    assert.match(readFileSync(t.summary, 'utf8'), /left job tst-1 while it was cancelling/)
    t.h.ctl.finish(143)
    await until(() => t.h.d.c.db.job(1)!.state === 'cancelled')
  } finally {
    t.server.close()
  }
})

test('--github without the runner env → an error before anything is submitted', async () => {
  const t = await up({ real: false })
  try {
    await assert.rejects(submit(t.client, opts(t, { cwd: '.', env: {} })), /missing GITHUB_STEP_SUMMARY, GITHUB_WORKSPACE/)
    assert.equal(t.h.d.c.db.recentJobs({ limit: 5 }).length, 0)
  } finally {
    t.server.close()
  }
})

// ------------------------------------------------------------ caps, from a job dir on disk

function fakeJob(logs: Record<string, string>, states: Record<string, string>): JobView {
  const dir = tmp('cib-job-')
  for (const [n, l] of Object.entries(logs)) writeFileSync(join(dir, `${n}.log`), l)
  return {
    id: 'tst-9', repo: 'me/app', profile: 'app', mode: 'test-all', args: [], commit: 'a'.repeat(40), source: 'pushed', state: 'failed', summary: null, error: null, dir, artifacts: [], statusTargets: [],
    shards: Object.entries(states).map(([name, state]) => ({ name, size: 'default', state, code: state === 'passed' ? 0 : 1, where: 'boat:x', reason: null, startedAt: 0, endedAt: 1000 })),
  }
}
const vitestFails = (n: number, pad = 0) =>
  Array.from({ length: n }, (_, i) => ` FAIL  src/t${i}.test.ts > suite > case ${i}\nError: failure ${i} ${'x'.repeat(pad)}\n ❯ src/t${i}.test.ts:${i + 1}:3\n`).join('\n')

test('annotations: at most 10; the rest are listed in the summary as not annotated', () => {
  const job = fakeJob({ a: vitestFails(15) }, { a: 'failed', b: 'passed' })
  const fs = failures(job)
  assert.equal(fs.length, 15)
  const lines = annotationLines(fs)
  assert.equal(lines.length, MAX_ANNOTATIONS)
  assert.equal(lines[9], '::error file=src/t9.test.ts,line=10,col=3,title=[a] suite > case 9::suite > case 9%0AError: failure 9')
  const md = stepSummary({ job, statusLine: 'status: x', reused: false, failures: fs })
  assert.match(md, /#### Failing tests \(15; the first 10 are annotations\)/)
  assert.equal(md.match(/\(not annotated\)/g)!.length, 5)
  assert.match(md, /- \(not annotated\) `a` `src\/t14\.test\.ts:15` suite &gt; case 14 — Error: failure 14/)
})

test('step summary cap: excerpts are trimmed first, then the failure list; never over the cap', () => {
  const job = fakeJob({ a: vitestFails(40, 2000), b: vitestFails(40, 2000) }, { a: 'failed', b: 'failed' })
  const fs = failures(job)
  const full = stepSummary({ job, statusLine: 'status: x', reused: false, failures: fs, cap: 10 * 1024 * 1024 })
  assert.ok(Buffer.byteLength(full) > 100_000, String(Buffer.byteLength(full)))
  // a cap that holds the list but not the excerpts: the excerpts shrink, every failure stays listed
  const listOnly = Buffer.byteLength(stepSummary({ job, statusLine: 'status: x', reused: false, failures: fs, cap: 10 * 1024 * 1024 }).replace(/<details>[\s\S]*?<\/details>/g, ''))
  const mid = stepSummary({ job, statusLine: 'status: x', reused: false, failures: fs, cap: listOnly + 20_000 })
  assert.ok(Buffer.byteLength(mid) <= listOnly + 20_000)
  assert.match(mid, /trimmed to fit/)
  assert.equal(mid.match(/<details>/g)!.length, 2, 'both excerpts kept, shortened')
  assert.match(mid, /\n…\n/)
  assert.equal(mid.match(/^- /gm)!.length, 80)
  assert.match(mid, /\*\*status: x\*\*/)
  // a cap below the list: the list is cut, the head and the status line stay
  const small = stepSummary({ job, statusLine: 'status: x', reused: false, failures: fs, cap: 20_000 })
  assert.ok(Buffer.byteLength(small) <= 20_000, String(Buffer.byteLength(small)))
  assert.doesNotMatch(small, /<details>/)
  assert.match(small, /- … and \d+ more/)
  assert.match(small, /\*\*status: x\*\*/)
  // the default cap
  const huge = fakeJob({ a: vitestFails(2000, 600) }, { a: 'failed' })
  assert.ok(Buffer.byteLength(stepSummary({ job: huge, statusLine: 's', reused: false, failures: failures(huge) })) <= SUMMARY_CAP)
})

test('failing groups: the last 2 MB of each failing shard log, commands stopped inside, passing shards left out', () => {
  const big = 'y'.repeat(100) + '\n'
  const job = fakeJob({ a: 'first line\n' + big.repeat(25_000) + 'last line\n', b: 'ok\n' }, { a: 'failed', b: 'passed' })
  const out: string[] = []
  failingGroups(job, (s) => void out.push(s), () => 'tok')
  const s = out.join('')
  assert.equal(out[0], '::group::a\n')
  assert.equal(out[1], '::stop-commands::tok\n')
  assert.match(s, /the last 2 MB of the log/)
  assert.doesNotMatch(s, /first line/)
  assert.match(s, /last line\n::tok::\n::endgroup::\n$/)
  assert.ok(Buffer.byteLength(s) < 2 * 1024 * 1024 + 500)
  assert.ok(!existsSync(join(job.dir, 'nope')))
})
