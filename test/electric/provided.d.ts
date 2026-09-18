/**
 * What `test/electric/global-setup.ts` hands to the specs.
 *
 * Its own declaration file because the setup file and the specs are typechecked
 * by two different projects — Nitro and app — and both need the augmentation.
 */
declare module 'vitest' {
  interface ProvidedContext {
    /** Why this layer is being skipped, or `''` when it is running. */
    electricLayerUnavailable: string
  }
}

export {}
