// An ACP adapter that refuses to be one — and a `codex app-server` that
// refuses to be one either (`NUXT_CODEX_ENTRY`), for the usage poller.
//
// The e2e layer drives the real `POST /api/agents`, which really spawns an
// adapter. Blanking the API keys is not enough to stop it: on macOS Claude Code
// reads its login straight out of the Keychain, so a developer's own machine
// happily started a real, billable session inside `pnpm test`. Pointing
// `NUXT_CLAUDE_ACP_ENTRY` / `NUXT_CODEX_ACP_ENTRY` here is what actually
// guarantees no account is ever touched. The usage poller spawns the bundled
// Codex CLI for the same kind of reason, and gets the same treatment.
process.stderr.write('no adapter in this test layer\n')
process.exit(1)
