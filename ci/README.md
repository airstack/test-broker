# ci-broker (opt-in, experimental)

> **Status: experimental and parked.** ci-broker works, and its tests pass, but it is not supported for beta testers
> yet. test-broker (the [main README](../README.md)) does not need it: `scripts/install.sh` never installs it.

ci-broker is a queueing test broker with a GitHub door: GitHub Actions jobs on self-hosted runners hand their test
runs to it. To try it, install it yourself: the `single` layout with `bin/ci-broker install` (no root, no runners), or
the `split` layout with `ci/scripts/install.sh` as root (needed for runners). Both are described below. Its code is
in `src/ci/`; it shares `src/core/` with test-broker.

`ci-brokerd` is one test broker daemon per machine. It owns a pool of **resources**: places where a test run can
happen. The resources are this machine (the **local slot**), Boat sandboxes (**boxes**), VPSes reached over ssh, and
GitHub-hosted CI. You set up each external resource by hand as a copy of this machine's environment. Agents and
`just` recipes talk to the daemon with the `ci-broker` client over the local socket. GitHub talks to it through
self-hosted runners on this machine, which run as their own user and reach only the GitHub door, where every claim
is checked with the daemon's own token (see [Trust](#trust-who-may-make-the-broker-run-what)). Daemons on different
machines never see each other.

```
 this machine                                      external: set up by hand as copies of this machine's env
┌───────────────────────────────────────────┐
│ ci-brokerd  (split: cibroker-admin)       │     ┌─ Boat boxes  cib-<daemon>-<env>-<size>-<rand>  (any repo)
│  • queue + fair scheduler                 │─────┼─ VPS "vps1" (ssh)   slots: 2
│  • resource registry + health             │     ├─ VPS "vps2" (ssh)   slots: 1
│  • its own credentials (gh token, Boat)   │     └─ GitHub-hosted CI (workflow_dispatch; opt-in fallback)
│  • the local slot: container | host       │
│  • SQLite state, one dir per job          │
└────────▲───────────────────────▲──────────┘
         │ the local door        │ the GitHub door (checks every claim; runner user cibroker-runner)
   ci-broker submit         self-hosted GitHub runner job: `exec ci-broker submit --github …`
   (agents, just recipes)   (live log, check, summary, annotations, artifacts, like any CI job)
```


## Trust: who may make the broker run what

**The rule: ci-broker runs a job only if someone we trust asked for it, for code that is ours.** "Someone we
trust" is a local process of the operator user, or a GitHub account on the approved list. "Code that is ours" is a
repo that has a profile here and that the daemon's GitHub credential can push to.

**Two doors.**

| door | socket | who | what is checked |
|---|---|---|---|
| local | `split`: `/var/lib/ci-broker/local/brokerd.sock` (the operator's group); `single`: `~/.local/state/ci-broker/brokerd.sock` | the operator's processes (agents, recipes) | names, the profile is the repo's, blocks, the repo's tier |
| GitHub | `/var/lib/ci-broker/sock/github.sock` (`split` only; the runner user's group) | the runners | everything: every field is a claim, checked live with the daemon's own token (15 checks) |

**Tiers and lanes.** The tier comes from GitHub (`GET /repos/{repo}` with the daemon's token), never from config.

| tier | means | local door | GitHub door |
|---|---|---|---|
| `private` | private, and our token can push | the **full** lane (local slot, ssh, Boat, GitHub-hosted, statuses) | full, after the run checks |
| `public` | public, and we can push | the **public** lane: the local container, locked down; Boat only in root's public environment (below) | refused (`repo-tier`) |
| `none` | no push, not found, renamed | refused (`repo-access`) | refused (`repo-access`) |

The local door caches the tier (`2 × watchSec`). If GitHub is unreachable it uses a tier up to 24 h old, else the
public lane: the lane can fall, never rise. The GitHub door never uses the cache.

**The approved list** lives only in root's `/etc/ci-broker/config.json` (`trust.githubUsers`, per repo
`trust.repos.<repo>.githubUsers`, which replaces the global list). Entries are pinned by account id:
`{ "login": "simple10", "id": 104495 }`. A plain string never matches (`doctor` warns). A GitHub-door run passes
only when the run is `broker.yml` on our runner, its event is `pull_request` or `workflow_dispatch`, and `actor`,
`triggering_actor` (and for a PR, the PR author) are approved `User` accounts. A PR must come from a branch of the
repo against the default branch and must not touch `.github/`. A dispatch must run from the default branch; its sha
must be merged, or the head of an open PR by an approved author; its mode, sha and args are bound through the run
name (`ci-broker dispatch`).

**Refusals** are loud: an error naming the check, `ci-broker: REFUSED (trust/<check>): <reason>`, **exit 77**, a
log line and a `trust log` row. In a runner job the reason is also an annotation on the run. 77 always means a
trust refusal: the client's exit code comes from the job state, never from a test (a shard exiting 77 is a failed
shard and the client exits 1).

**Credentials and job secrets** are two classes. Credentials are the daemon's own (its GitHub token, its Boat
login); no job ever gets one. Job secrets are values a job may receive (`local.env` names them; root sets them with
`install.sh --set-secret`); the operator can read any of them. `doctor` refuses a job secret equal to the daemon's
GitHub token. The public lane never gets job secrets; a GitHub-door job only with root's
`trust.repos.<repo>.envForGithubDoor`.

**The local lane, hardened.** Every local run gets its own `--shared` clone; the container sees only that clone (rw)
and the mirror's objects (read-only), never the work root, with `--cap-drop ALL`, `no-new-privileges` and a pids
limit. The daemon never runs git in a dir a job had, and passes the URL on every mirror fetch (hooks and fsmonitor
off). Artifacts are regular files inside the checkout only (the rest goes into `SKIPPED.txt`). The public lane runs
on the `ci-broker-pub` network (the internet, not this machine or private ranges) with per-repo volumes.

**The public lane on Boat** (opt-in, per repo). Root sets `trust.repos.<repo>.publicBoat` to a Boat environment that
injects nothing (`boat env set <env> --safe-for-third-parties true`: no GitHub access, secrets, files, variables,
repos or AI credentials). When the local slot is busy, the repo's public-lane shards then go to boxes of that
environment, never ssh or GitHub-hosted. The environment comes from root, never from the profile, and serves that one
repo; a full-lane job never uses it, nor any box marked public. Each pick checks the environment (`boat env info`,
at most every 30 s), and the executor checks it again just before a run: an environment that injects anything keeps
the job off Boat (a `TRUST` log line). A box is used only when it was made for this repo's public lane and Boat still
lists it at the version it was first listed at, the version just checked; any other box of the environment is
deleted once idle (it may hold what another version injected). Never `boat env upgrade` a public environment. The
box gets no token, and no artifacts come back from it; a snapshot travels as a bundle and the base comes from the
public repo. `trust.publicBoatMaxBoxes` (4) caps the boxes over all public environments (a quarantined box does not
count).

**The watchdog** (every 5 min) re-checks every repo we serve. A repo with runners or full-lane jobs that stops
qualifying (turns public, loses push, is gone) is **blocked**: its jobs fail, both doors refuse it, and `status`
prints the command that stops its runners (`sudo -n ci-broker-runnerctl stop <repo>`; the daemon has no sudo).
`ci-broker trust unblock <repo>` lifts it once the repo is private again.

| command | does |
|---|---|
| `ci-broker trust` | the approved lists, each known repo's tier and lane, runners, blocks |
| `ci-broker trust log [--limit N] [--repo R]` | refusals, GitHub-door admissions, offline fallbacks |
| `ci-broker trust check <owner/name>` | the local-door checks now, one line per check |
| `ci-broker trust check --run <owner/name> <runId> [--attempt N]` | replays the GitHub-door checks against the live API |
| `ci-broker trust unblock <owner/name>` | after review |
| `ci-broker dispatch --sha S [--mode M] [-- args…]` | `gh workflow run broker.yml` with the args digest in the run name |
| `ci-broker daemon-log [-f] [-n N]` | the daemon's own log, scrubbed |

**Limits** (stated, not solved; the spec has the full list): local agents are trusted callers; while the operator is
in the `docker` group the split hides the daemon's keys from normal access only (`status` says so); on day one the
daemon's GitHub token is a copy of the operator's; all runners are one Unix user; a job can change its runner for
later jobs on it; the runner user and the public lane have internet egress.

## How a job is placed

A **job** is one request: a repo, a **profile** (the per-repo recipe in `ci/profiles/<name>/`), a **mode** (for example
`test-all`) and optional args. A profile splits each mode into **shards**: parts that can run on separate machines.

The scheduler picks a placement for each job. It decides again on every pass until the first shard starts. Then the
placement is fixed.

1. **Local whole.** The job runs as one shard on this machine when all of these are true:
   - the local slot is free;
   - the 1-minute load is below `localMaxLoadFactor` × CPU count;
   - the profile has a local command for the mode;
   - local is not marked failing for the profile.
2. **Sharded.** At least one remote resource can take a shard now. The mode's shards then go remote. Shards that
   can't be placed yet wait for capacity.
3. **Wait.** Otherwise the job waits, and the scheduler tries again on the next pass.

Resources are used in a fixed order: **local → ssh → boat → github**. Owned machines come first because they cost
nothing. GitHub-hosted comes last because it costs money. A sharded job's shards try ssh, then boat:

- **ssh:** the lowest free slot on a host whose `sizes` include the shard's size. A host with no `sizes` takes any size.
- **boat:** an idle running box of the exact size, preferring one that last ran this repo. Else a stopped box of the
  size (a **resume**). Else a new box (a **create**).

A job with no shard started can go to **github** as a last resort: only for modes the resource lists, only for pushed
commits, and only after the job has waited `afterWaitSec`. One dispatch runs the whole mode.

**Start budget.** Boat allows 200 starts per rolling 24 hours, and a resume counts as a start. The daemon resumes or
creates a box only while more than `startsReserve` (20) starts would be left, after it subtracts the starts still in
progress. It reads `boat limits` before a start. A failed read means no start. The daemon never has more than the
resource's `maxBoxes` usable boxes, running or stopped. A quarantined box does not count: a new box takes its place.
With the quarantined ones, the pool holds at most 2 × `maxBoxes` boxes; past that, it deletes the oldest quarantined
box. At the cap, it deletes the least-recently-used stopped box of another size first. A delete costs no start.

**Fair turns.** On each pass the scheduler walks the queued shards in this order: repos take turns, starting after
the repo it served last; inside a repo, jobs take turns; inside a job, shards go in plan order. It places at most one
shard per repo per round. It repeats rounds until one places nothing. A shard that can't be placed does not block the
others.

**Retries.** An **infra failure** is a failure of the environment, not of the tests: no exit status, an unreachable
resource, or an exit code in the profile's `infraExitCodes`. The shard is re-queued once, as attempt 2, and avoids
that box or host. If attempt 2 fails with the same code, the commit is at fault: the shard is `failed`.

**Timeouts.** A shard queued longer than `queueTimeoutSec` (1 h) ends the job as `error`. A shard running longer than
`shardTimeoutSec` (2 h) is killed and marked `failed (timeout)`.

## Using it from a repo

Run it inside a checkout:

```bash
ci-broker submit                                   # mode `all` for the working tree
ci-broker submit --mode test-all
ci-broker submit --mode e2e -- tests/api/context-lists.spec.ts
ci-broker submit --mode cmd -- 'just typecheck'
just test-remote --mode e2e -- tests/e2e/login.spec.ts   # a just recipe that runs `ci-broker submit "$@"`
```

All flags:

```
ci-broker submit [--repo <path|owner/name>] [--profile P] [--mode M] [--sha S] [--force] [--no-status]
                 [--github] [--artifacts <dir>] [--label <text>] [--detach] [-- args…]
```

- The profile defaults to the repo name. The mode defaults to `all`.
- `--repo` takes a checkout path or `owner/name`. With `owner/name` and no checkout here, `--sha` must be a full sha.
- `--artifacts <dir>` copies the job's artifacts into that directory at the end.
- `--label <text>` is a note shown in `status` and `jobs`.

**Snapshots.** Without `--sha`, the client runs the **working tree**: HEAD plus uncommitted changes plus untracked
files that git does not ignore. It builds a **snapshot commit** from a copy of the index. Your index, branches and
stash do not change. It works in a git worktree and without a git identity. New files over `snapshotMaxFileMb` (50 MB)
are refused, with their names. A clean tree is submitted as HEAD itself. You do not have to push first. If the daemon
does not have the commit, the client sends a git bundle of only the commits it lacks. Keep secrets gitignored: a
snapshot includes every untracked file that is not ignored.

**Reuse and join.** The **job key** is the repo, profile, profile hash, mode, tree and args. The tree is the content,
not the commit, so the same files under another commit match.

- A passed job with the same key in the last `retentionDays` (14) → **reused**. The client prints its receipt at once.
  `--force` runs it again.
- A queued or running job with the same key → **joined**. The client follows that job.

**Receipt.** When the job ends, the client prints a **receipt**: each shard's PASS or FAIL, where it ran, its time,
totals, failure excerpts, the job id, and whether a commit status was posted.

**Exit codes.** `0` passed, `1` failed, `2` error (no result could be produced, or the daemon is not running),
`130` cancelled.

**Interest and Ctrl-C.** A submit that waits holds an **interest**: an open stream that keeps the job alive.

- Ctrl-C (or SIGTERM) withdraws the interest. When the last interest is gone, the daemon cancels the job. The client
  waits up to 20 s for `cancelled`, then exits 130.
- Ctrl-C before the daemon answers or during the bundle upload also stops the submit. A job without its bundle is
  cancelled.
- If the stream drops (for example, the daemon restarts), the client reconnects for up to `interestGraceSec` (30 s).
  The job keeps running in that time.
- `--detach` **pins** the job: it runs to the end with nobody waiting. The client prints the job id and exits 0.
  Follow it with `ci-broker logs <job> -f`. Stop it with `ci-broker cancel <job>`.
- `ci-broker logs -f` holds no interest. It never keeps a job alive.

## GitHub CI

The self-hosted runners on this machine run as their own Unix user (`cibroker-runner`, `split` only) under hardened
system units, and reach the daemon only through the GitHub door. A pre-job hook (`bin/cib-admit.sh`, set by
root in each runner's `.env`) asks the door whether the job may run before its first step; a refused job fails at
"Set up runner" with the reason as an annotation. A runner job only waits on the daemon. The workflow step runs
`exec ci-broker submit --github --repo … --sha … --mode … -- args…`. It needs `exec` so that GitHub's cancel signal
reaches the client. The daemon decides the job's label, source and status; the client's are ignored.

`ci/workflows/broker.yml` is the template:

- `workflow_dispatch` with inputs `sha`, `mode` (default `all`), `args` (a JSON array) and `argsHash`. Start it with
  `ci-broker dispatch --sha <sha> [--mode M] [-- args…]`: it fills `argsHash` (the sha256 of the compact JSON args, `-`
  for none), which the run name carries (`broker <mode> <sha> <argsHash>`) and the daemon checks.
- `pull_request`: runs the profile's `github.prMode` (example: `all`) on the PR **head** sha while the PR has the
  **`ci-broker-test`** label. It runs again on every push. A new push cancels the previous label run. Dispatch runs
  never cancel each other. A PR that touches `.github/` is refused: test it by dispatch.
- `runs-on: [self-hosted, ci-broker]`, `timeout-minutes: 240`.
- An `actions/upload-artifact` step for `ci-broker-artifacts/`.

What shows in GitHub:

- the live log, each line prefixed `[shard]`;
- the log of each failing shard again, in a group (the last 2 MB);
- up to 10 failures as `::error` annotations (vitest and Playwright lines are parsed);
- the receipt in the step summary (capped at 900 KB);
- the artifacts and every shard log, uploaded as `ci-broker-<run id>-<attempt>`;
- the step result: the job's pass or fail.

Test output can't run workflow commands: the client stops them (`::stop-commands::`) while it streams.

**Required check.** Make the commit status `ci-broker/<mode>` (for example `ci-broker/all`) the required check, not the
workflow job. The daemon posts that status for a full run from a local agent or a GitHub job alike.

## Commit statuses

A **commit status** is the sign-off. Context: `ci-broker/<mode>`. A submission asks for one when all of these are true:

- the commit is pushed (a snapshot has no commit on origin to mark);
- the profile does not set `"status": false`, and `--no-status` was not given;
- there are no args (a filtered run must not sign off the whole mode; the receipt says so).

The state is `success`, `failure` or `error`. A cancelled job posts nothing. The description reads like
`7/7 shards passed in 8m57s (job devbox-41)` or `reused job devbox-41 (same tree)`. The daemon posts when the job
ends, or at once for a reused job. A failed post is logged and shown in the receipt. It never changes the job result.

## Install on a machine

Two layouts. **`split`** (needed for runners): the daemon runs as `cibroker-admin` (a system unit) with its own
credentials, state and Boat login; runners run as `cibroker-runner`; root's config holds trust, credentials and job
secrets; the operator keeps profiles and `tuning.json` in `/var/lib/ci-broker/operator/`. **`single`** (no root, no
runners): everything as the operator, as below. Switching means uninstalling one and installing the other.

### `split` (from an admin account; the operator has no sudo)

Root never runs a script from the operator's checkout. Copy the commit into a root-owned dir, compare its tree hash
with GitHub's (`gh api repos/airstack/test-broker/commits/<sha> --jq .commit.tree.sha`), read the dry run, then
install:

```bash
S=<sha> D=/root/ci-broker-<sha>; sudo sh -c "rm -rf $D && mkdir -m 0700 $D && runuser -u dev -- git -C /home/dev/test-broker -c tar.umask=022 archive $S | tar -x --no-same-owner -C $D && cd $D && git init -q && git add -Af && echo sha $S tree \$(git write-tree) && rm -rf .git"
sudo bash /root/ci-broker-<sha>/ci/scripts/install.sh --operator dev --release <sha> --approve simple10 --approve octo-other --dry-run
sudo bash /root/ci-broker-<sha>/ci/scripts/install.sh --operator dev --release <sha> --approve simple10 --approve octo-other
```

It makes the users, dirs, `/etc/ci-broker/install.conf` (every user name and path; nothing else names one),
`/etc/ci-broker/config.json` (create-only), the pinned tools (`node`, `gh`, `boat`), the daemon's GitHub token (a
copy of the operator's) and Boat login (a device code to sign in), the root scripts, the units
(`ci-brokerd.service` installed **disabled**; a re-run keeps it enabled once you started it), the public network, the tmpfiles lock and the sudoers rule
(`dev ALL=(root) NOPASSWD: /usr/local/sbin/ci-broker-runnerctl`), builds the first release into
`/opt/ci-broker`, and ends with `--check`. It needs `jq`; the pinned node needs `libatomic1`. Other modes:
`--check`, `--release <sha>` (code updates are root's; `ci-broker update --checkout <your checkout>` prints the command), `--set-secret <name>`
(stdin), `--set-credential github|boat`, `--uninstall [--purge]`. Then `sudo -n ci-broker-runnerctl daemon start`
starts the daemon (the rollout does this through `ci-broker switch-to-split`). A fresh install's daemon takes no job
until its job ids are seeded: the switch does it; on a new machine, `ci-broker admin-seed 1`.

### `single`

Needs Node 26 (for `node:sqlite`), git, `flock`, `jq`, `gh` (logged in), the Boat CLI at `~/.local/bin/boat` (logged
in) and Docker (for local container runs). A public repo is refused in `single` (the public lane needs `split`).

1. Clone the repo:
   ```bash
   git clone git@github.com:airstack/test-broker.git ~/test-broker && cd ~/test-broker
   ```
2. Install the commands and the service. This links `~/.local/bin/ci-broker` and `~/.local/bin/ci-brokerd`, writes
   `ci-brokerd.service`, and starts it:
   ```bash
   bin/ci-broker install
   ```
3. Keep user services running after you log out:
   ```bash
   loginctl enable-linger "$USER"
   ```
4. Build the image for local example runs:
   ```bash
   docker build -t ci-broker-example ci/profiles/example
   ```
5. Optional: write `~/.config/ci-broker/config.json` (see [Config](#config)). With no file, the resources are
   `local` and `boat` for every profile.
6. Check the setup:
   ```bash
   ci-broker doctor
   ```

## Add a repo

1. Write a profile in `ci/profiles/<name>/` (`split`: `/var/lib/ci-broker/operator/profiles/<name>/`): `profile.json`,
   the remote script it names, and a Dockerfile for local runs. See `ci/profiles/example/` and `DEVELOPMENT.md`. The
   profile name defaults to the repo name; a profile serves only its own `repo`. `local.env` names job secrets
   (`{ "GITHUB_TOKEN": "fetchToken" }`), never commands; `github.prMode` is the mode a PR run runs.
2. Give the Boat environment access to the repo. Add the repo to the environment in Boat's UI (the default shared
   environment is `example`). Then add the profile to the boat resource's `profiles` (or keep `"*"`).
3. Register runners (`split` only). The repo must be private (checked live) and its approved list should have a
   pinned entry. The `gh` account here is not an admin, so get a registration token from the repo's *Settings →
   Actions → Runners → New self-hosted runner* page and pass it on stdin (never argv):
   ```bash
   ci-broker runner add <owner>/<name> --token-stdin       # 8 runners by default; --count N
   ```
4. In the repo, copy `ci/workflows/broker.yml` to `.github/workflows/broker.yml`. It must reach the default branch for
   `workflow_dispatch` to work.
5. In the repo, add a recipe:
   ```just
   [positional-arguments]
   test-remote *ARGS:
       ci-broker submit "$@"
   ```
6. Optional: for a `github` resource, copy `ci/workflows/ci-broker-hosted.yml` to `.github/workflows/` and fill in its two
   marked steps.
7. Check each resource for the new profile:
   ```bash
   ci-broker check boat <name>
   ```

`ci-broker runner ls` lists the runners. `ci-broker runner rm <owner>/<name>|<id>` removes them here (it runs
nothing from a runner dir) and prints the settings URL where you delete them on GitHub. Root's work goes through
`sudo -n ci-broker-runnerctl`, which checks every argument and takes no path, hash or text from its caller.

## Resources

The `resources` key in the config lists what the daemon may use. `profiles` says which repos a resource is set up
for (`"*"` = any). The order in the list does not matter: the order of use is always local → ssh → boat → github.

```jsonc
{
  "daemonId": "devbox",
  "resources": [
    { "id": "local", "kind": "local", "profiles": ["*"] },
    { "id": "boat",  "kind": "boat",  "profiles": ["example"], "environment": "example", "maxBoxes": 10 },
    { "id": "vps1",  "kind": "ssh",   "profiles": ["example"], "host": "vps1", "slots": 2,
      "sizes": ["default", "large"], "githubTokenCmd": "cat ~/.config/ci-broker/vps1-pat" },
    { "id": "gh",    "kind": "github", "profiles": ["example"], "workflow": "ci-broker-hosted.yml",
      "modes": ["test-all"], "afterWaitSec": 900 }
  ]
}
```

| key | kinds | default | meaning |
|---|---|---|---|
| `id` | all | (required) | the name in `status`, `check` and `resources reset` |
| `kind` | all | (required) | `local`, `boat`, `ssh` or `github` |
| `profiles` | all | `["*"]` | the profiles it is set up for |
| `environment` | boat | each profile's `boatEnvironment` | the Boat environment new boxes use |
| `maxBoxes` | boat | 10 | the cap on this daemon's usable boxes, running or stopped (quarantined ones do not count; 2 × this in all) |
| `host` | ssh | the `id` | the ssh destination (a `Host` in `~/.ssh/config`) |
| `slots` | ssh | 1 | shards that run on the host at once, each in `~/cib/<slot>/` |
| `sizes` | ssh | any | the shard sizes the host takes |
| `githubTokenCmd` | ssh | none | a local command whose output is a token for the remote script |
| `workflow` | github | (required) | the workflow file in the repo |
| `modes` | github | none | the modes it may run |
| `afterWaitSec` | github | 900 | how long a job waits for other resources first |

- **local** has one slot per machine. `ci-broker local-lock -- <cmd…>` takes the same slot for any heavy command.
- **ssh** uses this machine's `~/.ssh/config` with `BatchMode=yes`. With `githubTokenCmd`, the token goes to the
  remote script on the first line of the ssh stdin, never in argv. Use a **fine-grained, read-only PAT** (Contents:
  read) for only the repos it needs. Never use the account's `gh auth token`. No command means no token.
- **github** needs `ci/workflows/ci-broker-hosted.yml` on the repo's default branch. It costs Actions minutes, so list
  only the modes worth it.

Changes to the config take effect when the daemon restarts (see `ci-broker drain` below).

## Health checks and quarantine

A resource that is declared and not marked failing is usable. Health is kept per (resource, profile).

- `ci-broker check <resource> [<profile>] [--use-reserve]` runs the profile's `check` shard on the resource (every
  declared profile when none is given) and streams it. It also reports free disk, and for ssh, passwordless `sudo`
  and RAM per slot. Exit codes: `0` pass, `1` fail, `3` not checked.
- A pass clears **failing**. A fail sets it. A failing resource is skipped for that profile until a check passes.
- For boat, a check uses an idle running box. It resumes or creates one only within the start budget. At the reserve
  it exits 3 (`not checked: no Boat budget`) and changes nothing, unless you give `--use-reserve`.
- For github, a check only confirms the workflow is on the default branch (a dispatch costs money).
- An ssh host or local becomes failing after `infraFailLimit` (2) infra failures that a retry elsewhere showed were its
  fault. Exit 96 (disk) and "unreachable" count at once.
- A Boat box gets **quarantine** instead: after `infraFailLimit` such failures in a row it is stopped and never picked.
  `status` shows it. It does not count toward `maxBoxes`, and it is deleted after `pool.deleteAfterDays`.
- `ci-broker resources` shows health. `ci-broker resources reset <id>` clears failing flags and quarantine
  (test-broker: `test-broker reset`).

## Debugging

- `ci-broker status`: jobs and their shards, why a job waits, resources and slots, health, GitHub runs in flight,
  boxes, starts left.
- `ci-broker jobs [--repo R] [--limit N]`: recent jobs. A `*` after the sha marks a snapshot.
- `ci-broker show <job>`: shards, every placement with its reason, and the receipt.
- `ci-broker logs <job> [--shard S] [-f]`: output; `-f` follows.
- `journalctl --user -u ci-brokerd -f`: the daemon log, one line per decision or state change, for all jobs.
- `sqlite3 ~/.local/state/ci-broker/brokerd.db`: tables `jobs`, `shards`, `job_events`, `interests`,
  `status_targets`, `boxes`, `slots`, `health`, `gh_runs`, `meta`. The schema is in `src/db.ts`.
- `curl -s --unix-socket ~/.local/state/ci-broker/brokerd.sock http://x/status | jq`: the raw API.
- `ci-broker doctor`: daemon, `gh` and Boat login, Docker, each resource's health and last check, starts left.
- `ci-broker gc`: runs the timers' work now (Boat reconcile, idle stop, delete, prune).

To update the code without losing work:

1. Pull the new code.
2. Run `ci-broker drain`. The daemon stops starting shards and exits when none run.
3. systemd starts it again on the new code. New submits are refused while it drains.

A plain restart (`systemctl --user restart ci-brokerd`) is safe too. On start the daemon re-queues running shards as
their next attempt, kills leftover processes on busy boxes and slots, and removes its leftover containers. A job keeps
running only if it is pinned or a client comes back within `interestGraceSec`.

## Boat pool

- Boxes are named `cib-<daemonId>-<env>-<size>-<rand6>`. The daemon touches only boxes with its own `daemonId`.
- Every 60 s the daemon reconciles its rows with `boat list` and adopts unknown boxes with its prefix.
- v0.1 boxes (`cib-<profile>-<size>-<rand6>`) of a known profile are renamed once and adopted.
- A box idle longer than `pool.idleStopSec` (20 min) is stopped. With `pool.warmHours` set, the last running box of
  each size stays up inside those hours.
- A box stopped longer than `pool.deleteAfterDays` (7) is deleted.
- Boat's TTL (`pool.ttlSec`, 12 h) is a safety net. It is extended each time a box is picked.

## Config

`single`: `~/.config/ci-broker/config.json` (or `$CI_BROKER_CONFIG`). Every key is optional. The client reads the
same file (for the socket path and the snapshot limit).

`split`: root's `/etc/ci-broker/config.json` (root 0644; `sudoedit` from an admin account) takes every key below
except the path keys (`stateDir`, `socketPath`, `profilesDir`, `boatBin`, `sshBin`, `scpBin`: in `split` every path
comes from `install.conf`). The operator's `/var/lib/ci-broker/operator/tuning.json` takes only `local.cpus`,
`local.memory`, `pool.*`, `boat.maxBoxes`, `runnersPerRepo`, `queueTimeoutSec`, `shardTimeoutSec`,
`retentionDays`, `artifactsMaxMb` and `localMaxLoadFactor`; any other key refuses the next submit, naming it. Both
are read again at every submit.

Trust, credentials and job secrets (root's in `split`):

| key | default | meaning |
|---|---|---|
| `trust.githubUsers` | `[]` | the approved list: `{ "login", "id" }` entries (`install.sh --approve <login>` merges one) |
| `trust.repos.<owner/name>` | none | `githubUsers` (replaces the global list), `workflow` (default `.github/workflows/broker.yml`), `envForGithubDoor` (false), `publicBoat` (none: a public repo's lane may use Boat in this environment) |
| `trust.watchSec` | 300 | the watchdog period |
| `trust.localOfflineMaxAgeSec` | 86400 | GitHub down: a cached tier this young is used at the local door |
| `trust.githubDoorPerMin` / `githubDoorCallsPerHour` / `githubDoorMaxJobs` | 30 / 1000 / 20 | the GitHub door's limits |
| `trust.publicNetwork` | `ci-broker-pub` | the public lane's Docker network |
| `trust.publicBoatMaxBoxes` | 4 | the public lane's Boat boxes, over all its environments |
| `credentials.github` | `split`: `{ "file": "<daemon home>/github-token" }`; `single`: `{ "tokenCmd": "gh auth token" }` | the daemon's GitHub token |
| `credentials.boat.configHome` | `split`: `<daemon home>/.config` | `XDG_CONFIG_HOME` of every boat call |
| `secrets.<name>` | none | a job secret: `{ "file" }` (`split`: `<ETC_DIR>/secrets/<name>`, set with `--set-secret`); `single` also `{ "cmd" }` (run async: at the start of a run that needs it, and every 5 min for admission and doctor) |

| key | default | meaning |
|---|---|---|
| `daemonId` | short hostname | names boxes (`cib-<daemonId>-…`) and jobs (`<daemonId>-<n>`); lowercase letters and digits |
| `resources` | `local` + `boat` for every profile | see [Resources](#resources) |
| `boatBin` | `~/.local/bin/boat` | the Boat CLI |
| `sshBin` / `scpBin` | `ssh` / `scp` | for ssh resources |
| `sshCallTimeoutSec` | 120 | short ssh/scp calls (upload, kill, artifacts) |
| `boatCallTimeoutSec` | 60 | short Boat calls (stop, delete, kill, artifacts) |
| `githubPollSec` | 30 | how often a dispatched GitHub run is polled |
| `githubFindSec` | 300 | a dispatched run not found after this long is an infra failure |
| `gitUrl` | `https://github.com/{repo}.git` | clone URL for the mirrors |
| `gitTimeoutSec` | 600 | git calls on a mirror |
| `profilesDir` | `<this repo>/profiles` | where profiles live |
| `runnersPerRepo` | 8 | `runner add` default |
| `localMaxLoadFactor` | 0.5 | run locally only while load1 < this × CPU count |
| `startsReserve` | 20 | never resume or create a box at or below this many starts left today |
| `stateDir` | `~/.local/state/ci-broker` | daemon state |
| `socketPath` | `<stateDir>/brokerd.sock` | the API socket |
| `queueTimeoutSec` | 3600 | a shard queued this long → job `error` |
| `shardTimeoutSec` | 7200 | a shard running this long → killed, `failed (timeout)` |
| `interestGraceSec` | 30 | a dropped client may reconnect within this |
| `infraFailLimit` | 2 | attributed infra failures before failing / quarantine |
| `retentionDays` | 14 | keep jobs (and reuse passes) this long |
| `artifactsMaxMb` | 200 | larger artifact archives are skipped with a note |
| `snapshotMaxFileMb` | 50 | larger new files are refused in a snapshot |
| `bundleWaitSec` | 120 | a snapshot job with no bundle after this long → `error` |
| `tickSec` | 15 | scheduler tick (timeouts, interests, a pass) |
| `reconcileSec` | 60 | Boat reconcile, idle stop, delete |
| `pruneSec` | 3600 | retention pruning |
| `pool.idleStopSec` | 1200 | stop a box idle this long |
| `pool.warmHours` | `null` | e.g. `"08:00-20:00"` local time: keep one box per size running |
| `pool.deleteAfterDays` | 7 | delete a box stopped this long |
| `pool.ttlSec` | 43200 | Boat TTL safety net |
| `local.cpus` / `local.memory` | 6 / `"20g"` | container limits for local runs |

## File layout

This repo:

```
bin/ci-broker, bin/ci-brokerd   entries (run src/ci/cli.ts and src/ci/daemon/main.ts with Node's type stripping; a
                                release's pinned node when there is one)
bin/cib-admit.sh                the runners' pre-job hook (env -i, then `ci-broker admit`)
ci/scripts/                     install.sh (root), ci-broker-runnerctl, runner-start, pub-net-rules, the unit templates
ci/profiles/<name>/             per-repo profile, remote script, Dockerfile
ci/workflows/                   files a consumer repo copies (broker.yml, ci-broker-hosted.yml)
src/ci/                         client, daemon, config (module map in DEVELOPMENT.md)
src/core/                       shared with test-broker (Boat, box pool, mirror, snapshots, src/core/wrap/cib-wrap.sh)
test/ci/                        node:test suites (test/ci/docker-root: the root install in a container)
```

On this machine (`split`):

```
/etc/ci-broker/install.conf, config.json, secrets/<name>   root's: names and paths; trust, credentials, secrets
/opt/ci-broker/releases/<sha>-<ts>/, current               releases (cibroker-admin's; root installs them)
/usr/local/lib/ci-broker/tools/                            pinned node, gh, boat
/usr/local/sbin/ci-broker-runnerctl                        the operator's one root door (sudoers)
/var/lib/ci-broker/admin/                                  the daemon's home (0700): github-token, Boat login, state/
/var/lib/ci-broker/admin/state/                            brokerd.db, trust.db, daemon.log, jobs/, work/, ci/profiles/ (snapshots)
/var/lib/ci-broker/local/brokerd.sock, local.lock          the local door (the operator's group)
/var/lib/ci-broker/sock/github.sock                        the GitHub door (the runner user's group)
/var/lib/ci-broker/operator/profiles/, tuning.json         the operator's
/var/lib/ci-broker/runners/<owner>__<name>-<n>/, runners.json   the runners (cibroker-runner), root's list
```

On this machine (`single`):

```
~/.config/ci-broker/config.json               config (optional)
~/.local/bin/ci-broker, ci-brokerd            links into this repo
~/.config/systemd/user/ci-brokerd.service     the daemon unit
~/.config/systemd/user/ci-broker-runner@.service, ~/.local/share/ci-broker/runners/<owner>__<name>-<n>/   runners
~/.local/state/ci-broker/
  brokerd.sock, brokerd.db                    API socket, SQLite state
  jobs/<n>/                                   stream.ndjson, <shard>.log, summary.json, artifacts/<shard>/, snapshot.bundle
  work/<owner>__<name>.git                    bare mirror per repo
  work/<owner>__<name>/<job>-<rand>/          the --shared clone of a running local job
  trust.db                                    blocks, tiers, run uses, trust events, the ticket key (never reset)
  checks/                                     health check logs
  local.lock                                  the local slot's flock
```

On a box or ssh host:

```
~/cib/repos/<owner>__<name>/     one clone per repo
~/cib/<slot>/                    cib-wrap.sh, remote.sh, run.pid, snapshot.bundle, runs/
~/cib/<slot>/<owner>__<name>/    the slot's worktree
```
