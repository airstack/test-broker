// A fake ssh + scp for tests: real bash scripts in <root>/bin. Each host is a directory <root>/hosts/<host> used as
// HOME; `ssh <opts> <host> <cmd>` runs the command there with real bash (stdin passed through, so the wrapper's token
// line and its process-group kill are real). A host with <root>/<host>.down is unreachable: exit 255 like ssh.
// `sudo` on a fake host works iff <root>/<host>.sudo exists. Every call's argv is logged (to assert no token in argv).
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type FakeSsh = {
  root: string
  ssh: string
  scp: string
  home: (host: string) => string
  /** every ssh/scp call's argv, e.g. ['ssh', '-o', 'BatchMode=yes', …] */
  calls: () => string[][]
  down: (host: string, isDown?: boolean) => void
  sudo: (host: string, works: boolean) => void
}

export function makeFakeSsh(root: string): FakeSsh {
  const bin = join(root, 'bin')
  const hostBin = join(root, 'hostbin')
  mkdirSync(bin, { recursive: true })
  mkdirSync(hostBin, { recursive: true })
  mkdirSync(join(root, 'hosts'), { recursive: true })
  const log = join(root, 'calls.log')
  const R = JSON.stringify(root)
  const record = `{ printf '%s\\x1f' "$(basename "$0")" "$@"; printf '\\x1e'; } >> ${JSON.stringify(log)}`
  writeFileSync(
    join(bin, 'ssh'),
    `#!/usr/bin/env bash
root=${R}
${record}
while [ $# -gt 0 ]; do case "$1" in -o|-p|-i|-F) shift 2 ;; -*) shift ;; *) break ;; esac; done
host="$1"; shift
if [ -e "$root/$host.down" ]; then echo "ssh: connect to host $host port 22: Connection refused" >&2; exit 255; fi
mkdir -p "$root/hosts/$host"
cd "$root/hosts/$host" || exit 255
export HOME="$root/hosts/$host" PATH="$root/hostbin:$PATH" FAKE_SSH_HOST="$host"
exec bash -c "$*"
`,
  )
  writeFileSync(
    join(bin, 'scp'),
    `#!/usr/bin/env bash
root=${R}
${record}
args=()
while [ $# -gt 0 ]; do case "$1" in -o|-P|-i|-F) shift 2 ;; -*) shift ;; *) args+=("$1"); shift ;; esac; done
out=()
for a in "\${args[@]}"; do
  case "$a" in
    *:*) h="\${a%%:*}"; p="\${a#*:}"
         if [ -e "$root/$h.down" ]; then echo "ssh: connect to host $h port 22: Connection refused" >&2; exit 255; fi
         case "$p" in /*) out+=("$root/hosts/$h$p") ;; *) out+=("$root/hosts/$h/$p") ;; esac ;;
    *) out+=("$a") ;;
  esac
done
n=\${#out[@]}
dest="\${out[$((n-1))]}"
for ((i=0; i<n-1; i++)); do cp "\${out[$i]}" "$dest" || exit 1; done
`,
  )
  writeFileSync(join(hostBin, 'sudo'), `#!/usr/bin/env bash\n[ -e ${R}/"$FAKE_SSH_HOST.sudo" ] || { echo "sudo: a password is required" >&2; exit 1; }\nshift; [ "$1" = true ] && exit 0; exit 0\n`)
  for (const f of [join(bin, 'ssh'), join(bin, 'scp'), join(hostBin, 'sudo')]) chmodSync(f, 0o755)
  return {
    root,
    ssh: join(bin, 'ssh'),
    scp: join(bin, 'scp'),
    home: (host) => {
      const h = join(root, 'hosts', host)
      mkdirSync(h, { recursive: true })
      return h
    },
    calls: () =>
      existsSync(log)
        ? readFileSync(log, 'utf8')
            .split('\x1e')
            .filter(Boolean)
            .map((r) => r.split('\x1f').slice(0, -1))
        : [],
    down: (host, isDown = true) => (isDown ? writeFileSync(join(root, `${host}.down`), '') : rmSync(join(root, `${host}.down`), { force: true })),
    sudo: (host, works) => (works ? writeFileSync(join(root, `${host}.sudo`), '') : rmSync(join(root, `${host}.sudo`), { force: true })),
  }
}
