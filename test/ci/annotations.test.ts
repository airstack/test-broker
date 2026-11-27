import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { errorCommand, escapeData, escapeProperty, parseFailures, stripAnsi } from '../../src/ci/client/annotations.ts'

const fx = (n: string) => readFileSync(new URL(`../fixtures/${n}`, import.meta.url), 'utf8')

test('escaping: data escapes % CR LF; properties also : and ,', () => {
  assert.equal(escapeData('100% done\r\nnext: a, b'), '100%25 done%0D%0Anext: a, b')
  assert.equal(escapeProperty('100% done\r\nnext: a, b'), '100%25 done%0D%0Anext%3A a%2C b')
  // % first, so an escape already in the text is not decoded by the runner
  assert.equal(escapeData('%0A'), '%250A')
})

test('errorCommand: file, line, col, a shard-tagged title; message = name + first error line', () => {
  const cmd = errorCommand({ shard: 'unit', tool: 'vitest', file: 'src/a,b.ts', line: 5, col: 19, title: 'x > y: z', message: 'Error: 50% off\nmore' })
  assert.equal(cmd, '::error file=src/a%2Cb.ts,line=5,col=19,title=[unit] x > y%3A z::x > y: z%0AError: 50%25 off%0Amore')
  assert.equal(errorCommand({ shard: 's', tool: 'vitest', file: null, line: null, col: null, title: 't', message: null }), '::error title=[s] t::t')
})

test('vitest: FAIL lines with the project tag, the place from the ❯ line under each, the first error line', () => {
  const f = parseFailures('unit', fx('vitest-fail.log'))
  assert.deepEqual(
    f.map((x) => [x.file, x.line, x.col, x.title, x.message]),
    [
      ['src/math.unit.test.ts', 5, 19, 'math > subtracts', 'AssertionError: expected 1 to be 2 // Object.is equality'],
      ['src/math.unit.test.ts', 8, 47, 'math > nested > divides, by zero: "x"', 'Error: boom: bad'],
    ],
  )
  assert.ok(f.every((x) => x.tool === 'vitest' && x.shard === 'unit'))
})

test('vitest: × lines count when no FAIL line names the test (a cut-off log), under the file line above them', () => {
  const log = fx('vitest-fail.log').split('Failed Tests')[0] // the per-file list only
  const f = parseFailures('unit', log)
  assert.deepEqual(f.map((x) => [x.file, x.line, x.title]), [
    ['src/math.unit.test.ts', null, 'subtracts'],
    ['src/math.unit.test.ts', null, 'divides, by zero: "x"'],
  ])
})

test('ANSI colours and CRs are stripped before parsing', () => {
  const log = '\x1b[31m\x1b[1m FAIL \x1b[22m\x1b[39m \x1b[2msrc/\x1b[22ma.test.ts\x1b[2m > \x1b[22msuite\x1b[2m > \x1b[22mworks\r\n\x1b[31mError: nope\x1b[39m\r\n \x1b[36m❯\x1b[39m src/a.test.ts:3:7\n'
  assert.equal(stripAnsi('\x1b]8;;http://x\x07link\x1b]8;;\x07 \x1b[?25l'), 'link ')
  assert.deepEqual(parseFailures('s', log).map((x) => [x.file, x.line, x.col, x.title, x.message]), [['src/a.test.ts', 3, 7, 'suite > works', 'Error: nope']])
})

test('Playwright: ✘ lines, retries folded, flaky (passed on retry) dropped, repo path from the stack, first error line', () => {
  const f = parseFailures('e2e', fx('playwright-fail.log'), 'example-org/app')
  // the log's own summary: 3 failed, 3 flaky
  assert.equal(f.length, 3)
  assert.deepEqual(f[0], {
    shard: 'e2e', tool: 'playwright', file: 'e2e/tests/browser/signup.spec.ts', line: 35, col: 3,
    title: '@core browser — sign up and sign in › sign up → confirm email → dashboard; sign in again',
    message: 'Error: expect(locator).toBeVisible() failed',
  })
  assert.deepEqual(f.map((x) => `${x.file}:${x.line}`), ['e2e/tests/browser/signup.spec.ts:35', 'e2e/tests/browser/editor.spec.ts:90', 'e2e/tests/browser/dashboard-smoke.spec.ts:14'])
  // without the repo the path stays as printed (relative to Playwright's testDir)
  assert.equal(parseFailures('e2e', fx('playwright-fail.log'))[0].file, 'tests/browser/signup.spec.ts')
})

test('logs without test failures give none', () => {
  assert.deepEqual(parseFailures('s', fx('vitest-pass.log')), [])
  assert.deepEqual(parseFailures('s', fx('fetch-fail.log')), [])
})
