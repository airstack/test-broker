// Box probes: a short, fixed speed and health check that test-brokerd runs on idle Boat
// boxes (never on a stopped one: that would cost a start). The same work on every box, so boxes compare directly,
// unlike shard times (other args, other shards on the box). It also finds a box fault before a test run does: an
// I/O error reading the repo clone, a full disk, git gone.
import type { BoxProbeRow } from './runs-db.ts'

/** what a probe measured; secs are wall-clock seconds for fixed work */
export type ProbeResult = {
  cpu1: number | null; cpuN: number | null; write: number | null; read: number | null
  repoSecs: number | null; repoMb: number | null; freeGb: number | null; memMb: number | null; ioSome: number | null; nproc: number | null; load1: number | null
  git: boolean; errors: string[]
}

const DIR = '"$HOME/cib/.probe"'

/**
 * The probe script. cpuMb: the bytes hashed per core (sha256 of zeros: one core, then every core at once); diskMb:
 * written then read back with the page cache skipped where the filesystem allows it. Each pack file of the box's repo
 * clones is read once (health: an I/O error there broke a run on 2026-11-27). It runs in its own session so
 * probeKillCommand can stop it. Prints `probe.<key> <value>` lines.
 */
export function probeCommand(cpuMb: number, diskMb: number): string {
  const inner = `
set -u
d=${DIR}
mkdir -p "$d" || { echo "probe.error cannot make $d"; exit 0; }
echo $$ > "$d/pid"
now() { date +%s.%N; }
since() { awk -v a="$1" -v b="$(now)" 'BEGIN { printf "%.3f", b - a }'; }
err() { echo "probe.error $*"; }
n=$(nproc 2>/dev/null || echo 1)
echo "probe.nproc $n"
echo "probe.load1 $(cut -d' ' -f1 /proc/loadavg 2>/dev/null)"
t=$(now); head -c ${cpuMb}M /dev/zero | sha256sum >/dev/null; echo "probe.cpu1 $(since "$t")"
t=$(now); for i in $(seq "$n"); do head -c ${cpuMb}M /dev/zero | sha256sum >/dev/null & done; wait; echo "probe.cpuN $(since "$t")"
f="$d/disk"
t=$(now)
if dd if=/dev/zero of="$f" bs=1M count=${diskMb} oflag=direct conv=fsync status=none 2>"$d/dd.err" || dd if=/dev/zero of="$f" bs=1M count=${diskMb} conv=fsync status=none 2>"$d/dd.err"; then
  echo "probe.write $(since "$t")"
  t=$(now)
  if dd if="$f" of=/dev/null bs=1M iflag=direct status=none 2>/dev/null || dd if="$f" of=/dev/null bs=1M status=none 2>"$d/dd.err"; then echo "probe.read $(since "$t")"; else err "disk read: $(head -c 200 "$d/dd.err")"; fi
else err "disk write: $(head -c 200 "$d/dd.err")"; fi
rm -f "$f"
bytes=0
t=$(now)
for p in "$HOME"/cib/repos/*/.git/objects/pack/*.pack; do
  [ -f "$p" ] || continue
  if ! timeout 60 cat "$p" >/dev/null 2>"$d/cat.err"; then err "repo read $(basename "$p"): $(head -c 200 "$d/cat.err")"; break; fi
  bytes=$((bytes + $(stat -c %s "$p")))
done
[ "$bytes" -gt 0 ] && { echo "probe.repoSecs $(since "$t")"; echo "probe.repoMb $((bytes / 1048576))"; }
echo "probe.freeGb $(df -Pk "$HOME" | awk 'NR == 2 { printf "%.1f", $4 / 1048576 }')"
echo "probe.memMb $(awk '/^MemAvailable:/ { printf "%d", $2 / 1024 }' /proc/meminfo 2>/dev/null)"
echo "probe.ioSome $(awk '/^some/ { sub("avg10=", "", $2); print $2 }' /proc/pressure/io 2>/dev/null)"
command -v git >/dev/null && echo "probe.git 1" || echo "probe.git 0"
rm -f "$d/pid"
`
  return `exec setsid -w bash -c ${shq(inner)}`
}

/** stop a running probe (its session) and remove its scratch file; never fails */
export const probeKillCommand = () => `p=$(cat ${DIR}/pid 2>/dev/null) && kill -TERM -- -"$p" 2>/dev/null; rm -f ${DIR}/disk ${DIR}/pid; true`

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

export function parseProbe(out: string): ProbeResult {
  const r: ProbeResult = { cpu1: null, cpuN: null, write: null, read: null, repoSecs: null, repoMb: null, freeGb: null, memMb: null, ioSome: null, nproc: null, load1: null, git: false, errors: [] }
  for (const line of out.split('\n')) {
    const m = /^probe\.(\w+) ?(.*)$/.exec(line.trim())
    if (!m) continue
    const [, k, v] = m
    if (k === 'error') r.errors.push(v.slice(0, 300))
    else if (k === 'git') r.git = v === '1'
    else if (k in r) {
      const n = Number(v)
      if (v !== '' && Number.isFinite(n)) (r as Record<string, unknown>)[k] = n
    }
  }
  return r
}

/** the faults in a probe that charge the box (infra failures: infraFailLimit in a row quarantines it) */
export function probeFaults(r: ProbeResult, minFreeGb: number): string[] {
  const f: string[] = []
  for (const e of r.errors) if (/input\/output error|read-only file system|no space left/i.test(e) || /^disk (write|read)/.test(e)) f.push(e)
  if (r.freeGb != null && r.freeGb < minFreeGb) f.push(`disk nearly full: ${r.freeGb} GB free`)
  if (!r.git) f.push('git is not on PATH')
  if (r.cpu1 == null || r.cpuN == null) f.push('the probe did not finish its CPU work')
  return f
}

export type ProbeScore = { score: number; cpu: number; disk: number; probes: number; last: number }

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y)
  const n = s.length
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2
}

/**
 * Each box's probe score at `now`: the median of its last 3 clean probes (CPU = one core + every core; disk = write +
 * read), each ÷ the median over the other boxes of their size that probed in the last ageHours (2 boxes or more).
 * The score is the CPU ratio: disk times on Boat follow how far a resumed box's disk has hydrated (lazily, from
 * remote storage), so they are shown, not scored. A box with one probe gets a score too (probes says how many).
 */
export function probeScores(rows: BoxProbeRow[], now: number, ageHours: number): Map<string, ProbeScore> {
  const from = now - ageHours * 3_600_000
  const byBox = new Map<string, BoxProbeRow[]>()
  for (const r of rows) {
    if (r.t < from || r.t > now || r.cpu1 == null || r.cpuN == null || r.write == null || r.read == null) continue
    let a = byBox.get(r.box)
    if (!a) byBox.set(r.box, (a = []))
    a.push(r)
  }
  const per = new Map<string, { size: string; cpu: number; disk: number; probes: number; last: number }>()
  for (const [box, a] of byBox) {
    const l = a.sort((x, y) => x.t - y.t).slice(-3)
    per.set(box, { size: l[l.length - 1].size, cpu: median(l.map((x) => x.cpu1! + x.cpuN!)), disk: median(l.map((x) => x.write! + x.read!)), probes: l.length, last: l[l.length - 1].t })
  }
  const out = new Map<string, ProbeScore>()
  for (const [box, p] of per) {
    const others = [...per].filter(([b, x]) => b !== box && x.size === p.size).map(([, x]) => x)
    if (others.length < 2) continue
    const cpu = p.cpu / median(others.map((x) => x.cpu))
    const disk = p.disk / median(others.map((x) => x.disk))
    const r2 = (x: number) => Math.round(x * 100) / 100
    out.set(box, { score: r2(cpu), cpu: r2(cpu), disk: r2(disk), probes: p.probes, last: p.last })
  }
  return out
}
