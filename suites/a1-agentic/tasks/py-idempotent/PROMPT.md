# Make the loader safe to re-run

`loader.py` loads `feed.csv` into a SQLite table. It is run on a schedule and
sometimes retried after a partial failure, so it must be idempotent: running it
twice must leave the database in exactly the state one run leaves it in.

Right now a second run duplicates every row.

Fix `loader.py` so that:

- Re-running never creates duplicate rows.
- A row whose `amount` changed in the feed is UPDATED to the new value.
- A row present in the database but absent from the feed is left alone.
- `python3 loader.py` still exits 0 and still prints nothing on success.

`python3 count.py` prints a fingerprint of the table. It is used to check the
result; do not modify it.

Do not create a git commit.
