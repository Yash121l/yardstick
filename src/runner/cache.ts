import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { ProviderRequest, ProviderResponse } from "../types.js";

export interface CacheKeyParts {
  modelId: string;
  resolvedModel: string;
  request: ProviderRequest;
  fixturesVersion: string;
  repeatIndex: number;
}

/**
 * Repeat index is part of the key on purpose: repeats must produce independent
 * samples, so repeat 1 never reads repeat 0's cached answer.
 */
export function cacheKey(p: CacheKeyParts): string {
  const h = createHash("sha256");
  h.update(p.modelId).update("\0");
  h.update(p.resolvedModel).update("\0");
  h.update(p.fixturesVersion).update("\0");
  h.update(String(p.repeatIndex)).update("\0");
  h.update(stableStringify(p.request));
  return h.digest("hex");
}

/** Deterministic JSON — key order must never change the hash. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export class ResponseCache {
  private db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS responses (
        key TEXT PRIMARY KEY,
        model_id TEXT NOT NULL,
        resolved_model TEXT NOT NULL,
        fixtures_version TEXT NOT NULL,
        response_json TEXT NOT NULL,
        cost_usd REAL NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  get(key: string): { response: ProviderResponse; costUsd: number } | null {
    const row = this.db
      .prepare("SELECT response_json, cost_usd FROM responses WHERE key = ?")
      .get(key) as { response_json: string; cost_usd: number } | undefined;
    if (!row) return null;
    return { response: JSON.parse(row.response_json) as ProviderResponse, costUsd: row.cost_usd };
  }

  put(
    key: string,
    meta: { modelId: string; resolvedModel: string; fixturesVersion: string },
    response: ProviderResponse,
    costUsd: number,
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO responses
         (key, model_id, resolved_model, fixtures_version, response_json, cost_usd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        key,
        meta.modelId,
        meta.resolvedModel,
        meta.fixturesVersion,
        JSON.stringify(response),
        costUsd,
        new Date().toISOString(),
      );
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Is this response safe to cache?
 *
 * A `content` refusal is a fact about the model — it declined this text and will
 * decline it again, so caching it is correct. A `param_rejected` or
 * `schema_unsupported` refusal is normally a fact about OUR request: the
 * capability table was wrong. Caching that is actively harmful, because the
 * operator fixes the table, re-runs, and the stale refusal replays with its
 * original request_id as though the fix did nothing.
 *
 * The exception is a P6 probe. Those set `probeRaw` precisely to bypass the
 * capability table and let the provider answer for itself, so there the
 * rejection IS the measurement and must be kept.
 */
export function isCacheable(
  response: { refusal?: { kind: string } | null },
  request?: { probeRaw?: boolean },
): boolean {
  if (request?.probeRaw) return true;
  const kind = response.refusal?.kind;
  return kind !== "param_rejected" && kind !== "schema_unsupported";
}
