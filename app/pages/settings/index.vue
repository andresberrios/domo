<script setup lang="ts">
const { data: settings } = await useSettingsForm()
/**
 * OpenCode has two credentials that do different jobs, and one being present
 * says nothing about the other: a host login runs host sessions and is all
 * OpenCode needs there, while a console key is the only thing a container
 * session or the plan-limit poll can use.
 */
const openCodeAuthSummary = computed(() => {
  const key = settings.value?.hasOpenCodeKey
  const login = settings.value?.hasOpenCodeAuth
  if (key && login) return 'Console key and host login'
  if (key) return 'Console key configured'
  if (login) return 'Host login only — add a console key for environments'
  return 'Run opencode auth login, or add a console key'
})
</script>

<template>
  <SettingsShell
    title="General"
    description="The credentials Domo found."
  >
    <section class="space-y-3">
      <div>
        <h2 class="text-sm font-semibold">Credentials</h2>
        <p class="text-xs text-muted">Keys come from your <code class="rounded bg-elevated px-1">.env</code> file, never the database.</p>
      </div>
      <div class="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <UAlert
          :color="settings?.hasGeminiKey ? 'success' : 'warning'"
          variant="subtle"
          :icon="settings?.hasGeminiKey ? 'i-lucide-check' : 'i-lucide-key-round'"
          title="Gemini"
          :description="settings?.hasGeminiKey ? 'Speech key configured' : 'Set NUXT_GEMINI_API_KEY for its speech engines'"
        />
        <UAlert
          :color="settings?.hasAnthropicKey ? 'success' : 'neutral'"
          variant="subtle"
          icon="i-lucide-sparkles"
          title="Anthropic"
          :description="settings?.hasAnthropicKey ? 'API key configured' : 'Local login or setup token'"
        />
        <UAlert
          :color="settings?.hasOpenAiKey ? 'success' : 'neutral'"
          variant="subtle"
          icon="i-lucide-terminal"
          title="OpenAI"
          :description="settings?.hasOpenAiKey ? 'API key configured' : 'Local login may be used'"
        />
        <UAlert
          :color="settings?.hasOpenCodeKey || settings?.hasOpenCodeAuth ? 'success' : 'neutral'"
          variant="subtle"
          icon="i-lucide-code-xml"
          title="OpenCode"
          :description="openCodeAuthSummary"
        />
      </div>
    </section>
  </SettingsShell>
</template>
