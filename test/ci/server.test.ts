import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Server } from 'node:http'
import * as cmd from '../../src/ci/client/commands.ts'
import { ApiError, Client, DaemonDown } from '../../src/ci/client/http.ts'
import { submit, type SubmitOpts } from '../../src/ci/client/submit.ts'
import { listen } from '../../src/ci/daemon/server.ts'
import { harness, idOf, makeOrigin, tmp, until, type Harness } from '../harness.ts'

async function up(o: Parameters<typeof harness>[0] = {}): Promise<{ h: Harness; server: Server; client: Client; out: string[]; err: string[] }> {
  const h = harness(o)
  const server = await listen(h.d, h.cfg.socketPath)
  return { h, server, client: new Client(h.cfg.socketPath), out: [], err: [] }
}
const opts = (t: { out: string[]; err: string[] }, h: Harness, o: Partial<SubmitOpts>): SubmitOpts => ({
  mode: 'one', args: [], cwd: '.', maxFileMb: 50, interestGraceSec: h.cfg.interestGraceSec, out: (s) => void t.out.push(s), err: (s) => void t.err.push(s), reconnectMs: 0, profile: 'app', ...o,
})

test('the socket: status, JSON errors, 0600 file mode; a second daemon on the same socket is refused', async () => {
  const t = await up()
  try {
    const s = await t.client.request('GET', '/status')
    assert.equal(s.daemonId, 'tst')
    await assert.rejects(t.client.request('GET', '/jobs/tst-999'), (e: unknown) => e instanceof ApiError && e.status === 404)
    await assert.rejects(t.client.request('GET', '/jobs/zzz-1'), /no job/)
    const { statSync } = await import('node:fs')
    assert.equal(statSync(t.h.cfg.socketPath).mode & 0o777, 0o600)
    await assert.rejects(listen(t.h.d, t.h.cfg.socketPath), /another ci-brokerd/)
  } finally {
    t.server.close()
  }
})

test('no daemon → DaemonDown with the systemctl hint', async () => {
  const c = new Client(join(tmp(), 'nope.sock'))
  await assert.rejects(c.request('GET', '/status'), (e: unknown) => e instanceof DaemonDown && /systemctl --user start ci-brokerd/.test((e as Error).message))
})

test('submit of a clean pushed checkout over the socket: streams prefixed output, prints the receipt, exits 0; a second submit reuses it', async () => {
  const t = await up()
  t.h.boat.onCommand = undefined // the real wrapper + remote.sh on the fake box
  try {
    const o = makeOrigin(t.h.origins, 'me/app')
    const code = await submit(t.client, opts(t, t.h, { cwd: o.work }))
    assert.equal(code, 0, t.out.join('') + t.err.join(''))
    const out = t.out.join('')
    assert.match(out, new RegExp(`\\[one\\] remote ${o.sha} one`))
    assert.match(out, /RESULT: PASS/)
    assert.match(out, new RegExp(`status: ci-broker/one success posted on ${o.sha.slice(0, 12)}`))
    assert.deepEqual(t.h.gh.calls, [['api', '-X', 'POST', `repos/me/app/statuses/${o.sha}`, '-f', 'state=success', '-f', 'context=ci-broker/one', '-f', 'description=1/1 shards passed in 0s (job tst-1)']])
    t.out.length = 0
    assert.equal(await submit(t.client, opts(t, t.h, { cwd: o.work })), 0)
    assert.match(t.out.join(''), /reused job tst-1/)
    assert.match(t.out.join(''), /status: ci-broker\/one success posted/)
    assert.equal(t.h.gh.calls.length, 1, 'the same commit already shows this success: no second post')
  } finally {
    t.server.close()
  }
})

test('submit of a dirty checkout: snapshot + bundle upload, the run sees the edit; args → no status', async () => {
  const t = await up()
  t.h.boat.onCommand = undefined
  try {
    const o = makeOrigin(t.h.origins, 'me/app')
    writeFileSync(join(o.work, 'f.txt'), 'edited\n')
    const code = await submit(t.client, opts(t, t.h, { cwd: o.work, mode: 'cmd', args: ['echo hi'] }))
    assert.equal(code, 0, t.out.join('') + t.err.join(''))
    assert.match(t.err.join(''), /sending the snapshot \(base [0-9a-f]{12}\)/)
    assert.match(t.out.join(''), /status: none \(a run with args/)
    const j = t.h.d.c.db.job(1)!
    assert.equal(j.source, 'snapshot')
    assert.equal(j.base, o.sha)
  } finally {
    t.server.close()
  }
})

test('a status post that fails is shown in the receipt; the exit code is the job result', async () => {
  const t = await up()
  t.h.gh.fail = 'HTTP 422: No commit found for SHA'
  try {
    const o = makeOrigin(t.h.origins, 'me/app')
    const p = submit(t.client, opts(t, t.h, { cwd: o.work }))
    await until(() => t.h.ctl.pending.length === 1)
    t.h.ctl.finish(0)
    assert.equal(await p, 0)
    assert.match(t.out.join(''), new RegExp(`status: ci-broker/one on ${o.sha.slice(0, 12)} NOT posted: gh api exited 1: HTTP 422: No commit found for SHA`))
  } finally {
    t.server.close()
  }
})

test('a failing shard → exit 1; show and logs read the job back', async () => {
  const t = await up()
  try {
    const o = makeOrigin(t.h.origins, 'me/app')
    const p = submit(t.client, opts(t, t.h, { cwd: o.work }))
    await until(() => t.h.ctl.pending.length === 1)
    t.h.ctl.finish(1, undefined, 'FAIL boom\n')
    assert.equal(await p, 1)
    assert.match(t.out.join(''), /RESULT: FAIL/)
    const shown: string[] = []
    await cmd.show(t.client, (s) => void shown.push(s), 'tst-1')
    assert.match(shown.join(''), /one\s+failed\s+attempt 1 boat:cib-tst-acme-default-\w+ \(created\) exit 1/)
    assert.match(shown.join(''), /place\s+boat:/)
    const logs: string[] = []
    await cmd.logs(t.client, (s) => void logs.push(s), 'tst-1', { follow: false, shard: 'one' })
    assert.match(logs.join(''), /^ci-broker: one attempt 1 on boat:/)
    assert.match(logs.join(''), /FAIL boom/)
  } finally {
    t.server.close()
  }
})

test('a dropped stream reconnects with its interest token from the last seq: nothing lost, nothing doubled, job not cancelled', async () => {
  const t = await up()
  try {
    const o = makeOrigin(t.h.origins, 'me/app')
    const follows: string[] = []
    t.server.on('request', (req) => req.url?.includes('/events') && follows.push(req.url))
    const p = submit(t.client, opts(t, t.h, { cwd: o.work }))
    await until(() => t.h.ctl.pending.length === 1)
    t.h.ctl.pending[0].onData?.('before\n')
    await until(() => t.out.join('').includes('before'))
    t.server.closeAllConnections()
    t.h.ctl.pending[0].onData?.('after\n')
    t.h.ctl.finish(0)
    assert.equal(await p, 0)
    const out = t.out.join('')
    assert.equal(out.match(/before/g)!.length, 1)
    assert.equal(out.match(/after/g)!.length, 1)
    assert.equal(follows.length, 2)
    assert.match(follows[1], /from=[1-9]\d*&interest=[0-9a-f]{24}/)
  } finally {
    t.server.close()
  }
})

test('SIGINT withdraws the interest: the job is cancelled, the client exits 130', async () => {
  const t = await up()
  try {
    const o = makeOrigin(t.h.origins, 'me/app')
    const ac = new AbortController()
    const p = submit(t.client, opts(t, t.h, { cwd: o.work, signal: ac.signal }))
    await until(() => t.h.ctl.pending.length === 1)
    ac.abort()
    assert.equal(await p, 130)
    assert.equal(t.h.d.c.db.job(1)!.state, 'cancelled')
    assert.match(t.out.join(''), /RESULT: FAIL/)
  } finally {
    t.server.close()
  }
})

test('events: interest=1 sends a token first; a late joiner gets the whole replay; --detach returns at once', async () => {
  const t = await up()
  try {
    const o = makeOrigin(t.h.origins, 'me/app')
    assert.equal(await submit(t.client, opts(t, t.h, { cwd: o.work, detach: true })), 0)
    assert.match(t.out.join(''), /runs detached/)
    await until(() => t.h.ctl.pending.length === 1)
    t.h.ctl.pending[0].onData?.('line one\n')
    const ev: any[] = []
    const ac = new AbortController()
    const following = t.client.stream('/jobs/tst-1/events?follow=1&interest=1', (e) => {
      ev.push(e)
      if (e.t === 'log' && e.data.includes('line one')) t.h.ctl.finish(0)
    }, ac.signal)
    await following
    assert.equal(ev[0].t, 'interest')
    assert.match(ev[0].token, /^[0-9a-f]{24}$/)
    assert.equal(ev.at(-1).t, 'done')
    const seqs = ev.filter((e) => e.seq).map((e) => e.seq)
    assert.deepEqual(seqs, seqs.map((_, i) => i + 1))
    const fromTwo: any[] = []
    await t.client.stream('/jobs/tst-1/events?from=2', (e) => fromTwo.push(e))
    assert.equal(fromTwo[0].seq, 3)
    assert.equal(t.h.d.c.db.job(idOf('tst-1'))!.state, 'passed')
  } finally {
    t.server.close()
  }
})

test('a daemon restart while following: the client keeps reconnecting (socket gone / refused) with its token and finishes', async () => {
  const t = await up()
  let server = t.server
  try {
    const o = makeOrigin(t.h.origins, 'me/app')
    const p = submit(t.client, opts(t, t.h, { cwd: o.work }))
    await until(() => t.h.ctl.pending.length === 1)
    t.h.ctl.pending[0].onData?.('before\n')
    await until(() => t.out.join('').includes('before'))
    await new Promise<void>((r) => {
      server.close(() => r())
      server.closeAllConnections()
    })
    await until(() => t.err.join('').includes('not answering'), 'the client seeing the daemon down')
    server = await listen(t.h.d, t.h.cfg.socketPath)
    t.h.ctl.pending[0].onData?.('after\n')
    t.h.ctl.finish(0)
    assert.equal(await p, 0)
    assert.match(t.out.join(''), /after/)
    assert.equal(t.h.d.c.db.job(1)!.state, 'passed')
  } finally {
    server.close()
  }
})

test('a terminal job whose `done` never made it to its stream (a crash in between) gets it at boot and on follow', async () => {
  const { readFileSync, writeFileSync } = await import('node:fs')
  const { Daemon } = await import('../../src/ci/daemon/daemon.ts')
  const t = await up()
  try {
    const o = makeOrigin(t.h.origins, 'me/app')
    const r1 = await t.h.submit({ sha: o.sha, mode: 'one' })
    await t.h.pass()
    await until(() => t.h.ctl.pending.length === 1)
    t.h.ctl.finish(0)
    await until(() => t.h.d.c.db.job(idOf(r1.id))!.state === 'passed')
    await t.h.d.idle()
    const dropDone = (id: number) => {
      const f = join(t.h.d.c.streams.dir(id), 'stream.ndjson')
      const lines = readFileSync(f, 'utf8').trim().split('\n')
      assert.equal(JSON.parse(lines.at(-1)!).t, 'done')
      writeFileSync(f, lines.slice(0, -1).join('\n') + '\n')
      t.h.d.c.streams.forget(id)
    }
    // on follow
    dropDone(idOf(r1.id))
    const seen: any[] = []
    const res = await t.client.stream(`/jobs/${r1.id}/events?follow=1`, (e) => seen.push(e))
    assert.equal(res.ended, true)
    assert.equal(seen.at(-1).t, 'done')
    // at boot
    dropDone(idOf(r1.id))
    const d2 = new Daemon({ ghApi: t.h.github.run, apiSleep: async () => {}, cfg: t.h.cfg, boat: t.h.boat, now: () => t.h.clock.t, log: () => {}, sys: async () => ({ code: 0, stdout: '', stderr: '' }), gh: async () => ({ code: 0, stdout: '', stderr: '' }), localLock: async () => null })
    d2.c.scheduler.paused = true
    await d2.recover()
    assert.equal(d2.c.streams.read(idOf(r1.id)).at(-1)!.t, 'done')
    assert.equal(d2.c.streams.read(idOf(r1.id)).filter((e) => e.t === 'done').length, 1)
  } finally {
    t.server.close()
  }
})

/** A daemon whose git calls matching `when` wait until released; `reached` resolves when one does. */
async function gatedUp(when: (args: string[]) => boolean) {
  const { realGit } = await import('../../src/core/mirror.ts')
  const git = realGit(60)
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  let atGate!: () => void
  const reached = new Promise<void>((r) => (atGate = r))
  let armed = false
  const t = await up({
    deps: {
      git: async (args, o) => {
        if (armed && when(args)) {
          atGate()
          await gate
        }
        return git(args, o)
      },
    },
  })
  return { t, release, reached, arm: () => void (armed = true) }
}

test('Ctrl-C while the submit POST waits (a long mirror fetch): the client leaves at once with 130', async () => {
  const g = await gatedUp((a) => a.includes('fetch') && a.includes('--prune'))
  try {
    const o = makeOrigin(g.t.h.origins, 'me/app')
    g.arm()
    const ac = new AbortController()
    const p = submit(g.t.client, opts(g.t, g.t.h, { cwd: o.work, signal: ac.signal }))
    await g.reached
    ac.abort()
    assert.equal(await p, 130)
  } finally {
    g.release()
    await g.t.h.d.idle()
    g.t.server.close()
  }
})

test('Ctrl-C during the bundle upload: the upload stops, the temp ref goes, the interest is withdrawn and the job cancelled', async () => {
  const g = await gatedUp((a) => a.includes('list-heads'))
  try {
    const o = makeOrigin(g.t.h.origins, 'me/app')
    writeFileSync(join(o.work, 'f.txt'), 'edited\n')
    g.arm()
    const ac = new AbortController()
    const p = submit(g.t.client, opts(g.t, g.t.h, { cwd: o.work, signal: ac.signal }))
    await g.reached
    ac.abort()
    assert.equal(await p, 130)
    const { execFileSync } = await import('node:child_process')
    assert.equal(execFileSync('git', ['-C', o.work, 'for-each-ref', 'refs/ci-broker'], { encoding: 'utf8' }), '', 'temp ref deleted')
    await until(() => g.t.h.d.c.db.job(1)!.state === 'cancelled', 'the job cancelled')
  } finally {
    g.release()
    await g.t.h.d.idle()
    g.t.server.close()
  }
})
