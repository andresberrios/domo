import { describe, expect, it } from 'vitest'

import { ROW_BADGE_CLASS, ROW_MENU_CLASS, ROW_QUICK_ACTION_CLASS } from '~/utils/sidebar'

/**
 * An open row menu is portaled out of its row and takes the focus and the
 * pointer with it, so every "on hover or focus" rule stops matching. A trigger
 * that hid then had no box, and Reka placed the menu in the screen's top-left
 * corner. Nothing here can lay out a popover; what can be held is the rule that
 * keeps the trigger, and what sits beside it, where they were while it is open.
 */
describe('sidebar row actions while a row menu is open', () => {
  const classes = (value: string) => value.split(/\s+/)

  it('keeps the menu trigger displayed', () => {
    expect(classes(ROW_MENU_CLASS)).toContain('hidden')
    expect(classes(ROW_MENU_CLASS)).toContain('data-[state=open]:inline-flex')
  })

  it('keeps the row\'s quick action and badge as they were on hover, so the trigger does not move', () => {
    expect(classes(ROW_QUICK_ACTION_CLASS)).toContain('group-has-[[data-state=open]]:inline-flex')
    expect(classes(ROW_BADGE_CLASS)).toContain('group-has-[[data-state=open]]:hidden')
  })
})
