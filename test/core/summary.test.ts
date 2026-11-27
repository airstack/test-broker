import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { summarize, type ShardResult } from '../../src/core/summary.ts'

const fx = (n: string) => readFileSync(new URL(`../fixtures/${n}`, import.meta.url), 'utf8')
const r = (o: Partial<ShardResult>): ShardResult => ({ name: 's', size: 'default', where: 'boat', code: 0, secs: 10, log: '', ...o })

test('a passing vitest shard: PASS with totals and the HEAD line', () => {
  const s = summarize([r({ name: 'api-1', log: fx('vitest-pass.log') })])
  assert.equal(s.pass, true)
  assert.match(s.text, /PASS\s+api-1/)
  assert.match(s.text, /Tests 1397 passed \(1397\)/)
  assert.match(s.text, /HEAD: 105635ec/)
  assert.match(s.text, /RESULT: PASS/)
  assert.equal(s.json.shards[0].totals, 'Tests 1397 passed (1397)')
})

test('a Playwright failure: FAIL with the failing test names in the excerpt', () => {
  const s = summarize([r({ name: 'e2e', size: 'large', code: 1, log: fx('playwright-fail.log') })])
  assert.equal(s.pass, false)
  assert.match(s.text, /3 failed/)
  assert.match(s.text, /signup\.spec\.ts:35:3/)
  assert.match(s.text, /RESULT: FAIL/)
  assert.match(s.markdown, /<details>/)
})

test('an unfetchable ref: FAIL and the reason is in the excerpt', () => {
  const s = summarize([r({ name: 'cmd', code: 91, log: fx('fetch-fail.log') })])
  assert.equal(s.pass, false)
  assert.match(s.text, /cannot fetch ref d9168dfc6/)
})

test('a missing result (null code) is a FAIL with its reason, even next to passes', () => {
  const s = summarize([r({ name: 'a' }), r({ name: 'b', code: null, reason: 'lease lost' })])
  assert.equal(s.pass, false)
  assert.match(s.text, /FAIL\s+b.*lease lost/)
})

test('no shards at all is a FAIL', () => {
  assert.equal(summarize([]).pass, false)
})

// ---------------------------------------------------------------- the one-line reason of a failed shard

test('a Playwright failure: the reason counts the failing tests and names them (flaky ones are not failures)', () => {
  const s = summarize([r({ name: 'e2e', size: 'large', code: 1, log: fx('playwright-fail.log') })])
  const reason = s.json.shards[0].reason!
  assert.match(reason, /^3 Playwright tests failed: /)
  assert.match(reason, /tests\/browser\/signup\.spec\.ts:35:3 sign up → confirm email/)
  assert.match(reason, /tests\/browser\/dashboard-smoke\.spec\.ts:14:3 dashboard mounts/)
  assert.match(reason, /tests\/browser\/editor\.spec\.ts:90:3 /)
  assert.doesNotMatch(reason, /editor\.spec\.ts:114:3/, 'a flaky test is not a failure')
  assert.doesNotMatch(reason, /\n/)
  assert.match(s.text, /FAIL\s+e2e.*\(3 Playwright tests failed/)
})

test('a Playwright failure with many failing tests: the first few, then how many more', () => {
  const tests = Array.from({ length: 8 }, (_, i) => `    [chromium] › tests/t${i}.spec.ts:1:1 › suite › test ${i} `)
  const log = ['  8 failed', ...tests, '  2 passed (1.0m)', ''].join('\n')
  const reason = summarize([r({ code: 1, log })]).json.shards[0].reason!
  assert.match(reason, /^8 Playwright tests failed: tests\/t0\.spec\.ts:1:1 test 0, /)
  assert.match(reason, /tests\/t4\.spec\.ts:1:1 test 4, \+3 more$/)
})

test('a stack that never became healthy: the reason is that line and where the collected dev-stack log is', () => {
  const s = summarize([r({ name: 'e2e-1', size: 'large', code: 1, log: fx('e2e-stack-unhealthy.log') })])
  const reason = s.json.shards[0].reason!
  assert.match(reason, /^the stack did not become healthy at http:\/\/localhost:8700/)
  assert.match(reason, /artifacts\/e2e-1\/ci-broker-logs\/test-e2e-dev\.log/)
})

test('a vitest failure: the reason is the failing packages, else the Tests line', () => {
  assert.equal(summarize([r({ code: 1, log: fx('vitest-fail.log') })]).json.shards[0].reason, 'vitest: Tests 2 failed | 2 passed (4)')
  const log = 'x\n Test Files  1 failed (1)\n      Tests  1 failed (1)\n\nFAILED int packages: packages/api packages/web\n'
  assert.equal(summarize([r({ code: 1, log })]).json.shards[0].reason, 'FAILED int packages: packages/api packages/web')
})

test('any other failure: the reason is the phase it failed in and its last output line', () => {
  const s = summarize([r({ name: 'cmd', code: 91, log: fx('fetch-fail.log') })])
  assert.equal(s.json.shards[0].reason, 'exit 91 in "checkout d9168dfc6": cannot fetch ref d9168dfc6 from origin')
})

test('a reason the daemon gave wins; a passing shard has none', () => {
  const s = summarize([r({ name: 'a' }), r({ name: 'b', code: null, reason: 'lease lost', log: fx('playwright-fail.log') })])
  assert.equal(s.json.shards[0].reason, null)
  assert.equal(s.json.shards[1].reason, 'lease lost')
})
