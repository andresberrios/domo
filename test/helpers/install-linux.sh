#!/bin/sh
# Runs inside a Debian container with the host's Docker socket mounted:
# installs Domo from the feed given as $1 (`node scripts/release.mjs serve` on
# the host) with --no-service, runs the supervisor in the background, checks
# the app answers, runs update --check, creates a project in a new folder,
# and prints the lines that matter.
#
# The image has no git, so the installer installs Debian's.
set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
apt-get install -qq -y --no-install-recommends curl ca-certificates tar procps >/dev/null
arch=$(uname -m)
# A static docker CLI and the compose plugin, so install.sh's check and the
# supervisor's `docker compose up` have something to run.
curl -fsSL "https://download.docker.com/linux/static/stable/${arch}/docker-28.3.3.tgz" | tar -xz -C /tmp
mv /tmp/docker/docker /usr/local/bin/docker
mkdir -p /usr/local/lib/docker/cli-plugins
curl -fsSL "https://github.com/docker/compose/releases/download/v2.39.4/docker-compose-linux-${arch}" -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
docker version --format '{{.Server.Version}}' >/dev/null && echo "docker ok"

export DOMO_HOME=/root/.domo
mkdir -p "$DOMO_HOME"
# A scratch stack, never the machine's own `domo-prod`. Given in the
# environment: an install writes no `.env`, and needs none.
export DATABASE_URL=postgresql://postgres:password@host.docker.internal:54331/domo
export ELECTRIC_URL=http://host.docker.internal:30010
export COMPOSE_PROJECT_NAME=domo-inst DOMO_PG_PORT=54331 DOMO_ELECTRIC_PORT=30010
export DOMO_PORT=3767 DOMO_HTTPS_ADDRESS=localhost:3766
echo "== install"
if ! DOMO_FEED="$1" DOMO_INSTALL_ARGS="--no-service" sh /install.sh > /tmp/install.log 2>&1; then
  echo "INSTALL FAILED"; tail -40 /tmp/install.log; exit 1
fi
grep -E "==>|\[domo\]|^domo:|Installed\." /tmp/install.log
if [ -e "$DOMO_HOME/.env" ]; then echo "INSTALL WROTE A .env"; exit 1; fi
echo "== no .env"
echo "== git: $(command -v git || echo none)"
echo "== status"
"$DOMO_HOME/bin/domo" status
echo "== run"
"$DOMO_HOME/bin/domo" run > /tmp/run.log 2>&1 &
i=0
until curl -sk https://localhost:3766/api/health >/dev/null 2>&1 || [ $i -ge 60 ]; do sleep 2; i=$((i+1)); done
echo "health: $(curl -sk https://localhost:3766/api/health)"
grep "\[domo\]" /tmp/run.log | tail -5
echo "== update --check"
"$DOMO_HOME/bin/domo" update --check
echo "== new project"
curl -sk https://localhost:3766/api/projects -H 'content-type: application/json' \
  -d '{"repoPath":"/tmp/projects/fresh","initialize":true}' | head -c 300; echo
echo "branch: $(git -C /tmp/projects/fresh branch --show-current), log: $(git -C /tmp/projects/fresh log --format=%s)"
"$DOMO_HOME/bin/domo" stop 2>/dev/null || true
pkill -TERM -f "domo.mjs run" || true
sleep 3
echo "== done"
