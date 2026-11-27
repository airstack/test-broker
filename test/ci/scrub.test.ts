import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lineScrubber, scrubText } from '../../src/ci/daemon/scrub.ts'

const TOKEN = 'ghp_' + 'A'.repeat(36)

test('known secrets and GitHub token shapes become ***', () => {
  assert.equal(scrubText(`a ${TOKEN} b`, []), 'a *** b')
  assert.equal(scrubText('x github_pat_11ABCDEFG0123456789_abcdefghijkl y', []), 'x *** y')
  assert.equal(scrubText('pass=hunter2secret', ['hunter2secret']), 'pass=***')
})

test('line-buffered: a token split across chunks is still caught; partial lines wait for their newline', () => {
  const out: string[] = []
  const s = lineScrubber(() => ['s3cr3tvalue'], (l) => out.push(l))
  s.write(`one ${TOKEN.slice(0, 10)}`)
  assert.deepEqual(out, [])
  s.write(`${TOKEN.slice(10)} two\nthree s3cr`)
  s.write('3tvalue')
  s.flush()
  assert.deepEqual(out, ['one *** two\n', 'three ***\n'])
})

test('a runaway line cut in pieces never splits a secret or a token across the cut', () => {
  const secret = 'S3CRET-' + 'q'.repeat(40)
  for (const [value, secrets] of [[secret, [secret]], [TOKEN, []]] as [string, string[]][]) {
    for (const shift of [0, 5, 20, value.length - 1]) {
      const out: string[] = []
      const s = lineScrubber(() => secrets, (l) => out.push(l))
      // the value straddles the old cut point (512 chars before the end of the buffer)
      const total = 64 * 1024 + 100
      const at = total - 512 - shift
      s.write('x'.repeat(at) + value + '.'.repeat(total - at - value.length))
      s.write(' more\n')
      s.flush()
      const all = out.join('')
      assert.ok(out.length >= 2, 'the runaway line was cut')
      assert.ok(!all.includes(value.slice(0, 12)) && !all.includes(value.slice(-12)), `no half of the value leaks (shift ${shift})`)
      assert.ok(all.includes('***'))
      assert.equal(all.replace('***', value).length, total + ' more\n'.length)
    }
  }
})
