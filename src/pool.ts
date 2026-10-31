import sql from "mssql";

declare global {
  // eslint-disable-next-line no-var
  var _sqlPool: sql.ConnectionPool | undefined;
}

// The database is provisioned (always on), so retries only need to ride out
// Azure SQL's brief transient faults — failovers and maintenance
// reconfigurations that clear within a few seconds. Waits: 0.5s, then 1s.
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;

// Driver error codes are more reliable than message text — a dropped or
// refused connection fails at the TCP level (ETIMEOUT/ESOCKET), which never
// contains any of the message substrings below. Those substrings cover
// RequestError-shaped failures: Azure's transient error numbers 40613
// (database unavailable), 40197 (service error during reconfiguration) and
// 40501 (service busy).
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
    msg.includes("40197") ||
    msg.includes("40501") ||
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

// A healthy pool doesn't guarantee a healthy query — a transient Azure fault
// can hit mid-request even after getPool() above already succeeded. Route
// every read through this instead of calling pool.request() directly, or that
// failure mode has no retry at all. Be careful with non-idempotent writes: an
// INSERT can commit and then lose its connection, and a retry applies it twice.
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

