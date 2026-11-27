import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defaults, type Config } from '../../src/ci/config.ts'
import { Credentials } from '../../src/ci/credentials.ts'
import { tmp } from '../harness.ts'

const TOKEN = 'ghp_' + 'A'.repeat(36)

function cfg(o: Partial<Config> = {}): Config {
  const d = tmp()
  return { ...defaults({ HOME: d }), stateDir: join(d, 'state'), ...o }
}

test('split: the GitHub token comes from the 0600 file, never a command; it is added to the scrubber', async () => {
  const d = tmp()
  writeFileSync(join(d, 'github-token'), `${TOKEN}\n`, { mode: 0o600 })
  const seen: string[] = []
  const c = new Credentials(cfg({ layout: 'split', credentials: { github: { file: join(d, 'github-token'), tokenCmd: 'exit 9' }, boat: { configHome: join(d, '.config') } } }), { addSecret: (v) => void seen.push(v) })
  assert.equal(await c.load(), TOKEN)
  assert.deepEqual(seen, [TOKEN])
  assert.equal(c.ghEnv({ PATH: '/usr/bin' }).GH_TOKEN, TOKEN)
  assert.deepEqual(c.boatEnv({ PATH: '/x' }), { PATH: '/x', XDG_CONFIG_HOME: join(d, '.config'), BOAT_NO_UPDATE: '1' })
})

test('single: the token comes from tokenCmd (default `gh auth token`); a failing command leaves no token', async () => {
  const c = new Credentials(cfg({ credentials: { github: { tokenCmd: `echo ${TOKEN}` }, boat: {} } }), { addSecret: () => {} })
  assert.equal(await c.load(), TOKEN)
  const f = new Credentials(cfg({ credentials: { github: { tokenCmd: 'exit 3' }, boat: {} } }), { addSecret: () => {} })
  assert.equal(await f.load(), null)
  assert.equal(f.ghEnv({}).GH_TOKEN, undefined)
})

test('git: GIT_CONFIG_GLOBAL is the daemon\'s own file, no system config, credential helpers reset and the token only in the env', async () => {
  const d = tmp()
  writeFileSync(join(d, 't'), TOKEN)
  const c = new Credentials(cfg({ layout: 'split', stateDir: d, credentials: { github: { file: join(d, 't') }, boat: {} } }), { addSecret: () => {} })
  await c.load()
  const env = c.gitEnv({ HOME: '/h', GIT_CONFIG_GLOBAL: '/home/x/.gitconfig' })
  assert.equal(env.GIT_CONFIG_GLOBAL, join(d, 'gitconfig'))
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1')
  assert.equal(env.GIT_TERMINAL_PROMPT, '0')
  assert.equal(readFileSync(join(d, 'gitconfig'), 'utf8'), '[safe]\n\tdirectory = *\n')
  assert.equal(env.GIT_CONFIG_KEY_0, 'credential.helper')
  assert.equal(env.GIT_CONFIG_VALUE_0, '')
  assert.equal(env.GIT_CONFIG_KEY_1, 'credential.helper')
  assert.ok(!env.GIT_CONFIG_VALUE_1!.includes(TOKEN), 'the helper reads the token from the env')
  assert.equal(env.CIB_GIT_TOKEN, TOKEN)
  // the helper really answers git with the token from the env (and nothing else)
  const out = execFileSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', env: { ...env, PATH: process.env.PATH }, encoding: 'utf8' })
  assert.match(out, new RegExp(`password=${TOKEN}`))
  assert.match(out, /username=x-access-token/)
})

test('job secrets: read from their file at run time; unset when the file is missing or the name undefined; cmd only in single', async () => {
  const d = tmp()
  writeFileSync(join(d, 's'), 'secret-value\n', { mode: 0o640 })
  const c = new Credentials(cfg({ secrets: { fetchToken: { file: join(d, 's') }, gone: { file: join(d, 'nope') }, viaCmd: { cmd: 'echo from-cmd' } } }), { addSecret: () => {} })
  assert.equal(c.secret('fetchToken'), 'secret-value')
  assert.equal(c.secret('gone'), null)
  assert.equal(c.secret('undefined-name'), null)
  assert.equal(c.secret('viaCmd'), null, 'a cmd secret has no value until its command answered')
  assert.equal(await c.readSecret('viaCmd'), 'from-cmd')
  assert.equal(c.secret('viaCmd'), 'from-cmd')
  assert.equal(await c.readSecret('fetchToken'), 'secret-value')
  const s = new Credentials(cfg({ layout: 'split', secrets: { viaCmd: { cmd: 'echo from-cmd' } } }), { addSecret: () => {} })
  await s.refreshSecrets()
  assert.equal(s.secret('viaCmd'), null)
  assert.equal(await s.readSecret('viaCmd'), null)
})

test('a slow secret command does not block the event loop (#5)', async () => {
  const c = new Credentials(cfg({ secrets: { slow: { cmd: 'sleep 1; echo late' } } }), { addSecret: () => {} })
  let ticks = 0
  const t = setInterval(() => ticks++, 50)
  const v = await c.readSecret('slow')
  clearInterval(t)
  assert.equal(v, 'late')
  assert.ok(ticks >= 10, `timers kept firing while the command ran (${ticks})`)
})

test('a job secret equal to the daemon\'s GitHub credential is found (full sha256 compare)', async () => {
  const d = tmp()
  writeFileSync(join(d, 't'), TOKEN)
  writeFileSync(join(d, 'same'), `${TOKEN}\n`)
  writeFileSync(join(d, 'other'), 'ghp_' + 'B'.repeat(36))
  const c = new Credentials(cfg({ layout: 'split', credentials: { github: { file: join(d, 't') }, boat: {} }, secrets: { same: { file: join(d, 'same') }, other: { file: join(d, 'other') } } }), { addSecret: () => {} })
  await c.load()
  assert.deepEqual(c.secretsEqualToCredential(), ['same'])
  assert.equal(c.tokenHash()!.length, 64)
})
