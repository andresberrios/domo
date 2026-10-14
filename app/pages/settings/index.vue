<script setup lang="ts">
const { data: settings, refresh } = await useSettingsForm()
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
        <p class="text-xs text-muted">Stored on the server and never sent to the browser. A variable in <code class="rounded bg-elevated px-1">.env</code> wins over a value saved here.</p>
      </div>
      <CredentialSettings :settings="settings ?? null" @saved="refresh" />
      <UAlert
        :color="settings?.hasOpenCodeKey || settings?.hasOpenCodeAuth ? 'success' : 'neutral'"
        variant="subtle"
        icon="i-lucide-code-xml"
        title="OpenCode"
        :description="openCodeAuthSummary"
        :actions="[{ label: 'OpenCode settings', color: 'neutral', variant: 'subtle', to: '/settings/adapters/opencode' }]"
      />
    </section>
  </SettingsShell>
</template>
