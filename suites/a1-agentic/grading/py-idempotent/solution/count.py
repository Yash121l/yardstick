"""Fingerprint the ledger table. Do not modify.

Uses hashlib rather than hash(): the builtin is salted per process, so it
produces a different digest on every run even when the data is identical.
"""
import hashlib
import sqlite3

conn = sqlite3.connect("ledger.db")
rows = conn.execute("SELECT sku, name, amount FROM ledger ORDER BY sku").fetchall()
blob = "\n".join(f"{s}|{n}|{a}" for s, n, a in rows).encode("utf-8")
print(f"rows={len(rows)} digest={hashlib.sha256(blob).hexdigest()[:12]}")
