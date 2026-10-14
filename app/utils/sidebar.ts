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
 * which carries the same action, is shown instead. It stays while the row's
 * menu is open, so the menu's trigger beside it does not shift.
 */
export const ROW_QUICK_ACTION_CLASS
  = 'hidden group-hover:inline-flex group-focus-within:inline-flex group-has-[[data-state=open]]:inline-flex pointer-coarse:hidden'

/**
 * A row's menu: on hover or focus with a fine pointer, always on a touch screen
 * — and always while it is open (`data-state=open` is Reka's, on the trigger).
 * The open menu is portaled out of the row and takes the focus and the
 * pointer with it, so the row stops being hovered or focused; a trigger that
 * hid then had no box, and the menu was placed against nothing, in the
 * screen's top-left corner.
 */
export const ROW_MENU_CLASS
  = 'hidden group-hover:inline-flex group-focus-within:inline-flex pointer-coarse:inline-flex data-[state=open]:inline-flex'

/**
 * The count badge yields to the actions on hover rather than pushing them off
 * a narrow row, and keeps yielding while the row's menu is open, so the
 * trigger the menu hangs off does not move under it.
 */
export const ROW_BADGE_CLASS
  = 'group-hover:hidden group-focus-within:hidden pointer-coarse:hidden group-has-[[data-state=open]]:hidden'
