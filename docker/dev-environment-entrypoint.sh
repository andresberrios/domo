#!/bin/sh
set -eu

agent_uid="${DOMO_AGENT_UID:-1000}"
agent_gid="${DOMO_AGENT_GID:-1000}"
if ! grep -Eq "^[^:]+:[^:]*:${agent_gid}:" /etc/group; then
  echo "domo-agent:x:${agent_gid}:" >> /etc/group
fi
if ! grep -Eq "^[^:]+:[^:]*:${agent_uid}:" /etc/passwd; then
  echo "domo-agent:x:${agent_uid}:${agent_gid}:Domo agent:/home/node:/bin/bash" >> /etc/passwd
fi
chown -R "$agent_uid:$agent_gid" /home/node /workspace

dockerd-entrypoint.sh dockerd >/var/log/dockerd.log 2>&1 &

attempt=0
until docker info >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    cat /var/log/dockerd.log >&2
    exit 1
  fi
  sleep 1
done

# Coding agents run without root, but need access to the environment's private
# Docker daemon in order to run Docker Compose stacks.
chmod 666 /var/run/docker.sock
exec tail -f /dev/null
