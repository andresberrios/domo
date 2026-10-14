<script setup lang="ts">
interface Health { db: boolean, electric: boolean, electricUrl: string, message: string }

const health = ref<Health | null>(null)

async function check() {
  try {
    health.value = await $fetch<Health>('/api/health')
  } catch {
    health.value = { db: false, electric: false, electricUrl: '', message: 'Domo server unreachable' }
  }
}

onMounted(() => {
  void check()
  const timer = setInterval(check, 15000)
  onScopeDispose(() => clearInterval(timer))
})

const down = computed(() => health.value && (!health.value.db || !health.value.electric))

const description = computed(() => {
  if (!health.value) return ''
  const missing = [
    !health.value.db ? 'Postgres' : null,
    !health.value.electric ? 'Electric' : null
  ].filter(Boolean).join(' and ')
  return `${missing} ${missing.includes('and') ? 'are' : 'is'} not reachable, so the UI cannot sync. Make sure Docker is running: an installed Domo's containers start again with it. In a development checkout, run \`docker compose up -d\`.`
})
</script>

<template>
  <UAlert
    v-if="down"
    color="warning"
    variant="subtle"
    icon="i-lucide-plug-zap"
    title="Domo cannot reach its database"
    :description="description"
    class="mb-3"
    :actions="[{ label: 'Re-check', color: 'neutral', variant: 'subtle', onClick: check }]"
  />
</template>
