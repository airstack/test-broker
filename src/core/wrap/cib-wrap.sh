#!/usr/bin/env bash
# ci-broker's generic wrapper, uploaded with the profile script to ~/cib/<slot>/ on every run.
#   bash ~/cib/<slot>/cib-wrap.sh <sha> <args…>     env: CIB_REPO CIB_SHA CIB_SLOT CIB_BASE CIB_BUNDLE CIB_TOKEN_LINE
#   bash ~/cib/<slot>/cib-wrap.sh --kill [--fence <attempt>]
#                                                   kill this slot's process group (cancel, timeout, lost connection);
#                                                   --fence: that attempt (CIB_ATTEMPT) never runs, even if its exec
#                                                   reaches the box later, and the kill stops only that attempt: a
#                                                   late kill never stops the next shard in the slot
# 1. CIB_TOKEN_LINE=1: read exactly one line from stdin into GITHUB_TOKEN; then stdin is closed in every case, so
#    nothing downstream can read the ssh stdin.
# 2. Kill the leftover process group recorded in run.pid (a run the broker lost), then start the profile script
#    (remote.sh, next to this file) in its own session, recording its pgid in run.pid. Slots never touch each
#    other's processes: each has its own run.pid.
# 3. When the script ends, kill what it left in its group; exit with the script's code.
# Every kill also ends the processes that left the group (setsid, a sandbox) by the CIB_RUN token in their environment.
# CIB_SEED (test-broker): a bundle with refs/cib/seed, the run's base and its history (or the part the box lacks). The
# wrapper puts it into ~/cib/repos/<owner__name> before the script runs, so the script finds its base without
# GitHub. No clone, or a partial one (it would fetch blobs from origin): a new full clone, and the slot's checkout of
# the old one goes too. CIB_DEFAULT_BRANCH + CIB_BASE: the default branch moves forward to the base (never back),
# so a script that diffs against it sees the same merge-base as the dev box.
# CIB_NOFSYNC=1 (Boat boxes): run the script under eatmydata, so fsync is a no-op. Boat disks are slow to flush: a
# runtime test shard took 389-447 s with fsync and 172 s without. Installed once per box when
# missing (passwordless sudo); without it the script runs as before.
# CIB_ATTEMPT (test-broker): this attempt's id. A fenced attempt exits 97 before it touches the slot: a Boat exec that
# came back with no status can still reach the box after the broker gave up on it, and must not run then. CIB_FENCE:
# attempts the broker lost on this slot before (space-separated), fenced first, so a fence never hangs on a kill exec
# reaching the box. slot.lock (fd 7) covers the fence check + start + run.pid, and every kill: a kill either fences an
# attempt before it starts or finds it in run.pid.
# CIB_CPUSET (test-broker, boat.packing): the script runs under `taskset -c $CIB_CPUSET`, so shards that share a box
# keep to their own CPUs. CIB_UNITS, CIB_CPUS and CIB_MEM_MB tell the script its share.
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pidf="$here/run.pid"

tokf="$here/run.tok"
fencef="$here/fenced"
attf="$here/run.attempt"
lockf="$here/slot.lock"

# add attempt ids to the fence list (the newest 50 are kept)
fence_add() {
  local ids="" id
  for id in "$@"; do
    case "$id" in '' | *[!A-Za-z0-9._-]*) continue ;; esac
    ids="$ids$id"$'\n'
  done
  [ -n "$ids" ] || return 0
  { cat "$fencef" 2>/dev/null; printf '%s' "$ids"; } | tail -n 50 > "$fencef.new" && mv -f "$fencef.new" "$fencef"
}

fenced() {
  [ -n "${CIB_ATTEMPT:-}" ] && [ -f "$fencef" ] && grep -qxF "$CIB_ATTEMPT" "$fencef"
}

# pids (not this shell) whose environment carries the run's CIB_RUN token: what left the group (setsid, a sandbox)
tagged() {
  local tok="$1" e p
  for e in /proc/[0-9]*/environ; do
    p="${e#/proc/}"; p="${p%/environ}"
    [ "$p" = "$$" ] && continue
    grep -qzxF "CIB_RUN=$tok" "$e" 2>/dev/null && echo "$p"
  done
}

kill_group() {
  local rp tok
  rp=$(cat "$pidf" 2>/dev/null)
  tok=$(cat "$tokf" 2>/dev/null)
  case "$rp" in '' | *[!0-9]*) rp="" ;; esac
  case "$tok" in '' | *[!0-9a-f]*) tok="" ;; esac
  if [ -n "$rp" ]; then
    kill -TERM -- -"$rp" 2>/dev/null
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do kill -0 -- -"$rp" 2>/dev/null || break; sleep 0.2; done
    kill -KILL -- -"$rp" 2>/dev/null
  fi
  # a process that left the group keeps the token: a retried shard never runs on top of the copy it replaces
  if [ -n "$tok" ]; then
    local left
    left=$(tagged "$tok")
    if [ -n "$left" ]; then
      kill -TERM $left 2>/dev/null
      sleep 1
      left=$(tagged "$tok")
      [ -z "$left" ] || kill -KILL $left 2>/dev/null
    fi
  fi
  rm -f "$pidf" "$tokf" "$attf"
}

if [ "${1:-}" = --kill ]; then
  exec 7>"$lockf"
  flock -w 30 7
  if [ "${2:-}" = --fence ] && [ -n "${3:-}" ]; then
    fence_add "$3"
    # only the attempt it names: another attempt in the slot now is the next shard's
    cur=$(cat "$attf" 2>/dev/null)
    [ -z "$cur" ] || [ "$cur" = "$3" ] || exit 0
  fi
  kill_group
  exit 0
fi

exec 7>"$lockf"
flock -w 60 7
# shellcheck disable=SC2086
[ -z "${CIB_FENCE:-}" ] || fence_add $CIB_FENCE
if fenced; then
  echo "cib-wrap: attempt $CIB_ATTEMPT was given up by the broker; not running"
  exit 97
fi

if [ "${CIB_TOKEN_LINE:-0}" = 1 ]; then
  IFS= read -r GITHUB_TOKEN || true
  export GITHUB_TOKEN
fi
exec </dev/null

# eatmydata on PATH, installing it once per box when the caller asks for it and sudo needs no password
nofsync() {
  [ "${CIB_NOFSYNC:-0}" = 1 ] || return 1
  command -v eatmydata >/dev/null 2>&1 && return 0
  sudo -n true 2>/dev/null || return 1
  (
    flock 8
    command -v eatmydata >/dev/null 2>&1 && exit 0
    sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq eatmydata >/dev/null 2>&1 && exit 0
    sudo -n apt-get update -qq >/dev/null 2>&1
    sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq eatmydata >/dev/null 2>&1
  ) 8>"$here/../.eatmydata.lock"
  command -v eatmydata >/dev/null 2>&1
}

# drop a clone and every slot's checkout of it (a worktree or a --shared clone would point at the old objects). A
# checkout may hold mounts (a tmpfs for a build cache): unmount them first, or rm fails and the next step trips on
# the leftover directory.
drop_clone() {
  local name="$1" d m p r
  # a packed box: another slot may be running on that clone right now
  if [ -n "${CIB_CPUSET:-}" ]; then
    for p in "$HOME"/cib/[0-9]*/run.pid; do
      [ "$p" = "$pidf" ] && continue
      r=$(cat "$p" 2>/dev/null)
      case "$r" in '' | *[!0-9]*) continue ;; esac
      if kill -0 -- -"$r" 2>/dev/null; then echo "cib-wrap: the clone of $CIB_REPO must be replaced, but ${p%/run.pid} is running on it"; exit 90; fi
    done
  fi
  for d in "$HOME/cib/repos/$name" "$HOME"/cib/[0-9]*/"$name"; do
    [ -e "$d" ] || continue
    for m in $(findmnt -rn -o TARGET 2>/dev/null | grep -F "$d/" | sort -r); do sudo -n umount "$m" 2>/dev/null || umount "$m" 2>/dev/null; done
    rm -rf "$d" 2>/dev/null
    [ ! -e "$d" ] || { echo "cib-wrap: cannot remove $d"; exit 90; }
  done
}

seed_clone() {
  [ -n "${CIB_REPO:-}" ] || return 0
  local name="${CIB_REPO/\//__}" repos="$HOME/cib/repos" clone cur br="${CIB_DEFAULT_BRANCH:-main}" fresh=0
  clone="$repos/$name"
  [ -n "${CIB_SEED:-}" ] || [ -n "${CIB_DEFAULT_BRANCH:-}" ] || return 0
  mkdir -p "$repos"
  # the remote scripts take this lock (fd 8) around their clone work too
  exec 8>"$repos/$name.lock"
  flock 8
  if [ -n "${CIB_SEED:-}" ] && [ -s "$CIB_SEED" ]; then
    if [ -d "$clone/.git" ] && [ "$(git -C "$clone" config --get remote.origin.promisor)" = true ]; then
      echo "cib-wrap: replacing the partial clone of $CIB_REPO with a full one"
      drop_clone "$name"
    fi
    if [ ! -d "$clone/.git" ]; then
      drop_clone "$name"
      git init -q -b "$br" "$clone" && git -C "$clone" remote add origin "https://github.com/$CIB_REPO.git" \
        || { echo "cib-wrap: cannot create the clone of $CIB_REPO"; exit 90; }
      fresh=1
    fi
    git -C "$clone" fetch -q "$CIB_SEED" "+refs/cib/seed:refs/cib/seed" || { echo "cib-wrap: cannot fetch the seed bundle"; exit 91; }
    rm -f "$CIB_SEED"
    echo "cib-wrap: seeded $CIB_REPO up to ${CIB_BASE:0:12} from a bundle"
  fi
  if [ -n "${CIB_BASE:-}" ] && [ -d "$clone/.git" ] && git -C "$clone" cat-file -e "$CIB_BASE^{commit}" 2>/dev/null; then
    cur=$(git -C "$clone" rev-parse -q --verify "refs/heads/$br" 2>/dev/null)
    # a new clone's HEAD must resolve (worktree add needs it); else only forward, never back
    if [ "$fresh" = 1 ] || [ -z "$cur" ] || { [ "$cur" != "$CIB_BASE" ] && git -C "$clone" merge-base --is-ancestor "$cur" "$CIB_BASE" 2>/dev/null; }; then
      git -C "$clone" update-ref "refs/heads/$br" "$CIB_BASE" 2>/dev/null || true
      # a seeded clone fetched nothing from origin: give readers of origin/<branch> the same commit
      [ "$fresh" = 1 ] && git -C "$clone" update-ref "refs/remotes/origin/$br" "$CIB_BASE" 2>/dev/null
    fi
  fi
  flock -u 8
  exec 8>&-
  return 0
}

kill_group
flock -u 7
seed_clone
pre=""
if nofsync; then pre="eatmydata"; echo "cib-wrap: fsync off (eatmydata)"
elif [ "${CIB_NOFSYNC:-0}" = 1 ]; then echo "cib-wrap: eatmydata unavailable, fsync stays on"
fi
if [ -n "${CIB_CPUSET:-}" ]; then
  case "$CIB_CPUSET" in *[!0-9,-]*) echo "cib-wrap: bad CIB_CPUSET"; exit 90 ;; esac
  if command -v taskset >/dev/null 2>&1; then pre="taskset -c $CIB_CPUSET $pre"; echo "cib-wrap: slot $CIB_SLOT on CPUs $CIB_CPUSET"
  else echo "cib-wrap: taskset unavailable; slot $CIB_SLOT is not pinned to CPUs $CIB_CPUSET"
  fi
fi
flock -w 60 7
# a kill may have fenced this attempt while it seeded
if fenced; then
  echo "cib-wrap: attempt $CIB_ATTEMPT was given up by the broker; not running"
  exit 97
fi
CIB_RUN=$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')
echo "$CIB_RUN" > "$tokf"
if [ -n "${CIB_ATTEMPT:-}" ]; then echo "$CIB_ATTEMPT" > "$attf"; else rm -f "$attf"; fi
export CIB_RUN
# Not a process group leader (no job control in a script), so setsid execs in place: $! is the new session's leader
# and its pid is the group id.
# fd 7 (the slot lock) is not passed on: the run must not hold the lock
setsid bash -c 'echo $$ > "$0"; exec $1 bash "${@:2}"' "$pidf" "$pre" "$here/remote.sh" "$@" 7>&- &
child=$!
# the new session writes run.pid: wait for it, so a kill (under the lock) always finds this run
for _ in $(seq 50); do [ -s "$pidf" ] && break; sleep 0.1; done
flock -u 7
exec 7>&-
wait "$child"
rc=$?
# whatever the script left running in its group (a dev stack, a watcher) goes with it
kill_group
exit "$rc"
