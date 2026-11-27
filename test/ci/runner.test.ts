// `ci-broker runner …`, update, switch-to-split, against a fake runnerctl (argv + stdin logged, `list` answered) and
// harness daemons behind real sockets.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from '../../src/ci/cli.ts'
import { Client } from '../../src/ci/client/http.ts'
import { listen } from '../../src/ci/daemon/server.ts'
import { add, daemonUnit, finish, instanceName, migrate, oldRunners, rm, runnerCli, runnerName, switchToSplit, updateSplit, verify, type RunnerDeps } from '../../src/ci/runner.ts'
import { harness, idOf, makeOrigin, tmp, until } from '../harness.ts'

const TOKEN = 'AAAAREGISTRATIONTOKEN1234'

class FakeRunnerctl {
  calls: { args: string[]; stdin: string }[] = []
  rows: any[] = []
  fail: string | null = null
  run = async (args: string[], stdin = '') => {
    this.calls.push({ args, stdin })
    if (this.fail) return { code: 1, stdout: '', stderr: this.fail }
    if (args[0] === 'versions') return { code: 0, stdout: '2.338.2\n', stderr: '' }
    if (args[0] === 'list') return { code: 0, stdout: JSON.stringify(this.rows), stderr: '' }
    if (args[0] === 'add') this.rows.push({ id: `${args[1].replace('/', '__')}-${args[2]}`, repo: args[1], name: args[3], active: 'active' })
    if (args[0] === 'rm') this.rows = this.rows.filter((r) => r.id !== args[1])
    return { code: 0, stdout: `${args[0]} ok\n`, stderr: '' }
  }
}

async function up(o: Parameters<typeof harness>[0] = {}) {
  const h = harness(o)
  const server = await listen(h.d, h.cfg.socketPath)
  const client = new Client(h.cfg.socketPath)
  await client.sayHello()
  return { h, server, client }
}
/** git in the live checkout: fetch ok, ff possible, origin/main and HEAD have split support; the old daemon's
 * server closes when its unit is disabled (as systemd would stop it) */
function switchSys(d: { sysCalls: string[][] }, old: { server: import('node:http').Server } | null, o: { split?: boolean; pull?: number; disable?: number } = {}) {
  return async (cmd0: string, args0: string[]) => {
    d.sysCalls.push([cmd0, ...args0])
    const [cmd, args] = cmd0 === 'env' ? [args0[1], args0.slice(2)] : [cmd0, args0]
    if (cmd === 'systemctl' && args.includes('disable')) {
      if ((o.disable ?? 0) === 0 && old) {
        old.server.close()
        old.server.closeAllConnections()
      }
      return { code: o.disable ?? 0, stdout: '', stderr: o.disable ? 'Failed to connect to bus' : '' }
    }
    if (cmd === 'git' && args.includes('pull')) return { code: o.pull ?? 0, stdout: '', stderr: o.pull ? 'fatal: Not possible to fast-forward' : '' }
    if (cmd === 'git' && args.includes('cat-file')) return { code: o.split === false ? 1 : 0, stdout: '', stderr: '' }
    if (cmd === 'git' && args.includes('show')) return { code: 0, stdout: o.split === false ? 'export const X = 1\n' : 'export const PROTOCOL = 2\n', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
}

function deps(client: Client, r: FakeRunnerctl, o: Partial<RunnerDeps> = {}): RunnerDeps & { outs: string[]; sysCalls: string[][] } {
  const outs: string[] = []
  const sysCalls: string[][] = []
  return {
    runnerctl: r.run, client, out: (s) => void outs.push(s), err: (s) => void outs.push(s), readToken: async () => `${TOKEN}\n`, host: 'box1',
    sys: async (cmd, args) => (sysCalls.push([cmd, ...args]), { code: 0, stdout: '', stderr: '' }), sleep: async () => {},
    outs, sysCalls, ...o,
  }
}

test('names: instance ids and runner names (the r keeps them apart from the old <host>-<name>-<n>)', () => {
  assert.equal(instanceName('simple10/acme', 2), 'simple10__acme-2')
  assert.equal(runnerName('devbox', 'simple10/acme', 2), 'devbox-acme-r2')
})

test('runner add: the live tier first; the token only on runnerctl stdin; existing runners skipped', async () => {
  const t = await up()
  try {
    const r = new FakeRunnerctl()
    r.rows = [{ id: 'me__app-1', repo: 'me/app', name: 'box1-app-r1' }]
    const d = deps(t.client, r)
    assert.equal(await add(d, 'me/app', 3), 0)
    assert.deepEqual(r.calls.map((c) => c.args[0]), ['versions', 'dist', 'list', 'add', 'add'])
    assert.deepEqual(r.calls[1].args, ['dist', '2.338.2'])
    assert.deepEqual(r.calls[3].args, ['add', 'me/app', '2', 'box1-app-r2', 'ci-broker,box1', '2.338.2'])
    assert.equal(r.calls[3].stdin, `${TOKEN}\n`)
    assert.ok(r.calls.every((c) => !c.args.join(' ').includes(TOKEN)), 'never in argv')
    assert.ok(t.h.github.calls.includes('repos/me/app'), 'a live tier check')
  } finally {
    t.server.close()
  }
})

test('runner add: a public repo is refused before any runnerctl call (77); --token is refused', async () => {
  const t = await up()
  try {
    t.h.github.setRepo('me/app', { private: false })
    const r = new FakeRunnerctl()
    await assert.rejects(add(deps(t.client, r), 'me/app', 2), (e: any) => e.code === 77 && /public/.test(e.message))
    assert.equal(r.calls.length, 0)
    const old = process.stderr.write
    let said = ''
    ;(process.stderr as any).write = (s: string) => ((said += s), true)
    try {
      assert.equal(await runnerCli(parseArgs(['runner', 'add', 'me/app', '--token', TOKEN]), { ...t.h.cfg, layout: 'split' }, t.client), 2)
    } finally {
      ;(process.stderr as any).write = old
    }
    assert.match(said, /--token is gone/)
  } finally {
    t.server.close()
  }
})

test('runner add without the sudoers rule → exit 2 with the install hint; single refuses runners', async () => {
  const t = await up()
  try {
    const r = new FakeRunnerctl()
    r.fail = 'sudo: a password is required'
    await assert.rejects(add(deps(t.client, r), 'me/app', 1), (e: any) => e.code === 2 && /an admin must run scripts\/install\.sh first/.test(e.message))
    const old = process.stderr.write
    let said = ''
    ;(process.stderr as any).write = (s: string) => ((said += s), true)
    try {
      assert.equal(await runnerCli(parseArgs(['runner', 'ls']), t.h.cfg, t.client), 2)
    } finally {
      ;(process.stderr as any).write = old
    }
    assert.match(said, /runners need the split layout/)
  } finally {
    t.server.close()
  }
})

test('runner rm <repo>: every runner of the repo; no token (nothing runs from a runner dir; GitHub side by URL)', async () => {
  const t = await up()
  try {
    const r = new FakeRunnerctl()
    r.rows = [{ id: 'me__app-1', repo: 'me/app' }, { id: 'me__app-2', repo: 'me/app' }, { id: 'x__y-1', repo: 'x/y' }]
    assert.equal(await rm(deps(t.client, r), 'me/app'), 0)
    assert.deepEqual(r.calls.filter((c) => c.args[0] === 'rm').map((c) => [c.args[1], c.stdin]), [['me__app-1', ''], ['me__app-2', '']])
    const old = process.stderr.write
    let said = ''
    ;(process.stderr as any).write = (x: string) => ((said += x), true)
    try {
      assert.equal(await runnerCli(parseArgs(['runner', 'rm', 'me/app', '--token-stdin']), { ...t.h.cfg, layout: 'split' }, t.client), 2)
    } finally {
      ;(process.stderr as any).write = old
    }
    assert.match(said, /rm takes no token/)
  } finally {
    t.server.close()
  }
})

function oldDir() {
  const dir = tmp()
  for (const i of [1, 2]) {
    mkdirSync(join(dir, `me__app-${i}`))
    writeFileSync(join(dir, `me__app-${i}`, '.runner'), `﻿${JSON.stringify({ agentName: `box1-app-${i}` })}`)
  }
  return dir
}

test('migrate: runnersPerRepo new runners for each repo with old ones', async () => {
  const t = await up()
  try {
    const r = new FakeRunnerctl()
    const dir = oldDir()
    assert.deepEqual(oldRunners(dir).map((x) => [x.id, x.repo, x.name]), [['me__app-1', 'me/app', 'box1-app-1'], ['me__app-2', 'me/app', 'box1-app-2']])
    assert.equal(await migrate(deps(t.client, r, { oldRunnersDir: dir }), { ...t.h.cfg, runnersPerRepo: 3 }), 0)
    assert.equal(r.calls.filter((c) => c.args[0] === 'add').length, 3)
  } finally {
    t.server.close()
  }
})

test('migrate --verify: waits for no Runner.Worker, disables the old units, dispatches cmd -- true and waits for it to pass on the GitHub door', async () => {
  const t = await up()
  try {
    const dir = oldDir()
    const o = makeOrigin(t.h.origins, 'me/app')
    let pg = 0
    const d = deps(t.client, new FakeRunnerctl(), {
      oldRunnersDir: dir, user: 'op', now: () => t.h.clock.t,
      sys: async (cmd, args) => {
        d.sysCalls.push([cmd, ...args])
        if (cmd === 'pgrep') return { code: ++pg < 3 ? 0 : 1, stdout: '', stderr: '' }
        if (cmd === 'gh' && args[0] === 'api' && /^repos\/[^/]+\/[^/]+\/commits\/main$/.test(args[1])) return { code: 0, stdout: `${o.sha}\n`, stderr: '' }
        if (cmd === 'gh' && args.includes('.defaultBranchRef.target.oid')) return { code: 0, stdout: '\n', stderr: '' } // the real gh: no target
        if (cmd === 'gh' && args.includes('.defaultBranchRef.name')) return { code: 0, stdout: 'main\n', stderr: '' }
        if (cmd === 'gh' && args[0] === 'workflow') {
          // the new runner's job reaches the GitHub door: a github-door job of cmd true at the sha
          const id = await t.h.d.c.jobs.submit({ repo: 'me/app', profile: 'app', mode: 'cmd', args: ['true'], commit: o.sha, detach: true, door: 'github', ghRun: '1.1 workflow_dispatch octo-other', label: 'github run 1.1 by octo-other' })
          t.h.d.c.db.updateJob(idOf(id.id), { state: 'passed', endedAt: t.h.clock.t })
        }
        return { code: 0, stdout: '', stderr: '' }
      },
    })
    assert.equal(await verify(d, { pollMs: 0 }), 0, d.outs.join(''))
    assert.equal(pg, 3)
    assert.deepEqual(d.sysCalls.filter((c) => c[0] === 'systemctl').map((c) => c.slice(1)), [['--user', 'disable', '--now', 'ci-broker-runner@me__app-1.service'], ['--user', 'disable', '--now', 'ci-broker-runner@me__app-2.service']])
    const wf = d.sysCalls.find((c) => c[1] === 'workflow')!
    assert.ok(wf.includes('mode=cmd') && wf.includes('args=["true"]'))
    assert.ok(wf.includes('--ref') && wf[wf.indexOf('--ref') + 1] === 'refs/heads/main', wf.join(' '))
    assert.ok(wf.includes(`argsHash=${(await import('../../src/ci/client/dispatch.ts')).argsDigest(['true'])}`))
    assert.match(d.outs.join(''), /verified: job tst-1 passed/)
  } finally {
    t.server.close()
  }
})

test('migrate --verify: a failure re-enables the old units at once', async () => {
  const t = await up()
  try {
    const d = deps(t.client, new FakeRunnerctl(), {
      oldRunnersDir: oldDir(), user: 'op',
      sys: async (cmd, args) => (d.sysCalls.push([cmd, ...args]), { code: cmd === 'pgrep' ? 1 : cmd === 'gh' ? 1 : 0, stdout: '', stderr: 'no' }),
    })
    assert.equal(await verify(d, { pollMs: 0 }), 1)
    const sc = d.sysCalls.filter((c) => c[0] === 'systemctl').map((c) => c[2])
    assert.deepEqual(sc, ['disable', 'disable', 'enable', 'enable'])
    assert.match(d.outs.join(''), /verify FAILED.*the old runners are back/)
  } finally {
    t.server.close()
  }
})

test('migrate --finish: the old dirs and user units go; the old names are listed for GitHub', async () => {
  const t = await up()
  try {
    const dir = oldDir()
    const units = tmp()
    writeFileSync(join(units, 'ci-broker-runner@.service'), 'x')
    writeFileSync(join(units, 'ci-brokerd.service'), 'x')
    const r = new FakeRunnerctl()
    r.rows = [{ id: 'me__app-1', repo: 'me/app', name: 'box1-app-r1', active: 'active' }]
    const d = deps(t.client, r, { oldRunnersDir: dir, unitsDir: units, sys: async () => ({ code: 1, stdout: '', stderr: '' }) })
    assert.equal(await finish(d), 0)
    assert.ok(!existsSync(join(dir, 'me__app-1')))
    assert.ok(!existsSync(join(units, 'ci-brokerd.service')))
    assert.match(d.outs.join(''), /box1-app-1 {2}https:\/\/github\.com\/me\/app\/settings\/actions\/runners/)
  } finally {
    t.server.close()
  }
})

test('update in split prints the admin\'s root commands with origin/main\'s sha and the diffstat since the running release', async () => {
  const t = await up()
  try {
    const rel = join(tmp(), 'RELEASE')
    writeFileSync(rel, `${'a'.repeat(40)}\nprotocol 2\n`)
    const d = deps(t.client, new FakeRunnerctl(), {
      sys: async (cmd, args) => (args.includes('ls-remote') ? { code: 0, stdout: `${'b'.repeat(40)}\trefs/heads/main\n`, stderr: '' } : args.includes('--stat') ? { code: 0, stdout: ' src/x.ts | 2 +-\n', stderr: '' } : { code: 0, stdout: '', stderr: '' }),
    })
    assert.equal(await updateSplit(d, { ...t.h.cfg, layout: 'split', releaseFile: rel, operator: 'dev' }, '/home/dev/acme/ci-broker'), 0)
    const s = d.outs.join('')
    assert.match(s, /running release: a{40}\norigin\/main: b{40}/)
    assert.match(s, /src\/x\.ts \| 2/)
    assert.match(s, new RegExp(`sudo bash /root/ci-broker-${'b'.repeat(40)}/scripts/install\\.sh --release ${'b'.repeat(40)}`))
    assert.match(s, /runuser -u dev -- git -C \/home\/dev\/acme\/ci-broker -c tar\.umask=022 archive/)
  } finally {
    t.server.close()
  }
})

test('switch-to-split against two daemons: drain (new submits wait), zero active, the old unit off, the split one on, ids seeded', async () => {
  const a = await up()
  const b = await up({ cfg: { layout: 'split', operatorUid: process.getuid!() } })
  try {
    const o = makeOrigin(a.h.origins, 'me/app')
    const r = await a.h.submit({ sha: o.sha, mode: 'one' })
    await a.h.pass()
    await until(() => a.h.ctl.pending.length === 1)
    const ctl = new FakeRunnerctl()
    const d = deps(a.client, ctl, {})
    d.sys = switchSys(d, a)
    let polls = 0
    d.sleep = async () => {
      if (++polls === 2) a.h.ctl.pending[0].done(0)
      await new Promise((res) => setImmediate(res))
    }
    const done = switchToSplit({ ...d, single: a.client, split: async () => (await b.client.sayHello(), b.client), checkout: '/live/checkout' }, { pollMs: 0 })
    await until(() => a.h.d.c.switchDrain)
    assert.equal(await done, 0, d.outs.join(''))
    assert.equal(a.h.d.c.db.job(idOf(r.id))!.state, 'passed', 'the running job finished first')
    assert.deepEqual(d.sysCalls.filter((c) => c[0] === 'systemctl' || c.includes('pull')).map((c) => c.slice(0, 6)), [['systemctl', '--user', 'disable', '--now', 'ci-brokerd.service'], ['env', 'GIT_TERMINAL_PROMPT=0', 'git', '-C', '/live/checkout', 'pull']])
    assert.deepEqual(ctl.calls.map((c) => c.args), [['daemon', 'start']])
    const s = await b.h.submit({ sha: makeOrigin(b.h.origins, 'me/app').sha, mode: 'one' })
    assert.equal(s.id, `tst-${idOf(r.id) + 1}`, 'ids continue above the old daemon\'s')
  } finally {
    a.server.close()
    b.server.close()
  }
})

test('the single daemon unit runs ci-brokerd and always restarts', () => {
  const u = daemonUnit({ bin: '/x/bin/ci-brokerd', path: '/usr/bin' })
  assert.match(u, /ExecStart=\/x\/bin\/ci-brokerd/)
  assert.match(u, /Restart=always/)
})

// ---------------------------------------------------------------- review fixes (batch 4)

test('correctness #1: switch-to-split refuses before touching anything when origin/main has no split support', async () => {
  const a = await up()
  try {
    const ctl = new FakeRunnerctl()
    const d = deps(a.client, ctl)
    d.sys = switchSys(d, a, { split: false })
    await assert.rejects(switchToSplit({ ...d, single: a.client, split: async () => a.client, checkout: '/live' }, { pollMs: 0 }), /origin\/main .* has no split support/)
    assert.ok(!d.sysCalls.some((c) => c[0] === 'systemctl'))
    assert.equal(a.h.d.c.switchDrain, false, 'no drain started')
    assert.equal(ctl.calls.length, 0)
  } finally {
    a.server.close()
  }
})

test('correctness #4: a failed disable, or an old daemon still answering, aborts before the split daemon starts', async () => {
  for (const mode of ['disable', 'still-up'] as const) {
    const a = await up()
    try {
      const ctl = new FakeRunnerctl()
      const d = deps(a.client, ctl)
      d.sys = switchSys(d, mode === 'still-up' ? null : a, mode === 'disable' ? { disable: 1 } : {})
      await assert.rejects(switchToSplit({ ...d, single: a.client, split: async () => a.client, checkout: '/live' }, { pollMs: 0 }), mode === 'disable' ? /disable --now .* failed/ : /the old daemon still answers/)
      assert.ok(!ctl.calls.some((c) => c.args[0] === 'daemon'), mode)
    } finally {
      a.server.close()
    }
  }
})

test('correctness #1/#11: a failed pull brings the old daemon back and stops; a seed 409 is an error that says why', async () => {
  const a = await up()
  try {
    const ctl = new FakeRunnerctl()
    const d = deps(a.client, ctl)
    d.sys = switchSys(d, a, { pull: 1 })
    await assert.rejects(switchToSplit({ ...d, single: a.client, split: async () => a.client, checkout: '/live' }, { pollMs: 0 }), /git pull .* failed.*old daemon is back/s)
    assert.ok(d.sysCalls.some((c) => c[0] === 'systemctl' && c.includes('enable')), 're-enabled')
    assert.ok(!ctl.calls.some((c) => c.args[0] === 'daemon'))
  } finally {
    a.server.close()
  }
  const b = await up()
  const n = await up({ cfg: { layout: 'split', operatorUid: process.getuid!() } })
  try {
    await n.h.submit({ sha: makeOrigin(n.h.origins, 'me/app').sha, mode: 'one' })
    const d = deps(b.client, new FakeRunnerctl())
    d.sys = switchSys(d, b)
    await assert.rejects(switchToSplit({ ...d, single: b.client, split: async () => (await n.client.sayHello(), n.client), checkout: '/live' }, { pollMs: 0 }), /already has jobs/)
  } finally {
    b.server.close()
    n.server.close()
  }
})

test('correctness #3/#12: update in split reads the release and the operator from install.conf, asks origin through the checkout', async () => {
  const { clientConfig } = await import('../../src/ci/cli.ts')
  const base = tmp()
  mkdirSync(join(base, 'opt', 'current'), { recursive: true })
  writeFileSync(join(base, 'opt', 'current', 'RELEASE'), `${'a'.repeat(40)}\nprotocol 2\n`)
  writeFileSync(join(base, 'install.conf'), `OPERATOR=dev\nOPERATOR_GROUP=dev\nDAEMON_USER=cibroker-admin\nRUNNER_USER=cibroker-runner\nOPT_DIR=${base}/opt\nSTATE_DIR=${base}/state\nETC_DIR=${base}/etc\nTOOLS_DIR=${base}/tools\n`)
  const cc = clientConfig({ HOME: base, CI_BROKER_INSTALL_CONF: join(base, 'install.conf') })
  assert.equal(cc.cfg.releaseFile, join(base, 'opt', 'current', 'RELEASE'))
  assert.equal(cc.cfg.operator, 'dev')
  const t = await up()
  try {
    const d = deps(t.client, new FakeRunnerctl())
    d.sys = async (cmd, args) => (d.sysCalls.push([cmd, ...args]), args.includes('ls-remote') ? { code: 0, stdout: `${'a'.repeat(40)}\trefs/heads/main\n`, stderr: '' } : { code: 0, stdout: '', stderr: '' })
    assert.equal(await updateSplit(d, cc.cfg, '/live/checkout'), 0)
    assert.match(d.outs.join(''), /up to date/)
    assert.deepEqual(d.sysCalls[0], ['env', 'GIT_TERMINAL_PROMPT=0', 'git', '-C', '/live/checkout', 'ls-remote', 'origin', 'refs/heads/main'])
  } finally {
    t.server.close()
  }
})

test('correctness #9: migrate --finish refuses without an active new runner for each repo, and waits for no Runner.Worker', async () => {
  const t = await up()
  try {
    const r = new FakeRunnerctl()
    const dir = oldDir()
    const d = deps(t.client, r, { oldRunnersDir: dir, unitsDir: tmp(), user: 'op' })
    await assert.rejects(finish(d), /no active new runner for me\/app/)
    assert.ok(existsSync(join(dir, 'me__app-1')))
    r.rows = [{ id: 'me__app-1', repo: 'me/app', name: 'box1-app-r1', active: 'active' }]
    let pg = 0
    d.sys = async (cmd, args) => (d.sysCalls.push([cmd, ...args]), { code: cmd === 'pgrep' ? (++pg < 2 ? 0 : 1) : 0, stdout: '', stderr: '' })
    assert.equal(await finish(d), 0)
    assert.equal(pg, 2)
    assert.ok(!existsSync(join(dir, 'me__app-1')))
  } finally {
    t.server.close()
  }
})

test('test quality: migrate --verify fails (old runners back) on a failed job and on a timeout', async () => {
  for (const how of ['failed', 'timeout'] as const) {
    const t = await up()
    try {
      const o = makeOrigin(t.h.origins, 'me/app')
      let now = t.h.clock.t
      const d = deps(t.client, new FakeRunnerctl(), {
        oldRunnersDir: oldDir(), user: 'op', now: () => (how === 'timeout' ? (now += 60_000) : now),
        sys: async (cmd, args) => {
          d.sysCalls.push([cmd, ...args])
          if (cmd === 'pgrep') return { code: 1, stdout: '', stderr: '' }
          if (cmd === 'gh' && args[0] === 'api' && /^repos\/[^/]+\/[^/]+\/commits\/main$/.test(args[1])) return { code: 0, stdout: `${o.sha}\n`, stderr: '' }
          if (cmd === 'gh' && args.includes('.defaultBranchRef.target.oid')) return { code: 0, stdout: '\n', stderr: '' } // the real gh: no target
          if (cmd === 'gh' && args.includes('.defaultBranchRef.name')) return { code: 0, stdout: 'main\n', stderr: '' }
          if (cmd === 'gh' && args[0] === 'workflow' && how === 'failed') {
            const id = await t.h.d.c.jobs.submit({ repo: 'me/app', profile: 'app', mode: 'cmd', args: ['true'], commit: o.sha, detach: true, door: 'github', ghRun: '1.1 workflow_dispatch x' })
            t.h.d.c.db.updateJob(idOf(id.id), { state: 'failed', endedAt: t.h.clock.t })
          }
          return { code: 0, stdout: '', stderr: '' }
        },
      })
      assert.equal(await verify(d, { pollMs: 0, timeoutMs: 5 * 60_000 }), 1, how)
      assert.match(d.outs.join(''), how === 'failed' ? /job tst-1 failed/ : /within/)
      assert.ok(d.sysCalls.some((c) => c[0] === 'systemctl' && c.includes('enable')))
    } finally {
      t.server.close()
    }
  }
})

// ---------------------------------------------------------------- re-review fixes

test('re-review #6: a pgrep that fails (exit 2: no user, bad args) is an error, never "no old runner works a job"', async () => {
  const t = await up()
  try {
    const r = new FakeRunnerctl()
    r.rows = [{ id: 'me__app-1', repo: 'me/app', name: 'box1-app-r1', active: 'active' }]
    const sys = async (cmd: string) => ({ code: cmd === 'pgrep' ? 2 : 0, stdout: '', stderr: 'pgrep: invalid user name' })
    const dir = oldDir()
    await assert.rejects(finish(deps(t.client, r, { oldRunnersDir: dir, unitsDir: tmp(), sys })), /pgrep failed \(exit 2/)
    assert.ok(existsSync(join(dir, 'me__app-1')), 'nothing removed')
    await assert.rejects(verify(deps(t.client, r, { oldRunnersDir: oldDir(), sys })), /pgrep failed \(exit 2/)
  } finally {
    t.server.close()
  }
})

test('re-review #7: switch-to-split says what to do when the old daemon can\'t come back, or the split one doesn\'t start', async () => {
  const a = await up()
  try {
    const d = deps(a.client, new FakeRunnerctl())
    const base = switchSys(d, a, { pull: 1 })
    d.sys = async (cmd, args) => (cmd === 'systemctl' && args.includes('enable') ? (d.sysCalls.push([cmd, ...args]), { code: 1, stdout: '', stderr: 'bus' }) : base(cmd, args))
    await assert.rejects(switchToSplit({ ...d, single: a.client, split: async () => a.client, checkout: '/live' }, { pollMs: 0 }), /could NOT bring the old daemon back.*systemctl --user enable --now ci-brokerd\.service/s)
  } finally {
    a.server.close()
  }
  const b = await up()
  try {
    const r = new FakeRunnerctl()
    const d = deps(b.client, r)
    d.sys = switchSys(d, b)
    r.fail = 'Job for ci-brokerd.service failed'
    await assert.rejects(switchToSplit({ ...d, single: b.client, split: async () => b.client, checkout: '/live' }, { pollMs: 0 }), /no daemon runs now.*sudo -n ci-broker-runnerctl daemon start.*ci-broker admin-seed 1.*rollback/s)
  } finally {
    b.server.close()
  }
})
