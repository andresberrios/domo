/**
 * Settings — a tiny key/value store in the `settings` table. Backs
 * UX-shaped, restart-surviving preferences (e.g. which panels are open)
 * so the SPA can rehydrate the same layout on reload.
 */
import { db } from './db'

export function getSetting(key: string): string | null {
  const row = db().prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
    | { value: string | null }
    | undefined
  return row?.value ?? null
}

export function setSetting(key: string, value: string): void {
  db()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value)
}
