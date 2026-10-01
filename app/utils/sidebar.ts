/**
 * Every row in the sidebar tree: one height, one hover, one active state, so
 * projects, folders, environments and agents read as one list.
 */
export const ROW_CLASS
  = 'group flex h-8 items-center gap-1 rounded-md pe-1 text-sm pointer-coarse:h-10 hover:bg-elevated has-[a.row-active]:bg-accented/70 has-[a.row-active]:font-medium'

/**
 * A row's one-click action (a plus). With a fine pointer it appears on hover
 * or keyboard focus and takes no room until then, so a nested row keeps its
 * name; focusing the row's link reveals it before the next tab lands on it.
 * A touch screen has no hover: there it is left out, and the row's menu,
 * which carries the same action, is shown instead.
 */
export const ROW_QUICK_ACTION_CLASS
  = 'hidden group-hover:inline-flex group-focus-within:inline-flex pointer-coarse:hidden'

/** A row's menu: on hover or focus with a fine pointer, always on a touch screen. */
export const ROW_MENU_CLASS
  = 'hidden group-hover:inline-flex group-focus-within:inline-flex pointer-coarse:inline-flex'

/** The count badge yields to the actions on hover rather than pushing them off a narrow row. */
export const ROW_BADGE_CLASS = 'group-hover:hidden group-focus-within:hidden pointer-coarse:hidden'
