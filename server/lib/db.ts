import Database from 'better-sqlite3'
import { domoDbPath } from './paths'

let _db: Database.Database | null = null

/**
 * Singleton handle to Domo's SQLite metadata DB. Schema is migrated on first
 * access. Holds projects, envs, sessions, the per-session `session_events`
 * transcript log, parked `pending_diffs`, settings, users — every piece of
 * durable state Domo owns (Decided #6: SQLite owns everything).
 *
 * The pivot put the engine in-process and made SQLite the authoritative
 * event log. The old Electric Agents durable stream is gone; `session_events`
 * is the chat transcript, `pending_diffs` is the durable diff-approval queue
 * (so a parked edit survives a Domo restart and re-renders the card). Coast
 * still owns container runtime state until step 3 swaps it for devcontainers.
 */
export function db(): Database.Database {
  if (_db) return _db
  _db = new Database(domoDbPath())
  _db.pragma('journal_mode = WAL')
  _db.pragma('foreign_keys = ON')
  migrate(_db)
  return _db
}

function migrate(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL UNIQUE,
      default_branch TEXT,
      has_coastfile INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS envs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      branch TEXT,
      worktree_path TEXT,
      coast_instance_name TEXT NOT NULL,
      status TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(project_id, name)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      env_id TEXT NOT NULL REFERENCES envs(id) ON DELETE CASCADE,
      title TEXT,
      status TEXT NOT NULL DEFAULT 'waiting',
      done INTEGER NOT NULL DEFAULT 0,
      entity_id TEXT,
      durable_stream_url TEXT,
      native_claude_session_id TEXT,
      approval_mode TEXT,
      created_at INTEGER NOT NULL,
      last_event_at INTEGER,
      viewed_at_per_device TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_env_id ON sessions(env_id);
    CREATE INDEX IF NOT EXISTS idx_envs_project_id ON envs(project_id);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      last_login_at INTEGER
    );

    -- Per-session transcript log (the new in-process engine's durable
    -- truth — replaces the Electric Agents durable stream). One row per
    -- envelope from the spawned claude process plus a few Domo-synthesized
    -- types (prompt, steer_sent, pending_diff, diff_decision, aborted,
    -- error). seq is monotonic per session and primary-keys the row so
    -- the SSE seq-tail (?since=) is naturally idempotent +
    -- reconnect-lossless.
    --
    -- Streaming assistant deltas are NOT stored — partials live on the
    -- change bus / SSE only, and the complete assistant envelope (its
    -- own row here) is the source of truth in the adapter. The
    -- message_id column lingers from step 1's first cut (when partials
    -- were UPDATE-coalesced in place); unused now, kept to avoid an
    -- awkward SQLite column drop.
    CREATE TABLE IF NOT EXISTS session_events (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      message_id TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, seq)
    );
    -- Drop the (now dead) partial-row index on existing DBs from the
    -- first cut. Idempotent, safe on a fresh DB.
    DROP INDEX IF EXISTS idx_session_events_partial;

    -- Durable diff-approval queue. A manual-mode edit parks here so the
    -- card re-renders cross-device and survives restart. The engine's
    -- boot-reconcile pass auto-rejects any row still pending on startup
    -- (its parking turn is dead — Decided #7's "no corruption mode").
    CREATE TABLE IF NOT EXISTS pending_diffs (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      call_id TEXT NOT NULL,
      path TEXT NOT NULL,
      before TEXT NOT NULL,
      after TEXT NOT NULL,
      tab_name TEXT,
      status TEXT NOT NULL,
      created_ts INTEGER NOT NULL,
      PRIMARY KEY (session_id, call_id)
    );
    CREATE INDEX IF NOT EXISTS idx_pending_diffs_session
      ON pending_diffs(session_id, status);
  `)

  // Additive, idempotent column migrations. `CREATE TABLE IF NOT EXISTS`
  // above is a no-op on an existing DB, so new columns on existing tables
  // must be ALTERed in explicitly (guarded by PRAGMA table_info so it is
  // safe to run on every boot).
  ensureColumn(d, 'sessions', 'approval_mode', 'approval_mode TEXT')

  const row = d.prepare(`SELECT version FROM schema_version LIMIT 1`).get() as
    | { version: number }
    | undefined
  if (!row) {
    d.prepare(`INSERT INTO schema_version (version) VALUES (?)`).run(1)
  }
}

function ensureColumn(
  d: Database.Database,
  table: string,
  column: string,
  ddl: string,
): void {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string
  }[]
  if (!cols.some((c) => c.name === column)) {
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
  }
}
