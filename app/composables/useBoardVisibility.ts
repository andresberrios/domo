import { breakpointsTailwind, useBreakpoints, useLocalStorage } from '@vueuse/core'

/**
 * Whether the status board is showing. On a wide screen it is a panel that
 * stays open across pages and visits; on a narrow one a slideover that is
 * closed again every time a page opens.
 */
export function useBoardVisibility() {
  const wide = useBreakpoints(breakpointsTailwind).greaterOrEqual('lg')
  const pinned = useLocalStorage('domo-board-open', false)
  const sliding = useState('board-slideover-open', () => false)
  const open = computed({
    get: () => wide.value ? pinned.value : sliding.value,
    set: (value: boolean) => {
      if (wide.value) pinned.value = value
      else sliding.value = value
    }
  })
  return { open, wide }
}
