"""Load feed.csv into the ledger table. Idempotent: upsert on sku."""
import csv
import sqlite3

DB = "ledger.db"


def main() -> None:
    conn = sqlite3.connect(DB)
    conn.execute(
        """CREATE TABLE IF NOT EXISTS ledger (
               sku    TEXT NOT NULL PRIMARY KEY,
               name   TEXT NOT NULL,
               amount INTEGER NOT NULL
           )"""
    )
    with open("feed.csv", newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            conn.execute(
                """INSERT INTO ledger (sku, name, amount) VALUES (?, ?, ?)
                   ON CONFLICT(sku) DO UPDATE SET
                       name = excluded.name,
                       amount = excluded.amount""",
                (row["sku"], row["name"], int(row["amount"])),
            )
    conn.commit()
    conn.close()


if __name__ == "__main__":
    main()
