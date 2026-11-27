#!/bin/bash
# shellcheck disable=SC2016,SC2015 # single quotes are for the child shells; ok() never fails
# ci-broker install.sh: the split layout's install (root, from an admin account). See the spec, "Install".
#
#   install.sh --operator <user> [--daemon-user U] [--runner-user U] [--opt D] [--state D] [--etc D] [--tools D]
#              [--approve <login>]… [--release <sha>] [--boat-copy] [--dry-run]
#   install.sh --release <sha>               a code update (as the daemon user: clone, archive, drain, swap, restart)
#   install.sh --check                        owners, modes, sudoers, units, tool hashes, the release (safe any time)
#   install.sh --set-secret <name>            a job secret, the value on stdin
#   install.sh --set-credential github|boat   the daemon's GitHub token (stdin) or a fresh Boat login
#   install.sh --uninstall [--purge]          units, sudoers, install.conf (data dirs stay unless --purge)
#
# Run it from a root-owned copy (it refuses otherwise). It reads only /etc/ci-broker/install.conf (never the env).
set -euo pipefail
PATH=/usr/sbin:/usr/bin:/sbin:/bin
IFS=$' \t\n'
umask 022
LC_ALL=C
export LC_ALL
HERE=$(cd "$(dirname "$0")" && pwd -P)
SRC=$(dirname "$HERE")
cd / # the admin's cwd may be unreadable for the daemon user (git clone as it dies there)
CONF=/etc/ci-broker/install.conf
LIB=/usr/local/lib/ci-broker
REPO_URL=https://github.com/airstack/test-broker.git
# Tool pins (2026-11-11). Boat publishes only its current build: when upstream moves on, bump the pin in a reviewed commit.
NODE_DIR=node-v26.13.0-linux-x64
NODE_URL=https://nodejs.org/dist/v26.13.0/node-v26.13.0-linux-x64.tar.xz
NODE_SHA=d28a96af6c38596f6d9d97c0ee531c13d238d757742387d1928de822d959e997
GH_DIR=gh_2.103.3_linux_amd64
GH_URL=https://github.com/cli/cli/releases/download/v2.103.3/gh_2.103.3_linux_amd64.tar.gz
GH_SHA=4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d
BOAT_URL='https://boat.dev/api/boat/cli/download?platform=linux-x64&channel=prod'
BOAT_SHA=a29f1f5cdcfc0b8c4f60894174f7f0c65987ba31ea3f23ec6ed0711dd0f58109
# >>> install-conf reader (the same in every root script; a test checks the copies match)
# Strict: one KEY=value per line, known keys only, no duplicates, values ^[A-Za-z0-9_./-]{1,200}$, user/group names
# ^[a-z_][a-z0-9_-]{0,31}$, paths absolute without a `..` segment. Parsed, never sourced. Sets IC_<KEY>.
read_install_conf() {
  local f=$1 line k v n=0 seen=' '
  [[ -f $f && ! -L $f ]] || { echo "install.conf: $f is missing (run scripts/install.sh)" >&2; return 1; }
  while IFS= read -r line || [[ -n $line ]]; do
    n=$((n + 1))
    [[ -z $line ]] && continue
    [[ $line =~ ^([A-Z_]+)=(.*)$ ]] || { echo "install.conf line $n: not KEY=value" >&2; return 1; }
    k=${BASH_REMATCH[1]} v=${BASH_REMATCH[2]}
    case $k in OPERATOR | OPERATOR_GROUP | DAEMON_USER | RUNNER_USER | OPT_DIR | STATE_DIR | ETC_DIR | TOOLS_DIR) ;; *) echo "install.conf line $n: unknown key $k" >&2; return 1 ;; esac
    [[ $seen == *" $k "* ]] && { echo "install.conf line $n: $k given twice" >&2; return 1; }
    seen+="$k "
    [[ $v =~ ^[A-Za-z0-9_./-]{1,200}$ ]] || { echo "install.conf: $k has a bad value" >&2; return 1; }
    case $k in
      OPERATOR | OPERATOR_GROUP | DAEMON_USER | RUNNER_USER) [[ $v =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || { echo "install.conf: $k is not a user or group name" >&2; return 1; } ;;
      *) [[ $v == /* && /$v/ != */../* ]] || { echo "install.conf: $k must be an absolute path" >&2; return 1; } ;;
    esac
    printf -v "IC_$k" '%s' "$v"
  done <"$f"
  for k in OPERATOR OPERATOR_GROUP DAEMON_USER RUNNER_USER OPT_DIR STATE_DIR ETC_DIR TOOLS_DIR; do
    [[ $seen == *" $k "* ]] || { echo "install.conf: $k is missing" >&2; return 1; }
  done
}
# <<< install-conf reader

die() {
  echo "install.sh: $*" >&2
  exit 1
}
say() { echo "install.sh: $*"; }
DRY=0
run() { if ((DRY)); then printf '+ %s\n' "$(printf '%q ' "$@")"; else "$@"; fi; }
no_link() { [[ ! -L $1 ]] || die "$1 is a symlink: refusing (root never follows a link in a tree another user can write)"; }
name_ok() { [[ $1 =~ ^[a-z_][a-z0-9_-]{0,31}$ ]]; }
path_ok() { [[ $1 =~ ^/[A-Za-z0-9_./-]{0,199}$ && /$1/ != */../* ]]; }
WORK=$(mktemp -d)
trap 'rm -rf -- "${WORK:?}"' EXIT

# ---------------------------------------------------------------- flags
OPERATOR='' DAEMON_USER=cibroker-admin RUNNER_USER=cibroker-runner OPT_DIR=/opt/ci-broker STATE_DIR=/var/lib/ci-broker ETC_DIR=/etc/ci-broker TOOLS_DIR=/usr/local/lib/ci-broker/tools
APPROVE=() RELEASE='' MODE=install SECRET='' CRED='' BOATCOPY=0 PURGE=0 LAYOUT_FLAGS=0
while (($#)); do
  case $1 in
    --operator) OPERATOR=${2:?--operator <user>}; LAYOUT_FLAGS=1; shift 2 ;;
    --daemon-user) DAEMON_USER=${2:?}; LAYOUT_FLAGS=1; shift 2 ;;
    --runner-user) RUNNER_USER=${2:?}; LAYOUT_FLAGS=1; shift 2 ;;
    --opt) OPT_DIR=${2:?}; LAYOUT_FLAGS=1; shift 2 ;;
    --state) STATE_DIR=${2:?}; LAYOUT_FLAGS=1; shift 2 ;;
    --etc) ETC_DIR=${2:?}; LAYOUT_FLAGS=1; shift 2 ;;
    --tools) TOOLS_DIR=${2:?}; LAYOUT_FLAGS=1; shift 2 ;;
    --approve) APPROVE+=("${2:?--approve <login>}"); shift 2 ;;
    --release) RELEASE=${2:?--release <sha>}; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --check) MODE=check; shift ;;
    --set-secret) MODE=secret; SECRET=${2:?--set-secret <name>}; shift 2 ;;
    --set-credential) MODE=credential; CRED=${2:?--set-credential github|boat}; shift 2 ;;
    --boat-copy) BOATCOPY=1; shift ;;
    --uninstall) MODE=uninstall; shift ;;
    --purge) PURGE=1; shift ;;
    *) die "unknown flag $1" ;;
  esac
done
[[ $(id -u) == 0 ]] || die "run it as root (sudo bash /root/ci-broker-<sha>/scripts/install.sh …)"
for a in "${APPROVE[@]}"; do [[ $a =~ ^[A-Za-z0-9-]{1,39}$ ]] || die "--approve: bad login '$a'"; done
[[ -z $RELEASE || $RELEASE =~ ^[0-9a-f]{40}$ ]] || die "--release needs a full 40-character sha"

# ---------------------------------------------------------------- this copy must be root's own
d=$HERE
while :; do
  read -r u m < <(stat -c '%u %a' -- "$d")
  [[ $u == 0 ]] || die "$d is not root-owned: copy the commit into a root-owned dir first (see the spec, Running install)"
  ((8#$m & 8#022)) && die "$d is group/other-writable"
  [[ $d == / ]] && break
  d=$(dirname "$d")
done
if [[ -n $(find "$SRC" \( ! -user root -o -perm -0002 \) -print -quit 2>/dev/null) ]]; then die "$SRC holds files not owned by root (or world-writable): copy it again"; fi

if ((LAYOUT_FLAGS)) || [[ $MODE == install && -z $RELEASE && ${#APPROVE[@]} -eq 0 ]]; then
  [[ -n $OPERATOR ]] || die "--operator <user> is required"
else
  read_install_conf "$CONF" || die "no finished install: run it with --operator first"
  OPERATOR=$IC_OPERATOR DAEMON_USER=$IC_DAEMON_USER RUNNER_USER=$IC_RUNNER_USER OPT_DIR=$IC_OPT_DIR STATE_DIR=$IC_STATE_DIR ETC_DIR=$IC_ETC_DIR TOOLS_DIR=$IC_TOOLS_DIR
  [[ $MODE == install ]] && MODE=release-only
fi
for n in "$OPERATOR" "$DAEMON_USER" "$RUNNER_USER"; do name_ok "$n" || die "'$n' is not a user name (^[a-z_][a-z0-9_-]{0,31}$)"; done
for p in "$OPT_DIR" "$STATE_DIR" "$ETC_DIR" "$TOOLS_DIR"; do path_ok "$p" || die "'$p' must be an absolute path (letters, digits, _ . - /; no ..)"; done
[[ $DAEMON_USER != "$OPERATOR" && $RUNNER_USER != "$OPERATOR" && $DAEMON_USER != "$RUNNER_USER" ]] || die "--daemon-user, --runner-user and --operator must all differ"
getent passwd "$OPERATOR" >/dev/null || die "no user $OPERATOR"
OPERATOR_GROUP=$(id -gn "$OPERATOR")
OP_HOME=$(getent passwd "$OPERATOR" | cut -d: -f6)
DHOME=$STATE_DIR/admin
TOKFILE=$DHOME/github-token
BOATCFG=$DHOME/.config/ascii/boat/config.json
command -v jq >/dev/null || die "jq is needed (apt install jq)"

as_op() { runuser -u "$OPERATOR" -- env -i HOME="$OP_HOME" PATH=/usr/bin:/bin LANG=C.UTF-8 "$@"; }
as_daemon() { runuser -u "$DAEMON_USER" -- env -i HOME="$DHOME" PATH="$TOOLS_DIR:/usr/bin:/bin" LANG=C.UTF-8 XDG_CONFIG_HOME="$DHOME/.config" BOAT_NO_UPDATE=1 "$@"; }

# put <mode> <owner:group> <dest> <src>: dry-run prints the sha256 and a diff against the installed copy
put() {
  local mode=$1 og=$2 dest=$3 src=$4
  if ((DRY)); then
    echo "file $dest ($mode $og) sha256 $(sha256sum <"$src" | cut -c1-64)"
    if [[ -f $dest ]]; then diff -u "$dest" "$src" || true; else echo "  (new file)"; fi
    return 0
  fi
  no_link "$dest"
  install -m "$mode" -o "${og%%:*}" -g "${og#*:}" "$src" "$dest.tmp.$$"
  mv -f "$dest.tmp.$$" "$dest"
}
# mkd <mode> <owner:group> <dir>: made when missing, else owner and mode set; never through a link
mkd() {
  local mode=$1 og=$2 dir=$3
  no_link "$dir"
  if [[ -e $dir && ! -d $dir ]]; then die "$dir exists and is not a directory"; fi
  if [[ ! -d $dir ]]; then run install -d -m "$mode" -o "${og%%:*}" -g "${og#*:}" "$dir"; else
    run chown -h "$og" "$dir"
    run chmod "$mode" "$dir"
  fi
}
render() { # a template with @KEY@ placeholders → stdout
  sed -e "s#@DAEMON_USER@#$DAEMON_USER#g" -e "s#@RUNNER_USER@#$RUNNER_USER#g" -e "s#@STATE_DIR@#$STATE_DIR#g" -e "s#@OPT_DIR@#$OPT_DIR#g" -e "s#@TOOLS_DIR@#$TOOLS_DIR#g" -e "s#@OPERATOR@#$OPERATOR#g" "$1"
}
conf_text() {
  printf 'OPERATOR=%s\nOPERATOR_GROUP=%s\nDAEMON_USER=%s\nRUNNER_USER=%s\nOPT_DIR=%s\nSTATE_DIR=%s\nETC_DIR=%s\nTOOLS_DIR=%s\n' \
    "$OPERATOR" "$OPERATOR_GROUP" "$DAEMON_USER" "$RUNNER_USER" "$OPT_DIR" "$STATE_DIR" "$ETC_DIR" "$TOOLS_DIR"
}
config_merge() { # <jq filter> [jq args…]: root's config.json, rewritten (create-only otherwise)
  local f=$ETC_DIR/config.json filter=$1
  shift
  no_link "$f"
  if ((DRY)); then echo "+ jq merge into $f: $filter"; return 0; fi
  jq "$@" "$filter" "$f" >"$WORK/config.json"
  put 0644 root:root "$f" "$WORK/config.json"
}

# ---------------------------------------------------------------- the steps
preflight() { # every refusal before any change
  local u home uid h
  for u in "$DAEMON_USER" "$RUNNER_USER"; do
    home=$([[ $u == "$DAEMON_USER" ]] && echo "$DHOME" || echo /nonexistent)
    getent passwd "$u" >/dev/null || continue
    uid=$(id -u "$u")
    h=$(getent passwd "$u" | cut -d: -f6)
    ((uid < 1000)) || die "user $u exists but is not a system user (uid $uid)"
    [[ $h == "$home" ]] || die "user $u exists with home $h, not $home"
  done
}
users() {
  local u home
  for u in "$DAEMON_USER" "$RUNNER_USER"; do
    home=$([[ $u == "$DAEMON_USER" ]] && echo "$DHOME" || echo /nonexistent)
    getent passwd "$u" >/dev/null || run useradd --system --user-group --home-dir "$home" --no-create-home --shell /usr/sbin/nologin "$u"
  done
  if getent group docker >/dev/null; then run usermod -aG docker "$DAEMON_USER"; else say "no docker group here: the daemon needs it for local runs"; fi
}
dirs() {
  mkd 0755 root:root "$STATE_DIR"
  mkd 0700 "$DAEMON_USER:$DAEMON_USER" "$DHOME"
  mkd 2750 "$DAEMON_USER:$OPERATOR_GROUP" "$STATE_DIR/local"
  mkd 2750 "$DAEMON_USER:$RUNNER_USER" "$STATE_DIR/sock"
  mkd 0755 "$OPERATOR:$OPERATOR_GROUP" "$STATE_DIR/operator"
  if [[ ! -e $STATE_DIR/operator/profiles ]]; then run runuser -u "$OPERATOR" -- mkdir -m 0755 "$STATE_DIR/operator/profiles"; fi
  mkd 0750 "root:$RUNNER_USER" "$STATE_DIR/runners"
  mkd 0755 root:root "$STATE_DIR/runner-dist"
  mkd 0755 root:root "$(dirname "$CONF")"
  mkd 0755 root:root "$ETC_DIR"
  mkd 0750 "root:$DAEMON_USER" "$ETC_DIR/secrets"
  mkd 0755 "$DAEMON_USER:$DAEMON_USER" "$OPT_DIR"
  mkd 0755 root:root "$TOOLS_DIR"
  if [[ ! -e $STATE_DIR/runners.json ]]; then echo '[]' >"$WORK/runners.json" && put 0644 root:root "$STATE_DIR/runners.json" "$WORK/runners.json"; fi
}
config() {
  local f=$ETC_DIR/config.json login id
  if [[ ! -e $f ]]; then
    printf '{\n  "trust": { "githubUsers": [] }\n}\n' >"$WORK/config.json"
    put 0644 root:root "$f" "$WORK/config.json"
  fi
  for login in "${APPROVE[@]}"; do
    # unauthenticated, as root: nothing the operator configures (their gh) can answer for GitHub here
    curl -fsS --max-time 20 -H 'Accept: application/vnd.github+json' -o "$WORK/user.json" "https://api.github.com/users/$login" || die "--approve $login: GET https://api.github.com/users/$login failed"
    jq -e '.type == "User"' "$WORK/user.json" >/dev/null || die "--approve $login: not a User account ($(jq -r .type "$WORK/user.json"))"
    id=$(jq -er '.id' "$WORK/user.json")
    [[ $id =~ ^[1-9][0-9]{0,14}$ ]] || die "--approve $login: bad id"
    [[ $(jq -r .login "$WORK/user.json") == "$login" ]] || say "--approve $login: GitHub spells it $(jq -r .login "$WORK/user.json")"
    say "approve: $(jq -r .login "$WORK/user.json") → id $id (confirm this is the account you mean: https://github.com/$login)"
    ((DRY)) && continue
    config_merge '.trust.githubUsers = ([(.trust.githubUsers // [])[] | select((type == "object" and .id == $id) | not)] + [{ login: $l, id: $id }])' --arg l "$(jq -r .login "$WORK/user.json")" --argjson id "$id"
    say "approved $login (id $id)"
  done
}
fetch() { # <url> <sha256> <out>
  run curl -fsSL -o "$3" "$1"
  ((DRY)) && return 0
  local got
  got=$(sha256sum "$3" | cut -c1-64)
  [[ $got == "$2" ]] || die "tool $1: sha256 $got does not match the pin $2 (bump the pin in a reviewed commit)"
}
tools() {
  local pins=$TOOLS_DIR/.pins want
  want=$(printf 'node %s\ngh %s\nboat %s\n' "$NODE_SHA" "$GH_SHA" "$BOAT_SHA")
  if [[ -f $pins && $(cat "$pins") == "$want" && -x $TOOLS_DIR/node/bin/node && -x $TOOLS_DIR/gh && -x $TOOLS_DIR/boat ]]; then say "tools: as pinned"; else
    fetch "$NODE_URL" "$NODE_SHA" "$WORK/node.tar.xz"
    fetch "$GH_URL" "$GH_SHA" "$WORK/gh.tar.gz"
    fetch "$BOAT_URL" "$BOAT_SHA" "$WORK/boat"
    if ((DRY)); then echo "+ (unpack node, gh, boat root-owned into $TOOLS_DIR)"; else
      mkdir -p "$WORK/n" "$WORK/g"
      tar -xJf "$WORK/node.tar.xz" -C "$WORK/n" --no-same-owner
      tar -xzf "$WORK/gh.tar.gz" -C "$WORK/g" --no-same-owner
      [[ -x $WORK/n/$NODE_DIR/bin/node && -x $WORK/g/$GH_DIR/bin/gh ]] || die "tools: the archives do not hold $NODE_DIR/bin/node and $GH_DIR/bin/gh"
      chown -R root:root "$WORK/n/$NODE_DIR"
      chmod -R go-w "$WORK/n/$NODE_DIR"
      no_link "$TOOLS_DIR/node"
      rm -rf -- "${TOOLS_DIR:?}/node.old"
      [[ -e $TOOLS_DIR/node ]] && mv "$TOOLS_DIR/node" "$TOOLS_DIR/node.old"
      mv "$WORK/n/$NODE_DIR" "$TOOLS_DIR/node"
      rm -rf -- "${TOOLS_DIR:?}/node.old"
      put 0755 root:root "$TOOLS_DIR/gh" "$WORK/g/$GH_DIR/bin/gh"
      put 0755 root:root "$TOOLS_DIR/boat" "$WORK/boat"
      printf '%s\n' "$want" >"$WORK/pins"
      put 0644 root:root "$pins" "$WORK/pins"
    fi
  fi
  if ((!DRY)); then # root never runs them; the daemon user does
    local nv gv bv
    nv=$(as_daemon "$TOOLS_DIR/node/bin/node" --version 2>&1) || die "the pinned node does not run here: $nv (a minimal system needs libatomic1)"
    gv=$(as_daemon "$TOOLS_DIR/gh" --version 2>&1 | head -1) || die "the pinned gh does not run here: $gv"
    bv=$(as_daemon "$TOOLS_DIR/boat" --version 2>&1 | head -1) || die "the pinned boat does not run here: $bv"
    say "tools: node $nv, $gv, boat $bv"
  fi
}
root_files() {
  mkd 0755 root:root "$LIB"
  put 0755 root:root "$LIB/runner-start" "$HERE/runner-start"
  put 0755 root:root "$LIB/pub-net-rules" "$HERE/pub-net-rules"
  put 0755 root:root /usr/local/sbin/ci-broker-runnerctl "$HERE/ci-broker-runnerctl"
  render "$HERE/ci-brokerd.service" >"$WORK/ci-brokerd.service"
  put 0644 root:root /etc/systemd/system/ci-brokerd.service "$WORK/ci-brokerd.service"
  put 0644 root:root /etc/systemd/system/ci-broker-pub-net.service "$HERE/ci-broker-pub-net.service"
  render "$HERE/ci-broker.tmpfiles" >"$WORK/ci-broker.tmpfiles"
  put 0644 root:root /etc/tmpfiles.d/ci-broker.conf "$WORK/ci-broker.tmpfiles"
  printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/ci-broker-runnerctl\n' "$OPERATOR" >"$WORK/sudoers"
  visudo -cf "$WORK/sudoers" >/dev/null || die "the sudoers rule does not parse"
  put 0440 root:root /etc/sudoers.d/ci-broker "$WORK/sudoers"
}
units() {
  run systemctl daemon-reload
  run /usr/local/sbin/ci-broker-runnerctl install-unit
  run systemd-tmpfiles --create /etc/tmpfiles.d/ci-broker.conf
  # an existing lock file keeps its old mode: set it (a regular file root owns; never through a link)
  if [[ -f /run/lock/ci-brokerd.lock && ! -L /run/lock/ci-brokerd.lock ]]; then run chown root:"$DAEMON_USER" /run/lock/ci-brokerd.lock && run chmod 0640 /run/lock/ci-brokerd.lock; fi
  # never enabled here: `runnerctl daemon start` enables it (a reboot mid-rollout can't start a second daemon);
  # a re-run keeps what the operator chose
  if command -v docker >/dev/null; then
    docker network inspect ci-broker-pub >/dev/null 2>&1 || run docker network create --driver bridge -o com.docker.network.bridge.name=cib-pub0 -o com.docker.network.bridge.enable_icc=false ci-broker-pub
    run systemctl enable --now ci-broker-pub-net.service
  else
    say "no docker here: the public network (ci-broker-pub) is not made"
  fi
}
credentials() {
  no_link "$TOKFILE"
  if [[ ! -s $TOKFILE ]]; then
    if ((DRY)); then echo "+ ($OPERATOR's gh auth token → $TOKFILE, 0600, as $DAEMON_USER)"; else
      as_op "$TOOLS_DIR/gh" auth token | runuser -u "$DAEMON_USER" -- sh -c 'umask 077; cat > "$1"' _ "$TOKFILE" || true # pipefail: the check below says what to do
      [[ -s $TOKFILE ]] || die "no token from $OPERATOR's gh auth token: log $OPERATOR in (as $OPERATOR: gh auth login), then run this install again"
      say "GitHub credential: copied from $OPERATOR's gh login (replace it later: --set-credential github)"
    fi
  fi
  for p in "$DHOME/.config" "$DHOME/.config/ascii" "$DHOME/.config/ascii/boat" "$BOATCFG"; do no_link "$p"; done
  if [[ ! -s $BOATCFG ]]; then
    if ((DRY)); then echo "+ (a Boat login for $DAEMON_USER$( ((BOATCOPY)) && echo ': a copy of the operator token and org'))"; return 0; fi
    runuser -u "$DAEMON_USER" -- mkdir -p -m 0700 "$DHOME/.config/ascii/boat"
    if ((BOATCOPY)); then
      as_op cat "$OP_HOME/.config/ascii/boat/config.json" | jq '{ token: .token, org: .org, api_url: "https://boat.dev" }' | runuser -u "$DAEMON_USER" -- sh -c 'umask 077; cat > "$1"' _ "$BOATCFG"
      say "Boat: the operator's token and org copied (--boat-copy)"
    else
      say "Boat: a fresh login for $DAEMON_USER: open the URL, sign in to the same Boat org as $OPERATOR"
      as_daemon "$TOOLS_DIR/boat" login
    fi
  fi
}
release() { # <sha>: as the daemon user, from a fresh clone over https with its own token
  local sha=$1 ts rel name cur
  ts=$(date -u +%Y%m%d%H%M%S)
  name=$sha-$ts
  local n=1
  while [[ -e $OPT_DIR/releases/$name || -L $OPT_DIR/releases/$name ]]; do n=$((n + 1)); name=$sha-$ts-$n; done # two in one second
  rel=$OPT_DIR/releases/$name
  no_link "$OPT_DIR"
  no_link "$OPT_DIR/releases"
  # current IS a link (releases/<name>): root only readlinks it; the daemon user swaps it
  if ((DRY)); then echo "+ (as $DAEMON_USER: clone $REPO_URL, check $sha, git archive into $rel, link node, RELEASE)"; return 0; fi
  cur=$(as_daemon head -1 "$OPT_DIR/current/RELEASE" 2>/dev/null || true) # a daemon-owned file: read as the daemon
  runuser -u "$DAEMON_USER" -- env -i HOME="$DHOME" PATH=/usr/bin:/bin LANG=C.UTF-8 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 \
    GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0='' GIT_CONFIG_KEY_1=credential.helper \
    GIT_CONFIG_VALUE_1='!f() { test "$1" = get || exit 0; echo username=x-access-token; printf "password=%s\n" "$(cat "$HOME/github-token")"; }; f' \
    bash -c '
      set -euo pipefail
      umask 022
      url=$1 sha=$2 rel=$3 tools=$4 cur=$5
      tmp=$(mktemp -d "$HOME/.release.XXXXXX")
      trap "rm -rf -- \"\${tmp:?}\"" EXIT
      git clone --quiet --no-checkout "$url" "$tmp/src"
      git -C "$tmp/src" cat-file -e "$sha^{commit}" 2>/dev/null || git -C "$tmp/src" fetch --quiet origin "$sha" 2>/dev/null || { echo "install.sh: GitHub has no commit $sha" >&2; exit 3; }
      git -C "$tmp/src" cat-file -e "$sha^{commit}"
      mkdir -p "$(dirname "$rel")"
      mkdir "$rel"
      git -C "$tmp/src" archive "$sha" | tar -x -C "$rel"
      mkdir -p "$rel/node/bin"
      ln -s "$tools/node/bin/node" "$rel/node/bin/node"
      proto=$(sed -n "s/^export const PROTOCOL = \([0-9][0-9]*\).*/\1/p" "$rel/src/ci/client/http.ts")
      printf "%s\nprotocol %s\n" "$sha" "${proto:-?}" >"$rel/RELEASE"
      echo "release $sha (protocol ${proto:-?}) in $rel"
      if [[ -n $cur ]] && git -C "$tmp/src" cat-file -e "$cur^{commit}" 2>/dev/null; then git -C "$tmp/src" diff --stat "$cur" "$sha" | tail -20; fi
    ' _ "$REPO_URL" "$sha" "$rel" "$TOOLS_DIR" "$cur"
  if systemctl is-active --quiet ci-brokerd.service; then
    say "the daemon runs: draining (waits for idle; new submits wait), then the swap and a restart"
    if ! runuser -u "$DAEMON_USER" -- env -i HOME="$DHOME" PATH=/usr/bin:/bin "$OPT_DIR/current/bin/ci-broker" drain --wait; then
      runuser -u "$DAEMON_USER" -- env -i HOME="$DHOME" PATH=/usr/bin:/bin "$OPT_DIR/current/bin/ci-broker" drain --cancel || true
      die "the drain failed: cancelled it (submits go through again); $rel is built but not current: re-run --release $sha"
    fi
    as_daemon ln -sfn "releases/$name" "$OPT_DIR/current.tmp"
    as_daemon mv -T "$OPT_DIR/current.tmp" "$OPT_DIR/current"
    systemctl restart ci-brokerd.service
  else
    as_daemon ln -sfn "releases/$name" "$OPT_DIR/current.tmp"
    as_daemon mv -T "$OPT_DIR/current.tmp" "$OPT_DIR/current"
  fi
  # the newest three releases are kept (never the current one)
  local keep old
  keep=$(readlink "$OPT_DIR/current")
  for old in $(runuser -u "$DAEMON_USER" -- ls -1t "$OPT_DIR/releases" | tail -n +4); do
    [[ releases/$old == "$keep" ]] && continue
    [[ $old =~ ^[0-9a-f]{40}-[0-9]{14}(-[0-9]{1,3})?$ ]] || continue
    as_daemon rm -rf -- "$OPT_DIR/releases/$old"
  done
  say "current → $(readlink "$OPT_DIR/current")"
}

# ---------------------------------------------------------------- --check
check() {
  local bad=0
  ok() { echo "  ok   $*"; }
  no() {
    echo "  FAIL $*"
    bad=1
  }
  want() { # <path> <owner:group> <mode>
    local st
    if [[ -L $1 ]]; then no "$1 is a symlink"; return; fi
    st=$(stat -c '%U:%G %a' -- "$1" 2>/dev/null) || { no "$1 is missing"; return; }
    [[ $st == "$2 $3" ]] && ok "$1 $st" || no "$1 is $st, want $2 $3"
  }
  read_install_conf "$CONF" && ok "$CONF parses" || no "$CONF"
  want "$CONF" root:root 644
  want "$STATE_DIR" root:root 755
  want "$DHOME" "$DAEMON_USER:$DAEMON_USER" 700
  want "$STATE_DIR/local" "$DAEMON_USER:$OPERATOR_GROUP" 2750
  want "$STATE_DIR/sock" "$DAEMON_USER:$RUNNER_USER" 2750
  want "$STATE_DIR/operator" "$OPERATOR:$OPERATOR_GROUP" 755
  want "$STATE_DIR/runners" "root:$RUNNER_USER" 750
  want "$STATE_DIR/runners.json" root:root 644
  want "$ETC_DIR/config.json" root:root 644
  want "$ETC_DIR/secrets" "root:$DAEMON_USER" 750
  want "$OPT_DIR" "$DAEMON_USER:$DAEMON_USER" 755
  want "$TOOLS_DIR" root:root 755
  want /usr/local/sbin/ci-broker-runnerctl root:root 755
  want "$LIB/runner-start" root:root 755
  want "$LIB/pub-net-rules" root:root 755
  want /etc/sudoers.d/ci-broker root:root 440
  [[ -s $TOKFILE ]] && want "$TOKFILE" "$DAEMON_USER:$DAEMON_USER" 600
  visudo -cf /etc/sudoers.d/ci-broker >/dev/null && ok "visudo -cf /etc/sudoers.d/ci-broker" || no "visudo -cf /etc/sudoers.d/ci-broker"
  if out=$(systemd-analyze verify ci-brokerd.service ci-broker-pub-net.service ci-broker-runner@check__unit-1.service 2>&1 | grep -v -e 'xfs_scrub' -e 'docker.service' -e 'Unit configured to use KillMode=none' || true) && [[ -z $out ]]; then ok "systemd-analyze verify (3 units)"; else no "systemd-analyze verify: $out"; fi
  if systemctl is-enabled --quiet ci-brokerd.service 2>/dev/null; then ok "ci-brokerd.service enabled (runnerctl daemon start)"; else ok "ci-brokerd.service installed, disabled (start it with: sudo -n ci-broker-runnerctl daemon start)"; fi
  [[ $(cat "$TOOLS_DIR/.pins" 2>/dev/null) == "$(printf 'node %s\ngh %s\nboat %s' "$NODE_SHA" "$GH_SHA" "$BOAT_SHA")" ]] && ok "tools as pinned" || no "tools are not as pinned (re-run install)"
  [[ $(sha256sum <"$TOOLS_DIR/boat" 2>/dev/null | cut -c1-64) == "$BOAT_SHA" ]] && ok "boat sha256" || no "boat sha256 differs from the pin"
  local rel proto
  rel=$(as_daemon head -1 "$OPT_DIR/current/RELEASE" 2>/dev/null || true)
  proto=$(as_daemon sed -n 2p "$OPT_DIR/current/RELEASE" 2>/dev/null || true)
  if [[ $rel =~ ^[0-9a-f]{40}$ && $proto =~ ^protocol\ [0-9]+$ ]]; then ok "release $rel ($proto)"; else no "no release in $OPT_DIR/current (install.sh --release <sha>)"; fi
  return $bad
}

# ---------------------------------------------------------------- modes
case $MODE in
  check)
    check
    exit $?
    ;;
  secret)
    [[ $SECRET =~ ^[A-Za-z0-9_.-]{1,64}$ ]] || die "bad secret name"
    val=$(cat)
    [[ -n $val ]] || die "no value on stdin"
    mkd 0750 "root:$DAEMON_USER" "$ETC_DIR/secrets"
    f=$ETC_DIR/secrets/$SECRET
    no_link "$f"
    ( umask 077 && printf '%s' "$val" >"$WORK/secret" )
    put 0640 "root:$DAEMON_USER" "$f" "$WORK/secret"
    config_merge 'if .secrets[$n] then . else .secrets[$n] = {} end' --arg n "$SECRET"
    say "job secret $SECRET set ($f, root:$DAEMON_USER 0640)"
    exit 0
    ;;
  credential)
    case $CRED in
      github)
        IFS= read -r tok || true
        [[ $tok =~ ^[A-Za-z0-9_]{20,255}$ ]] || die "the token on stdin does not look like a GitHub token"
        no_link "$TOKFILE"
        printf '%s\n' "$tok" | runuser -u "$DAEMON_USER" -- sh -c 'umask 077; rm -f -- "$1"; cat > "$1"' _ "$TOKFILE"
        say "GitHub credential replaced; the daemon reads it at its next start or after a 401 (sudo -n ci-broker-runnerctl daemon restart)"
        ;;
      boat)
        no_link "$BOATCFG"
        [[ -e $BOATCFG ]] && as_daemon mv -f "$BOATCFG" "$BOATCFG.old"
        credentials
        ;;
      *) die "--set-credential github|boat" ;;
    esac
    exit 0
    ;;
  uninstall)
    systemctl is-active --quiet ci-brokerd.service && die "the daemon runs: sudo -n ci-broker-runnerctl daemon stop first"
    for u in $(systemctl list-units 'ci-broker-runner@*' --all --plain --no-legend 2>/dev/null | awk '{print $1}'); do run systemctl disable --now "$u" || true; done
    run systemctl disable --now ci-broker-pub-net.service || true
    run systemctl disable ci-brokerd.service || true
    for f in /etc/systemd/system/ci-brokerd.service /etc/systemd/system/ci-broker-pub-net.service /etc/systemd/system/ci-broker-runner@.service \
      /etc/systemd/system/ci-broker-runner@.service.d/10-host-addrs.conf /etc/sudoers.d/ci-broker /etc/tmpfiles.d/ci-broker.conf \
      /usr/local/sbin/ci-broker-runnerctl "$LIB/runner-start" "$LIB/pub-net-rules" "$CONF" "$CONF.pending"; do
      no_link "$f"
      run rm -f -- "$f"
    done
    run rmdir /etc/systemd/system/ci-broker-runner@.service.d 2>/dev/null || true
    # enabled but unloaded units leave their wants links: remove every link to our units
    find /etc/systemd/system -path '*.wants/*' -type l \( -name 'ci-broker-runner@*.service' -o -name ci-brokerd.service -o -name ci-broker-pub-net.service \) -print0 | while IFS= read -r -d '' l; do run rm -f -- "$l"; done
    run systemctl daemon-reload
    if ((PURGE)); then
      for d in "$STATE_DIR" "$OPT_DIR" "$ETC_DIR" "$TOOLS_DIR"; do run rm -rf --one-file-system -- "${d:?}"; done
      command -v docker >/dev/null && run docker network rm ci-broker-pub >/dev/null 2>&1 || true
      for u in "$DAEMON_USER" "$RUNNER_USER"; do getent passwd "$u" >/dev/null && run userdel "$u"; done
      say "uninstalled and purged"
    else
      say "uninstalled (data dirs kept: $STATE_DIR $OPT_DIR $ETC_DIR $TOOLS_DIR; --purge removes them)"
    fi
    exit 0
    ;;
  release-only)
    [[ -n $RELEASE || ${#APPROVE[@]} -gt 0 ]] || die "nothing to do"
    config # --approve on a finished install
    [[ -n $RELEASE ]] && release "$RELEASE"
    exit 0
    ;;
esac

# install: install.conf.pending first; renamed at the very end (a failed run is fixed and re-run)
preflight
conf_text >"$WORK/install.conf"
if [[ -f $CONF ]] && ! cmp -s "$CONF" "$WORK/install.conf"; then
  diff -u "$CONF" "$WORK/install.conf" >&2 || true
  die "a finished install has other flags: uninstall first (install.sh --uninstall)"
fi
if ((DRY)); then
  say "dry run: nothing changes. install.conf would be:"
  sed 's/^/  /' "$WORK/install.conf"
fi
mkd 0755 root:root "$(dirname "$CONF")"
[[ -f $CONF ]] || put 0644 root:root "$CONF.pending" "$WORK/install.conf"
users
dirs
tools
config
root_files
units
credentials
# a fresh state: the daemon takes no job until the switch seeds its job ids above the old daemon's (or an
# operator runs `ci-broker admin-seed <n>` on a new machine)
if [[ ! -e $DHOME/state/brokerd.db ]]; then run runuser -u "$DAEMON_USER" -- sh -c 'umask 077; mkdir -p "$1/state" && : > "$1/state/await-seed"' _ "$DHOME"; fi
[[ -n $RELEASE ]] && release "$RELEASE"
if ((DRY)); then say "dry run done"; exit 0; fi
[[ -f $CONF ]] || mv -f "$CONF.pending" "$CONF"
chmod 0644 "$CONF"
if systemctl is-enabled --quiet ci-brokerd.service 2>/dev/null; then say "installed. ci-brokerd.service stays enabled"; else say "installed. ci-brokerd.service is disabled until: sudo -n ci-broker-runnerctl daemon start"; fi
check
