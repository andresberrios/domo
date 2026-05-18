// Nuxt UI v4 theme. Color roles map to the Tailwind color scales defined
// in `app/assets/css/main.css` (`@theme static`):
//   primary   → robo     (Robo's golden/amber body)
//   secondary → roboeye  (Robo's mint-green eyes — accent)
//   neutral   → robodark (Robo's dark metal/outline — UI text/border/bg)
// Nuxt UI generates `--ui-primary` / `--ui-secondary` / the neutral set
// (+ the full `--ui-color-*-{shade}` set) from these by name.
export default defineAppConfig({
  ui: {
    colors: {
      primary: 'robo',
      secondary: 'roboeye',
      neutral: 'robodark',
    },
  },
})
