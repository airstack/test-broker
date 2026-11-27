import '../tmp-root.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CliBoat, KEEP_OUT } from '../../src/core/boat.ts'

// A stub `boat` binary: logs its argv to calls.log and prints canned output per subcommand.
function stub(script: string): { bin: string; calls: () => string[] } {
  const d = mkdtempSync(join(tmpdir(), 'cib-boat-'))
  const bin = join(d, 'boat')
  writeFileSync(bin, `#!/usr/bin/env bash\necho "$*" >> ${d}/calls.log\n${script}\n`)
  chmodSync(bin, 0o755)
  return { bin, calls: () => readFileSync(join(d, 'calls.log'), 'utf8').trim().split('\n') }
}

test('list maps sandboxes and asks for every state', async () => {
  const s = stub(`echo '{"pageInfo":{},"sandboxes":[{"id":"bx_1","name":"cib-acme-large-abc123","state":"stopped","type":"large","environment":"acme","stoppedAt":"2026-11-03T03:31:15.042Z"}]}'`)
  const boxes = await new CliBoat(s.bin).list()
  assert.deepEqual(boxes, [{ id: 'bx_1', name: 'cib-acme-large-abc123', state: 'stopped', type: 'large', environment: 'acme', stoppedAt: Date.parse('2026-11-03T03:31:15.042Z') }])
  assert.match(s.calls()[0], /^list --all --json/)
})

test('starts reads the remaining day/hour/minute budget', async () => {
  const s = stub(`echo '{"starts":{"day":{"limit":200,"remaining":7,"used":193},"hour":{"remaining":50},"minute":{"remaining":12}}}'`)
  assert.deepEqual(await new CliBoat(s.bin).starts(), { day: 7, hour: 50, minute: 12, dayLimit: 200 })
})

test('create returns the id from the JSON stream and passes name/size/env/ttl', async () => {
  const s = stub(`echo 'Creating…'; echo '{"status":"creating"}'; echo '{"id":"bx_new","state":"ready"}'`)
  const id = await new CliBoat(s.bin).create({ name: 'cib-acme-default-x', size: 'default', environment: 'acme', ttlSec: 600 })
  assert.equal(id, 'bx_new')
  assert.match(s.calls()[0], /new --environment acme --type default --name cib-acme-default-x --ttl 600 --json/)
})

test('create with no id in the output throws', async () => {
  const s = stub(`echo '{"error":"no_ready_machine"}'; exit 1`)
  await assert.rejects(new CliBoat(s.bin).create({ name: 'n', size: 'large', environment: 'e', ttlSec: 1 }), /no_ready_machine/)
})

test('exec streams decoded data and returns the frame exit code', async () => {
  const s = stub(`echo '{"data":"line1\\n"}'; echo '{"data":"line2\\n"}'; echo '{"type":"exit","exitCode":4}'`)
  const seen: string[] = []
  const r = await new CliBoat(s.bin).exec('bx_1', 'echo hi', { onData: (d) => seen.push(d) })
  assert.equal(r.code, 4)
  assert.equal(r.out, 'line1\nline2\n')
  assert.equal(seen.join(''), 'line1\nline2\n')
  assert.match(s.calls()[0], /^exec bx_1 --timeout 0 -- bash -lc echo hi$/)
})

test('exec with no exit frame has no exit status (null: infra, retried), whatever the process exit code', async () => {
  for (const code of [0, 1, 255]) {
    const s = stub(`echo 'connection reset'; exit ${code}`)
    const r = await new CliBoat(s.bin).exec('bx_1', 'true')
    assert.equal(r.code, null, `process exit ${code}`)
  }
})

test('a failing resume throws with the output', async () => {
  const s = stub(`echo 'sandbox not found' >&2; exit 2`)
  await assert.rejects(new CliBoat(s.bin).resume('bx_9'), /sandbox not found/)
})

test('exec with an already-aborted signal kills the command at once', async () => {
  const s = stub(`exec sleep 20`)
  const ac = new AbortController()
  ac.abort()
  const t0 = Date.now()
  const r = await new CliBoat(s.bin).exec('bx_1', 'true', { signal: ac.signal })
  assert.ok(Date.now() - t0 < 3000)
  assert.notEqual(r.code, 0)
})

test('exec with timeoutSec gives up and returns 124', async () => {
  const s = stub(`exec sleep 20`)
  const t0 = Date.now()
  const r = await new CliBoat(s.bin).exec('bx_1', 'true', { timeoutSec: 0.3 })
  assert.equal(r.code, 124)
  assert.ok(Date.now() - t0 < 3000)
})

test('exec keeps only the tail of a long output, but streams all of it', async () => {
  // 48 data frames of 64 KiB (3 MiB), the last ending in END, then the exit frame
  const s = stub(`python3 -c 'import sys,json
for i in range(48): sys.stdout.write(json.dumps({"data": "x"*65536 + ("END" if i == 47 else "")})+"\\n")
sys.stdout.write(json.dumps({"type":"exit","exitCode":0})+"\\n")'`)
  let streamed = 0
  const r = await new CliBoat(s.bin).exec('bx_1', 'true', { onData: (d) => (streamed += d.length) })
  assert.equal(r.code, 0)
  assert.equal(streamed, 48 * 65536 + 3)
  assert.ok(r.out.length <= KEEP_OUT, `kept ${r.out.length}`)
  assert.ok(r.out.endsWith('END'))
})
