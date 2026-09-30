/**
 * Row actions reveal on hover or keyboard focus, and stay put on a touch
 * screen, where there is no hover to reveal them with. Until then they take no
 * room: a nested row (an environment in a folder) cannot spare it for its
 * name. Keyboard users still reach them, because focusing the row's link is
 * what reveals them, before the next tab lands on them.
 */
export const ROW_ACTIONS_CLASS
  = 'hidden group-hover:inline-flex group-focus-within:inline-flex pointer-coarse:inline-flex'

/** The count badge yields to the actions rather than pushing them off a narrow row. */
export const ROW_BADGE_CLASS = 'group-hover:hidden group-focus-within:hidden pointer-coarse:hidden'
