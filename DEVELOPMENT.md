# Developing test-broker

For someone changing the code. What it does and how to use it: [README.md](README.md) and
[docs/test-broker.md](docs/test-broker.md). The opt-in ci-broker: [ci/README.md](ci/README.md).

## Basics

- Node 24 or later runs the `.ts` files directly (type stripping). There is no build step and there are **no
  runtime dependencies**. `npm install` (or `pnpm install`) only adds `typescript` and `@types/node` for the
  typecheck.
- Use only erasable TypeScript: no enums, namespaces or parameter properties. Imports use `.ts` extensions.
- `npm test` runs `node --test` over `test/**/*.test.ts`. `npm run typecheck` runs `tsc --noEmit`.
- Run one file: `node --test test/tb/broker.test.ts`.
- `npm run test:root` runs ci-broker's root install scripts as root in a throwaway docker container
  (`test/ci/docker-root/`; needs the docker group, not sudo). Not part of `npm test`. Run it after any change under
  `ci/scripts/`, `bin/ci-*` or the units.
- A few ci-broker tests need Docker (local container runs); they fail on a machine without it or with a different
  user-namespace setup.

## Layout

| dir | what | may import |
|---|---|---|
| `src/core/` | shared by both brokers | only `src/core/` |
| `src/tb/` | test-broker | `src/core/`, `src/tb/` |
| `src/ci/` | ci-broker (opt-in, experimental) | anything |

`test/core/layout.test.ts` checks these rules. Tests mirror the layout: `test/core/`, `test/tb/`, `test/ci/`; fakes
and shared fixtures are in `test/` and `test/fixtures/`.

## Module map

Core (`src/core/`):

| file | does |
|---|---|
| `boat.ts` | the `Boat` interface and the Boat CLI wrapper (`CliBoat`) |
| `frames.ts` | turns `boat exec` JSON frames back into output and an exit code |
| `boatpool.ts` | a broker's own Boat pool: `setState`, `place`, budget, reconcile, idle stop, quarantine; reads `PoolCfg` |
| `boxes-db.ts` | the boxes table: `BoxTable` (on any open SQLite file), `BoxesDb` (a file with just that table), `BoxStore` |
| `boat-commands.ts` | the shell commands run on a box: run a shard through the wrapper, kill a slot, the seed probe, artifacts |
| `mirror.ts` | one bare mirror per repo (URL passed on every fetch, hooks/fsmonitor off); by-sha fetch; bundles; `cloneForRun`; gated gc; `isMerged`; per-repo mutex; `repoDir` |
| `snapshot.ts` | the working tree as a commit (temp index), head candidates, the bundle stream |
| `summary.ts` | shard results → the receipt (text, markdown, JSON) |
| `shell.ts` | `q`: shell single-quoting |
| `wrap/cib-wrap.sh` | the generic wrapper uploaded to every remote run |

test-broker (`src/tb/`):

| file | does |
|---|---|
| `cli.ts` | the `test-broker` client: `run` (ask, then run here, follow the Boat run, or exit 75), `ask`, `status`, `usage`, … |
| `main.ts` | test-brokerd: the machine config, the broker, the socket |
| `server.ts` | the unix socket: newline-delimited JSON; a connection holds its lease until it closes |
| `broker.ts` | answers asks, keeps the leases, hands Boat runs to the Boat side |
| `admit.ts` | the local half of an ask: locks, then load |
| `boat-side.ts` | the Boat half: reserve boxes, run shards, the queue, faults and re-runs |
| `repo-config.ts` | `.test-broker.json` |
| `machine-config.ts` | `~/.config/test-broker/config.json` over defaults; state and socket paths |
| `runs-db.ts` | `runs.db`: every run, box state changes, `boat limits` snapshots, probes |
| `usage.ts` | the `usage` report |
| `steer.ts` | steering heavy runs (sameTree, perWorktree, budget) |
| `eta.ts` | how long a shard takes (the queue's waits, the start cost) |
| `warm.ts` | the warm pool's target |
| `boxspeed.ts`, `probe.ts` | box speed scores, idle-box probes, box flags (drains) |
| `outage.ts` | the Boat outage pause |
| `housekeep.ts` | the state dir's disk use (compress, delete, seeds) |
| `logsum.ts` | a shard's output in short |
| `history.ts` | past run durations per repo + suite + where |
| `paths.ts` | the wrapper's path |

ci-broker shared (`src/ci/`):

| file | does |
|---|---|
| `cli.ts` | the `ci-broker` client: argument parsing, usage text, dispatch to the commands |
| `config.ts` | the two layouts: single's file, split's root `config.json` + the operator's `tuning.json` (allowlist, no path keys); trust validation; `reloadLive` at every submit; `resolveResources`, `serves` |
| `install-conf.ts` | the strict `install.conf` reader (same fixtures as the bash one), `derivePaths` (every split path) |
| `credentials.ts` | the daemon's GitHub token (file / `tokenCmd`), the env of each `gh`/`git`/`boat` child, job secrets, the secret ≠ credential check |
| `db.ts` | ci-brokerd's SQLite schema and every query (the boxes table through `core/boxes-db.ts`) |
| `profile.ts` | profiles (validation of every key; split: operator files read with O_NOFOLLOW into a daemon-owned snapshot), shard plans, `localCommand` (the `{cmd}` rule), the job key (lane, env class) and profile hash |
| `local.ts` | flocks (the local slot, the one-daemon lock), `dockerArgs` per lane, `nonoArgv`, container and host runs |
| `runner.ts` | `runner add/rm/ls/migrate` over `sudo -n ci-broker-runnerctl`, `update`, `switch-to-split`, `drain --wait`, single's `install` |

ci-broker daemon (`src/ci/daemon/`):

| file | does |
|---|---|
| `main.ts` | entry: the one-daemon flock, start refusals, the local socket (split: dir check), the GitHub door, recovery, timers, `--warm-mirrors` |
| `daemon.ts` | wires the parts together from `DaemonDeps` (incl. the trust parts); `status()`, `drain()`, `unblock()` |
| `github-api.ts` | `gh api -i` calls, the parser, strict readers (a missing field is `Missing`), rate limits, 5xx retries |
| `trust.ts` | the admission checks of both doors, the tier cache and offline rule, limits, the per-run cache, tickets |
| `local-door.ts` | the local door's admission and routes: `/hello`, `/trust*`, `/doctor`, `/daemon-log`, `/admin/seed`, the banner |
| `gh-door.ts` | the GitHub door: its socket, its route table, forced job fields, `run_uses`, tickets on reads |
| `watchdog.ts` | the tick (tiers, blocks, watch errors), the door re-check, the public-network probe, `unblock` under its mutex |
| `files-tar.ts` | `files.tar`: a regular-files-only walk of a job dir, streamed through `tar --no-recursion` |
| `ctx.ts` | `Ctx`: what the parts share (config, DB, injected clock, load, git, gh, lock) |
| `server.ts` | HTTP/1.1 + JSON over the unix socket; NDJSON streams |
| `jobs.ts` | submit (reuse / join / new), bundles, interests and pins, cancel, shard end (retry and attribution), job end, timeouts, retention |
| `scheduler.ts` | the scheduler loop: placement mode, fair turns, candidates per resource kind |
| `shard.ts` | runs a placed shard in the background; scrubbed output to the log and stream; abort |
| `resources.ts` | `Placement`, `Outcome`, the `Executor` interface, the kind order |
| `exec-local.ts` | a whole mode on this machine: a `--shared` clone, container or host, job secrets by name, regular-only artifacts, `removeTree` |
| `exec-boat.ts` | a shard on a Boat box: start, upload, run, kill, artifacts (the commands: `src/core/boat-commands.ts`) |
| `exec-ssh.ts` | a shard on an ssh host slot; the token line on stdin |
| `exec-github.ts` | a whole mode on GitHub-hosted CI: dispatch, find, poll, log, download, cancel |
| `checks.ts` | `ci-broker check`: the profile's check shard on one resource; health updates |
| `recovery.ts` | daemon start: re-queue running shards, kill leftovers, free slots |
| `statuses.ts` | commit statuses: rules, descriptions, posting with `gh api` |
| `stream.ts` | `stream.ndjson` per job: numbered events, replay, live subscribers |
| `scrub.ts` | token scrubbing, line by line |
| `timers.ts` | the tick, Boat reconcile + sweep, pruning |

ci-broker client (`src/ci/client/`):

| file | does |
|---|---|
| `http.ts` | transport over the socket: JSON requests, NDJSON streams, streamed upload, `files.tar` download; `PROTOCOL`; `TrustRefused` (exit 77); `pickClient` (split's socket, then single's); `GhDoorClient` (`/gh/*` with the run's claims and the ticket) |
| `admit.ts` | `ci-broker admit`: the pre-job hook's client (0 / 77 / 2) |
| `dispatch.ts` | `ci-broker dispatch`, `argsDigest` (shared with the daemon) |
| `submit.ts` | `ci-broker submit`: ask (waiting out a switch drain), bundle, follow with an interest (one re-submit when the daemon changed), receipt, `files.tar` for a split daemon, signals |
| `receipt.ts` | the receipt text and the exit code |
| `github.ts` | `--github` mode: stop-commands, groups, annotations, step summary, artifacts dir |
| `annotations.ts` | parses vitest and Playwright failures; escapes workflow command values |
| `commands.ts` | `status`, `jobs`, `show`, `logs`, `cancel`, `resources`, `check`, `gc`, `drain`, `doctor` |

## The scheduler loop (ci-broker)

- `Scheduler.wake()` asks for a pass. Passes never overlap. A wake during a pass runs one more pass after it.
- Wakes come from a submit, a shard end, a cancel, a resource change, and the 15 s tick.
- A pass decides only from DB state. It runs rounds until a round places nothing. Each round walks repos in turn, then
  each repo's jobs in turn, then each job's shards, and places at most one shard per repo.
- A job with no placement yet is one item. `tryJob` tries local whole, then each queued shard (ssh, then boat), then
  github whole.
- After every `await`, a `try*` method reads the job and shard again before it starts anything. The job may have been
  cancelled meanwhile.
- `start()` marks the shard `running`, writes a `place` event with its reason, and hands it to `ShardRunner`.
- When a shard ends, `Jobs.shardEnded` frees the box or slot, applies the retry and attribution rules, and wakes the
  scheduler.
- A job that can't be placed gets a `waitWhy`. `status` shows it.

## Box states and the one rule

Box states: `creating`, `resuming`, `idle`, `busy`, `stopping`, `stopped`, `quarantined`.

```
creating ──(boat new ok)──► busy ──(shard ends)──► idle ──(idle > idleStopSec)──► stopping ──► stopped
resuming ──(resume ok)────► busy                    idle ◄──(picked)── stopped ──(picked)──► resuming
any ──(infraFailLimit attributed failures; a busy box once its shard ends)──► quarantined ──(resources reset boat)──► stopped
```

**The rule:** every state change goes through `BoatPool.setState()`. It writes the DB **synchronously, before any
await**. So a box picked by one scheduler step is never picked by the next, and a pending start counts against the
budget at once. A create inserts its row (`creating`, name chosen up front) before `boat new` runs.

More invariants:

- Any missing or unknown result is a fail (`code: null` plus a reason). The receipt never says PASS on ambiguity.
- A failed shard with no reason from the daemon gets one from its log (`failReason` in `summary.ts`): a dev stack that
  never became healthy (and where its collected log is), the failing Playwright tests, the failing vitest packages or
  Tests line, else the last phase and its last output line.
- A shard's artifacts are only its own: the example remote script clears the slot's artifact paths before it runs,
  `artifactsCommand` removes an old tarball first, and each executor clears `artifacts/<shard>/` before it collects.
- The daemon never touches a box whose name does not parse with its own `daemonId` (`parseBoxName`). The one
  exception: it renames v0.1 boxes of known profiles once.
- Output is scrubbed line by line (`scrub.ts`) before it is written or streamed.
- Check a signal that may already be aborted before you start work. An `abort` listener added to an aborted signal
  never fires.
- Reconcile leaves a row alone if it changed while `boat list` ran. Transitional rows older than 10 min are re-read.

## Trust invariants

Keep these true; the tests pin each one.

- **The GitHub door trusts no field.** Every field of a `/gh/*` request is a claim that checks 1–15 verify with the
  daemon's own token. The daemon sets the job's source, label, lane, env class, door and status itself.
- **No git in a job dir.** The daemon runs git in a run's clone only while it is fresh; afterwards only `chmod -R`
  and `rm -rf` (also at recovery).
- **A job never writes a mirror.** Containers get their clone (rw) and the mirror's objects (ro), never the work root.
  Every mirror call runs with `core.hooksPath=/dev/null`, `core.fsmonitor=false`, `gc.auto=0` and an explicit URL.
- **trust.db is never reset.** Its changes are additive under its own `user_version`; a newer file refuses to start.
- **runnerctl takes no path, hash or text from its caller.** Every argument is checked against a fixed rule; the
  runner tarball hashes are inside it.
- **No name or path outside install.conf** (split). Config files have no path keys; root scripts read only
  `/etc/ci-broker/install.conf` (or its `.pending` while an install runs), never an env override.
- **In split the client and the daemon share no file but the sockets and the local lock.** Artifacts and logs cross
  as `files.tar`; receipts never print the job dir.
- **No job gets a daemon credential.** Credentials (GitHub token, Boat login) stay in the daemon's env and argv-free
  children; jobs get job secrets only, by name, only in the full lane (GitHub door: only with `envForGithubDoor`).
- **Root never runs operator code or follows a daemon-owned link.** install.sh runs from a root-owned copy, checks
  every path in a daemon- or operator-owned tree with `-L`, uses `chown -h`, and runs the tools and the release step
  as the daemon user.
- **Operator files never print their content.** Profiles and `tuning.json` are opened with O_NOFOLLOW, must be
  regular files the operator owns, and their errors name the file and key only. Every profile field that reaches a
  path or a `docker`/`boat` argument is checked (shard names, image, tmpfs, sizes, environment).
- **Tests never call real GitHub.** Under `node --test` the real `gh api` refuses to run; inject
  `DaemonDeps.ghApi` (the harness gives every daemon `FakeGithubApi`).

## The remote script contract

For each remote shard, the daemon uploads two files to `~/cib/<slot>/`: `cib-wrap.sh` (ours) and the profile's remote
script (as `remote.sh`). For a snapshot it also uploads `snapshot.bundle`. Then it runs:

```
CIB_REPO=… CIB_SHA=… CIB_SLOT=… CIB_BASE=… CIB_BUNDLE=… CIB_TOKEN_LINE=0|1 bash ~/cib/<slot>/cib-wrap.sh <sha> <args…>
```

| variable | meaning |
|---|---|
| `CIB_REPO` | `owner/name` |
| `CIB_SHA` | the commit to check out |
| `CIB_SLOT` | the slot number (always 0 on Boat) |
| `CIB_BASE` | snapshot only: a commit on origin the bundle is built against (may be empty) |
| `CIB_BUNDLE` | snapshot only: the path of `snapshot.bundle`; its one ref is `refs/cib/snap` |
| `CIB_TOKEN_LINE` | `1`: the first stdin line is a GitHub token (ssh with `githubTokenCmd`) |

The wrapper:

1. With `CIB_TOKEN_LINE=1`, reads one line into `GITHUB_TOKEN`. Then it closes stdin in every case.
2. Kills the leftover process group in `~/cib/<slot>/run.pid`.
3. Starts `remote.sh` with `setsid` and writes its process group id to `run.pid`.
4. When the script ends, kills what is left in its group and exits with the script's code.

`cib-wrap.sh --kill` kills the slot's group. The daemon uses it on cancel, timeout and a lost connection.

The profile script must:

- keep one clone per repo at `~/cib/repos/<owner>__<name>` and one `git worktree` per slot at
  `~/cib/<slot>/<owner>__<name>`;
- check out by sha. For a snapshot: fetch `CIB_BASE` from origin when it is set, then
  `git fetch "$CIB_BUNDLE" "+refs/cib/snap:refs/cib/slot-$CIB_SLOT"` (a ref per slot), then check out `CIB_SHA`;
- be idempotent: boxes are reused across repos and commits;
- check free disk before setup. Below `CIB_MIN_FREE_GB` (default 15), evict the least-recently-used other repos, then
  the package cache. Still below → exit 96;
- keep scratch per slot (the example: a per-slot `TMPDIR` and `TEST_PORT_BASE`);
- take `flock ~/cib/bootstrap.lock` around one-time system installs;
- write artifacts only under the checkout.

How the daemon reads the result:

| result | meaning |
|---|---|
| `0` | passed |
| any code in the profile's `infraExitCodes` | infra failure: retry once elsewhere |
| `96` | disk: infra failure, charged to the box or host at once |
| `255` from `ssh` or `boat exec`, or no exit status | the connection was lost: infra failure |
| anything else | failed |

The example's infra codes: 89 bootstrap, 90 no repo, 91 fetch, 92 checkout, 93 install, 96 disk
(`ci/profiles/example/remote-run.sh`). It is also a starting point for a test-broker `boat.remoteScript`.

## Writing a profile

`profiles/<name>/profile.json`:

| key | required | meaning |
|---|---|---|
| `name` | yes | the profile name (the directory name) |
| `repo` | yes | `owner/name` |
| `remoteScript` | yes | the script file in the profile dir |
| `modes` | yes | mode → a list of shards, or a string `"a + b"` that combines other modes |
| `boatEnvironment` | no | default: the boat resource's `environment` |
| `artifacts` | no | checkout-relative paths collected after each run if they exist (regular files inside the checkout only) |
| `github` | no | `{ "prMode": "<mode>" }`: the mode a PR run runs at the GitHub door (none: PR runs refused) |
| `infraExitCodes` | no | exit codes that mean "the environment failed" |
| `check` | no | shard args for `ci-broker check` (should still run the full setup path) |
| `status` | no | `false` turns off commit statuses |
| `local` | no | how to run a whole mode on this machine (below) |

A shard is `{ name, size, args, passArgs?, requireArgs? }`. The name follows the name rule
(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`; `local` and `hosted` are the daemon's):

- `size` is a Boat size (`small`, `default`, `large`, `xlarge`). ssh hosts filter on it with `sizes`.
- The shard runs `remote.sh <sha> <args…>`.
- `passArgs: true` appends the user's args.
- `requireArgs` is a usage line. A submit of the mode with no args is refused with it, so `int` and `cmd` never pass
  with nothing run.

`local`:

| key | meaning |
|---|---|
| `where` | `container` or `host` (`host` is refused in `split` and in the public lane) |
| `image` | container: the Docker image (a reference, never a flag) |
| `nono` | host: extra `nono run` args, or `false` for no sandbox |
| `nonoProfile` | `single`, host: `nono run -s --profile <p>` (a convenience, not a boundary) |
| `dockerRelax` | full lane: `["caps"]` drops `--cap-drop ALL` |
| `setup` | runs first in the fresh worktree |
| `commands` | mode → shell command; `{args}` = the user args quoted; `{cmd}` = one arg as is (a shell command on purpose), several args each quoted |
| `env` | variable → a job secret's name (e.g. `"GITHUB_TOKEN": "fetchToken"`); read at run time, handed to the container by name, never on a command line; never in the public lane |
| `tmpfs` | container: worktree-relative dirs mounted as tmpfs (e.g. `.wrangler`) |

A mode with no local command never runs locally.

Full-lane container runs share two Docker volumes: `ci-broker-pnpm-store` and `ci-broker-ms-playwright` (Playwright
browsers). The public lane gets per-repo ones (`ci-broker-pub-<owner>__<name>-pnpm`, `…-ms-playwright`).
The image seeds the browser volume the first time. A repo on a newer Playwright tops it up with
`playwright install chromium`.

The **profile hash** covers every file in the profile dir and is part of the job key. Any edit there makes old passes
not reusable.

## Testing

- Tests never touch real Boat, ssh or GitHub. They never touch `~/.config/test-broker`, `~/.config/ci-broker`, the real state dirs or running
  systemd units.
- `test/harness.ts` builds a daemon in a temp dir: test clock, local bare "origins", fake local slot and load,
  `FakeBoat`, fake `gh`. Tests drive the scheduler (`h.pass()`), the timers and the clock (`h.advance()`) directly.
- `test/fake-boat.ts`: an in-memory Boat. Each box has its own temp HOME, and `exec` runs real bash there (the real
  `cib-wrap.sh` and profile script). Its `scp` is strict like real `boat scp`: the destination directory must exist.
  `ShardControl` holds shard runs until the test ends them. `gate` holds create, resume and stop (transitional
  states). `budget`, `failStarts`, `failCreate` and `unreachable` inject the rest.
- `test/fake-ssh.ts`: real bash `ssh` and `scp` scripts. Each host is a directory used as HOME. A `<host>.down` file
  makes it unreachable (exit 255). Every call's argv is logged, so tests can assert no token is in argv.
- `test/fake-gh.ts`: an in-process `gh` behind the daemon's injected runner: statuses, `repo view`, `workflow run`,
  `run list/view/download/cancel`.
- `test/fake-github-api.ts`: the trust layer's `gh api -i`, built from the answers recorded from the real API in
  `test/ci/fixtures/github/` (the real parser reads them). Knobs: `offline`, `timeout`, `failNext`, `rateLimited`,
  `mutate` (null a field), `gate` (hold a call), `setRepo` (flip a repo at any moment). The harness answers every
  repo as private with push and pins `simple10` and `octo-other`.
- `test/ci/docker-root/`: the root tests. `all.sh` runs as root in the container (fakes for systemctl, curl, docker,
  gh, boat and the runner tarball) and prints `ok`/`FAIL` lines that `root-tests.ts` turns into tests.
- No sleeps and no bumped timeouts. Await the promise that resolves when the state is reached, or inject the wait.
- Tests that create git repos isolate git config (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`; the
  harness sets both). (Global hooks on a dev machine may refuse commits with an overridden author.)
- Never run `pkill -f "node --test"`. It also kills the shell that runs it.

## A scratch daemon

Run a second daemon against temp dirs to try a change by hand. Give it its own `daemonId`, or it would manage the
real daemon's boxes.

1. Make a temp dir:
   ```bash
   S=$(mktemp -d)
   ```
2. Write a config that uses only the local resource:
   ```bash
   cat > "$S/config.json" <<EOF
   { "daemonId": "scratch", "stateDir": "$S/state",
     "resources": [{ "id": "local", "kind": "local", "profiles": ["*"] }] }
   EOF
   ```
3. Start the daemon:
   ```bash
   CI_BROKER_CONFIG="$S/config.json" node src/ci/daemon/main.ts
   ```
4. In another shell, use the client with the same config:
   ```bash
   CI_BROKER_CONFIG="$S/config.json" node src/cli.ts status
   ```
5. Stop it with Ctrl-C. Remove `$S` when done.

Its local slot is a different flock (`$S/state/local.lock`), so it does not wait for the real daemon's local runs.
On a machine with a `split` install, also set `CI_BROKER_INSTALL_CONF=/nonexistent` and give it its own
`daemonLockPath` in the config (a single daemon refuses to start while `install.conf` exists, and both layouts flock
`/run/lock/ci-brokerd.lock`). It asks GitHub for tiers with the operator's `gh` token (`tokenCmd`).
Add a boat resource only on purpose: it spends real Boat starts.

## Consumer workflows

Lint `ci/workflows/*.yml` after you edit them. GitHub reports a broken workflow only as a failed run with no jobs.

```bash
actionlint -config-file <(printf 'self-hosted-runner:\n  labels: [ci-broker]\n') ci/workflows/broker.yml ci/workflows/ci-broker-hosted.yml
```

## A Bun port

Three modules import `node:sqlite`: `src/core/boxes-db.ts`, `src/tb/runs-db.ts` and `src/ci/db.ts`. A Bun port swaps
those files (to `bun:sqlite`) and the test runner. Keep every query behind them.
