import { decodeJwt } from "jose";
import { cookies } from "next/headers";

const DEV_USER_ID = "dev-user-1";
const DEV_USER_NAME = "Dev User (Parker)";

function isAuthDisabled(): boolean {
  return process.env.DISABLE_AUTH === "true" && process.env.NODE_ENV !== "production";
}

async function getPayload() {
  const token = (await cookies()).get("auth_token")!.value;
  return decodeJwt(token);
}

// proxy.ts verifies the token's signature and expiry (jwtVerify) on every
// request before this ever runs, so a plain decode here is safe.
export async function getUserId(): Promise<string> {
  if (isAuthDisabled()) return DEV_USER_ID;
  return (await getPayload()).sub!;
}

export async function getUserName(): Promise<string | null> {
  if (isAuthDisabled()) return DEV_USER_NAME;
  try {
    const payload = await getPayload();
    return (payload.name as string | undefined) ?? (payload.email as string | undefined) ?? null;
  } catch {
    return null;
  }
}
