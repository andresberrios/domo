/**
 * Resolve "which env am I looking at?" from the route.
 *
 * The workspace surfaces (file tree, editor, git, terminal) all key off
 * the selected env, derived from `/p/:project/e/:env/...`. `nuxt-procedures`
 * `useCall` is keyed on its serialized input (no reactive refetch), so we
 * fetch the project list once reactively and re-`call()` the env list
 * whenever the resolved project changes — that keeps env identity correct
 * as the user clicks across the left rail without remounting the panels.
 */
type EnvList = Awaited<ReturnType<typeof apiClient.envs.list.call>>
type Env = EnvList[number]

export function useSelectedEnv() {
  const route = useRoute()
  const projectName = computed(() => (route.params.project as string) || null)
  const envName = computed(() => (route.params.env as string) || null)

  const { data: projects } = apiClient.projects.list.useCall()
  const project = computed(
    () => projects.value?.find((p) => p.name === projectName.value) ?? null,
  )
  const projectId = computed(() => project.value?.id ?? null)

  const envs = ref<EnvList>([])
  watch(
    projectId,
    async (pid) => {
      if (!pid) {
        envs.value = []
        return
      }
      try {
        envs.value = await apiClient.envs.list.call({ projectId: pid })
      } catch {
        envs.value = []
      }
    },
    { immediate: true },
  )

  const env = computed<Env | null>(
    () => envs.value.find((e) => e.name === envName.value) ?? null,
  )
  const envId = computed(() => env.value?.id ?? null)

  return { projectName, envName, project, projectId, env, envId }
}
