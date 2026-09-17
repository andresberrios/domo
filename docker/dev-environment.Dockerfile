FROM docker:27-dind

RUN apk add --no-cache \
      bash \
      ca-certificates \
      docker-cli-compose \
      git \
      nodejs \
      npm \
      openssh-client \
      ripgrep \
    && addgroup -S node \
    && adduser -S -G node -h /home/node -s /bin/bash node \
    && npm install --global @agentclientprotocol/claude-agent-acp@0.78.0 \
    && mkdir -p /workspace/repo /opt/domo /home/node/.claude \
    && chown -R node:node /workspace /home/node

COPY server/mcp/agent-mesh.mjs /opt/domo/agent-mesh.mjs
COPY docker/dev-environment-entrypoint.sh /usr/local/bin/domo-dev-environment

RUN chmod +x /usr/local/bin/domo-dev-environment

ENV DOCKER_TLS_CERTDIR=""
ENTRYPOINT ["/usr/local/bin/domo-dev-environment"]
