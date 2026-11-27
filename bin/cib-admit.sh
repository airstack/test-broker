#!/bin/sh
# ci-broker pre-job hook: asks the daemon whether this job may run. Ignores the job's environment.
D=$(cd "$(dirname "$0")/.." && pwd -P)    # the release dir, not the `current` link: an update mid-job can't mix
exec /usr/bin/env -i PATH="$D/bin:/usr/bin:/bin" LANG=C.UTF-8 HOME=/nonexistent \
  GITHUB_RUN_ID="$GITHUB_RUN_ID" GITHUB_RUN_ATTEMPT="$GITHUB_RUN_ATTEMPT" GITHUB_REPOSITORY="$GITHUB_REPOSITORY" \
  GITHUB_REF="$GITHUB_REF" GITHUB_EVENT_NAME="$GITHUB_EVENT_NAME" RUNNER_NAME="$RUNNER_NAME" \
  CI_BROKER_GITHUB_SOCKET="$CI_BROKER_GITHUB_SOCKET" \
  "$D/node/bin/node" "$D/src/ci/cli.ts" admit
