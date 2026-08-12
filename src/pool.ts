import sql from "mssql";

declare global {
  // eslint-disable-next-line no-var
  var _sqlPool: sql.ConnectionPool | undefined;
}

const MAX_ATTEMPTS = 8;
const BASE_DELAY_MS = 1000;

// Driver error codes are more reliable than message text — a genuinely cold/
// paused database fails the TCP-level connect itself (ETIMEOUT), which never
// contains any of the message substrings below. Those substrings stay as a
// fallback for RequestError-shaped failures (e.g. Azure's 40613 returned once
// a connection succeeds but the engine itself isn't ready yet).
const RETRYABLE_CODES = new Set(["ETIMEOUT", "ECONNREFUSED", "ESOCKET"]);

function isRetryable(error: unknown): boolean {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : undefined;
  if (code && RETRYABLE_CODES.has(code)) return true;

  const msg = error instanceof Error ? error.message : String(error);
  return (
    msg.includes("40613") ||
    
    msg.includes("not currently available") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("Connection timeout") ||
    msg.includes("socket hang up")
  );
}

export async function getPool(): Promise<sql.ConnectionPool> {
  if (global._sqlPool?.connected) return global._sqlPool;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      global._sqlPool = await new sql.ConnectionPool({
        server: process.env.DB_SERVER!,
        database: process.env.DB_DATABASE!,
        user: process.env.DB_USER!,
        password: process.env.DB_PASSWORD!,
        options: {
          encrypt: true,
          trustServerCertificate: false,
        },
      }).connect();
      return global._sqlPool;
    } catch (error) {
      if (attempt === MAX_ATTEMPTS || !isRetryable(error)) throw error;
      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error("unreachable");
}

// A resumed connection doesn't guarantee the database is done waking up — a
// serverless/auto-paused SQL instance can accept the connection while still
// finishing its own resume, so the *query* itself can still fail transiently
// even after getPool() above already succeeded. Route every query through
// this instead of calling pool.request() directly, or that failure mode has
// no retry at all.
export async function executeQuery<T>(
  fn: (request: sql.Request) => Promise<T>
): Promise<T> {
  const pool = await getPool();

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn(new sql.Request(pool));
    } catch (error) {
      if (attempt === MAX_ATTEMPTS || !isRetryable(error)) throw error;
      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error("unreachable");
}

// TODO(db-wake-progress): callers currently have zero visibility into retry
// attempts in progress — from the UI's perspective the whole operation is
// just pending until it resolves or exhausts MAX_ATTEMPTS (up to ~4 minutes
// of backoff). A caller can't currently show "waking up the database, retrying
// 3/8..." because there's nowhere for that state to surface.
//
// To support that: getPool()/executeQuery() would need to accept an optional
// onAttempt?: (attempt: number, maxAttempts: number, delayMs: number) => void
// callback (or be rewritten as async generators that yield progress events
// before their final value), and callers would need a way to stream that state
// to the browser mid-request (Server-Sent Events, or a Next.js Route Handler
// returning a ReadableStream) since a normal request/response can't push
// updates before the final response. Deferred for now in favor of a simpler
// client-side "this is taking a while" heuristic (see wp-ui's slow-request
// notice) — revisit if per-attempt detail turns out to matter in practice.
