# Server configuration (developer overrides)

People set Domo up in the app: keys are saved in the database through the
setup guide and each settings page. A variable here is a developer's or
operator's override. It goes in `.env` (`~/.domo/.env` for an install, which
has none until someone makes one, and which the launcher reads at every server
start), wins over the value saved in the app,
and the app then says "set by the server's configuration" without naming it.
Never name a variable or `.env` in UI copy, help text or errors.

| Variable | Purpose |
| --- | --- |
| `NUXT_GEMINI_API_KEY` | Gemini key, for the Gemini speech engines |
| `NUXT_CLAUDE_CODE_OAUTH_TOKEN` | From `claude setup-token` |
| `NUXT_ANTHROPIC_API_KEY` | Optional. Bills the API, not your subscription |
| `NUXT_OPENAI_API_KEY` | OpenAI key: the OpenAI speech engine, OpenCode's `openai/…` models, and Codex's fallback when it has no ChatGPT login. Bills the API |
| `NUXT_CODEX_API_KEY` | Optional. Codex uses it only when there is no ChatGPT login, and it bills the API |
| `NUXT_OPENCODE_API_KEY` | OpenCode console service-account key |
| `NUXT_OPENCODE_CONFIG_CONTENT` | Optional inline OpenCode configuration |
| `NUXT_GH_TOKEN` | GitHub token for environment sessions |
| `DATABASE_URL`, `ELECTRIC_URL` | Default to the compose services |
| `NUXT_DEFAULT_CWD` | Default for **Settings → Coding agents → Default folder**, where new sessions start |
| `NUXT_DATA_DIR` | Where uploads are stored (default `./.data`) |
| `NUXT_DEV_ENV_IMAGE` | Base image when a project has no `.domo.json` |
| `NUXT_DEV_ENV_RUNTIME_IMAGE` | Image that provides Node and the adapters to environments (default `node:22-bookworm-slim`) |
| `NUXT_DEV_ENV_HELPER_IMAGE` | Small image Domo runs for chores on environment volumes (default `busybox:1.37`) |
| `NUXT_DEV_ENV_RESOURCE_PREFIX` | Prefix for Docker resources Domo creates (default `domo-dev-` under `pnpm dev`, `domo-prod-` when installed) |
| `NUXT_DEV_ENV_DOCKER_READY_MS` | How long Docker in a new environment has to answer before creation fails (default `30000`) |
| `NUXT_DOOD_SOCKET_DIR` | Where each environment's Docker socket is created (default `~/.domo/s/<install>`). Docker Desktop forwards a socket only if its path is at most 88 bytes, so set this if your home directory is longer than 53 characters. Do not use `/tmp`: macOS cleans it |
| `NUXT_CLAUDE_CONFIG_DIR` | Where the Claude config copied into a new environment is read from (default `~/.claude`). Only `CLAUDE.md`, `settings.json`, `skills/`, `commands/` and `agents/` are copied |
| `NUXT_CODEX_CONFIG_DIR` | Codex config mounted into environments (default `~/.codex`) |
| `NUXT_HOME_OVERLAY_DIR` | Home directory the environment mounts come from (default `$HOME`) |
| `NUXT_KYUTAI_API_KEY` | Key for a Kyutai speech server |
| `DOMO_PORT`, `DOMO_HTTPS_ADDRESS` | An installed Domo's addresses |
