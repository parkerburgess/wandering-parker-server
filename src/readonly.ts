import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import type { JWTPayload } from "jose";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Read-only enforcement for the shared guest account. Returns a 403 NextResponse
 * when the guest (identified by the GUEST_EMAIL claim in the verified JWT) makes
 * a mutating request, or null to let the request through.
 *
 * Call it from an app's proxy after the JWT is verified. It is pure — no DB, no
 * shared pool — so it is safe to use in Next's proxy runtime.
 */
export function enforceReadOnly(payload: JWTPayload, request: NextRequest): NextResponse | null {
  const guestEmail = process.env.GUEST_EMAIL;
  if (!guestEmail || payload.email !== guestEmail) {
    return null;
  }

  if (SAFE_METHODS.has(request.method.toUpperCase())) {
    return null;
  }

  // Auth endpoints (guest sign-in / sign-out) must stay reachable.
  if (request.nextUrl.pathname.startsWith("/api/auth")) {
    return null;
  }

  return NextResponse.json({ error: "Guest access is read-only." }, { status: 403 });
}
