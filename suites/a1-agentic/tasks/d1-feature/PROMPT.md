# Add soft delete to the notes store

`src/store.ts` is a small SQLite-backed note store. Add soft deletion.

Required behaviour:

- A new migration adds a nullable `deleted_at` column (INTEGER, unix millis).
- `remove(id, now)` marks a note deleted instead of removing the row.
- `get(id)` returns `null` for a deleted note.
- `list()` excludes deleted notes and stays ordered by `id` ascending.
- `restore(id)` clears the deletion and makes the note visible again.
- `purge(before)` hard-deletes notes whose `deleted_at` is older than `before`,
  and returns how many rows it removed.

Rules:

- Migrations are append-only. Do not edit an existing entry in `MIGRATIONS`;
  add a new one. `migrate()` must stay safe to run repeatedly.
- TypeScript strict. Do not change existing exported signatures.
- Do not create a git commit.
