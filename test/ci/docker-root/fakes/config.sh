#!/bin/bash
# fake actions runner config.sh: records argv, uid, umask and whether the token came in the env (never argv)
mkdir -p _diag
{ echo "argv: $*"; echo "uid: $(id -un)"; echo "umask: $(umask)"; echo "token-env: ${ACTIONS_RUNNER_INPUT_TOKEN:-none}"; } >>_diag/config.log
if [[ ${1:-} == remove ]]; then rm -f .runner .credentials; exit 0; fi
name=''
while (($#)); do case $1 in --name) name=$2; shift 2 ;; *) shift ;; esac; done
printf '{"agentName":"%s"}' "$name" >.runner
echo secret >.credentials
