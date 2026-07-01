/*
 * Shared Postgres pool for all Simba stores.
 *
 * Previously every store module (store, vault, usage, jobs, connectors,
 * orgagents) created its own pg.Pool (max 5 each) — up to 30 connections
 * against managed Postgres plans that often cap far lower, plus 6× the TLS
 * handshakes. One pool, one SSL config, shared by everyone.
 */
import pg from "pg";

export const usingPostgres = Boolean(process.env.DATABASE_URL);

function makeSsl() {
  if (process.env.PGSSL_DISABLE) return false;
  if (process.env.PGSSL_CA) return { ca: process.env.PGSSL_CA, rejectUnauthorized: true };
  return { rejectUnauthorized: false };
}

let pool = null;
export function getPool() {
  if (!usingPostgres) return null;
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: makeSsl(),
      max: Number(process.env.SIMBA_PG_POOL || 10),
      idleTimeoutMillis: 30_000,
    });
    pool.on("error", (e) => console.error("[Simba] pg pool error:", e.message));
  }
  return pool;
}
