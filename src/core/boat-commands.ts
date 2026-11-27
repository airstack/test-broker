// The shell commands a broker runs on a Boat box: run a shard through the wrapper (wrap/cib-wrap.sh), kill a slot,
// probe the box's clone before a seed, tar the artifacts. Pure string builders, shared by test-broker and ci-brokerd.
import { repoDir } from './mirror.ts'
import { q } from './shell.ts'

/** The command that runs a shard: env + the wrapper. Boat runs pass noFsync (CIB_NOFSYNC=1). */
export function remoteCommand(o: { slot: number; repo: string; sha: string; base: string | null; bundle: boolean; args: string[]; tokenLine?: boolean; noFsync?: boolean; seed?: boolean; defaultBranch?: string; extras?: string[]; attempt?: string; fence?: string[]; share?: SlotShare }): string {
  const env = [
    // test-broker: this attempt's id, fenced by a kill so a late exec never runs
    ...(o.attempt ? [`CIB_ATTEMPT=${q(o.attempt)}`] : []),
    // earlier attempts the broker lost on this slot: fenced on the box before this one starts
    ...(o.fence?.length ? [`CIB_FENCE=${q(o.fence.join(' '))}`] : []),
    // test-broker with boat.packing: the slot's share of the box
    ...(o.share ? [`CIB_UNITS=${o.share.units}`, `CIB_CPUS=${o.share.cpus}`, `CIB_CPUSET=${q(o.share.cpuset)}`, `CIB_MEM_MB=${o.share.memMb}`] : []),
    // test-broker: extra repos' bundles, one variable each (CIB_EXTRA_HELPER_SERVICE for helper-service)
    ...(o.extras ?? []).map((n) => `CIB_EXTRA_${n.toUpperCase().replace(/-/g, '_')}="$HOME/cib/extra/${n}.bundle"`),
    // test-broker: the wrapper seeds ~/cib/repos/<repo> from this bundle first, and moves the default branch to the base
    ...(o.seed ? [`CIB_SEED="$HOME/cib/${o.slot}/seed.bundle"`] : []),
    ...(o.defaultBranch ? [`CIB_DEFAULT_BRANCH=${q(o.defaultBranch)}`] : []),
    `CIB_REPO=${q(o.repo)}`, `CIB_SHA=${q(o.sha)}`, `CIB_SLOT=${o.slot}`, `CIB_BASE=${q(o.base ?? '')}`,
    `CIB_BUNDLE=${o.bundle ? `"$HOME/cib/${o.slot}/snapshot.bundle"` : "''"}`, `CIB_TOKEN_LINE=${o.tokenLine ? 1 : 0}`,
    // Boat disks flush slowly: Boat runs turn fsync off
    `CIB_NOFSYNC=${o.noFsync ? 1 : 0}`,
  ]
  return `${env.join(' ')} bash "$HOME/cib/${o.slot}/cib-wrap.sh" ${[o.sha, ...o.args].map(q).join(' ')}`
}

/** What the box's clone of `repo` needs before a run at `base`: `has` (base is there), `none` (no clone, or a partial
 *  one: it would fetch blobs from origin later), or `need <tips…>` (the clone's ref tips, so the seed can leave out
 *  what the box already holds). */
export function seedProbeCommand(repo: string, base: string): string {
  const c = `"$HOME/cib/repos/${repoDir(repo)}"`
  return [
    `c=${c}`,
    `if [ ! -d "$c/.git" ] || [ "$(git -C "$c" config --get remote.origin.promisor)" = true ]; then echo none; exit 0; fi`,
    `if git -C "$c" cat-file -e ${q(base + '^{commit}')} 2>/dev/null; then echo has; exit 0; fi`,
    `echo "need $(git -C "$c" for-each-ref --count=50 --sort=-committerdate --format='%(objectname)' refs/heads refs/remotes refs/cib | tr '\n' ' ')"`,
  ].join('\n')
}

/** A slot's share of a packed box (test-broker, boat.packing). */
export type SlotShare = { units: number; cpus: number; cpuset: string; memMb: number }

/** Kill a slot's run; `fence`: that attempt id never runs on the slot, even if its exec lands later. */
export const killCommand = (slot: number, fence?: string) =>
  `[ -f "$HOME/cib/${slot}/cib-wrap.sh" ] && bash "$HOME/cib/${slot}/cib-wrap.sh" --kill${fence ? ` --fence ${q(fence)}` : ''}; true`

/** Tar the profile's artifact paths that exist in the slot's worktree; prints the archive size, exit 3 = none. An
 *  earlier job's tarball is removed first, so it can never be downloaded as this one's. tar's exit 1 ("file changed
 *  as we read it") still made an archive: it is kept. */
export function artifactsCommand(slot: number, repo: string, paths: string[]): string {
  return [
    `rm -f "$HOME/cib/${slot}/artifacts.tgz"`,
    `cd "$HOME/cib/${slot}/${repoDir(repo)}" || exit 3`,
    'set --',
    `for p in ${paths.map(q).join(' ')}; do [ -e "$p" ] && set -- "$@" "$p"; done`,
    '[ $# -gt 0 ] || exit 3',
    `tar czf "$HOME/cib/${slot}/artifacts.tgz" -- "$@"; rc=$?`,
    `[ $rc -le 1 ] && [ -s "$HOME/cib/${slot}/artifacts.tgz" ] || exit $(( rc > 3 ? rc : 4 ))`,
    `stat -c %s "$HOME/cib/${slot}/artifacts.tgz"`,
  ].join('\n')
}
