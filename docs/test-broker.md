# test-broker reference

The full behaviour of test-broker, for operators and agents. Start with the [README](../README.md).

```
test-broker run <suite> [--cpus N] [--no-boat] [--force-load] [--json] -- <direct command…>
test-broker ask <suite> [--json]        # a peek: what a run would get, here and on Boat; no lease, claim or start
test-broker status | logs <run> [-f] | cancel <run> | reset
test-broker hint --worktree <path> [--ttl 60m] [--gone]   # optional: an agent works here, tests are likely soon
test-broker usage [--days N] [--repo owner/name] [--runs] [--json]
```

- A repo opts in with `.test-broker.json` at its root (suites: `local` cpus/minCpus/memGb/locks, `boat` shards) and,
  for Boat, a remote script in the repo (`boat.remoteScript`).
- Pools: `boat.pool` (default `"shared"`) names the group of boxes a repo shares with the other repos of that pool on
  this dev box. Its Boat environment is `tbx-<hostId>-<pool>`: made on first use to inject nothing (no GitHub token,
  secrets, agent or Boat credentials), and checked before every run; a pool that injects anything is refused. Boxes
  are `tbx-<hostId>-<pool>-<size>-<rand6>`; a daemon touches only its own host's. `boat.hostId` (machine config)
  defaults to the short hostname: set it by hand when two dev boxes share one. The old key `boat.environment` is read and
  ignored: such a repo runs in the `shared` pool.
- Extra repos: `boat.extraRepos: [{ "name", "repo", "ref" }]` names another repo the remote script needs (for example a pinned
  helper service). `ref` is a commit sha, or `<file>#<dotted.key>`: a JSON file in the commit under test and the
  key holding the sha (`services/helper-service/package.json#helperSource.commit`). test-brokerd fetches that commit
  on this dev box (gh's login, through a credential helper), bundles its history once
  (`~/.local/state/test-broker/extra/`), and sends it only to a box that lacks it: `~/cib/extra/<name>.bundle`
  (`refs/cib/extra`), passed to the script as `CIB_EXTRA_<NAME>` (`CIB_EXTRA_HELPER_SERVICE`). Only a private repo is
  sent; its owner need not be in `boat.owners` (the approved repo's own config names it).
- Artifacts: `boat.artifacts` lists checkout-relative paths (e.g. `["e2e/test-results", "ci-broker-logs"]`). When a
  Boat shard fails or is killed (not cancelled), they are brought back to
  `~/.local/state/test-broker/runs/<run>.artifacts/<shard>/`, and the receipt prints that path. Over
  `boat.artifactsMaxMb` (200, compressed) they stay on the box.
- The daemon's log: `~/.local/state/test-broker/test-brokerd.log` (rotated at 10 MB, 3 kept), also on stderr (the
  journal). The file does not need journald: a user journal can be unreadable (journald on volatile storage).
- State dir disk use (`~/.local/state/test-broker/`): `runs/<run>.log` (a Boat run's output, every line prefixed
  `[shard]`) is compressed after `compressAfterHours` (24) to `<run>.log.zst` (zstd; `.gz` on a Node without it), and
  the big `.log` and `.txt` files (64 KB or more) of `runs/<run>.artifacts/` to `.gz`, except inside a dir named like
  `*report*` (a Playwright report links its files, so it still opens). Run logs and artifacts are deleted
  after `keepDays` (14). `test-broker logs <run>` reads a done run's log from its file (compressed or not) once the
  run has left the daemon's memory (2 h); else `zstdcat` it. The seeds (`seeds/`) keep the newest 3 per repo (a use
  refreshes a seed) and any seed an upload reads now. A pass runs at start and then at most every 10 min, async and
  in small steps. Before each log is compressed or deleted, runs.db already holds its summary (below).
- `run` exits with the command's (or the Boat run's) code; **75** = busy (nothing ran). The command gets
  `TEST_BROKER_CPUS`. Daemon down: the command runs directly, with a warning. Daemon up but no answer in 60 s (it
  says so after 10 s), or a config error: it runs directly with `TEST_BROKER_CPUS` at a quarter of nproc.
- Usage: `~/.local/state/test-broker/runs.db` (SQLite, kept a year) records every admitted run (repo,
  worktree, branch, HEAD, the snapshot tree for Boat runs, suite, shape `whole`/`narrowed`, where it ran and why,
  exit code, CPUs × time, and per Boat shard its box, units, seconds and the `resources:` line), each pool box's
  state changes, and a `boat limits` snapshot every 15 min. Plan hours: 1 = 4 CPUs for an hour (a default box; a
  large one costs 2 an hour). `test-broker usage` prints per day and repo: runs, CPU-minutes, shard plan hours and box
  plan hours (a box's up time, idle tail included, charged to the repo it last ran: what Boat bills), the costliest
  suites, and today's box hours against the daily target (the plan's hours left at the day's first snapshot over the
  days left in the period). `--json` is the same report for agents. It reads the file directly (daemon down too).
  Direct runs the client makes on its own (daemon down or no answer) are not recorded. `--runs` adds every run
  (newest first). `--runs --json` is the interface for agents and scheduled reviews: each run's `id`, `repo`,
  `worktree`, `branch`, `head`, `tree`, `suite`, `shape`, `where` (`boat`/`local`/`advised`), `boatWhy`, `startedAt`,
  `endedAt`, `secs`, `exitCode`, `cpuMin`, `planHours`, `heavy`, `steer` (`checks`, `advised`, `confirm`) and `shards`.
  Each Boat shard has its box, `how` (reused, shared, resumed, created), `waitSecs`, `waitGaveUp`, the `resources:`
  numbers and `log`: its output in short, built as it streams in and kept after the log file is gone: `bytes`,
  `lines`, `phases` (the remote script's `=== [Ns] <step>` lines: each step's seconds), `tests` (the last count line
  of vitest, pytest or Playwright), `failing` (up to 20 test names) and `sources` (bytes per vitest console block
  file, the 5 biggest and the rest: a noisy test file shows here). `pool` (the whole pool: `--repo` does not narrow it) gives per day the queue (waits, median wait,
  starts avoided, gave up), box starts, and the box plan hours split into busy, idle gaps, idle tails and early tails
  (the warm pool's), with the idle share and the early stops that drew a box start within 10 min.
  Fields are added, never renamed; read it rather than runs.db, whose schema may change.
- Steering, machine config `steer`. A run is **heavy** when the median CPU-minutes of its key's last
  `heavyRuns` (8) finished runs (repo + suite + shape) is at least `heavyCpuMin` (15). It is learned, so it follows a
  suite as it grows or shrinks; a suite's `"heavy": true|false` in `.test-broker.json` overrides it. A new key is not
  heavy until it has a cost. Only heavy runs are judged, by three checks:
  - `sameTree`: this exact tree (tracked and untracked files, as a Boat snapshot sees them) passed this suite with
    the same args (none, or the same narrowed args) within `sameTreeHours` (12), from any worktree;
  - `perWorktree`: this worktree started `heavyPerWorktreePerHour` (2) heavy runs in the last hour (an advised ask
    and a Boat run that never started, exit 3, do not count; neither counts toward a suite's heavy class);
  - `budget`: today's box plan hours ÷ the daily target (the plan's hours left at the day's first snapshot, less
    `reserveHours`, over the days left) is at least `softAt` (0.7) **and** this repo used more than its fair share
    (1 ÷ the repos that ran tests) of the last `fairWindowHours` (3) **while other repos are testing**; or the pressure
    is at least 1 (every heavy run). A repo alone on Boat may use the budget.

  `steer.mode` is `off`, `log` (the default: the verdict is recorded on the run, `test-broker usage` counts what it
  would advise, nothing is blocked) or `advise`; `steer.checks` holds a check at a lower mode (`{"budget": "log"}`).
  An advised run does not run: `run` exits **76** and prints the reasons, the repo's `advice` (top-level text in
  `.test-broker.json`: its own testing policy) and how to run it anyway, `TEST_BROKER_CONFIRM="<why>"` (at least 15
  characters; recorded on the run). A peek (`ask`) never steers: it shows the checks as they would judge.
- Budget: the daily target counts the plan's hours left **and** the wallet's (`boat limits` `packBalanceHours`), at
  the day's first snapshot, over the days left in the period. With the plan used up, the wallet still pays.
- The queue (packing on). A shard that finds no free units and no idle box may **wait** for a busy box about to free,
  rather than resume or create one: when the box will have room within `min(maxWaitSec, startCost)` (with budget
  pressure, `steer.softAt` or more: within `maxWaitSec`). `startCost` is learned: what a box start adds to that
  shard, about 40 s. A holder's time left is its key's p75 (repo, suite, shape, shard and a hash of its args) less the
  time it ran; with no history it is never waited for. One claim per box. When a holder leaves, the claim takes the
  units before the box can go back to the pool. A claim not served by its limit (the time left + max(15 s, 50%), at
  most `maxWaitSec`) gives up, and the shard is placed again with no wait. The start deadline of a shard that waited
  counts from when it got its box. `maxWaitSec`: `.test-broker.json` `boat.maxWaitSec` (default 60), a suite's
  `boat.maxWaitSec`, capped by the machine config `boat.maxWaitSec` (default 180); 0 turns it off. The stream shows
  `waiting for box`; `status` shows each waiting shard; runs.db keeps `waitSecs` and `argsKey` per shard.
- `ask` on Boat: per shard `shared` / `reused` (now), `wait` (about N s for that box), `resume` / `create` (about the
  start cost), or `none` (it would run here), with its usual time (p75); the pool (busy, idle, starting, stopped,
  quarantined, waiting); today's budget (hours, target, pressure, wallet); the steering checks. Nothing is taken or
  started. An agent uses it to decide whether to run a heavy suite now or batch more changes first. It exits 0 when
  a run would start now, on Boat or here: busy CPUs here do not make it 75 when Boat would take every shard.
- The warm pool. Every minute the sweep keeps each pool's **warm target** up on the long idle stop (`idleStopMin`) and
  stops the idle boxes past it after `shortIdleMin` (machine config, default 2). The target, in units, is the larger
  of the p90 of the units busy or claimed over the last 20 min (sampled each minute) and the active agents × units
  per agent; at least one box while any repo of the pool ran a test in the last 30 min, else 0. The boxes in use
  count first, then the idle ones used most recently. Active agents: worktrees with a test run in the last 30 min,
  plus hinted ones. Units per agent is learned per repo from runs.db (last 24 h; 1 with no history). The starts guard:
  when today's Boat starts left (less `startsReserve`) are 25% of the day's limit (less `startsReserve`) or less, every box keeps
  `idleStopMin`. `shortIdleMin` at `idleStopMin` or more turns it off. `status --json` shows `agents` (repo,
  worktree, source `runs` or `hint`) and `warm` per pool (target, D_recent, D_agents, the boxes past it).
- Hints: `test-broker hint --worktree <path> [--ttl 60m]` tells the daemon an agent works there and tests are likely
  soon (a worktree hook calls it); `--gone` says the worktree is gone. The hint counts for `--ttl` (machine config
  `boat.hintTtlMin`, 60), and a test run from the worktree refreshes it. Optional information: kept in memory (lost on
  restart), a worktree with no `.test-broker.json` Boat config is ignored, and the command exits 0, also with the
  daemon down or outside a worktree (2 only for bad arguments).
- Machine settings: `~/.config/test-broker/config.json` (`budgetFactor`, `boat.maxBoxes`, …; defaults in
  `src/tb/machine-config.ts`). `boat.sizes` (default all four) lists the box sizes this machine may use: a suite
  with a shard of another size runs locally, and idle or stopped boxes of that size are deleted within a minute.
- Units: a shard may give `units` (1-4) instead of `size`. 1 unit = 2 CPUs + 4 GB; a small box holds 1, default 2,
  large 4. Without `units`, the size gives them; with only `units`, the box is the smallest size on this machine that
  holds them. `boat.packing` (machine config, default **off**): shards share boxes by units. A shard takes free units
  on a box already running shards (the best fit), then an idle box, a stopped one, a new one (sized to what the run
  still has to place). Each gets its own slot dir (`~/cib/<slot>`, slot = its first unit), its own CPUs
  (`taskset -c`), and `CIB_SLOT`, `CIB_UNITS`, `CIB_CPUS`, `CIB_CPUSET`, `CIB_MEM_MB`: a remote script must keep
  its slots apart (ports, scratch dirs) before packing goes on. The box goes back to the pool when its last shard
  ends. A shard may also give `memGb` (0.5-16): its RAM, apart from its units (else 4 GB a unit). Packing then
  fits both: e2e at `units: 2, memGb: 11` leaves its large box's other 4 CPUs to a shard of `memGb` 5 or less.
  The box size must hold both (11 GB needs a large box). RAM is not capped on the box: set `memGb` from a measured
  peak.
- Infra exit codes: `.test-broker.json` `boat.infraExitCodes` (else the machine config's `boat.infraExitCodes`, a map
  of `owner/name` to codes) lists the remote script's exit codes that mean the box failed, not the code under test
  (for example 89 bootstrap, 90 no repo, 91 fetch, 92 checkout, 96 disk; not a code that a branch can cause, such as a failed install). Such an
  exit charges the box and does not clear its failures: after `infraFailLimit` (3) in a row it is quarantined and a
  new box takes its place. The shard still fails (its output says to run it again). Before this, a box with `git`
  gone failed 153 of its 156 shards with exit 91 and was never quarantined (2026-11-20).
- **Slow boxes**: a Boat box can run the same shards much slower than its peers for hours (a slow
  or crowded host under the VM; a resume does not move it; `tbx-…-4h8wm3` ran typecheck at about 1.6x its peers
  from 2026-11-26 20:40 UTC). Each box gets a **speed score** from `runs.db`: the median, over its newest 40 passing
  shards of the last 24 h (20 s or longer), of the shard's time ÷ the median of the same shard (repo, suite, shape,
  shard, args) on the other boxes within 12 h of it. 1.0 = as fast as its peers. At `boat.speed.slowAt` (1.4) with
  10 or more scored shards a box is **slow**, until its score falls below `clearAt` (1.25), so a score near 1.4
  does not flip it back and forth. Packing gives a slow box no new shards beside others, no shard waits for it, and
  placement takes, in order, an idle box that is not slow, a stopped one (a resume), then the slow one. A suite
  with `boat.avoidSlow: true` never takes a slow box (a box start instead). With `boat.speed.mode` `retire`
  (default; `avoid`: only last; `off`) a box slow for `retireAfterMin` (120) is drained if it ran a scored shard
  after it turned slow and is still slow; at most `maxRetirePerDay` (2) a day, so a fleet-wide slowdown cannot empty
  the pool. A slow box that gets no work is not drained on old shards: they age out of the 24 h window, it has no
  score, and it is used and measured again. Scores are refreshed every 5 min.
- **Probes:** test-brokerd checks idle running boxes itself (never a stopped one: that would cost a start). A box is
  probed once it has been idle `boat.speed.probeIdleSec` (60), after each start and then at most every
  `probeEveryMin` (30; 0 turns probes off), 2 boxes at a time. The probe (`src/tb/probe.ts`, about 7 s) is fixed
  work: sha256 of `probeCpuMb` (2048) MB of zeros on one core, then on every core; `probeDiskMb` (256) MB written and
  read back; each pack file of the box's repo clones read once; free disk and RAM, IO pressure, `git`. A shard
  placed on the box stops the probe at once (it is killed on the box). Results go to `runs.db` (`box_probes`). The
  **probe score** is the box's CPU time (median of its last 3 probes) ÷ the median of the other boxes of its size
  (2 or more); disk times are shown, not scored (on Boat they follow how far a resumed disk has hydrated). Either
  score can make a box slow (probes: 2 or more); when they disagree the newer one wins, so a fresh normal probe
  clears a box judged on old shards. A **fault** (an I/O error, a write that fails, under `probeMinFreeGb` (3) GB
  free, `git` gone, a probe that fails or times out) charges the box: `infraFailLimit` (3) in a row quarantines it.
  `test-broker box probe <box>` probes an idle box now; `test-broker boxes` shows each box's probe score, disk ratio
  and last probe.
- **Drains:** `test-broker box drain <box> [--reason "<why>"]` (name, Boat id, or the last 6 characters): no new
  shards; the box is deleted once free (at once when it is free), and the pool makes a new one when it needs one.
  `test-broker box undrain <box>` undoes it while the box is still there. Drains (the operator's and retire's) are in
  `state/box-flags.json`. `test-broker boxes` lists every box with its score, shards scored, slow time and drain,
  slowest first; `status` shows each box's `speed`, `slow`, `drained`. No verb pins a suite to a box: boxes come and
  go, and speed ranking already prefers the fast ones.
- **Box faults in a run**: a shard that fails with an I/O fault in its output (`Input/output error`, `EIO`,
  `Read-only file system`, `No space left on device`; a passing shard's output never counts) or with one of the
  repo's infra exit codes ran on a box that failed under it. An I/O fault quarantines the box at once (once its other
  shards end); an infra code charges it as before. The shard then runs once more on another box (no wait; idle,
  stopped or new), and its time counts from there. The receipt names the cause: `ran again on <box> after a box fault
  on <box>: …` on a pass; `box fault on <box>: …; no other box to run it again` when none was free; and when the
  second box fails the same way, `… it may be the tests, not the boxes`.
- A box start that fails (a create or resume error, or an upload to the box that fails) before any test ran there
  ends the run as **not started** (exit 3), like a missed start deadline: `test-broker run` asks again without Boat
  and runs the suite here. Before, it ended as a failure (exit 1), so callers saw failing tests during a Boat outage
  (2026-11-23, 06:10-06:27 UTC) and wrote `--no-boat` into briefs. A failed resume charges the box like a failed
  upload: after `infraFailLimit` (3) in a row it is quarantined, and the next shard gets another box.
- **Outage pause:** `boat.outageFails` (3) failed box starts within `boat.outageWindowMin` (5), on at least 2 boxes,
  pause Boat for `boat.outagePauseMin` (5): asks get "Boat paused until HH:MM UTC" and run here. Then the next ask
  tries Boat; if that start fails, the pause starts again at once; a start that works clears it. `test-broker status`
  shows it (`boat.outage`). `outageFails: 0` turns it off. Never pass `--no-boat` for an outage: it outlives the
  outage in agents' briefs.
- A lost Boat exec: each attempt has an id (`CIB_ATTEMPT`); the kill after a lost connection fences it, so an exec
  that reaches the box later exits 97 before it touches the slot.
- Repo gate: only repos whose owner is in `boat.owners` (default `[]`: none) **and** that GitHub says are private
  (`gh api repos/<repo>` with the dev user's login; cached 30 min, a "no" or a failed check 5 min) go to Boat. Any
  other repo runs locally, and the ask says why.
- Code reaches a Boat box by bundle, never from GitHub: the run bundle (the snapshot; the whole history when there is
  no base), and a **seed** when the box's clone (`~/cib/repos/<owner__name>`) lacks the base. The seed is the part
  the box lacks, or the base's whole history for a box with no clone or a partial one (cached in
  `state/seeds/`, the newest 3 per repo are kept). The wrapper puts it in the clone and moves the default branch forward to
  the base. The start deadline covers only placing, starting and hydrating the boxes; a seed upload may take 600 s. State: `~/.local/state/test-broker/`. Socket: `$XDG_RUNTIME_DIR/test-broker.sock`.
- Install or update: `scripts/install.sh` from a clean checkout (no root; a user systemd unit). Logs:
  `journalctl --user -u test-brokerd`.
- Code: `src/tb/`, on top of the shared `src/core/` (the Boat CLI wrapper, the box pool, the remote wrapper,
  snapshots and receipts). It never imports `src/ci/`.

