export type Migration = {
  readonly id: string;
  readonly sql: string;
};

/** Ordered schema changes. 0001 creates the migrations table; 0002 adds the append-only write log. */
export const MIGRATIONS: readonly Migration[] = [
  {
    id: "0001-initial",
    sql: `CREATE TABLE oc_family_pack_schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
) STRICT`,
  },
  {
    id: "0002-write-log",
    // One row per calendar write outcome. `request_key` is the base key plus how many
    // committed rows already share that base, so a committed request key appears once.
    // Rows are never changed or removed; an undo is a new `reverted` row.
    sql: `CREATE TABLE oc_family_pack_write_log (
  id INTEGER PRIMARY KEY,
  request_key TEXT NOT NULL,
  base_key TEXT NOT NULL,
  requester TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('create', 'update', 'move', 'delete')),
  calendar_id TEXT NOT NULL,
  event_id TEXT,
  before_json TEXT,
  after_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('committed', 'failed', 'denied', 'timed-out', 'reverted')),
  at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX oc_family_pack_write_log_committed_key ON oc_family_pack_write_log (request_key) WHERE status = 'committed';
CREATE INDEX oc_family_pack_write_log_base ON oc_family_pack_write_log (base_key, status);
CREATE INDEX oc_family_pack_write_log_event ON oc_family_pack_write_log (calendar_id, event_id, at);
CREATE TRIGGER oc_family_pack_write_log_no_update BEFORE UPDATE ON oc_family_pack_write_log
BEGIN SELECT RAISE(ABORT, 'oc_family_pack_write_log is append-only'); END;
CREATE TRIGGER oc_family_pack_write_log_no_delete BEFORE DELETE ON oc_family_pack_write_log
BEGIN SELECT RAISE(ABORT, 'oc_family_pack_write_log is append-only'); END;`,
  },
];
