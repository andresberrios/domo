/**
 * Row actions reveal on hover or keyboard focus, and stay put on a touch
 * screen, where there is no hover to reveal them with. `opacity-0` rather than
 * `hidden`: the buttons keep their place in the tab order, so tabbing into a
 * row is what makes them visible.
 */
export const ROW_ACTIONS_CLASS
  = 'opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100'

/** The count badge yields to the actions rather than pushing them off a narrow row. */
export const ROW_BADGE_CLASS = 'group-hover:hidden group-focus-within:hidden pointer-coarse:hidden'
