/**
 * Shape of the nuxt-auth-utils sealed session. We store **identity only**
 * — `role`/`status` are deliberately NOT here: they're re-read from the
 * `users` table in the server guards (`server/lib/auth.ts`) so an admin
 * approve/reject takes effect on the user's next request without forcing
 * a re-login (a sealed cookie can't be mutated server-side). The client
 * gets fresh role/status from the `auth.me` procedure.
 */
declare module '#auth-utils' {
  interface User {
    id: string
    email: string
    name: string
  }
  // UserSession / SecureSessionData keep nuxt-auth-utils' defaults — we
  // store nothing beyond `user` (identity); role/status come from the DB.
}

export {}
