import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS, NoteStore } from "../src/store.js";

interface SoftDelete {
  remove(id: number, now: number): void;
  restore(id: number): void;
  purge(before: number): number;
}
type Store = NoteStore & SoftDelete;

let db: DatabaseSync;
let s: Store;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  s = new NoteStore(db) as Store;
  s.migrate();
});

describe("soft delete", () => {
  it("hides a removed note from get()", () => {
    const id = s.add("alpha");
    s.remove(id, 1000);
    expect(s.get(id)).toBeNull();
  });

  it("keeps the row in the table rather than deleting it", () => {
    const id = s.add("alpha");
    s.remove(id, 1000);
    const raw = db.prepare("SELECT COUNT(*) AS n FROM notes").get() as { n: number };
    expect(raw.n).toBe(1);
  });

  it("excludes removed notes from list() and preserves ordering", () => {
    const a = s.add("a");
    s.add("b");
    const c = s.add("c");
    s.remove(a, 1000);
    s.remove(c, 1000);
    expect(s.list().map((n) => n.body)).toEqual(["b"]);
  });

  it("restores a removed note", () => {
    const id = s.add("alpha");
    s.remove(id, 1000);
    s.restore(id);
    expect(s.get(id)?.body).toBe("alpha");
    expect(s.list()).toHaveLength(1);
  });

  it("purges only notes deleted before the cutoff, and reports the count", () => {
    const old = s.add("old");
    const recent = s.add("recent");
    s.add("live");
    s.remove(old, 1_000);
    s.remove(recent, 9_000);
    expect(s.purge(5_000)).toBe(1);
    const raw = db.prepare("SELECT COUNT(*) AS n FROM notes").get() as { n: number };
    expect(raw.n).toBe(2);
  });

  it("never purges a live note", () => {
    s.add("live");
    expect(s.purge(Number.MAX_SAFE_INTEGER)).toBe(0);
    expect(s.list()).toHaveLength(1);
  });

  it("adds the column via a NEW migration instead of editing the first one", () => {
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(2);
    expect(MIGRATIONS[0]).not.toMatch(/deleted_at/i);
  });

  it("migrate() stays safe to run repeatedly", () => {
    const id = s.add("alpha");
    s.migrate();
    s.migrate();
    expect(s.get(id)?.body).toBe("alpha");
  });

  it("applies the new migration to a database created before it existed", () => {
    // A pre-existing v1 database must pick up deleted_at, not crash.
    const old = new DatabaseSync(":memory:");
    old.exec(`CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL)`);
    old.exec(`CREATE TABLE schema_version (version INTEGER NOT NULL)`);
    old.exec(`INSERT INTO schema_version VALUES (1)`);
    old.prepare(`INSERT INTO notes (body) VALUES (?)`).run("legacy");
    const s2 = new NoteStore(old) as Store;
    s2.migrate();
    expect(s2.list().map((n) => n.body)).toEqual(["legacy"]);
    const legacyId = s2.list()[0]!.id;
    s2.remove(legacyId, 1000);
    expect(s2.get(legacyId)).toBeNull();
  });
});
