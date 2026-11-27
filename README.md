# Airstack Test Broker

> **Beta.** test-broker works every day on the author's machines, but expect rough edges. Please report problems in
> [GitHub issues](https://github.com/airstack/test-broker/issues).

test-broker decides **where a test run may start, now**. Many AI agents (or people) on one dev machine all want to
run tests at the same time. Without a broker they overload the CPUs, and every run gets slow. test-broker answers
each ask in under 2 seconds and never queues. The answer is one of:

- **run it here with N CPUs**: the command runs on this machine with `TEST_BROKER_CPUS=N`;
- **running on Boat**: the suite runs in [Boat](https://boat.dev) cloud sandboxes (optional), and the output streams
  back;
- **busy**: nothing ran (exit 75), and the message says why, so the caller can wait or do other work.

It runs as a small daemon for your user (`test-brokerd`, a systemd user service). No root is needed.

The repo also holds **ci-broker**, an opt-in and experimental broker for GitHub Actions self-hosted runners. It is
not installed by default. See [ci/README.md](ci/README.md).

## Requirements

- Linux with systemd (a user session; `loginctl enable-linger` keeps it up after you log out)
- Node.js 24 or later on `PATH` (test-broker uses Node's built-in TypeScript support and `node:sqlite`; there is no
  build step and no npm dependency at run time)
- git
- Optional, for Boat: the [Boat CLI](https://boat.dev) (logged in) and the GitHub CLI `gh` (logged in). Boat is off
  until you turn it on (see [Boat](#boat-optional)).

## Install

1. Clone the repo:
   ```bash
   git clone https://github.com/airstack/test-broker.git ~/test-broker
   cd ~/test-broker
   ```
2. Install the command and the service. This copies the checkout's `HEAD` to
   `~/.local/share/test-broker/releases/<sha>/`, links `~/.local/bin/test-broker`, and starts
   `test-brokerd.service`:
   ```bash
   scripts/install.sh
   ```
3. Keep the service running after you log out:
   ```bash
   loginctl enable-linger "$USER"
   ```
4. Check it:
   ```bash
   test-broker status
   ```

To update, run `git pull` and then `scripts/install.sh` again. The install refuses a checkout with uncommitted
changes. A restart cancels running Boat runs; local commands go on, without a lease.

To uninstall:

```bash
systemctl --user disable --now test-brokerd.service
rm -f ~/.config/systemd/user/test-brokerd.service ~/.local/bin/test-broker
rm -rf ~/.local/share/test-broker        # the releases
rm -rf ~/.local/state/test-broker        # optional: run history and logs
```

## Use it in a repo

1. Add `.test-broker.json` at the repo root. It names your test **suites** and what each one needs. A small one:
   ```json
   {
     "suites": {
       "unit": { "local": { "cpus": 4, "minCpus": 2, "memGb": 4 } },
       "e2e": { "local": { "cpus": 8, "minCpus": 4, "memGb": 8, "locks": ["port:3000"] } }
     }
   }
   ```
   - `cpus`: what the suite wants. `minCpus`: the least it can run with. `memGb`: the RAM it needs.
   - `locks`: names that only one run may hold at a time (for example a fixed port).

   A fuller example with Boat shards is in [examples/.test-broker.json](examples/.test-broker.json).
2. Run tests through the broker. Put the real command after `--`:
   ```bash
   test-broker run unit -- npm test
   ```
   Use `$TEST_BROKER_CPUS` in the command (or your test runner's config) to size the worker pool:
   ```bash
   test-broker run unit -- sh -c 'npx vitest run --maxWorkers="$TEST_BROKER_CPUS"'
   ```
3. Tell your agents to run tests only through `test-broker run`. A short rule in your `AGENTS.md` or `CLAUDE.md` is
   enough. For example: "Run tests with `test-broker run <suite> -- <command>`. Exit 75 means busy: do other work and
   try again later."

### Exit codes

| code | meaning |
|---|---|
| the command's code | the command ran (here or on Boat) and ended with this code |
| 75 | busy: nothing ran; the message says why |
| 76 | steered off: a heavy run that the repo's policy advises against now (Boat budget). Set `TEST_BROKER_CONFIRM="<why>"` to run it anyway |

If a Boat run cannot start (for example during a Boat outage), `run` asks again without Boat and runs the suite
here. If the daemon is down, `run` runs the command directly, with a warning. If the daemon does not answer in 60 seconds,
`run` runs the command with `TEST_BROKER_CPUS` at a quarter of the machine.

## Commands

```
test-broker run <suite> [suite args…] [--cpus N] [--no-boat] [--force-load] [--json] -- <command…>
test-broker ask <suite> [--json]        # a peek: what a run would get now; takes nothing, starts nothing
test-broker status [--json]             # leases, load, Boat boxes and runs
test-broker logs <run> [-f]             # a Boat run's output
test-broker cancel <run>
test-broker usage [--days N] [--repo owner/name] [--runs] [--json]
test-broker hint --worktree <path> [--ttl 60m] [--gone]
test-broker boxes | box drain|undrain|probe <box> | reset
```

`test-broker help` prints the details of each command.

## Boat (optional)

Boat runs a suite's shards in cloud sandboxes ("boxes"), so a big suite does not load your machine. test-broker
keeps a small pool of boxes, reuses them across runs and repos, and stops idle ones.

Boat is off by default. To turn it on:

1. Install the Boat CLI and log in. Log in to `gh` too: test-broker sends only **private** GitHub repos to Boat, and
   it asks GitHub (with your `gh` login) whether a repo is private.
2. Name the GitHub owners whose private repos may use Boat, in `~/.config/test-broker/config.json`:
   ```json
   { "boat": { "owners": ["your-github-name"], "maxBoxes": 4 } }
   ```
3. In the repo, add a `boat` block to `.test-broker.json` and a remote script that runs one shard on a box. See
   [examples/.test-broker.json](examples/.test-broker.json) and the remote script contract in
   [DEVELOPMENT.md](DEVELOPMENT.md#the-remote-script-contract).
4. Run `scripts/install.sh` again (it puts `boat` and `gh` on the service's `PATH`), then try
   `test-broker ask <suite>`.

Code goes to a box as a git bundle of your working tree (a snapshot), never from GitHub. The boxes' Boat environment
injects no secrets.

## Where things are

| path | what |
|---|---|
| `~/.config/test-broker/config.json` | machine settings (optional; defaults in `src/tb/machine-config.ts`) |
| `~/.local/state/test-broker/` | state: `runs.db` (run history), `boxes.db`, run logs, `test-brokerd.log` |
| `$XDG_RUNTIME_DIR/test-broker.sock` | the daemon's socket |
| `journalctl --user -u test-brokerd` | the service log |

The full reference (Boat pools, packing, the warm pool, steering, slow boxes, usage reports) is in
[docs/test-broker.md](docs/test-broker.md).

## The code

```
src/core/   shared by both brokers: the Boat CLI wrapper, the box pool, the on-box wrapper, snapshots, receipts
src/tb/     test-broker (the CLI and test-brokerd)
src/ci/     ci-broker (opt-in; test-broker never imports it)
ci/         ci-broker's scripts, workflow templates and example profile
scripts/    the test-broker install and its systemd unit
test/       node:test suites (test/core, test/tb, test/ci)
```

Development: `npm test` (or `node --test 'test/**/*.test.ts'`) and `npx tsc --noEmit`. See
[DEVELOPMENT.md](DEVELOPMENT.md).

## License

MIT. See [LICENSE](LICENSE).
