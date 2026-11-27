import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { derivePaths, parseInstallConf, readInstallConf } from '../../src/ci/install-conf.ts'
import { tmp } from '../harness.ts'

const DIR = join(import.meta.dirname, 'fixtures', 'install-conf')

test('install.conf fixtures: every ok-* parses, every bad-* is refused (the bash reader uses the same files)', () => {
  const files = readdirSync(DIR)
  assert.ok(files.length >= 10)
  for (const f of files) {
    const text = readFileSync(join(DIR, f), 'utf8')
    if (f.startsWith('ok-')) assert.doesNotThrow(() => parseInstallConf(text), f)
    else assert.throws(() => parseInstallConf(text), /install\.conf/, f)
  }
})

test('install.conf: the values, and every path derived from them', () => {
  const ic = parseInstallConf(readFileSync(join(DIR, 'ok-custom.conf'), 'utf8'))
  assert.equal(ic.DAEMON_USER, 'cbx-admin')
  const p = derivePaths(ic)
  assert.deepEqual(p, {
    daemonHome: '/var/lib/cbx/admin',
    stateDir: '/var/lib/cbx/admin/state',
    localDir: '/var/lib/cbx/local',
    socketPath: '/var/lib/cbx/local/brokerd.sock',
    localLockPath: '/var/lib/cbx/local/local.lock',
    sockDir: '/var/lib/cbx/sock',
    githubSocketPath: '/var/lib/cbx/sock/github.sock',
    operatorDir: '/var/lib/cbx/operator',
    profilesDir: '/var/lib/cbx/operator/profiles',
    tuningPath: '/var/lib/cbx/operator/tuning.json',
    runnersJson: '/var/lib/cbx/runners.json',
    rootConfigPath: '/etc/cbx/config.json',
    secretsDir: '/etc/cbx/secrets',
    ghBin: '/usr/local/lib/cbx/gh',
    boatBin: '/usr/local/lib/cbx/boat',
    nodeBin: '/usr/local/lib/cbx/node/bin/node',
    releaseFile: '/opt/cbx/current/RELEASE',
    runnerctl: '/usr/local/sbin/ci-broker-runnerctl',
  })
})

test('readInstallConf: CI_BROKER_INSTALL_CONF (the daemon and the client only), missing file → null (single)', () => {
  const d = tmp()
  assert.equal(readInstallConf({ CI_BROKER_INSTALL_CONF: join(d, 'none.conf') }), null)
  const f = join(d, 'install.conf')
  writeFileSync(f, readFileSync(join(DIR, 'ok-default.conf')))
  assert.equal(readInstallConf({ CI_BROKER_INSTALL_CONF: f })!.OPERATOR, 'dev')
  writeFileSync(f, readFileSync(join(DIR, 'bad-subst.conf')))
  assert.throws(() => readInstallConf({ CI_BROKER_INSTALL_CONF: f }), /OPT_DIR/)
})

// ---- the bash reader: the same fixtures, and every root script embeds the same copy

import { spawnSync } from 'node:child_process'

const SCRIPTS = join(import.meta.dirname, '..', '..', 'ci', 'scripts')
const reader = readFileSync(join(SCRIPTS, 'install-conf-reader.sh'), 'utf8')

test('the bash reader agrees with the TypeScript one on every fixture', () => {
  for (const f of readdirSync(DIR)) {
    const r = spawnSync('bash', ['-c', `${reader}\nread_install_conf "$1" && echo "$IC_DAEMON_USER $IC_STATE_DIR"`, '_', join(DIR, f)], { encoding: 'utf8' })
    if (f.startsWith('ok-')) {
      assert.equal(r.status, 0, `${f}: ${r.stderr}`)
      const ic = parseInstallConf(readFileSync(join(DIR, f), 'utf8'))
      assert.equal(r.stdout.trim(), `${ic.DAEMON_USER} ${ic.STATE_DIR}`, f)
    } else {
      assert.notEqual(r.status, 0, f)
      assert.match(r.stderr, /install\.conf/, f)
    }
  }
  assert.ok(!pathExists('/tmp/pwned'), 'a $(…) value is never run')
})
const pathExists = (p: string) => spawnSync('test', ['-e', p]).status === 0

test('every root script embeds the same install.conf reader', () => {
  for (const s of ['ci-broker-runnerctl', 'runner-start', 'install.sh']) {
    const text = readFileSync(join(SCRIPTS, s), 'utf8')
    assert.ok(text.includes(reader), `${s} embeds scripts/install-conf-reader.sh as is`)
  }
})

test('ci/workflows/broker.yml: the dispatch run name binds the args digest; actions pinned by sha', () => {
  const y = readFileSync(join(import.meta.dirname, '..', '..', 'ci', 'workflows', 'broker.yml'), 'utf8')
  assert.match(y, /format\('broker \{0\} \{1\} \{2\}', inputs\.mode, inputs\.sha, inputs\.argsHash\)/)
  assert.match(y, /argsHash:\n\s+description: .*\n\s+default: '-'/)
  for (const m of y.matchAll(/uses: (\S+)/g)) assert.match(m[1], /@[0-9a-f]{40}$/, m[1])
  assert.match(y, /touches \.github\/ is refused/)
})
