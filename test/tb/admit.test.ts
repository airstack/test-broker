import { test } from 'node:test'
import assert from 'node:assert/strict'
import { admitLocal, freeCpus, type Lease } from '../../src/tb/admit.ts'
import { parseRepoConfig, RepoConfigError } from '../../src/tb/repo-config.ts'
import { defaultHostId, parseMachineConfig, MachineConfigError } from '../../src/tb/machine-config.ts'

const suite = (local: Record<string, unknown>) => parseRepoConfig({ suites: { s: { local } } }, '/r').suites.s
const lease = (o: Partial<Lease> = {}): Lease => ({ id: 'L-1', repo: 'me/app', root: '/w/wt-1', suite: 's', pid: 42, cpus: 4, locks: [], since: 0, ...o })
const box = (o: Partial<{ nproc: number; load1: number; memAvailGb: number }> = {}) => ({ nproc: 12, load1: 0, memAvailGb: 32, ...o })
const run = (o: Partial<Parameters<typeof admitLocal>[0]> & { suite: ReturnType<typeof suite> }) =>
  admitLocal({ leases: [], box: box(), budgetFactor: 1, flags: {}, now: 1000, eta: () => null, ...o })

test('free CPUs: the budget minus the larger of leased CPUs and load1', () => {
  assert.equal(freeCpus(box(), [], 1), 12)
  assert.equal(freeCpus(box({ load1: 3.5 }), [lease({ cpus: 6 })], 1), 6) // leases count before load1 shows them
  assert.equal(freeCpus(box({ load1: 9.2 }), [lease({ cpus: 6 })], 1), 2) // load from outside the broker
  assert.equal(freeCpus(box({ load1: 30 }), [], 1), 0)
  assert.equal(freeCpus(box(), [], 0.5), 6)
})

test('local: grants up to the suite cpus, never more than free', () => {
  assert.deepEqual(run({ suite: suite({ cpus: 8, minCpus: 2 }) }), { decision: 'local', cpus: 8, locks: [] })
  assert.deepEqual(run({ suite: suite({ cpus: 8, minCpus: 2 }), box: box({ load1: 9 }) }), { decision: 'local', cpus: 3, locks: [] })
  assert.deepEqual(run({ suite: suite({ cpus: 8, minCpus: 2 }), flags: { cpus: 2 } }), { decision: 'local', cpus: 2, locks: [] })
  assert.deepEqual(run({ suite: suite({ cpus: 8, minCpus: 2 }), flags: { cpus: 99 } }), { decision: 'local', cpus: 8, locks: [] })
})

test('busy on load below minCpus; --cpus below minCpus lowers the floor', () => {
  const s = suite({ cpus: 8, minCpus: 4 })
  const a = run({ suite: s, box: box({ load1: 10 }) })
  assert.equal(a.decision, 'busy')
  assert.deepEqual(a.decision === 'busy' && a.reasons, [{ kind: 'load', freeCpus: 2, needCpus: 4 }])
  assert.deepEqual(run({ suite: s, box: box({ load1: 10 }), flags: { cpus: 2 } }), { decision: 'local', cpus: 2, locks: [] })
})

test('a held lock means busy with the holder and an ETA; --force-load does not skip it', () => {
  const s = suite({ cpus: 2, locks: ['db'] })
  const held = [lease({ locks: ['db'], since: Date.parse('2026-11-13T10:00:00Z') })]
  for (const flags of [{}, { forceLoad: true }]) {
    const a = run({ suite: s, leases: held, flags, eta: () => 120 })
    assert.equal(a.decision, 'busy')
    if (a.decision !== 'busy') continue
    assert.deepEqual(a.reasons, [{ kind: 'lock', key: 'db', holder: 'me/app wt-1 (s, pid 42)', since: '2026-11-13T10:00:00.000Z', etaSec: 120 }])
    assert.equal(a.retryAfterSec, 120)
  }
  assert.deepEqual(run({ suite: s, leases: [lease({ locks: ['other'] })] }), { decision: 'local', cpus: 2, locks: ['db'] })
})

test('--force-load skips load and memory, granting the full want', () => {
  const s = suite({ cpus: 6, minCpus: 4, memGb: 8 })
  assert.equal(run({ suite: s, box: box({ load1: 12, memAvailGb: 2 }) }).decision, 'busy')
  assert.deepEqual(run({ suite: s, box: box({ load1: 12, memAvailGb: 2 }), flags: { forceLoad: true } }), { decision: 'local', cpus: 6, locks: [] })
})

test('memory below the suite memGb is busy', () => {
  const a = run({ suite: suite({ cpus: 2, memGb: 8 }), box: box({ memAvailGb: 3.04 }) })
  assert.deepEqual(a.decision === 'busy' && a.reasons, [{ kind: 'memory', memAvailGb: 3, needGb: 8 }])
})

test('repo config: errors name the key', () => {
  const bad = (doc: unknown, re: RegExp) => assert.throws(() => parseRepoConfig(doc, '/r'), (e: Error) => e instanceof RepoConfigError && re.test(e.message))
  bad({ suites: {} }, /suites: must name at least one suite/)
  bad({ suites: { s: { local: { cpus: 0 } } } }, /suites\.s\.local\.cpus/)
  bad({ suites: { s: { local: { cpus: 2, minCpus: 3 } } } }, /minCpus/)
  bad({ suites: { s: { local: { cpus: 2 }, boat: { shards: [{ name: 'a', args: [] }] } } } }, /needs the top-level boat/)
  bad({ boat: { environment: 'e', remoteScript: '../x' }, suites: { s: { local: { cpus: 2 } } } }, /inside the repo/)
  bad({ suites: { s: { local: { cpus: 2, locks: ['a b'] } } } }, /locks/)
  bad({ suites: { s: { local: { cpus: 2 }, extra: 1 } } }, /unknown key "extra"/)
  for (const a of ['/abs', '../up', 'a/../b', 'sp ace', '$(x)', '', '-h', '--remove-files'])
    bad({ boat: { environment: 'e', remoteScript: 'r.sh', artifacts: [a] }, suites: { s: { local: { cpus: 2 } } } }, /boat\.artifacts/)
  bad({ boat: { environment: 'e', remoteScript: 'r.sh', artifacts: 'out' }, suites: { s: { local: { cpus: 2 } } } }, /boat\.artifacts/)
  const arts = parseRepoConfig({ boat: { environment: 'e', remoteScript: 'r.sh', artifacts: ['e2e/test-results', 'ci-broker-logs', 'ci-broker-logs'] }, suites: { s: { local: { cpus: 2 } } } }, '/r')
  assert.deepEqual(arts.boat!.artifacts, ['e2e/test-results', 'ci-broker-logs'])
  assert.equal(parseRepoConfig({ boat: { remoteScript: 'r.sh' }, suites: { s: { local: { cpus: 2 } } } }, '/r').boat!.pool, 'shared')
  assert.deepEqual(parseRepoConfig({ boat: { environment: 'acme', remoteScript: 'r.sh' }, suites: { s: { local: { cpus: 2 } } } }, '/r').boat, { pool: 'shared', remoteScript: 'r.sh', artifacts: [], extraRepos: [], maxWaitSec: 60, infraExitCodes: null }, 'the old environment key: read, ignored, the shared pool')
  assert.equal(parseRepoConfig({ boat: { pool: 'acme', remoteScript: 'r.sh' }, suites: { s: { local: { cpus: 2 } } } }, '/r').boat!.pool, 'acme')
  // the queue: repo and suite maxWaitSec (0 turns it off), within 0-900
  const mw = parseRepoConfig({ boat: { remoteScript: 'r.sh', maxWaitSec: 30 }, suites: { s: { local: { cpus: 2 }, boat: { shards: [{ name: 'a', args: [] }], maxWaitSec: 0 } } } }, '/r')
  assert.equal(mw.boat!.maxWaitSec, 30)
  assert.equal(mw.suites.s.boat!.maxWaitSec, 0)
  bad({ boat: { remoteScript: 'r.sh', maxWaitSec: 901 }, suites: { s: { local: { cpus: 2 } } } }, /boat\.maxWaitSec/)
  bad({ boat: { remoteScript: 'r.sh' }, suites: { s: { local: { cpus: 2 }, boat: { shards: [{ name: 'a', args: [] }], maxWaitSec: -1 } } } }, /maxWaitSec/)
  bad({ boat: { pool: 'acme', environment: 'e', remoteScript: 'r.sh' }, suites: { s: { local: { cpus: 2 } } } }, /pool or environment, not both/)
  const xr = (extraRepos: unknown) => ({ boat: { remoteScript: 'r.sh', extraRepos }, suites: { s: { local: { cpus: 2 } } } })
  assert.deepEqual(parseRepoConfig(xr([{ name: 'helper-service', repo: 'example-org/helper-service', ref: 'services/helper-service/package.json#helperSource.commit' }]), '/r').boat!.extraRepos,
    [{ name: 'helper-service', repo: 'example-org/helper-service', ref: { file: 'services/helper-service/package.json', key: ['helperSource', 'commit'] } }])
  assert.deepEqual(parseRepoConfig(xr([{ name: 'gw', repo: 'o/gw', ref: 'a'.repeat(40) }]), '/r').boat!.extraRepos[0].ref, { sha: 'a'.repeat(40) })
  bad(xr([{ name: 'Gw', repo: 'o/gw', ref: 'a'.repeat(40) }]), /extraRepos\[0\]\.name/)
  bad(xr([{ name: 'gw', repo: 'o/gw', ref: 'a'.repeat(40) }, { name: 'gw', repo: 'o/x', ref: 'a'.repeat(40) }]), /named twice/)
  bad(xr([{ name: 'gw', repo: 'gw', ref: 'a'.repeat(40) }]), /\.repo: must be a GitHub owner\/name/)
  bad(xr([{ name: 'gw', repo: 'o/gw', ref: 'main' }]), /\.ref: must be a 40-hex/)
  bad(xr([{ name: 'gw', repo: 'o/gw', ref: '../p.json#a' }]), /\.ref: must be a 40-hex/)
  bad(xr([{ name: 'gw', repo: 'o/gw', ref: 'p.json#a;b' }]), /\.ref: must be a 40-hex/)
  bad({ boat: { pool: 'Shared-1', remoteScript: 'r.sh' }, suites: { s: { local: { cpus: 2 } } } }, /boat\.pool/)
  const ok = parseRepoConfig({ boat: { environment: 'acme', remoteScript: '.test-broker/remote.sh' }, suites: { t: { local: { cpus: 4 }, boat: { shards: [{ name: 'u', args: ['unit'] }] } }, l: { local: { cpus: 1 }, boat: false } } }, '/r')
  assert.deepEqual(ok.suites.t.boat, { shards: [{ name: 'u', size: 'default', units: 2, memMb: 8192, args: ['unit'], passArgs: false }], maxSec: 3600, silentSec: null, maxWaitSec: null, avoidSlow: false })
  // units: 1 unit = 2 CPUs + 4 GB; from the size when not given; no size when only units are given
  const sh = (shard: unknown) => parseRepoConfig({ boat: { remoteScript: 'r.sh' }, suites: { t: { local: { cpus: 2 }, boat: { shards: [{ name: 'u', args: [], ...(shard as object) }] } } } }, '/r').suites.t.boat!.shards[0]
  assert.deepEqual([sh({ size: 'small' }).units, sh({ size: 'large' }).units, sh({}).units], [1, 4, 2])
  assert.deepEqual([sh({ units: 3 }).size, sh({ units: 3 }).units], [null, 3])
  assert.deepEqual([sh({ size: 'large', units: 2 }).size, sh({ size: 'large', units: 2 }).units], ['large', 2])
  const shBad = (shard: unknown, re: RegExp) => bad({ boat: { remoteScript: 'r.sh' }, suites: { t: { local: { cpus: 2 }, boat: { shards: [{ name: 'u', args: [], ...(shard as object) }] } } } }, re)
  shBad({ units: 0 }, /shards\[0\]\.units/)
  shBad({ units: 5 }, /shards\[0\]\.units/)
  shBad({ units: 1.5 }, /shards\[0\]\.units/)
  shBad({ size: 'default', units: 3 }, /do not fit a default box/)
  // memGb: the RAM, apart from the units (else 4 GB a unit)
  assert.deepEqual([sh({ units: 2 }).memMb, sh({ units: 2, memGb: 11 }).memMb, sh({ units: 1, memGb: 0.5 }).memMb], [8192, 11264, 512])
  shBad({ units: 2, memGb: 0 }, /shards\[0\]\.memGb/)
  shBad({ units: 2, memGb: 17 }, /shards\[0\]\.memGb/)
  shBad({ units: 2, memGb: '4' }, /shards\[0\]\.memGb/)
  shBad({ size: 'default', memGb: 9 }, /9 GB does not fit a default box/)
  assert.equal(ok.suites.t.local.minCpus, 4)
  assert.equal(ok.suites.l.boat, null)
  assert.deepEqual(ok.boat!.artifacts, [])
})

test('machine config: defaults and limits', () => {
  assert.equal(parseMachineConfig(undefined).budgetFactor, 1)
  assert.equal(parseMachineConfig({ boat: { maxBoxes: 4 } }).boat.maxBoxes, 4)
  assert.deepEqual(parseMachineConfig({ boat: { infraExitCodes: { 'Simple10/Acme': [89, 91] } } }).boat.infraExitCodes, { 'simple10/acme': [89, 91] })
  assert.throws(() => parseMachineConfig({ boat: { infraExitCodes: { acme: [91] } } }), MachineConfigError)
  assert.throws(() => parseMachineConfig({ boat: { infraExitCodes: { 'o/r': [0] } } }), MachineConfigError)
  assert.throws(() => parseMachineConfig({ boat: { maxBoxes: 99 } }), MachineConfigError)
  assert.throws(() => parseMachineConfig({ nope: 1 }), /unknown key "nope"/)
  assert.equal(parseMachineConfig(undefined).boat.packing, false)
  assert.equal(parseMachineConfig({ boat: { packing: true } }).boat.packing, true)
  assert.throws(() => parseMachineConfig({ boat: { packing: 'yes' } }), /boat\.packing/)
  assert.equal(parseMachineConfig(undefined).keepDays, 14)
  assert.equal(parseMachineConfig(undefined).compressAfterHours, 24)
  assert.equal(parseMachineConfig({ compressAfterHours: 2 }).compressAfterHours, 2)
  assert.throws(() => parseMachineConfig({ compressAfterHours: 0 }), /compressAfterHours/)
  assert.equal(parseMachineConfig(undefined).boat.shortIdleMin, 2)
  assert.equal(parseMachineConfig(undefined).boat.hintTtlMin, 60)
  assert.equal(parseMachineConfig({ boat: { shortIdleMin: 3, hintTtlMin: 30 } }).boat.shortIdleMin, 3)
  assert.throws(() => parseMachineConfig({ boat: { shortIdleMin: 0 } }), /shortIdleMin/)
  assert.equal(parseMachineConfig({ keepDays: 30, boat: { artifactsMaxMb: 50 } }).boat.artifactsMaxMb, 50)
  assert.throws(() => parseMachineConfig({ keepDays: 0 }), /keepDays/)
  assert.deepEqual(parseMachineConfig(undefined).boat.sizes, ['small', 'default', 'large', 'xlarge'])
  assert.deepEqual(parseMachineConfig({ boat: { sizes: ['default', 'default'] } }).boat.sizes, ['default'])
  assert.throws(() => parseMachineConfig({ boat: { sizes: ['huge'] } }), /boat\.sizes/)
  assert.throws(() => parseMachineConfig({ boat: { sizes: 'default' } }), /boat\.sizes/)
  assert.deepEqual(parseMachineConfig(undefined).boat.owners, [])
  assert.match(defaultHostId('Dev-Box_1.example.com', 'abc'), /^devbox1[0-9a-f]{4}$/)
  assert.notEqual(defaultHostId('dev', 'machine-a'), defaultHostId('dev', 'machine-b'), 'same hostname, different machines')
  assert.equal(defaultHostId('a-very-long-host-name-indeed', '').length, 11)
  assert.equal(defaultHostId('---', ''), '')
  assert.equal(parseMachineConfig({ boat: { hostId: 'vps2' } }).boat.hostId, 'vps2')
  assert.throws(() => parseMachineConfig({ boat: { hostId: 'Vps-2' } }), /boat\.hostId/)
  assert.deepEqual(parseMachineConfig({ boat: { owners: ['Simple10', 'simple10', 'octo-other'] } }).boat.owners, ['simple10', 'octo-other'])
  assert.throws(() => parseMachineConfig({ boat: { owners: ['a/b'] } }), /boat\.owners/)
})
