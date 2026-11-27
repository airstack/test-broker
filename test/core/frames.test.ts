import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newFrameState, parseFrames } from '../../src/core/frames.ts'

test('data frames become output', () => {
  const s = newFrameState()
  assert.equal(parseFrames('{"data":"hello "}\n{"data":"world"}\n', s).out, 'hello world')
})

test('an exit frame sets the exit code', () => {
  const s = newFrameState()
  parseFrames('{"type":"exit","exitCode":3}\n', s)
  assert.equal(s.exitCode, 3)
})

test('a one-shot stdout+exitCode frame', () => {
  const s = newFrameState()
  assert.equal(parseFrames('{"stdout":"a","stderr":"b","exitCode":0}\n', s).out, 'ab')
  assert.equal(s.exitCode, 0)
})

test('a JSON line split across chunks parses once', () => {
  const s = newFrameState()
  const a = parseFrames('{"da', s).out
  const b = parseFrames('ta":"x"}\n', s).out
  assert.equal(a + b, 'x')
})

test('non-JSON lines pass through; error frames are reported', () => {
  const s = newFrameState()
  assert.equal(parseFrames('plain\n{"error":"boom"}\n', s).out, 'plain\n[boat] boom\n')
  assert.equal(s.exitCode, undefined)
})

test('flush returns a trailing partial line', () => {
  const s = newFrameState()
  parseFrames('tail-no-newline', s)
  assert.equal(parseFrames('', s, true).out, 'tail-no-newline')
})
