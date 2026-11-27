// Which docker the tests can use. Rootless docker maps container uids to other host uids (container root is the
// user; `--user <uid>` is a subuid), so tests of ci-broker's file-ownership rules do not hold there: they skip.
import { spawnSync } from 'node:child_process'

export function dockerSkip(): string | false {
  const r = spawnSync('docker', ['info', '--format', '{{json .SecurityOptions}}'], { encoding: 'utf8' })
  if (r.status !== 0) return 'no docker'
  if (r.stdout.includes('rootless')) return 'rootless docker (container uids are not host uids)'
  return false
}
