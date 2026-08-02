"""Load feed.csv into the ledger table."""
import csv
import sqlite3

DB = "ledger.db"


def main() -> None:
    conn = sqlite3.connect(DB)
    conn.execute(
        """CREATE TABLE IF NOT EXISTS ledger (
               sku    TEXT NOT NULL,
               name   TEXT NOT NULL,
               amount INTEGER NOT NULL
           )"""
    )
    with open("feed.csv", newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            conn.execute(
                "INSERT INTO ledger (sku, name, amount) VALUES (?, ?, ?)",
                (row["sku"], row["name"], int(row["amount"])),
            )
    conn.commit()
    conn.close()


if __name__ == "__main__":
    main()
