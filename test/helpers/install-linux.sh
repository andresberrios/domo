#!/bin/sh
# Runs inside a Debian container with the host's Docker socket mounted:
# installs Domo from the mounted branch checkout with --no-service, runs the
# supervisor in the background, checks the app answers, runs update --check,
# creates a project in a new folder, and prints the lines that matter.
#
# The image has no git, so the installer installs Debian's. With `bundle` as
# the second argument it downloads Domo's own instead (DOMO_BUNDLE_GIT=1), and
# the machine never has another: every git call proves the wrapper works.
set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
# libcurl4: the bundled git's HTTPS helper links against the system's.
apt-get install -qq -y --no-install-recommends curl ca-certificates tar procps libcurl4 >/dev/null
if [ "${2:-}" = bundle ]; then export DOMO_BUNDLE_GIT=1; fi
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
cat > "$DOMO_HOME/.env" <<EOF
DATABASE_URL=postgresql://postgres:password@host.docker.internal:54331/domo
ELECTRIC_URL=http://host.docker.internal:30010
COMPOSE_PROJECT_NAME=domo-inst
DOMO_PG_PORT=54331
DOMO_ELECTRIC_PORT=30010
DOMO_PORT=3767
DOMO_HTTPS_ADDRESS=localhost:3766
EOF
echo "== install"
if ! DOMO_REPO=file:///repo.git DOMO_CHANNEL="$1" DOMO_INSTALL_ARGS="--no-service" sh /src/scripts/install.sh > /tmp/install.log 2>&1; then
  echo "INSTALL FAILED"; tail -40 /tmp/install.log; exit 1
fi
grep -E "==>|\[domo\]|^domo:|Built\." /tmp/install.log
echo "== git: $(command -v git || echo none on the machine) / $(cat "$DOMO_HOME/git/VERSION" 2>/dev/null || echo not bundled)"
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
echo "== shallow: $(PATH="$DOMO_HOME/bin:$PATH" git -C $DOMO_HOME/app rev-parse --is-shallow-repository)"
echo "== server PATH: $(tr '\0' '\n' < "/proc/$(pgrep -f '.output/server/index.mjs' | head -n 1)/environ" | grep '^PATH=' | cut -c1-80)"
echo "== new project"
curl -sk https://localhost:3766/api/projects -H 'content-type: application/json' \
  -d '{"repoPath":"/tmp/projects/fresh","initialize":true}' | head -c 300; echo
echo "branch: $(PATH="$DOMO_HOME/bin:$PATH" git -C /tmp/projects/fresh branch --show-current), log: $(PATH="$DOMO_HOME/bin:$PATH" git -C /tmp/projects/fresh log --format=%s)"
if [ -n "${DOMO_BUNDLE_GIT:-}" ]; then
  echo "== launcher moves a bundled git to the pinned version"
  echo v0 > "$DOMO_HOME/git/VERSION"
  "$DOMO_HOME/bin/domo" install --no-service --skip-trust --no-open 2>&1 | grep -E "git|current is now|domo:" || true
  echo "version: $(cat "$DOMO_HOME/git/VERSION"), runs: $("$DOMO_HOME/bin/git" --version)"
fi
"$DOMO_HOME/bin/domo" stop 2>/dev/null || true
pkill -TERM -f "domo.mjs run" || true
sleep 3
echo "== done"
