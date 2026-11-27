# Local (container) runs of the example profile. Build: ci-broker image example
# (or: docker build -t ci-broker-example ci/profiles/example)
# The container runs as the caller's uid with HOME=/tmp/home, so everything here must work for a non-root user.
FROM node:24-bookworm
RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
      git ca-certificates procps \
 && rm -rf /var/lib/apt/lists/*
ENV CI=1 npm_config_cache=/tmp/home/.npm
