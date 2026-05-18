<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'

const showDone = useState('leftRail:showDone', () => false)
const { me, isAdmin, logout } = useAuth()

const initials = computed(() => {
  const n = me.value?.name?.trim() || me.value?.email || '?'
  return n.slice(0, 2).toUpperCase()
})

const menuItems = computed<DropdownMenuItem[][]>(() => {
  const groups: DropdownMenuItem[][] = []
  if (isAdmin.value) {
    groups.push([
      { label: 'Manage users', icon: 'i-lucide-users', to: '/admin/users' },
    ])
  }
  groups.push([
    { label: 'Sign out', icon: 'i-lucide-log-out', onSelect: () => logout() },
  ])
  return groups
})
</script>

<template>
  <!-- The sidebar `footer` slot is `flex items-center`; without `w-full`
       this flex child shrinks to its content and the dropdown can't span
       the rail. -->
  <div class="space-y-2 w-full min-w-0">
    <USwitch v-model="showDone" label="Show done sessions" size="xs" />

    <UDropdownMenu
      v-if="me"
      :items="menuItems"
      :content="{ align: 'start', side: 'top' }"
      :ui="{ content: 'w-(--reka-dropdown-menu-trigger-width)' }"
      class="block w-full"
    >
      <UButton
        variant="ghost"
        color="neutral"
        block
        class="w-full justify-start"
        :ui="{ base: 'px-2' }"
      >
        <UAvatar :text="initials" size="2xs" />
        <span class="min-w-0 flex-1 text-left truncate text-sm">
          {{ me.name }}
        </span>
        <UIcon name="i-lucide-chevrons-up-down" class="size-3.5 text-muted" />
      </UButton>
    </UDropdownMenu>
  </div>
</template>
