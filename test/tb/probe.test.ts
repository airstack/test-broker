import '../tmp-root.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import type { BoxProbeRow } from '../../src/tb/runs-db.ts'
import { parseProbe, probeCommand, probeFaults, probeScores } from '../../src/tb/probe.ts'
import { tmp } from '../harness.ts'

const NOW = Date.UTC(2026, 10, 27, 20, 0, 0)
const row = (box: string, t: number, cpu: number, disk = 1, o: Partial<BoxProbeRow> = {}): BoxProbeRow =>
  ({ t, box, size: 'large', secs: 5, cpu1: cpu, cpuN: cpu, write: disk, read: disk, repoSecs: null, repoMb: null, freeGb: 100, memMb: 14000, ioSome: 0, load1: 0, ok: true, faults: [], ...o })

test('the probe script runs here and reports every field; parseProbe reads it', () => {
  const home = tmp('tb-probe-home-')
  const out = execFileSync('bash', ['-c', probeCommand(2, 2)], { env: { ...process.env, HOME: home }, encoding: 'utf8' })
  const r = parseProbe(out)
  for (const k of ['cpu1', 'cpuN', 'write', 'read', 'freeGb', 'memMb', 'nproc'] as const) assert.equal(typeof r[k], 'number', `${k}: ${out}`)
  assert.equal(r.git, true)
  assert.deepEqual(r.errors, [])
  assert.deepEqual(probeFaults(r, 0), [])
})

test('probe faults: I/O errors, a full disk, git gone, unfinished CPU work; other errors do not charge', () => {
  const r = parseProbe('probe.cpu1 1\nprobe.cpuN 1\nprobe.git 0\nprobe.freeGb 1.5\nprobe.error repo read pack-1.pack: cat: Input/output error\nprobe.error something odd\n')
  assert.deepEqual(probeFaults(r, 3), ['repo read pack-1.pack: cat: Input/output error', 'disk nearly full: 1.5 GB free', 'git is not on PATH'])
  assert.deepEqual(probeFaults(parseProbe('probe.git 1\nprobe.freeGb 50\n'), 3), ['the probe did not finish its CPU work'])
})

test('probe scores: CPU against the other boxes of the size (median of the last 3), disk shown not scored', () => {
  const rows = ['a', 'b', 'c'].flatMap((b) => [1, 2, 3].map((i) => row(b, NOW - i * 600_000, 2)))
  rows.push(...[1, 2, 3].map((i) => row('d', NOW - i * 600_000, 3.2, 5)))
  // an old slow probe of a does not count (only its last 3), nor one of another size
  rows.push(row('a', NOW - 10 * 600_000, 9), row('x', NOW, 9, 1, { size: 'default' }))
  const s = probeScores(rows, NOW, 24)
  assert.deepEqual(s.get('d'), { score: 1.6, cpu: 1.6, disk: 5, probes: 3, last: NOW - 600_000 })
  assert.equal(s.get('a')!.score, 1)
  assert.equal(s.get('x'), undefined)
  // fewer than 2 other boxes: no score; probes out of the window do not count
  assert.equal(probeScores(rows.filter((r) => r.box === 'a' || r.box === 'd'), NOW, 24).size, 0)
  assert.equal(probeScores(rows, NOW + 48 * 3_600_000, 24).size, 0)
})
