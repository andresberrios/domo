export default defineAppConfig({
  ui: {
    colors: {
      primary: 'domo',
      // A warm olive-tinted grey rather than zinc's cool blue — see the scale
      // in app/assets/css/main.css for why the neutral is not stock.
      neutral: 'bark'
    },
    button: {
      defaultVariants: { size: 'md' }
    }
  }
})
