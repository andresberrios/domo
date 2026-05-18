<script setup lang="ts">
/**
 * Admin-only user management. Renders inside the app shell (admins are
 * active users). The server enforces admin on every mutation; this guard
 * is just UX. Pending signups are approved or rejected here.
 */
const { me, isAdmin } = useAuth()

watchEffect(() => {
  if (me.value && !isAdmin.value) void navigateTo('/')
})

const { data, refresh, pending } = await apiClient.auth.admin.listUsers.useCall()
const busy = ref<string | null>(null)

function errText(e: unknown): string {
  const x = e as { data?: { message?: string }; statusMessage?: string }
  return x?.data?.message || x?.statusMessage || (e as Error).message
}

const toast = useToast()

async function approve(userId: string) {
  busy.value = userId
  try {
    await apiClient.auth.admin.approveUser.call({ userId })
    await refresh()
  } catch (e) {
    toast.add({ title: errText(e), color: 'error' })
  } finally {
    busy.value = null
  }
}

async function remove(userId: string) {
  busy.value = userId
  try {
    await apiClient.auth.admin.deleteUser.call({ userId })
    await refresh()
  } catch (e) {
    toast.add({ title: errText(e), color: 'error' })
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <div class="p-8 max-w-3xl mx-auto">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-xl font-semibold">
          Users
        </h1>
        <p class="mt-1 text-sm text-muted">
          Approve people who have requested access, or remove accounts.
        </p>
      </div>
      <UButton
        size="sm"
        variant="ghost"
        icon="i-lucide-refresh-cw"
        :loading="pending"
        @click="refresh()"
      >
        Refresh
      </UButton>
    </div>

    <ul class="mt-6 divide-y divide-default rounded-lg border border-default">
      <li
        v-for="u in data?.users ?? []"
        :key="u.id"
        class="flex items-center gap-3 p-4"
      >
        <div class="min-w-0 flex-1">
          <div class="font-medium truncate flex items-center gap-2">
            {{ u.name }}
            <UBadge
              v-if="u.role === 'admin'"
              size="xs"
              color="primary"
              variant="subtle"
            >
              admin
            </UBadge>
          </div>
          <div class="text-xs text-muted truncate">
            {{ u.email }}
          </div>
        </div>

        <UBadge
          size="sm"
          variant="subtle"
          :color="u.status === 'active' ? 'success' : 'warning'"
        >
          {{ u.status === 'active' ? 'active' : 'pending' }}
        </UBadge>

        <div class="flex items-center gap-1.5">
          <UButton
            v-if="u.status === 'pending'"
            size="xs"
            color="primary"
            icon="i-lucide-check"
            :loading="busy === u.id"
            @click="approve(u.id)"
          >
            Approve
          </UButton>
          <UButton
            v-if="u.id !== me?.id && u.role !== 'admin'"
            size="xs"
            color="error"
            variant="ghost"
            :icon="u.status === 'pending' ? 'i-lucide-x' : 'i-lucide-trash-2'"
            :loading="busy === u.id"
            @click="remove(u.id)"
          >
            {{ u.status === 'pending' ? 'Reject' : 'Remove' }}
          </UButton>
        </div>
      </li>
    </ul>
  </div>
</template>
