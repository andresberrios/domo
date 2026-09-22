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
    }
  }
})
