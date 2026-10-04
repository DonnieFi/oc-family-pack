export type Migration = {
  readonly id: string;
  readonly sql: string;
};

/** Ordered schema changes. 0001 creates the migrations table; 0002 adds the append-only write log; 0003 the delivery log; 0004 reminder modes. */
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
  {
    id: "0003-delivery-log",
    // One row per delivery attempt. `target` is a member id or a channels key, never a Discord id.
    // error_kind is set on every row but a sent one. A key is sent at most once; rows are never
    // changed or removed.
    sql: `CREATE TABLE oc_family_pack_delivery_log (
  id INTEGER PRIMARY KEY,
  delivery_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('daily', 'weekly', 'reminder', 'household', 'alert')),
  target TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent', 'partial', 'failed', 'held', 'unknown')),
  error_kind TEXT CHECK (error_kind IN ('no-permission', 'no-channel', 'other')),
  error_detail TEXT CHECK (length(error_detail) <= 200),
  receipt_json TEXT,
  at INTEGER NOT NULL,
  CHECK ((status = 'sent') = (error_kind IS NULL))
) STRICT;
CREATE UNIQUE INDEX oc_family_pack_delivery_log_sent_key ON oc_family_pack_delivery_log (delivery_key) WHERE status = 'sent';
CREATE INDEX oc_family_pack_delivery_log_streak ON oc_family_pack_delivery_log (kind, target, at);
CREATE TRIGGER oc_family_pack_delivery_log_no_update BEFORE UPDATE ON oc_family_pack_delivery_log
BEGIN SELECT RAISE(ABORT, 'oc_family_pack_delivery_log is append-only'); END;
CREATE TRIGGER oc_family_pack_delivery_log_no_delete BEFORE DELETE ON oc_family_pack_delivery_log
BEGIN SELECT RAISE(ABORT, 'oc_family_pack_delivery_log is append-only'); END;`,
  },
  {
    id: "0004-reminder-mode",
    // One row per chat change of how a person gets reminders. The latest row for a profile wins.
    // Config is the mode until the first row. Rows are never changed or removed.
    sql: `CREATE TABLE oc_family_pack_reminder_mode (
  id INTEGER PRIMARY KEY,
  profile_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('dm', 'channel', 'off')),
  at INTEGER NOT NULL
) STRICT;
CREATE INDEX oc_family_pack_reminder_mode_profile ON oc_family_pack_reminder_mode (profile_id, id);
CREATE TRIGGER oc_family_pack_reminder_mode_no_update BEFORE UPDATE ON oc_family_pack_reminder_mode
BEGIN SELECT RAISE(ABORT, 'oc_family_pack_reminder_mode is append-only'); END;
CREATE TRIGGER oc_family_pack_reminder_mode_no_delete BEFORE DELETE ON oc_family_pack_reminder_mode
BEGIN SELECT RAISE(ABORT, 'oc_family_pack_reminder_mode is append-only'); END;`,
  },
];
