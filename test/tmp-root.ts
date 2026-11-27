// Imported first by every test file that makes temp dirs (the harness imports it too).
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// one temp root per test process (os.tmpdir() reads TMPDIR), removed at exit: the suite leaves nothing in /tmp
if (!process.env.CIB_TEST_TMP) {
  const root = mkdtempSync(join(tmpdir(), 'cib-run-'))
  process.env.CIB_TEST_TMP = root
  process.env.TMPDIR = root
  process.on('exit', () => {
    try {
      execFileSync('chmod', ['-R', 'u+rwX', root], { stdio: 'ignore' })
    } catch {}
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {}
  })
}
