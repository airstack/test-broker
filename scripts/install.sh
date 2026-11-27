#!/usr/bin/env bash
# Install test-broker for the current user from this checkout's HEAD, then (re)start its user unit. No root.
#   ~/.local/share/test-broker/releases/<sha>/   the code (git archive of HEAD)
#   ~/.local/share/test-broker/current           -> the release in use
#   ~/.local/bin/test-broker                     -> current/bin/test-broker
#   ~/.config/systemd/user/test-brokerd.service  runs current/bin/test-brokerd
# A restart drops every lease (running local commands go on, unleased) and cancels running Boat runs.
set -euo pipefail
src=$(cd "$(dirname "$0")/.." && pwd)
[ -z "$(git -C "$src" status --porcelain --untracked-files=no)" ] || { echo "install: $src has uncommitted changes" >&2; exit 1; }
sha=$(git -C "$src" rev-parse HEAD)
node=$(command -v node) || { echo "install: node is not on PATH" >&2; exit 1; }
boat=$(command -v boat || true)
# the Boat repo gate asks GitHub through gh (its own login): without gh on the unit's PATH no repo goes to Boat
gh=$(command -v gh || true)
[ -n "$gh" ] || echo "install: WARNING: gh is not on PATH; the Boat repo gate will refuse every repo" >&2
base=${XDG_DATA_HOME:-$HOME/.local/share}/test-broker
dest=$base/releases/$sha
if [ ! -d "$dest" ]; then
  tmp=$base/releases/.tmp-$sha
  rm -rf "$tmp" && mkdir -p "$tmp"
  git -C "$src" archive HEAD | tar -x -C "$tmp"
  echo "$sha" > "$tmp/RELEASE"
  mv "$tmp" "$dest"
fi
ln -sfn "$dest" "$base/current"
mkdir -p "$HOME/.local/bin"
ln -sfn "$base/current/bin/test-broker" "$HOME/.local/bin/test-broker"
unit_dir=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
mkdir -p "$unit_dir"
path="$(dirname "$node")${boat:+:$(dirname "$boat")}${gh:+:$(dirname "$gh")}:/usr/local/bin:/usr/bin:/bin"
sed -e "s|@BIN@|$base/current/bin/test-brokerd|" -e "s|@PATH@|$path|" "$src/scripts/test-brokerd.service" > "$unit_dir/test-brokerd.service"
systemctl --user daemon-reload
systemctl --user enable test-brokerd.service >/dev/null
systemctl --user restart test-brokerd.service
for _ in $(seq 50); do "$HOME/.local/bin/test-broker" status --json >/dev/null 2>&1 && break; sleep 0.2; done
echo "test-broker ${sha:0:7} installed; daemon: $(systemctl --user is-active test-brokerd.service)"
# old releases: keep the newest 3
ls -1dt "$base"/releases/*/ 2>/dev/null | tail -n +4 | xargs -r rm -rf
