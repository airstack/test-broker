import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { main, parseArgs, START_FLAGS } from '../../src/ci/cli.ts'

test('flags, then everything after -- is passed through untouched', () => {
  assert.deepEqual(parseArgs(['run', '--repo', 'me/x', '--sha', 'abc', '--mode', 'cmd', '--', 'just typecheck', '--flag']), {
    cmd: 'run', flags: { repo: 'me/x', sha: 'abc', mode: 'cmd' }, rest: ['just typecheck', '--flag'], positional: [],
  })
})

test('--flag=value, boolean flags and positionals', () => {
  assert.deepEqual(parseArgs(['runner', 'add', 'me/x', '--count=2', '--dry-run']), {
    cmd: 'runner', flags: { count: '2', 'dry-run': 'true' }, rest: [], positional: ['add', 'me/x'],
  })
})

test('--help on any command prints the usage and runs nothing (submit --help once submitted a job)', async () => {
  const w = process.stdout.write.bind(process.stdout)
  let got = ''
  process.stdout.write = ((c: string | Uint8Array) => ((got += String(c)), true)) as typeof process.stdout.write
  try {
    const env = process.env.CI_BROKER_CONFIG
    process.env.CI_BROKER_CONFIG = '/nonexistent/ci-broker.json'
    try {
      // not submit itself: without the fix it would submit a real job on a machine with a daemon; cancel and
      // runner reach the same early return and fail (usage, exit 2) without it
      for (const cmd of ['cancel', 'runner', 'status']) {
        got = ''
        assert.equal(await main([cmd, '--help']), 0)
        assert.match(got, /^ci-broker — run a repo/)
      }
    } finally {
      if (env === undefined) delete process.env.CI_BROKER_CONFIG
      else process.env.CI_BROKER_CONFIG = env
    }
  } finally {
    process.stdout.write = w
  }
  assert.deepEqual(parseArgs(['submit', '--mode', 'cmd', '--', 'x', '--help']).flags.help, undefined)
})

test('submit and dispatch refuse a flag they do not take, before anything runs (submit --dry-run once queued a job)', async () => {
  const w = process.stderr.write.bind(process.stderr)
  let got = ''
  process.stderr.write = ((c: string | Uint8Array) => ((got += String(c)), true)) as typeof process.stderr.write
  try {
    // dispatch only (a regression on submit would submit a real job on a machine with a daemon), with no gh on PATH
    // and a repo that doesn't exist, so a regression can't dispatch anything either
    const path = process.env.PATH
    process.env.PATH = '/nonexistent'
    try {
      assert.equal(await main(['dispatch', '--repo', 'nobody/none', '--sha', 'a'.repeat(40), '--dry-run']), 2)
      assert.equal(await main(['dispatch', '--repo', 'nobody/none', '--sha', 'a'.repeat(40), 'cmd', '--', 'x']), 2)
      assert.match(got, /dispatch: unexpected 'cmd' \(nothing was started; the mode is --mode cmd/)
    } finally {
      process.env.PATH = path
    }
    assert.match(got, /^ci-broker dispatch: unknown flag --dry-run \(nothing was started/)
  } finally {
    process.stderr.write = w
  }
  assert.ok(START_FLAGS.submit.has('no-status') && !START_FLAGS.submit.has('dry-run'))
})

test('START_FLAGS.submit lists every flag the submit case reads', () => {
  const src = readFileSync(new URL('../../src/ci/cli.ts', import.meta.url), 'utf8')
  const body = src.slice(src.indexOf("case 'submit': {"), src.indexOf("case 'status':"))
  const read = new Set([...body.matchAll(/a\.flags(?:\.([a-z]+)|\['([a-z-]+)'\])/g)].map((m) => m[1] ?? m[2]))
  assert.deepEqual([...read].sort(), [...START_FLAGS.submit].sort())
  const d = src.slice(src.indexOf("case 'dispatch':"))
  const dline = d.slice(0, d.indexOf('\n', d.indexOf('return')))
  assert.deepEqual([...new Set([...dline.matchAll(/a\.flags\.([a-z]+)/g)].map((m) => m[1]))].sort(), [...START_FLAGS.dispatch].sort())
})
