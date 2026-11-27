import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WRAP_SCRIPT } from '../../src/ci/daemon/daemon.ts'
import { tmp, until } from '../harness.ts'

function slot(home: string, n: number, script: string): string {
  const d = join(home, 'cib', String(n))
  mkdirSync(d, { recursive: true })
  copyFileSync(WRAP_SCRIPT, join(d, 'cib-wrap.sh'))
  writeFileSync(join(d, 'remote.sh'), script)
  return d
}
const alive = (pgid: number) => {
  try {
    process.kill(-pgid, 0)
    return true
  } catch {
    return false
  }
}

test('CIB_TOKEN_LINE=1: one stdin line becomes GITHUB_TOKEN, the rest of stdin is closed; the exit code passes through', () => {
  const d = slot(tmp(), 0, 'echo "tok=$GITHUB_TOKEN args=$*"; if read -r x; then echo "read:$x"; else echo stdin-closed; fi; exit 7\n')
  const r = spawnSync('bash', [join(d, 'cib-wrap.sh'), 'sha1', 'cmd', 'x y'], { input: 'TOKEN123\nmore\n', encoding: 'utf8', env: { ...process.env, CIB_TOKEN_LINE: '1' } })
  assert.equal(r.status, 7)
  assert.match(r.stdout, /tok=TOKEN123 args=sha1 cmd x y/)
  assert.match(r.stdout, /stdin-closed/)
  assert.equal(existsSync(join(d, 'run.pid')), false)
})

test('without CIB_TOKEN_LINE nothing is read and stdin is still closed', () => {
  const d = slot(tmp(), 0, 'echo "tok=${GITHUB_TOKEN:-none}"; read -r x && echo "read:$x" || echo stdin-closed\n')
  const r = spawnSync('bash', [join(d, 'cib-wrap.sh'), 'sha1'], { input: 'TOKEN123\n', encoding: 'utf8', env: { ...process.env, CIB_TOKEN_LINE: '0', GITHUB_TOKEN: '' } })
  assert.match(r.stdout, /tok=none/)
  assert.match(r.stdout, /stdin-closed/)
})

test('--kill on one slot kills only that slot\'s process group (children included)', async () => {
  const home = tmp()
  const script = 'sleep 300 & echo started; wait\n'
  const d0 = slot(home, 0, script)
  const d1 = slot(home, 1, script)
  const w0 = spawn('bash', [join(d0, 'cib-wrap.sh'), 's'], { stdio: 'ignore' })
  const w1 = spawn('bash', [join(d1, 'cib-wrap.sh'), 's'], { stdio: 'ignore' })
  const ended0 = new Promise<number | null>((r) => w0.on('close', r))
  await until(() => existsSync(join(d0, 'run.pid')) && existsSync(join(d1, 'run.pid')), 'both pid files')
  const g0 = Number(readFileSync(join(d0, 'run.pid'), 'utf8'))
  const g1 = Number(readFileSync(join(d1, 'run.pid'), 'utf8'))
  assert.ok(alive(g0) && alive(g1))
  assert.equal(spawnSync('bash', [join(d0, 'cib-wrap.sh'), '--kill']).status, 0)
  await ended0
  assert.equal(alive(g0), false)
  assert.equal(alive(g1), true)
  spawnSync('bash', [join(d1, 'cib-wrap.sh'), '--kill'])
  await new Promise((r) => w1.on('close', r))
  assert.equal(alive(g1), false)
})

test('a new run first kills the group a lost run left in the slot', async () => {
  const home = tmp()
  const d = slot(home, 0, 'sleep 300 & wait\n')
  const lost = spawn('bash', [join(d, 'cib-wrap.sh'), 's'], { stdio: 'ignore' })
  await until(() => existsSync(join(d, 'run.pid')), 'pid file')
  const g = Number(readFileSync(join(d, 'run.pid'), 'utf8'))
  writeFileSync(join(d, 'remote.sh'), 'echo second\n')
  const r = spawnSync('bash', [join(d, 'cib-wrap.sh'), 's'], { encoding: 'utf8' })
  assert.equal(r.status, 0)
  assert.match(r.stdout, /second/)
  assert.equal(alive(g), false)
  await new Promise((res) => (lost.exitCode !== null ? res(null) : lost.on('close', res)))
})

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('a process that left the group (setsid) dies with the run: on --kill, on a new run, and when the script ends', async () => {
  const home = tmp()
  // the escaped child writes its pid, then the script waits (lost-run case) or exits (end-of-script case)
  const d = slot(home, 0, `setsid sleep 300 </dev/null >/dev/null 2>&1 & echo $! > "${'$'}{0%/*}/escaped.pid"; [ "\${1:-}" = wait ] && sleep 300; exit 0\n`)
  // 0 while the script is still writing the file; never use 0: kill(0, 0) is this test's own process group. Read it
  // once per check: two reads can see the old pid and then the truncated file.
  const escaped = () => (existsSync(join(d, 'escaped.pid')) && Number(readFileSync(join(d, 'escaped.pid'), 'utf8'))) || 0
  const fresh = (not: number[]) => {
    const e = escaped()
    return e > 0 && !not.includes(e) ? e : 0
  }

  // 1. --kill: the group and the escaped child go
  const w = spawn('bash', [join(d, 'cib-wrap.sh'), 'wait'], { stdio: 'ignore' })
  let p1 = 0
  await until(() => existsSync(join(d, 'run.tok')) && (p1 = fresh([])) > 0, 'escaped child + token')
  assert.ok(pidAlive(p1))
  assert.equal(spawnSync('bash', [join(d, 'cib-wrap.sh'), '--kill']).status, 0)
  await new Promise((r) => (w.exitCode !== null ? r(null) : w.on('close', r)))
  await until(() => !pidAlive(p1), 'the escaped child to die on --kill')
  assert.equal(existsSync(join(d, 'run.tok')), false)

  // 2. a new run (the retry) kills what the lost run left outside its group before it starts
  const lost = spawn('bash', [join(d, 'cib-wrap.sh'), 'wait'], { stdio: 'ignore' })
  let p2 = 0
  await until(() => existsSync(join(d, 'run.tok')) && (p2 = fresh([p1])) > 0, 'second escaped child')
  const r = spawnSync('bash', [join(d, 'cib-wrap.sh'), 'nowait'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  // a killed process can stay a zombie for a moment: wait, as steps 1 and 3 do
  await until(() => !pidAlive(p2), 'the lost run\'s escaped child to die before the new run')
  await new Promise((res) => (lost.exitCode !== null ? res(null) : lost.on('close', res)))

  // 3. the run that just ended took its own escaped child with it
  await until(() => {
    const p3 = fresh([p1, p2])
    return p3 > 0 && !pidAlive(p3)
  }, 'the end-of-script kill')
})

function fakeBin(home: string, tools: Record<string, string>): string {
  const bin = join(home, 'bin')
  mkdirSync(bin, { recursive: true })
  for (const [name, body] of Object.entries(tools)) writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 })
  return bin
}

test('CIB_NOFSYNC=1 runs the script under eatmydata; the token kill still finds it', () => {
  const home = tmp()
  const bin = fakeBin(home, { eatmydata: 'export EMD=1; exec "$@"', sudo: 'exit 1' })
  const d = slot(home, 0, 'echo "emd=${EMD:-0} args=$*"; exit 3\n')
  const r = spawnSync('bash', [join(d, 'cib-wrap.sh'), 'sha1', 'a b'], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CIB_NOFSYNC: '1' } })
  assert.equal(r.status, 3)
  assert.match(r.stdout, /cib-wrap: fsync off \(eatmydata\)/)
  assert.match(r.stdout, /emd=1 args=sha1 a b/)
})

test('without CIB_NOFSYNC, or with no eatmydata and no sudo, the script runs as before', () => {
  const home = tmp()
  const withEmd = fakeBin(home, { eatmydata: 'export EMD=1; exec "$@"', sudo: 'exit 1' })
  const d = slot(home, 0, 'echo "emd=${EMD:-0} args=$*"\n')
  const off = spawnSync('bash', [join(d, 'cib-wrap.sh'), 'sha1'], { encoding: 'utf8', env: { ...process.env, PATH: `${withEmd}:${process.env.PATH}`, CIB_NOFSYNC: '0' } })
  assert.equal(off.status, 0)
  assert.match(off.stdout, /emd=0 args=sha1/)
  assert.doesNotMatch(off.stdout, /cib-wrap:/)
  const home2 = tmp()
  const noEmd = fakeBin(home2, { sudo: 'exit 1' })
  // a PATH with the wrapper's tools but no eatmydata (this machine may have one in /usr/bin)
  for (const t of ['bash', 'env', 'od', 'tr', 'setsid', 'cat', 'rm', 'grep', 'sleep', 'dirname', 'flock']) {
    const w = spawnSync('bash', ['-c', `command -v ${t}`], { encoding: 'utf8' }).stdout.trim()
    if (w) symlinkSync(w, join(noEmd, t))
  }
  const d2 = slot(home2, 0, 'echo "emd=${EMD:-0} args=$*"\n')
  const miss = spawnSync('bash', [join(d2, 'cib-wrap.sh'), 'sha1'], { encoding: 'utf8', env: { ...process.env, PATH: noEmd, CIB_NOFSYNC: '1' } })
  assert.equal(miss.status, 0)
  assert.match(miss.stdout, /eatmydata unavailable, fsync stays on/)
  assert.match(miss.stdout, /emd=0 args=sha1/)
})

test('--kill --fence: that attempt never runs, even when its exec lands after the kill; other attempts still run (#44)', () => {
  const home = tmp()
  const d = slot(home, 0, 'echo ran > "$HOME/ran.$CIB_ATTEMPT"\n')
  const env = (attempt: string) => ({ ...process.env, HOME: home, CIB_ATTEMPT: attempt })
  assert.equal(spawnSync('bash', [join(d, 'cib-wrap.sh'), '--kill', '--fence', 'tb-1.a.2']).status, 0)
  const late = spawnSync('bash', [join(d, 'cib-wrap.sh'), 'sha1'], { encoding: 'utf8', env: env('tb-1.a.2') })
  assert.equal(late.status, 97)
  assert.match(late.stdout, /given up by the broker; not running/)
  assert.equal(existsSync(join(home, 'ran.tb-1.a.2')), false)
  const next = spawnSync('bash', [join(d, 'cib-wrap.sh'), 'sha1'], { encoding: 'utf8', env: env('tb-2.a.1') })
  assert.equal(next.status, 0, next.stdout)
  assert.equal(existsSync(join(home, 'ran.tb-2.a.1')), true)
  // the fence list keeps the newest 50
  for (let i = 0; i < 60; i++) spawnSync('bash', [join(d, 'cib-wrap.sh'), '--kill', '--fence', `f${i}`])
  const lines = readFileSync(join(d, 'fenced'), 'utf8').trim().split('\n')
  assert.equal(lines.length, 50)
  assert.equal(lines.at(-1), 'f59')
})

test('CIB_CPUSET: the script runs pinned to those CPUs; a bad value is refused', () => {
  const d = slot(tmp(), 1, 'taskset -pc $$ | sed "s/.*: //"\n')
  const r = spawnSync('bash', [join(d, 'cib-wrap.sh'), 'sha1'], { encoding: 'utf8', env: { ...process.env, CIB_SLOT: '1', CIB_CPUSET: '0-1' } })
  assert.equal(r.status, 0, r.stdout)
  assert.match(r.stdout, /slot 1 on CPUs 0-1/)
  assert.match(r.stdout, /^0,1$|^0-1$/m)
  const bad = spawnSync('bash', [join(d, 'cib-wrap.sh'), 'sha1'], { encoding: 'utf8', env: { ...process.env, CIB_SLOT: '1', CIB_CPUSET: '0;rm' } })
  assert.equal(bad.status, 90)
})

test('--kill --fence X stops only attempt X: a late kill leaves the next attempt in the slot running; CIB_FENCE fences without a kill', async () => {
  const home = tmp()
  const d = slot(home, 0, 'echo $$ > "$HOME/pid.$CIB_ATTEMPT"; sleep 30\n')
  const env = (attempt: string, fence = '') => ({ ...process.env, HOME: home, CIB_ATTEMPT: attempt, ...(fence ? { CIB_FENCE: fence } : {}) })
  const p = spawn('bash', [join(d, 'cib-wrap.sh'), 'sha1'], { env: env('tb-1.a.2'), stdio: 'ignore' })
  await until(() => existsSync(join(home, 'pid.tb-1.a.2')), 'attempt 2 running')
  const pgid = Number(readFileSync(join(d, 'run.pid'), 'utf8'))
  // a late kill of attempt 1 (lost earlier): fences 1, leaves 2 alone
  assert.equal(spawnSync('bash', [join(d, 'cib-wrap.sh'), '--kill', '--fence', 'tb-1.a.1']).status, 0)
  assert.equal(alive(pgid), true)
  assert.match(readFileSync(join(d, 'fenced'), 'utf8'), /^tb-1\.a\.1$/m)
  // the kill naming attempt 2 stops it
  assert.equal(spawnSync('bash', [join(d, 'cib-wrap.sh'), '--kill', '--fence', 'tb-1.a.2']).status, 0)
  await until(() => !alive(pgid), 'attempt 2 stopped')
  await new Promise((r) => p.on('close', r))
  // an attempt the next one names in CIB_FENCE never runs, though no kill reached the box for it
  // (this attempt names itself too: it adds the fences, then finds itself fenced and never starts)
  const next = spawnSync('bash', [join(d, 'cib-wrap.sh'), 'sha1'], { encoding: 'utf8', env: env('tb-2.a.1', 'tb-9.a.1 bad;id tb-2.a.1') })
  assert.equal(next.status, 97, next.stdout)
  assert.equal(existsSync(join(home, 'pid.tb-2.a.1')), false)
  const late = spawnSync('bash', [join(d, 'cib-wrap.sh'), 'sha1'], { encoding: 'utf8', env: env('tb-9.a.1') })
  assert.equal(late.status, 97, late.stdout)
  assert.doesNotMatch(readFileSync(join(d, 'fenced'), 'utf8'), /bad/)
})
