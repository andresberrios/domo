import type { InjectionKey } from 'vue'
import { NO_NAMES, type DomoNames } from '~/utils/domoTools'

const KEY: InjectionKey<DomoNames> = Symbol('domo-names')

/**
 * The page that draws a transcript knows every agent, environment and project
 * by name; the cards deep inside it only hold ids. Provided once rather than
 * queried per card, which would be one live query for every row on screen.
 */
export function provideDomoNames(names: DomoNames) {
  provide(KEY, names)
}

/** Ids stay ids where nothing provided the names, as in a lone card. */
export function useDomoNames(): DomoNames {
  return inject(KEY, NO_NAMES)
}
