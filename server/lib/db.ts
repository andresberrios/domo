import Database from 'better-sqlite3'
import { domoDbPath } from './paths'

let _db: Database.Database | null = null

/**
 * Singleton handle to Domo's SQLite metadata DB. Schema is migrated on first
 * access. Holds projects, envs, sessions, the per-session `session_events`
 * transcript log, parked `pending_diffs`, settings, users, the per-env
 * port-forward table — every piece of durable state Domo owns
 * (Decided #6: SQLite owns everything).
 *
 * Schema is the post-pivot v0.4 shape — no Coast / Electric legacy columns
 * linger. SQLite's `ALTER TABLE DROP COLUMN` (3.35+) handles the column
 * drops if an older DB is opened; new installs get the clean
 * `CREATE TABLE IF NOT EXISTS` definitions below.
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
      has_devcontainer INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS envs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      branch TEXT,
      base_branch TEXT,
      worktree_path TEXT,
      container_id TEXT,
      devcontainer_path TEXT,
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

    -- Per-session transcript log — the in-process engine's durable
    -- truth. One row per envelope from the spawned claude process
    -- plus a few Domo-synthesized types (prompt, steer_sent,
    -- pending_diff, diff_decision, aborted, error). seq is monotonic
    -- per session and primary-keys the row so the SSE seq-tail
    -- (?since=) is naturally idempotent + reconnect-lossless.
    -- Streaming assistant deltas are NOT stored — partials live on
    -- the change bus / SSE only.
    CREATE TABLE IF NOT EXISTS session_events (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, seq)
    );

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

    -- Per-env external-port mappings. A row here means "expose this
    -- declared inner port (already published to 127.0.0.1:<random> by
    -- the container) on 0.0.0.0:<external_port> via a Domo-side TCP
    -- forwarder". Source of truth for restart-safe rebuild.
    CREATE TABLE IF NOT EXISTS env_external_ports (
      env_id TEXT NOT NULL REFERENCES envs(id) ON DELETE CASCADE,
      inner_port INTEGER NOT NULL,
      external_port INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (env_id, inner_port)
    );

    -- Drop the (now dead) partial-row index on existing DBs from
    -- step 1's first cut. Idempotent, safe on a fresh DB.
    DROP INDEX IF EXISTS idx_session_events_partial;
  `)

  // Drop legacy columns left over from the pre-pivot Electric/Coast
  // stack. Requires SQLite 3.35+ (better-sqlite3 11 ships well past
  // that). Idempotent: SQLite errors on DROP of a missing column, so
  // we guard with a PRAGMA check. No prod data to migrate — the user
  // wiped prod before the pivot.
  dropColumnIfExists(d, 'projects', 'has_coastfile')
  dropColumnIfExists(d, 'envs', 'coast_instance_name')
  dropColumnIfExists(d, 'sessions', 'entity_id')
  dropColumnIfExists(d, 'sessions', 'durable_stream_url')
  dropColumnIfExists(d, 'session_events', 'message_id')

  // Additive idempotent migrations. Columns added after the post-pivot
  // initial cut land here; every other shape is captured in the
  // `CREATE TABLE IF NOT EXISTS` above. Order doesn't matter — each
  // ensureColumn is a no-op once the column exists.
  ensureColumn(d, 'sessions', 'approval_mode', 'approval_mode TEXT')
  // `branch` is the env's own branch (== env.name); `base_branch` is
  // the branch it was created from. Without this split, `git worktree
  // add -B <branch>` collided with the project root having the base
  // branch already checked out. See server/api/envs/run.post.ts.
  ensureColumn(d, 'envs', 'base_branch', 'base_branch TEXT')

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

function dropColumnIfExists(
  d: Database.Database,
  table: string,
  column: string,
): void {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string
  }[]
  if (cols.some((c) => c.name === column)) {
    d.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`)
  }
}
