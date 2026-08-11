import sql from "mssql";

declare global {
  // eslint-disable-next-line no-var
  var _sqlPool: sql.ConnectionPool | undefined;
}

const MAX_ATTEMPTS = 8;
const BASE_DELAY_MS = 1000;

function isRetryable(error: unknown): boolean {
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
