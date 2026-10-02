export type Migration = {
  readonly id: string;
  readonly sql: string;
};

/** Ordered schema changes. 0001 creates the migrations table and nothing else. */
export const MIGRATIONS: readonly Migration[] = [
  {
    id: "0001-initial",
    sql: `CREATE TABLE oc_family_pack_schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
) STRICT`,
  },
];
