/*
 * Nuxt UI's animations, on the motion tokens in app/assets/css/main.css:
 * menus and tooltips are `quick`, modals, slideovers and toasts `slow`, and
 * content that opens is `disclose` — it fades up into its full height rather
 * than growing into it, so nothing animates a height (see main.css).
 */
const popup = 'data-[state=open]:animate-[scale-in_var(--motion-quick)_var(--ease-out)] data-[state=closed]:animate-[scale-out_var(--motion-quick)_var(--ease-out)]'
const fade = 'data-[state=open]:animate-[fade-in_var(--motion-slow)_var(--ease-out)] data-[state=closed]:animate-[fade-out_var(--motion-slow)_var(--ease-out)]'
// Spelt out, not built from the side: Tailwind only generates classes it can read in the source.
const slide = {
  top: 'data-[state=open]:animate-[slide-in-from-top_var(--motion-slow)_var(--ease-out)] data-[state=closed]:animate-[slide-out-to-top_var(--motion-slow)_var(--ease-out)]',
  right: 'data-[state=open]:animate-[slide-in-from-right_var(--motion-slow)_var(--ease-out)] data-[state=closed]:animate-[slide-out-to-right_var(--motion-slow)_var(--ease-out)]',
  bottom: 'data-[state=open]:animate-[slide-in-from-bottom_var(--motion-slow)_var(--ease-out)] data-[state=closed]:animate-[slide-out-to-bottom_var(--motion-slow)_var(--ease-out)]',
  left: 'data-[state=open]:animate-[slide-in-from-left_var(--motion-slow)_var(--ease-out)] data-[state=closed]:animate-[slide-out-to-left_var(--motion-slow)_var(--ease-out)]'
}

export default defineAppConfig({
  ui: {
    colors: {
      primary: 'domo',
      // A wood-toned brown rather than zinc's cool blue-grey — see the scale
      // in app/assets/css/main.css for why the neutral is not stock.
      neutral: 'bark'
    },
    button: {
      defaultVariants: { size: 'md' }
    },
    badge: {
      slots: { base: 'transition-colors duration-(--motion-base)' }
    },
    // A count or dot appearing (a permission waiting, a notification) pops in.
    chip: {
      slots: { base: 'motion-pop' }
    },
    dashboardPanel: {
      slots: { root: 'motion-page' }
    },
    popover: { slots: { content: popup } },
    dropdownMenu: { slots: { content: popup } },
    contextMenu: { slots: { content: popup } },
    tooltip: {
      slots: { content: 'data-[state=delayed-open]:animate-[scale-in_var(--motion-quick)_var(--ease-out)] data-[state=closed]:animate-[scale-out_var(--motion-quick)_var(--ease-out)]' }
    },
    select: { variants: { transition: { true: { content: popup } } } },
    selectMenu: { variants: { transition: { true: { content: popup } } } },
    modal: {
      variants: {
        transition: {
          true: {
            overlay: fade,
            content: 'data-[state=open]:animate-[scale-in_var(--motion-slow)_var(--ease-out)] data-[state=closed]:animate-[scale-out_var(--motion-slow)_var(--ease-out)]'
          }
        }
      }
    },
    slideover: {
      variants: { transition: { true: { overlay: fade } } },
      compoundVariants: (['top', 'right', 'bottom', 'left'] as const).map(side => ({
        transition: true,
        side,
        class: { content: slide[side] }
      }))
    },
    collapsible: {
      slots: {
        content: 'data-[state=open]:animate-[motion-rise_var(--motion-base)_var(--ease-out)] data-[state=closed]:animate-[motion-sink_var(--motion-quick)_var(--ease-out)_forwards]'
      }
    },
    toaster: {
      slots: {
        base: 'data-[state=closed]:animate-[toast-closed_var(--motion-slow)_var(--ease-out)] data-[state=closed]:data-[expanded=false]:data-[front=false]:animate-[toast-collapsed-closed_var(--motion-slow)_var(--ease-out)] duration-(--motion-slow)'
      },
      compoundVariants: [
        { position: ['top-left', 'top-center', 'top-right'] as const, class: { base: 'data-[state=open]:animate-[toast-slide-in-from-top_var(--motion-slow)_var(--ease-out)]' } },
        { position: ['bottom-left', 'bottom-center', 'bottom-right'] as const, class: { base: 'data-[state=open]:animate-[toast-slide-in-from-bottom_var(--motion-slow)_var(--ease-out)]' } }
      ]
    }
  }
})
