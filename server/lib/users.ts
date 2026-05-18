/**
 * User helpers — typed CRUD against the `users` table.
 *
 * Domo's auth model is self-hosted and email+password only (no email is
 * ever sent): the **first** account created is the admin (auto-active);
 * every later signup lands `status='pending'` until the admin approves
 * it. The sealed session cookie carries only identity — `role`/`status`
 * are always re-read from here in the server guards (`server/lib/auth.ts`)
 * so an approve/reject takes effect on the user's very next request with
 * no re-login and no stale-cookie window.
 */
import { randomUUID } from 'node:crypto'
import { db } from './db'

export type UserRole = 'admin' | 'member'
export type UserStatus = 'active' | 'pending'

export interface UserRow {
  id: string
  email: string
  name: string
  passwordHash: string
  role: UserRole
  status: UserStatus
  createdAt: number
  lastLoginAt: number | null
}

interface UserDbRow {
  id: string
  email: string
  name: string
  password_hash: string
  role: string
  status: string
  created_at: number
  last_login_at: number | null
}

function fromDb(r: UserDbRow): UserRow {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    passwordHash: r.password_hash,
    role: r.role as UserRole,
    status: r.status as UserStatus,
    createdAt: r.created_at,
    lastLoginAt: r.last_login_at,
  }
}

/** Public-safe projection (never leak the password hash). */
export interface PublicUser {
  id: string
  email: string
  name: string
  role: UserRole
  status: UserStatus
  createdAt: number
  lastLoginAt: number | null
}

export function toPublic(u: UserRow): PublicUser {
  const { passwordHash: _ph, ...pub } = u
  return pub
}

export function countUsers(): number {
  const r = db().prepare(`SELECT COUNT(*) AS n FROM users`).get() as { n: number }
  return r.n
}

export function getUserByEmail(email: string): UserRow | null {
  const r = db()
    .prepare(`SELECT * FROM users WHERE email = ?`)
    .get(email.trim().toLowerCase()) as UserDbRow | undefined
  return r ? fromDb(r) : null
}

export function getUserById(id: string): UserRow | null {
  const r = db().prepare(`SELECT * FROM users WHERE id = ?`).get(id) as
    | UserDbRow
    | undefined
  return r ? fromDb(r) : null
}

export function listUsers(): UserRow[] {
  const rows = db()
    .prepare(`SELECT * FROM users ORDER BY created_at ASC`)
    .all() as UserDbRow[]
  return rows.map(fromDb)
}

export function createUser(input: {
  email: string
  name: string
  passwordHash: string
  role: UserRole
  status: UserStatus
}): UserRow {
  const row: UserRow = {
    id: randomUUID(),
    email: input.email.trim().toLowerCase(),
    name: input.name.trim(),
    passwordHash: input.passwordHash,
    role: input.role,
    status: input.status,
    createdAt: Date.now(),
    lastLoginAt: null,
  }
  db()
    .prepare(
      `INSERT INTO users (
         id, email, name, password_hash, role, status, created_at, last_login_at
       ) VALUES (
         @id, @email, @name, @passwordHash, @role, @status, @createdAt, @lastLoginAt
       )`,
    )
    .run(row)
  return row
}

export function setUserStatus(id: string, status: UserStatus): void {
  db().prepare(`UPDATE users SET status = ? WHERE id = ?`).run(status, id)
}

export function setUserRole(id: string, role: UserRole): void {
  db().prepare(`UPDATE users SET role = ? WHERE id = ?`).run(role, id)
}

export function touchLastLogin(id: string, ts = Date.now()): void {
  db().prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`).run(ts, id)
}

export function deleteUser(id: string): void {
  db().prepare(`DELETE FROM users WHERE id = ?`).run(id)
}
