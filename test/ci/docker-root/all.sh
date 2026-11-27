#!/bin/bash
# The root tests (pnpm test:root): run as root in a throwaway cib-root-test container. /src is the working tree
# (read-only, not root-owned), /fx the fixtures (tool tarballs, pins). Prints `ok <section>: …` / `FAIL <section>: …`
# and DONE at the end; test/docker-root/root-tests.ts turns them into assertions.
set -uo pipefail
export LC_ALL=C
S=''
section() { S=$1; }
ok() { echo "ok $S: $*"; }
no() { echo "FAIL $S: $*"; }
check() { # <what> <command…>
  local what=$1
  shift
  if "$@" >/tmp/check.out 2>&1; then ok "$what"; else no "$what ($(tail -3 /tmp/check.out | tr '\n' ' '))"; fi
}
refuse() { # <what> <regex> <command…>: must fail with output matching
  local what=$1 re=$2
  shift 2
  if "$@" >/tmp/check.out 2>&1; then no "$what (it succeeded)"; elif grep -qE -- "$re" /tmp/check.out; then ok "$what"; else no "$what (wrong error: $(tail -2 /tmp/check.out | tr '\n' ' '))"; fi
}
mode_is() { [[ $(stat -c '%U:%G %a' -- "$1") == "$2" ]] || { echo "$1 is $(stat -c '%U:%G %a' -- "$1"), want $2"; return 1; }; }

# ---------------------------------------------------------------- fakes, users, sources
section setup
mkdir -p /var/log/fake /run/lock
for f in systemctl curl docker; do install -m 0755 "/src/test/ci/docker-root/fakes/$f" "/usr/bin/$f"; done
groupadd -r docker
useradd -m -u 1500 -s /bin/bash op1 && chmod 0750 /home/op1
useradd -m -u 1600 -s /bin/bash mallory
useradd -m -u 1700 -s /bin/bash cbx-human
mkdir -p /home/op1/.config/ascii/boat
printf '{"api_url":"https://evil.example","token":"boat-op-token","org":"org1","browser_session":true,"pending_login_url":"x"}' >/home/op1/.config/ascii/boat/config.json
chown -R op1:op1 /home/op1/.config
mkdir -p /root/cib && tar -x -f /fx/src.tar -C /root/cib --no-same-owner && chown -R root:root /root/cib && chmod -R go-w /root/cib
# the test copy: pins of the local tool server, the release from a local bare repo
source /fx/pins.env
sed -i -e "s/^NODE_SHA=.*/NODE_SHA=$NODE_SHA/" -e "s/^GH_SHA=.*/GH_SHA=$GH_SHA/" -e "s/^BOAT_SHA=.*/BOAT_SHA=$BOAT_SHA/" -e "s#^REPO_URL=.*#REPO_URL=file:///srv/ci-broker.git#" /root/cib/ci/scripts/install.sh
sed -i -e "s/^  \"2.338.2 .*/  \"2.338.2 $RUNNER_SHA\"\n  \"9.9.9 $RUNNER_SHA\"/" /root/cib/ci/scripts/ci-broker-runnerctl
git config --global --add safe.directory '*' 2>/dev/null
mkdir -p /srv/work && tar -x -f /fx/src.tar -C /srv/work && cd /srv/work && git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm release && SHA=$(git rev-parse HEAD) && git clone -q --bare /srv/work /srv/ci-broker.git && chmod -R a+rX /srv && cd / || exit 1
FLAGS=(--operator op1 --daemon-user cbx-admin --runner-user cbx-runner --opt /opt/cbx --state /var/lib/cbx --etc /etc/cbx --tools /usr/local/lib/cbx)
I=/root/cib/ci/scripts/install.sh
ok "fixtures ready (release $SHA)"

# ---------------------------------------------------------------- bad flags and a copy that isn't root's
section flags
refuse "a name with a slash" "not a user name" bash $I --operator op1 --daemon-user 'cbx/admin'
refuse "a relative path" "absolute path" bash $I --operator op1 --state var/lib/cbx
refuse "a path with .." "absolute path" bash $I --operator op1 --opt /opt/../etc
refuse "daemon user = operator" "must all differ" bash $I --operator op1 --daemon-user op1
refuse "an existing non-system user" "not a system user" bash $I "${FLAGS[@]/cbx-runner/cbx-human}"
refuse "an unknown flag" "unknown flag" bash $I --operator op1 --frobnicate
refuse "not root-owned (the operator's checkout)" "not root-owned" bash /src/ci/scripts/install.sh "${FLAGS[@]}"
[[ ! -e /etc/ci-broker && ! -e /var/lib/cbx ]] && ok "nothing made by the refusals" || no "a refusal changed something"

# ---------------------------------------------------------------- --dry-run changes nothing
section dry-run
before=$(find / -xdev \( -path /proc -o -path /sys -o -path /tmp -o -path /var/log/fake -o -path /root/cib \) -prune -o -newer /fx/pins.env -print 2>/dev/null | sort | md5sum)
bash $I "${FLAGS[@]}" --approve alice --release "$SHA" --boat-copy --dry-run >/tmp/dry.out 2>&1 && ok "exit 0" || no "exit $? ($(tail -3 /tmp/dry.out))"
after=$(find / -xdev \( -path /proc -o -path /sys -o -path /tmp -o -path /var/log/fake -o -path /root/cib \) -prune -o -newer /fx/pins.env -print 2>/dev/null | sort | md5sum)
[[ $before == "$after" ]] && ok "no file changed" || no "files changed by --dry-run"
grep -q '^  DAEMON_USER=cbx-admin$' /tmp/dry.out && ok "prints the install.conf" || no "no install.conf in the output"
grep -qE '^file /usr/local/sbin/ci-broker-runnerctl \(0755 root:root\) sha256 [0-9a-f]{64}$' /tmp/dry.out && ok "prints each file's sha256" || no "no file hashes"
grep -q '^+ ' /tmp/dry.out && ok "prints the commands" || no "no commands"
getent passwd cbx-admin >/dev/null && no "made a user" || ok "made no user"

# ---------------------------------------------------------------- a run killed half-way, then fixed
section pending
cp $I /root/cib/ci/scripts/install-badpin.sh
sed -i "s/^BOAT_SHA=.*/BOAT_SHA=$(printf '0%.0s' {1..64})/" /root/cib/ci/scripts/install-badpin.sh
refuse "a tool whose hash doesn't match its pin" "does not match the pin" bash /root/cib/ci/scripts/install-badpin.sh "${FLAGS[@]}"
rm -f /root/cib/ci/scripts/install-badpin.sh
[[ -f /etc/ci-broker/install.conf.pending && ! -e /etc/ci-broker/install.conf ]] && ok "install.conf.pending only" || no "install.conf state after a failed run"

# ---------------------------------------------------------------- the install (non-default names)
section install
touch /tmp/gh-fail
refuse "no token from the operator's gh says how to fix it" "gh auth login\), then run this install again" bash $I "${FLAGS[@]}"
rm -f /tmp/gh-fail
( while :; do ps -eo args >>/tmp/ps.log 2>/dev/null; sleep 0.01; done ) &
SAMPLER=$!
# from a cwd the daemon user can't read (the admin's home): the release's git clone must still work
(cd /home/op1 && bash $I "${FLAGS[@]}" --approve alice --release "$SHA" --boat-copy) >/tmp/install.out 2>&1 && ok "install exit 0 (run from an unreadable cwd)" || no "install failed: $(tail -15 /tmp/install.out | tr '\n' '|')"
kill $SAMPLER 2>/dev/null
[[ -f /etc/ci-broker/install.conf && ! -e /etc/ci-broker/install.conf.pending ]] && ok "install.conf written at the end" || no "install.conf"
grep -q 'ok   ci-brokerd.service installed, disabled' /tmp/install.out && ok "ci-brokerd.service installed disabled" || no "daemon unit state: $(grep ci-brokerd.service /tmp/install.out)"
grep -q '^systemctl enable.* ci-brokerd.service' /var/log/fake/systemctl && no "ci-brokerd.service was enabled" || ok "never enabled ci-brokerd.service"
for p in "/etc/ci-broker/install.conf root:root 644" "/var/lib/cbx root:root 755" "/var/lib/cbx/admin cbx-admin:cbx-admin 700" "/var/lib/cbx/local cbx-admin:op1 2750" \
  "/var/lib/cbx/sock cbx-admin:cbx-runner 2750" "/var/lib/cbx/operator op1:op1 755" "/var/lib/cbx/operator/profiles op1:op1 755" "/var/lib/cbx/runners root:cbx-runner 750" \
  "/var/lib/cbx/runners.json root:root 644" "/etc/cbx/config.json root:root 644" "/etc/cbx/secrets root:cbx-admin 750" "/opt/cbx cbx-admin:cbx-admin 755" \
  "/usr/local/lib/cbx root:root 755" "/usr/local/sbin/ci-broker-runnerctl root:root 755" "/usr/local/lib/ci-broker/runner-start root:root 755" \
  "/usr/local/lib/ci-broker/pub-net-rules root:root 755" "/etc/sudoers.d/ci-broker root:root 440" "/etc/systemd/system/ci-brokerd.service root:root 644" \
  "/etc/systemd/system/ci-broker-runner@.service root:root 644" "/etc/tmpfiles.d/ci-broker.conf root:root 644" "/var/lib/cbx/admin/github-token cbx-admin:cbx-admin 600"; do
  set -- $p
  check "$1 is $2 $3" mode_is "$1" "$2 $3"
done
for u in cbx-admin cbx-runner; do
  [[ $(getent passwd $u | cut -d: -f7) == /usr/sbin/nologin && $(id -u $u) -lt 1000 && $(getent shadow $u | cut -d: -f2) == '!'* ]] && ok "$u: system, nologin, locked" || no "$u: $(getent passwd $u) $(getent shadow $u | cut -d: -f2)"
done
id -nG cbx-admin | grep -qw docker && ok "cbx-admin is in docker" || no "cbx-admin not in docker"
id -nG cbx-runner | grep -qw docker && no "cbx-runner is in docker" || ok "cbx-runner is not in docker"
check "visudo -cf the sudoers file" visudo -cf /etc/sudoers.d/ci-broker
grep -qx 'op1 ALL=(root) NOPASSWD: /usr/local/sbin/ci-broker-runnerctl' /etc/sudoers.d/ci-broker && ok "the one sudoers rule" || no "sudoers: $(cat /etc/sudoers.d/ci-broker)"
check "--check passes" bash $I --check
jq -e '.trust.githubUsers == [{"login":"alice","id":5001}]' /etc/cbx/config.json >/dev/null && ok "--approve took the id from GitHub (unauthenticated), not the operator's gh" || no "config: $(cat /etc/cbx/config.json)"
grep -q 'approve: alice → id 5001 (confirm' /tmp/install.out && ok "--approve prints login → id for the admin" || no "no approve line"
check "the one-daemon lock is root:cbx-admin 0640" mode_is /run/lock/ci-brokerd.lock "root:cbx-admin 640"
runuser -u cbx-runner -- flock -n /run/lock/ci-brokerd.lock true 2>/dev/null && no "the runner user can hold the one-daemon lock" || ok "no other user can hold the one-daemon lock"
check "a fresh state waits for the job id seed" mode_is /var/lib/cbx/admin/state/await-seed "cbx-admin:cbx-admin 600"
[[ $(cat /var/lib/cbx/admin/github-token) == ghp_ROOTTESTTOKENROOTTESTTOKEN1234567 ]] && ok "the operator's token in the daemon's github-token" || no "token file"
jq -e 'keys == ["api_url","org","token"] and .api_url == "https://boat.dev" and .token == "boat-op-token"' /var/lib/cbx/admin/.config/ascii/boat/config.json >/dev/null && ok "--boat-copy: token, org and a fixed api_url only" || no "boat config: $(cat /var/lib/cbx/admin/.config/ascii/boat/config.json)"
grep -q 'ROOTTESTTOKEN\|boat-op-token' /tmp/ps.log && no "a secret showed in a process's argv" || ok "no secret in any argv ($(wc -l </tmp/ps.log) ps samples)"
runuser -u op1 -- cat /var/lib/cbx/admin/github-token >/dev/null 2>&1 && no "the operator reads the daemon's token" || ok "the operator can't read the daemon's token"
[[ -L /opt/cbx/current && -f /opt/cbx/current/RELEASE ]] && grep -q "^$SHA$" /opt/cbx/current/RELEASE && ok "release $SHA is current" || no "no current release"
[[ $(stat -c %U /opt/cbx/current/src/ci/cli.ts) == cbx-admin ]] && ok "the release is the daemon user's" || no "release owner"
[[ $(readlink /opt/cbx/current/node/bin/node) == /usr/local/lib/cbx/node/bin/node ]] && ok "the release's node is the pinned one" || no "node link"

# ---------------------------------------------------------------- no default name or path in anything installed
section names
files=(/etc/ci-broker/install.conf /etc/cbx/config.json /etc/sudoers.d/ci-broker /etc/tmpfiles.d/ci-broker.conf /etc/systemd/system/ci-brokerd.service /etc/systemd/system/ci-broker-pub-net.service \
  /etc/systemd/system/ci-broker-runner@.service /etc/systemd/system/ci-broker-runner@.service.d/10-host-addrs.conf /usr/local/sbin/ci-broker-runnerctl /usr/local/lib/ci-broker/runner-start /usr/local/lib/ci-broker/pub-net-rules)
hits=$(grep -nE 'cibroker-admin|cibroker-runner|/opt/ci-broker|/var/lib/ci-broker|/usr/local/lib/ci-broker/tools|/etc/ci-broker/(config|secrets)' "${files[@]}" 2>/dev/null | grep -v '^\S*:[0-9]*:\s*#' || true)
[[ -z $hits ]] && ok "no default user, group or path in ${#files[@]} installed files" || no "defaults found: $hits"
dump=$(runuser -u cbx-admin -- env -i HOME=/var/lib/cbx/admin PATH=/usr/bin:/bin /usr/local/lib/cbx/node/bin/node -e 'import("/opt/cbx/current/src/ci/config.ts").then(m => console.log(JSON.stringify(m.loadAnyConfig({}))))' 2>&1)
echo "$dump" | grep -qE 'cibroker-admin|cibroker-runner|/opt/ci-broker|/var/lib/ci-broker|/usr/local/lib/ci-broker/tools' && no "the daemon's resolved config names a default: $dump" || { echo "$dump" | grep -q '/var/lib/cbx/admin/state' && ok "the daemon's resolved config has no default name or path" || no "config dump: $dump"; }

# ---------------------------------------------------------------- re-runs
section rerun
cp /etc/cbx/config.json /tmp/config.before
echo '{"trust":{"githubUsers":[{"login":"alice","id":5001}]},"daemonId":"cbx","gitUrl":"file:///srv/origins/{repo}.git","localMaxLoadFactor":1000,"resources":[{"id":"local","kind":"local","profiles":["*"]}]}' >/etc/cbx/config.json
cp /etc/cbx/config.json /tmp/config.mine
tok0=$(md5sum </var/lib/cbx/admin/github-token)
echo ci-brokerd.service >>/var/log/fake/enabled
check "a second install with the same flags" bash $I "${FLAGS[@]}"
systemctl is-enabled ci-brokerd.service && ok "a re-run keeps ci-brokerd.service enabled" || no "a re-run disabled ci-brokerd.service"
sed -i '/^ci-brokerd.service$/d' /var/log/fake/enabled
cmp -s /etc/cbx/config.json /tmp/config.mine && ok "config.json is create-only (root's edits kept)" || no "config.json was rewritten"
[[ $(md5sum </var/lib/cbx/admin/github-token) == "$tok0" ]] && ok "credentials not overwritten" || no "token changed"
check "--approve merges into config.json" bash $I "${FLAGS[@]}" --approve bob
check "--approve alone (no install flags) on a finished install" bash $I --approve carl
jq -e '[.trust.githubUsers[].login] == ["alice","bob","carl"] and .daemonId == "cbx" and .localMaxLoadFactor == 1000' /etc/cbx/config.json >/dev/null && ok "bob and carl merged, the rest kept" || no "config: $(cat /etc/cbx/config.json)"
refuse "--approve of a non-User account" "not a User" bash $I "${FLAGS[@]}" --approve bot
refuse "different flags on a finished install" "uninstall first" bash $I "${FLAGS[@]/cbx-runner/cbx-runner2}"

# ---------------------------------------------------------------- root scripts ignore CI_BROKER_INSTALL_CONF
section env
printf 'OPERATOR=op1\nOPERATOR_GROUP=op1\nDAEMON_USER=root\nRUNNER_USER=root\nOPT_DIR=/tmp\nSTATE_DIR=/tmp\nETC_DIR=/tmp\nTOOLS_DIR=/tmp\n' >/tmp/evil.conf
CI_BROKER_INSTALL_CONF=/tmp/evil.conf /usr/local/sbin/ci-broker-runnerctl install-unit >/dev/null 2>&1
grep -q '^User=cbx-runner$' /etc/systemd/system/ci-broker-runner@.service && ok "runnerctl ignores CI_BROKER_INSTALL_CONF" || no "the unit: $(grep ^User= /etc/systemd/system/ci-broker-runner@.service)"
CI_BROKER_INSTALL_CONF=/tmp/evil.conf bash $I --check >/tmp/check-env.out 2>&1
grep -q '/var/lib/cbx/admin cbx-admin:cbx-admin 700' /tmp/check-env.out && ok "install.sh ignores CI_BROKER_INSTALL_CONF" || no "install.sh --check read: $(head -3 /tmp/check-env.out)"

# ---------------------------------------------------------------- root never follows a daemon-owned link
section release
echo ci-brokerd.service >>/var/log/fake/active
refuse "a release whose drain fails cancels the drain and stops" "the drain failed: cancelled it" bash $I --release "$SHA"
sed -i '/^ci-brokerd.service$/d' /var/log/fake/active
[[ $(readlink /opt/cbx/current) == releases/$SHA-* ]] && ok "current did not move" || no "current: $(readlink /opt/cbx/current)"
CUR0=$(readlink /opt/cbx/current)
check "a second release (a code update)" bash $I --release "$SHA"
[[ $(readlink /opt/cbx/current) != "$CUR0" && $(readlink /opt/cbx/current) == releases/$SHA-* ]] && ok "current moved to the new release" || no "current: $(readlink /opt/cbx/current)"

section links
echo canary >/etc/canary && chmod 0600 /etc/canary
runuser -u cbx-admin -- ln -s /etc/canary /var/lib/cbx/local/planted
runuser -u cbx-admin -- sh -c 'mv /var/lib/cbx/admin/github-token /var/lib/cbx/admin/github-token.real && ln -s /etc/canary /var/lib/cbx/admin/github-token'
refuse "a symlink planted at github-token" "is a symlink" bash $I "${FLAGS[@]}"
runuser -u cbx-admin -- sh -c 'rm /var/lib/cbx/admin/github-token && mv /var/lib/cbx/admin/github-token.real /var/lib/cbx/admin/github-token'
runuser -u cbx-admin -- sh -c 'mv /var/lib/cbx/admin/.config/ascii/boat/config.json /tmp/boat.json && ln -s /etc/canary /var/lib/cbx/admin/.config/ascii/boat/config.json'
refuse "a symlink planted at the Boat config" "is a symlink" bash $I "${FLAGS[@]}"
runuser -u cbx-admin -- sh -c 'rm /var/lib/cbx/admin/.config/ascii/boat/config.json && cp /tmp/boat.json /var/lib/cbx/admin/.config/ascii/boat/config.json'
check "a re-run with a link inside local/ (never recursed into)" bash $I "${FLAGS[@]}"
REL=$(readlink -f /opt/cbx/current)/RELEASE
runuser -u cbx-admin -- sh -c "mv $REL $REL.real && ln -s /etc/canary $REL"
bash $I --check >/tmp/check-link.out 2>&1
grep -q canary /tmp/check-link.out && no "root read a daemon-owned RELEASE link" || ok "RELEASE is read as the daemon (a link to a root file shows nothing)"
runuser -u cbx-admin -- sh -c "rm $REL && mv $REL.real $REL"
[[ $(stat -c '%U %a' /etc/canary) == 'root 600' && $(cat /etc/canary) == canary ]] && ok "the canary is untouched" || no "canary: $(stat -c '%U %a' /etc/canary)"

# ---------------------------------------------------------------- runnerctl
section runnerctl
R=/usr/local/sbin/ci-broker-runnerctl
install -m 0755 /root/cib/ci/scripts/ci-broker-runnerctl $R # the test copy: the fake tarball's hash allowlisted
TOK=AAAAREGISTRATIONTOKEN1234
refuse "a bad id" "bad runner id" $R rm 'x;y'
refuse "a repo with .." "bad repo" $R add 'me/..' 1 n ci-broker 2.338.2
refuse "labels with a space" "bad labels" $R add me/app 1 n 'a b' 2.338.2
refuse "a version not allowlisted" "allowlist" $R dist 2.999.0
refuse "a dist whose hash differs" "is not the allowlisted" $R dist 9.9.9
check "dist 2.338.2 (hash-checked)" $R dist 2.338.2
check "dist leaves its sha256 marker" test -f /var/lib/cbx/runner-dist/2.338.2/.ci-broker-sha256
rm /var/lib/cbx/runner-dist/2.338.2/.ci-broker-sha256
$R dist 2.338.2 >/tmp/dist.out 2>&1
grep -q 'no matching sha256 marker: replacing it' /tmp/dist.out && [[ -f /var/lib/cbx/runner-dist/2.338.2/.ci-broker-sha256 ]] && ok "a dist dir without a matching marker is downloaded and verified again" || no "dist: $(cat /tmp/dist.out)"
refuse "a 600-byte token" "bad token" bash -c "printf '%0600d\n' 0 | $R add me/app 1 box-app-r1 ci-broker,box 2.338.2"
[[ ! -e /var/lib/cbx/runners/me__app-1 ]] && ok "a refused token leaves no runner dir" || no "a dir was made"

check "add reads one stdin line (the second is ignored)" bash -c "printf '%s\n%s\n' $TOK SECONDLINE | $R add me/app 1 box-app-r1 ci-broker,box 2.338.2"
D=/var/lib/cbx/runners/me__app-1
grep -q "token-env: $TOK$" $D/_diag/config.log && ok "the token reached config.sh in its env" || no "config.log: $(cat $D/_diag/config.log)"
grep -q 'SECONDLINE' $D/_diag/config.log && no "the second line was read" || ok "only one line read"
grep -q "$TOK" /tmp/ps.log 2>/dev/null && no "token in argv" || ok "the token in no argv"
grep -q 'argv: --unattended --url https://github.com/me/app --name box-app-r1 --labels ci-broker,box --work _work$' $D/_diag/config.log && ok "config.sh argv (no --replace)" || no "argv: $(grep argv $D/_diag/config.log)"
grep -q 'uid: cbx-runner' $D/_diag/config.log && grep -q 'umask: 0077' $D/_diag/config.log && ok "config.sh as cbx-runner, umask 077" || no "config.sh: $(cat $D/_diag/config.log)"
check "the runner dir is cbx-runner 0700" mode_is $D "cbx-runner:cbx-runner 700"
check ".credentials is 0600" mode_is $D/.credentials "cbx-runner:cbx-runner 600"
check ".env is root's 0644" mode_is $D/.env "root:root 644"
grep -qx 'ACTIONS_RUNNER_HOOK_JOB_STARTED=/opt/cbx/current/bin/cib-admit.sh' $D/.env && grep -qx 'CI_BROKER_GITHUB_SOCKET=/var/lib/cbx/sock/github.sock' $D/.env && grep -qx 'DOTNET_EnableDiagnostics=0' $D/.env && ok ".env content" || no ".env: $(cat $D/.env)"
grep -qx '/opt/cbx/current/bin:/usr/local/bin:/usr/bin:/bin' $D/.path && ok ".path content" || no ".path: $(cat $D/.path)"
jq -e '.[0] | .id == "me__app-1" and .repo == "me/app" and .name == "box-app-r1" and .version == "2.338.2"' /var/lib/cbx/runners.json >/dev/null && ok "the runners.json row" || no "runners.json: $(cat /var/lib/cbx/runners.json)"
grep -q 'enable --now ci-broker-runner@me__app-1.service' /var/log/fake/systemctl && ok "the unit enabled" || no "not enabled"
refuse "add refuses an existing dir" "exists in some form" bash -c "echo $TOK | $R add me/app 1 box-app-r1 ci-broker,box 2.338.2"
ln -s /etc /var/lib/cbx/runners/me__app-2
refuse "add refuses a symlink at the dir" "exists in some form" bash -c "echo $TOK | $R add me/app 2 box-app-r2 ci-broker,box 2.338.2"
rm /var/lib/cbx/runners/me__app-2
$R list | jq -e '.[0].active == "active"' >/dev/null && ok "list" || no "list: $($R list)"
check "stop <repo>" $R stop me/app
grep -q 'disable --now ci-broker-runner@me__app-1.service' /var/log/fake/systemctl && ok "stop = disable --now" || no "stop"
mkdir -p $D/ro/deep && chmod 0500 $D/ro/deep $D/ro
printf '#!/bin/sh\ntouch /tmp/runner-code-ran\n' >$D/config.sh
ln -s /etc/canary $D/link-out
$R rm me__app-1 </dev/null >/tmp/rm.out 2>&1 && ok "rm" || no "rm: $(cat /tmp/rm.out)"
[[ ! -e /tmp/runner-code-ran ]] && ok "rm runs nothing from the runner dir (a planted config.sh never ran)" || no "the runner dir's config.sh ran as part of rm"
grep -q 'delete the runner box-app-r1 on GitHub: https://github.com/me/app/settings/actions/runners' /tmp/rm.out && ok "rm prints the GitHub settings URL" || no "rm said: $(cat /tmp/rm.out)"
[[ ! -e $D ]] && jq -e 'length == 0' /var/lib/cbx/runners.json >/dev/null && ok "the dir (read-only parts too) and the row are gone" || no "after rm: $(ls -la /var/lib/cbx/runners)"
[[ $(stat -c '%U %a' /etc/canary) == 'root 600' ]] && ok "rm's chmod -R did not follow a link out" || no "canary changed by rm"
refuse "runnerctl as a non-root user" "run it as root" runuser -u op1 -- $R list

# ---------------------------------------------------------------- runner-start
section runner-start
mkdir -p /var/lib/cbx/runners/me__app-3
ln -sf /etc/passwd /var/lib/cbx/runners/me__app-3/.env
cp /etc/passwd /tmp/passwd.before
check "--prepare" /usr/local/lib/ci-broker/runner-start --prepare me__app-3
grep -qE '^\s*(chown|chmod) ' /usr/local/lib/ci-broker/runner-start && no "runner-start chowns or chmods by path in a dir the runner owns" || ok "runner-start has no chown/chmod after the create (no link swap can redirect one)"
check ".env from --prepare is root:root 0644 by the umask" mode_is /var/lib/cbx/runners/me__app-3/.env "root:root 644"
cmp -s /etc/passwd /tmp/passwd.before && [[ ! -L /var/lib/cbx/runners/me__app-3/.env ]] && ok "a planted .env link is unlinked, not followed" || no "/etc/passwd changed or the link stayed"
refuse "the run mode refuses uid 0" "refusing to run a runner as root" /usr/local/lib/ci-broker/runner-start me__app-3
refuse "a bad id" "bad runner id" /usr/local/lib/ci-broker/runner-start --prepare '../x'
rm -rf /var/lib/cbx/runners/me__app-3

# ---------------------------------------------------------------- systemd-analyze
section units
check "verify ci-brokerd.service" systemd-analyze verify ci-brokerd.service
check "verify ci-broker-pub-net.service" systemd-analyze verify ci-broker-pub-net.service
check "verify the runner unit (an instance)" systemd-analyze verify ci-broker-runner@me__app-1.service
rs=$(systemd-analyze security --offline=true /etc/systemd/system/ci-broker-runner@.service 2>/dev/null | grep -oE 'Overall exposure level for .*: [0-9.]+' | grep -oE '[0-9.]+$')
ds=$(systemd-analyze security --offline=true /etc/systemd/system/ci-brokerd.service 2>/dev/null | grep -oE 'Overall exposure level for .*: [0-9.]+' | grep -oE '[0-9.]+$')
awk -v s="${rs:-99}" 'BEGIN { exit !(s <= 1.7) }' && ok "the runner unit's exposure $rs ≤ 1.7" || no "the runner unit's exposure ${rs:-?} > 1.7"
[[ -n $ds ]] && ok "ci-brokerd.service exposure $ds (recorded)" || no "no score for ci-brokerd.service"

# ---------------------------------------------------------------- the daemon, the operator, the doors
section daemon
mkdir -p /srv/origins/op1 && rm -rf /tmp/app && mkdir /tmp/app && cd /tmp/app && git init -q -b main && echo v1 >f && git add f && git -c user.email=t@t -c user.name=t commit -qm one && git clone -q --bare /tmp/app /srv/origins/op1/app.git && APPSHA=$(git rev-parse HEAD) && chmod -R a+rX /srv/origins && cd /
runuser -u op1 -- mkdir -p /var/lib/cbx/operator/profiles/app
runuser -u op1 -- sh -c 'cat > /var/lib/cbx/operator/profiles/app/profile.json' <<'P'
{ "name": "app", "repo": "op1/app", "remoteScript": "remote.sh", "artifacts": ["out"],
  "local": { "where": "container", "image": "fake", "commands": { "one": "mkdir -p out && echo art > out/a.txt && echo ran-one" } },
  "modes": { "one": [{ "name": "one", "size": "default", "args": [] }] } }
P
runuser -u op1 -- sh -c 'echo true > /var/lib/cbx/operator/profiles/app/remote.sh'
check "tmpfiles made the one-daemon lock" test -f /run/lock/ci-brokerd.lock
DENV=(env -i HOME=/var/lib/cbx/admin PATH=/usr/local/lib/cbx:/usr/bin:/bin)
runuser -u cbx-admin -- "${DENV[@]}" /opt/cbx/current/bin/ci-brokerd >/tmp/daemon.log 2>&1 &
DPID=$!
for _ in $(seq 1 100); do [[ -S /var/lib/cbx/local/brokerd.sock ]] && break; sleep 0.1; done
check "the daemon made local.lock at start, 0660 cbx-admin:op1" mode_is /var/lib/cbx/local/local.lock "cbx-admin:op1 660"
check "the local socket is 0660 cbx-admin:op1" mode_is /var/lib/cbx/local/brokerd.sock "cbx-admin:op1 660"
check "the GitHub socket is 0660 cbx-admin:cbx-runner" mode_is /var/lib/cbx/sock/github.sock "cbx-admin:cbx-runner 660"
CB=/opt/cbx/current/bin/ci-broker
check "status as the operator" runuser -u op1 -- env -i HOME=/home/op1 PATH=/usr/bin:/bin $CB status
runuser -u op1 -- env -i HOME=/home/op1 PATH=/usr/bin:/bin $CB status >/tmp/status.out 2>&1
grep -q 'GitHub door' /tmp/status.out && no "banner: $(head -5 /tmp/status.out)" || ok "the GitHub door is open (no banner line)"
grep -q 'waiting for its job id seed' /tmp/status.out && ok "the banner says the fresh daemon waits for its id seed" || no "banner: $(head -4 /tmp/status.out)"
touch /tmp/hold && chmod 0666 /tmp/hold
runuser -u op1 -- env -i HOME=/home/op1 PATH=/usr/bin:/bin $CB local-lock -- sh -c 'touch /tmp/held; while [ -e /tmp/hold ]; do sleep 0.05; done' &
LPID=$!
for _ in $(seq 1 200); do [[ -e /tmp/held ]] && break; sleep 0.05; done
[[ -e /tmp/held ]] && ok "local-lock works before any job" || no "local-lock before the first job failed"
runuser -u cbx-admin -- flock -n /var/lib/cbx/local/local.lock true && no "the daemon took the slot the operator holds" || ok "local-lock from the operator excludes the daemon"
rm -f /tmp/hold
wait $LPID
check "admin-seed" runuser -u op1 -- env -i HOME=/home/op1 PATH=/usr/bin:/bin $CB admin-seed 1
[[ ! -e /var/lib/cbx/admin/state/await-seed ]] && ok "the seed cleared the wait" || no "await-seed still there"
runuser -u op1 -- bash -c "cd /home/op1 && env -i HOME=/home/op1 PATH=/usr/bin:/bin $CB submit --repo op1/app --sha $APPSHA --mode one --no-status --artifacts /home/op1/arts" >/tmp/submit.out 2>&1 && ok "a job submitted by the operator passed" || no "submit: $(tail -8 /tmp/submit.out | tr '\n' '|') daemon: $(tail -5 /tmp/daemon.log | tr '\n' '|')"
[[ $(cat /home/op1/arts/local/out/a.txt 2>/dev/null) == art ]] && ok "its artifacts arrived through files.tar" || no "no artifacts: $(ls -R /home/op1/arts 2>&1 | head) | job dir: $(ls -R /var/lib/cbx/admin/state/jobs 2>&1 | head -20 | tr '\n' ' ') | submit: $(tail -12 /tmp/submit.out | tr '\n' '|')"
sed -n '/^================ ci-broker/,$p' /tmp/submit.out | grep -q '/var/lib/cbx/admin' && no "the receipt printed the job dir" || ok "the receipt names no job dir"
runuser -u op1 -- ls /var/lib/cbx/admin/state >/dev/null 2>&1 && no "the operator can read the daemon's state" || ok "the operator can't read the daemon's state"
runuser -u mallory -- /usr/local/lib/cbx/node/bin/node -e 'require("net").connect("/var/lib/cbx/local/brokerd.sock").on("connect",()=>{console.log("connected");process.exit(0)}).on("error",e=>{console.log(e.code);process.exit(1)})' >/tmp/m.out 2>&1
grep -q EACCES /tmp/m.out && ok "an unrelated user gets EACCES on the local socket" || no "mallory: $(cat /tmp/m.out)"
runuser -u cbx-runner -- /usr/local/lib/cbx/node/bin/node -e 'require("net").connect("/var/lib/cbx/local/brokerd.sock").on("connect",()=>{console.log("connected");process.exit(0)}).on("error",e=>{console.log(e.code);process.exit(1)})' >/tmp/r.out 2>&1
grep -q EACCES /tmp/r.out && ok "the runner user can't reach the local socket" || no "runner: $(cat /tmp/r.out)"
refuse "a second split daemon" "another ci-brokerd holds /run/lock/ci-brokerd.lock" runuser -u cbx-admin -- "${DENV[@]}" /opt/cbx/current/bin/ci-brokerd
refuse "a single daemon while install.conf exists" "single daemon refuses to start" runuser -u op1 -- env -i HOME=/home/op1 CI_BROKER_CONFIG=/home/op1/none.json PATH=/usr/bin:/bin /opt/cbx/current/bin/ci-brokerd
refuse "a split daemon as the operator" "the daemon runs as cbx-admin" runuser -u op1 -- env -i HOME=/home/op1 PATH=/usr/bin:/bin /opt/cbx/current/bin/ci-brokerd

# ---------------------------------------------------------------- secrets and credentials from stdin
section secrets
printf 'secret-value-1' | bash $I --set-secret fetchToken >/tmp/s.out 2>&1 && ok "--set-secret" || no "--set-secret: $(cat /tmp/s.out)"
check "the secret file is root:cbx-admin 0640" mode_is /etc/cbx/secrets/fetchToken "root:cbx-admin 640"
[[ $(cat /etc/cbx/secrets/fetchToken) == secret-value-1 ]] && jq -e '.secrets.fetchToken == {}' /etc/cbx/config.json >/dev/null && ok "its value, and its name in config.json" || no "secret: $(cat /etc/cbx/config.json)"
echo ghp_NEWTOKENNEWTOKENNEWTOKEN12345678 | bash $I --set-credential github >/tmp/c.out 2>&1 && ok "--set-credential github" || no "$(cat /tmp/c.out)"
[[ $(cat /var/lib/cbx/admin/github-token) == ghp_NEWTOKENNEWTOKENNEWTOKEN12345678 ]] && check "the new token, cbx-admin 0600" mode_is /var/lib/cbx/admin/github-token "cbx-admin:cbx-admin 600" || no "token not replaced"
refuse "a junk credential" "does not look like" bash -c "echo 'not a token' | bash $I --set-credential github"

# ---------------------------------------------------------------- --uninstall
section uninstall
kill $DPID 2>/dev/null
wait $DPID 2>/dev/null
echo ci-brokerd.service >>/var/log/fake/active
refuse "--uninstall while the daemon runs" "the daemon runs" bash $I --uninstall
mkdir -p /etc/systemd/system/multi-user.target.wants && ln -sf /etc/systemd/system/ci-broker-runner@.service /etc/systemd/system/multi-user.target.wants/ci-broker-runner@x__y-9.service
sed -i '/^ci-brokerd.service$/d' /var/log/fake/active
check "--uninstall" bash $I --uninstall
for f in /etc/ci-broker/install.conf /etc/sudoers.d/ci-broker /etc/systemd/system/ci-brokerd.service /etc/systemd/system/ci-broker-runner@.service /usr/local/sbin/ci-broker-runnerctl; do
  [[ -e $f ]] && no "$f left" || ok "$f removed"
done
[[ -d /var/lib/cbx/admin && -d /opt/cbx && -f /etc/cbx/config.json ]] && ok "data dirs kept" || no "data dirs gone"
[[ ! -L /etc/systemd/system/multi-user.target.wants/ci-broker-runner@x__y-9.service ]] && ok "an enabled, unloaded runner's wants link is removed" || no "wants link left"
check "a fresh install after it" bash $I "${FLAGS[@]}"
check "--uninstall --purge" bash $I --uninstall --purge
[[ ! -e /var/lib/cbx && ! -e /opt/cbx && ! -e /etc/cbx ]] && ! getent passwd cbx-admin >/dev/null && ok "--purge removed the data and the users" || no "after purge: $(ls -d /var/lib/cbx /opt/cbx /etc/cbx 2>&1)"
echo DONE
