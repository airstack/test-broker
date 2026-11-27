// pnpm test:root: the root scripts (install.sh, runnerctl, runner-start, the units) as root in a throwaway
// container (no sudo: the docker group). Fixtures: the working tree as a tarball, a real node tarball, fake gh/boat
// and runner tarballs with their hashes (a test copy of the pins). test/ci/docker-root/all.sh does the work and prints
// ok/FAIL lines; each section becomes a test here. Not part of `pnpm test`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from "node:path"
import { dockerSkip } from '../../docker.ts'

const REPO = join(import.meta.dirname, '..', '..', '..')
const IMAGE = 'cib-root-test:2'
const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex')
const sh = (cmd: string) => execFileSync('bash', ['-c', cmd], { stdio: ['ignore', 'pipe', 'inherit'] })

const workDirs: string[] = []
function fixtures(): string {
  const fx = mkdtempSync(join(tmpdir(), 'cib-rootfx-'))
  const work = mkdtempSync(join(tmpdir(), 'cib-rootw-'))
  workDirs.push(work)
  sh(`cd ${REPO} && git ls-files -co --exclude-standard -z | tar --null -T - -cf ${fx}/src.tar`)
  mkdirSync(join(work, 'node-v26.13.0-linux-x64', 'bin'), { recursive: true })
  copyFileSync(process.execPath, join(work, 'node-v26.13.0-linux-x64', 'bin', 'node'))
  sh(`cd ${work} && tar -cf - node-v26.13.0-linux-x64 | xz -0 -T0 > ${fx}/node.tar.xz`)
  const F = join(REPO, 'test', 'ci', 'docker-root', 'fakes')
  mkdirSync(join(work, 'gh_2.103.3_linux_amd64', 'bin'), { recursive: true })
  copyFileSync(join(F, 'gh'), join(work, 'gh_2.103.3_linux_amd64', 'bin', 'gh'))
  chmodSync(join(work, 'gh_2.103.3_linux_amd64', 'bin', 'gh'), 0o755)
  sh(`cd ${work} && tar -czf ${fx}/gh.tar.gz gh_2.103.3_linux_amd64`)
  copyFileSync(join(F, 'boat'), join(fx, 'boat'))
  mkdirSync(join(work, 'runner'))
  for (const f of ['config.sh', 'run.sh']) copyFileSync(join(F, f), join(work, 'runner', f))
  sh(`cd ${work}/runner && chmod 0755 *.sh && tar -czf ${fx}/runner.tgz config.sh run.sh`)
  writeFileSync(join(fx, 'pins.env'), `NODE_SHA=${sha(join(fx, 'node.tar.xz'))}\nGH_SHA=${sha(join(fx, 'gh.tar.gz'))}\nBOAT_SHA=${sha(join(fx, 'boat'))}\nRUNNER_SHA=${sha(join(fx, 'runner.tgz'))}\n`)
  sh(`chmod -R a+rX ${fx}`)
  return fx
}

const skip = dockerSkip()
if (skip) test('root tests', { skip }, () => {})
else {
  const haveImage = () => spawnSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' }).status === 0
  if (!haveImage()) sh(`docker build -q -t ${IMAGE} ${join(REPO, 'test', 'ci', 'docker-root')}`)

  const fx = fixtures()
  // CIB_ROOT_KEEP=1 keeps the fixtures (debugging: docker run … -v <fx>:/fx:ro cib-root-test:2 bash)
  if (process.env.CIB_ROOT_KEEP) console.error(`fixtures kept in ${fx}`)
  else process.on('exit', () => spawnSync('rm', ['-rf', fx, ...workDirs], { stdio: 'ignore' }))
  const r = spawnSync('docker', ['run', '--rm', '-v', `${REPO}:/src:ro`, '-v', `${fx}:/fx:ro`, IMAGE, 'bash', '/src/test/ci/docker-root/all.sh'], { encoding: 'utf8', maxBuffer: 1 << 26, timeout: 900_000 })
  const lines = r.stdout.split('\n').filter((l) => /^(ok|FAIL) /.test(l))
  const sections = [...new Set(lines.map((l) => l.split(' ')[1].replace(/:$/, '')))]

  test('the container ran to the end', () => {
    assert.ok(r.stdout.includes('\nDONE'), `no DONE:\n${r.stdout.slice(-3000)}\n${r.stderr.slice(-2000)}`)
  })
  for (const s of sections)
    test(`root: ${s}`, () => {
      const mine = lines.filter((l) => l.split(' ')[1].replace(/:$/, '') === s)
      const bad = mine.filter((l) => l.startsWith('FAIL '))
      assert.deepEqual(bad, [], mine.join('\n'))
    })
  test('shellcheck: every root script and bin wrapper', () => {
    const files = ['ci/scripts/install.sh', 'ci/scripts/ci-broker-runnerctl', 'ci/scripts/runner-start', 'ci/scripts/pub-net-rules', 'ci/scripts/install-conf-reader.sh', 'bin/ci-broker', 'bin/ci-brokerd', 'bin/cib-admit.sh', 'test/ci/docker-root/all.sh', ...['systemctl', 'curl', 'docker', 'gh', 'boat', 'config.sh', 'run.sh'].map((f) => `test/ci/docker-root/fakes/${f}`)]
    const s = spawnSync('docker', ['run', '--rm', '-v', `${REPO}:/m:ro`, '-w', '/m', 'koalaman/shellcheck:stable', '-s', 'bash', '-S', 'warning', ...files], { encoding: 'utf8' })
    assert.equal(s.status, 0, s.stdout + s.stderr)
  })
}
