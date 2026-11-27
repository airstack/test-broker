# The throwaway root-test image (pnpm test:root): real useradd/chown/setpriv/install/visudo/systemd-analyze; the
# tests replace systemctl, curl, docker, iptables and gh/boat with fakes inside each container.
FROM ubuntu:26.04
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends systemd sudo jq git xz-utils ca-certificates iproute2 procps util-linux libatomic1 \
 && rm -rf /var/lib/apt/lists/*
