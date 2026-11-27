#!/usr/bin/env bash
# The example profile's remote script: a Node project tested with npm. ci-broker uploads it as ~/cib/<slot>/remote.sh
# next to its wrapper (cib-wrap.sh) and runs it on a remote resource (a Boat box, a VPS slot) for one shard:
#   remote.sh <sha> <mode> [args...]     env: CIB_REPO CIB_SHA CIB_SLOT CIB_BASE CIB_BUNDLE (GITHUB_TOKEN if given)
#   mode: test      -> npm test
#         unit      -> npm run test:unit
#         int-shard -> int-shard <i/n>: npm run test:int -- --shard=<i/n>
#         int       -> npm run test:int -- <test files…>
#         e2e       -> npm run test:e2e -- [args…]
#         setup     -> checkout + install only
#         cmd       -> run the rest of the args as a shell command in the checkout (ad-hoc; health checks)
# Resources are REUSED across runs, repos and slots, so everything here is idempotent:
#   - one clone per repo at ~/cib/repos/<owner>__<name>, one git worktree per slot at ~/cib/<slot>/<owner>__<name>
#     (slots share objects but not checkouts or scratch);
#   - checkout by sha; a snapshot comes as a bundle (CIB_BUNDLE, minus CIB_BASE, which is fetched from origin first);
#   - below CIB_MIN_FREE_GB (15) free disk: evict the least-recently-used other repos, then the npm cache; else exit 96;
#   - slot-scoped scratch: TMPDIR=/dev/shm/cib-<repo>-<slot> and TEST_PORT_BASE=8700+20*slot (for tests that open ports);
#   - the artifacts an earlier run left in the slot (ARTIFACTS, the tarball) are removed first, so a run's artifacts
#     are only ever its own.
# Exit codes the broker treats as infra (profile infraExitCodes): 89 bootstrap (no node/npm), 90 no repo, 91 fetch,
# 92 checkout, 93 install, 96 disk. Full output also goes to ~/cib/<slot>/runs/<timestamp>-<mode>.log.
set -uo pipefail
SHA="${1:?sha}"; MODE="${2:-test}"; shift 2 || true
: "${CIB_REPO:?CIB_REPO (owner/name) must be set}"
SLOT="${CIB_SLOT:-0}"
NAME="${CIB_REPO/\//__}"
CIB="$HOME/cib"
CLONE="$CIB/repos/$NAME"
WT="$CIB/$SLOT/$NAME"
MIN_FREE_GB="${CIB_MIN_FREE_GB:-15}"
CLONE_URL="${CIB_CLONE_URL:-https://github.com/$CIB_REPO.git}"
export PATH="$HOME/.local/bin:$PATH"
export CI=1 FORCE_COLOR=0 NO_COLOR=1

mkdir -p "$CIB/repos" "$CIB/$SLOT/runs"
echo "$NAME" > "$CIB/$SLOT/current"
LOG="$CIB/$SLOT/runs/$(date -u +%Y%m%dT%H%M%SZ)-${MODE}.log"
T0=$(date +%s)
phase() { echo; echo "=== [$(( $(date +%s) - T0 ))s] $*"; }

# git with the injected GitHub token for this command only (GIT_CONFIG_* env): the token is never written to a config
# file or captured in a snapshot.
gitc() {
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    GIT_TERMINAL_PROMPT=0 GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.https://github.com.helper \
    GIT_CONFIG_VALUE_0='!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f' git "$@"
  else
    GIT_TERMINAL_PROMPT=0 git "$@"
  fi
}

# The profile's `artifacts` paths (profile.json; a test checks the two lists agree), worktree-relative. The broker tars
# whichever exist after the run.
ARTIFACTS=(test-results coverage ci-broker-logs)
clear_artifacts() {
  rm -f "$CIB/$SLOT/artifacts.tgz"
  [ -d "$WT" ] || return 0
  local p
  for p in "${ARTIFACTS[@]}"; do rm -rf "${WT:?}/$p"; done
}

free_gb() { df -Pk "$HOME" | awk 'NR==2 { print int($4 / 1048576) }'; }

# A repo is busy when some slot's live run is on it.
repo_busy() {
  local d pg
  for d in "$CIB"/[0-9]*; do
    [ "$(cat "$d/current" 2>/dev/null)" = "$1" ] || continue
    [ "$d" = "$CIB/$SLOT" ] && continue
    pg=$(cat "$d/run.pid" 2>/dev/null)
    [ -n "$pg" ] && kill -0 -- -"$pg" 2>/dev/null && return 0
  done
  return 1
}

ensure_disk() {
  local r
  [ "$(free_gb)" -ge "$MIN_FREE_GB" ] && return 0
  phase "disk: $(free_gb) GB free, below ${MIN_FREE_GB} GB: evicting least-recently-used other repos"
  # oldest .used stamp first (a clone with none counts as oldest)
  for r in $(for d in "$CIB/repos"/*/; do [ -d "$d" ] || continue; r=$(basename "$d"); echo "$(stat -c %Y "$CIB/repos/$r.used" 2>/dev/null || echo 0) $r"; done | sort -n | awk '{ print $2 }'); do
    [ "$r" = "$NAME" ] && continue
    repo_busy "$r" && continue
    echo "evict $r"
    rm -rf "$CIB"/[0-9]*/"$r" "$CIB/repos/$r" "$CIB/repos/$r.used"
    [ "$(free_gb)" -ge "$MIN_FREE_GB" ] && return 0
  done
  if command -v npm >/dev/null; then
    echo "npm cache clean"
    npm cache clean --force >/dev/null 2>&1 || true
  fi
  [ "$(free_gb)" -ge "$MIN_FREE_GB" ] && return 0
  echo "not enough disk: $(free_gb) GB free, need ${MIN_FREE_GB} GB"
  exit 96
}

main() {
clear_artifacts
ensure_disk

# The box image must bring node and npm (a Boat environment, or a VPS set up by hand): their absence is infra.
command -v node >/dev/null && command -v npm >/dev/null || { echo "node and npm must be on PATH"; exit 89; }

phase "checkout $SHA${CIB_BUNDLE:+ (snapshot)}"
# The clone, its refs and the worktree list are shared by the slots: change them one slot at a time.
exec 8>"$CIB/repos/$NAME.lock"; flock 8
if [ ! -d "$CLONE/.git" ]; then
  rm -rf "$CLONE"
  gitc clone --quiet --no-checkout --filter=blob:none "$CLONE_URL" "$CLONE" || { echo "cannot clone $CIB_REPO"; exit 90; }
fi
touch "$CIB/repos/$NAME.used"
if [ ! -e "$WT/.git" ]; then
  rm -rf "$WT"
  git -C "$CLONE" worktree prune
  git -C "$CLONE" worktree add --quiet --detach --no-checkout "$WT" || { echo "cannot add a worktree at $WT"; exit 90; }
fi
if [ -n "${CIB_BUNDLE:-}" ]; then
  if [ -n "${CIB_BASE:-}" ] && ! git -C "$CLONE" cat-file -e "$CIB_BASE^{commit}" 2>/dev/null; then
    gitc -C "$CLONE" fetch --quiet origin "$CIB_BASE" || { echo "cannot fetch the snapshot base $CIB_BASE from origin"; exit 91; }
  fi
  # into a per-slot ref: two slots fetching snapshots at once must not clobber each other's
  git -C "$CLONE" fetch --quiet "$CIB_BUNDLE" "+refs/cib/snap:refs/cib/slot-$SLOT" || { echo "cannot fetch the snapshot bundle"; exit 91; }
elif ! git -C "$CLONE" cat-file -e "$SHA^{commit}" 2>/dev/null; then
  gitc -C "$CLONE" fetch --quiet origin "$SHA" || { echo "cannot fetch $SHA from origin"; exit 91; }
fi
flock -u 8
cd "$WT" || { echo "no worktree at $WT"; exit 90; }
gitc checkout --quiet --force --detach "$SHA" || exit 92
# Drop tracked edits + untracked files from a previous run; keep ignored caches (node_modules).
git reset --quiet --hard
git clean -fdq
echo "HEAD: $(git log --oneline -1)"

# Slot-scoped scratch: temp dirs in RAM, and a port range per slot.
export TMPDIR="/dev/shm/cib-$NAME-$SLOT"
rm -rf "$TMPDIR"; mkdir -p "$TMPDIR"
export TEST_PORT_BASE=$(( 8700 + 20 * SLOT ))

if [ -f package.json ]; then
  phase "npm ci"
  if [ -f package-lock.json ]; then npm ci --no-audit --no-fund 2>&1 | tail -n 15; else npm install --no-audit --no-fund 2>&1 | tail -n 15; fi
  [ "${PIPESTATUS[0]}" = 0 ] || { echo "npm install failed"; exit 93; }
fi

RC=0
case "$MODE" in
  setup) ;;
  test) phase "npm test"; npm test; RC=$? ;;
  unit) phase "npm run test:unit"; npm run test:unit; RC=$? ;;
  int-shard) phase "npm run test:int -- --shard=$1"; npm run test:int -- --shard="$1"; RC=$? ;;
  int) phase "npm run test:int -- $*"; npm run test:int -- "$@"; RC=$? ;;
  e2e) phase "npm run test:e2e -- $*"; npm run test:e2e -- "$@"; RC=$? ;;
  cmd) phase "cmd: $*"; bash -c "$*"; RC=$? ;;
  *) echo "unknown mode $MODE"; RC=2 ;;
esac

phase "done: mode=$MODE sha=$SHA slot=$SLOT rc=$RC elapsed=$(( $(date +%s) - T0 ))s log=$LOG"
exit $RC
}
main "$@" 2>&1 | tee "$LOG"
exit "${PIPESTATUS[0]}"
