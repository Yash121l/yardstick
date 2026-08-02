import { DatabaseSync } from "node:sqlite";

export interface Note {
  id: number;
  body: string;
}

/**
 * Append-only. `migrate()` applies every entry whose index is at or beyond the
 * recorded version, so editing an existing entry silently skips it on any
 * database that has already been migrated.
 */
export const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS notes (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     body TEXT NOT NULL
   )`,
];

export class NoteStore {
  constructor(private readonly db: DatabaseSync) {}

  migrate(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`);
    const row = this.db.prepare(`SELECT version FROM schema_version`).get() as
      | { version: number }
      | undefined;
    let at = row?.version ?? 0;
    if (row === undefined) this.db.prepare(`INSERT INTO schema_version VALUES (0)`).run();
    for (let i = at; i < MIGRATIONS.length; i++) {
      this.db.exec(MIGRATIONS[i] as string);
      at = i + 1;
    }
    this.db.prepare(`UPDATE schema_version SET version = ?`).run(at);
  }

  add(body: string): number {
    const r = this.db.prepare(`INSERT INTO notes (body) VALUES (?)`).run(body);
    return Number(r.lastInsertRowid);
  }

  get(id: number): Note | null {
    const row = this.db.prepare(`SELECT id, body FROM notes WHERE id = ?`).get(id) as
      | Note
      | undefined;
    return row ?? null;
  }

  list(): Note[] {
    return this.db.prepare(`SELECT id, body FROM notes ORDER BY id ASC`).all() as Note[];
  }
}
