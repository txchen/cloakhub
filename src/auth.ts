import { timingSafeEqual } from "node:crypto";
import { textResponse } from "./http";

export const ADMIN_AUTH_COOKIE = "cloakhub_auth";

export function isUiAuthorized(request: Request, authToken: string | undefined): boolean {
  if (!authToken) {
    return true;
  }

  const cookieToken = cookieTokenFrom(request, ADMIN_AUTH_COOKIE);
  return cookieToken !== undefined && tokensMatch(cookieToken, authToken);
}

export function isAdminApiAuthorized(request: Request, authToken: string | undefined): boolean {
  if (!authToken) {
    return true;
  }

  const bearerToken = bearerTokenFrom(request);
  return bearerToken !== undefined && tokensMatch(bearerToken, authToken);
}

export async function adminLoginResponse(request: Request, authToken: string | undefined): Promise<Response> {
  if (request.method !== "POST") {
    return textResponse("Method not allowed", 405, { Allow: "POST" });
  }

  if (!authToken) {
    return new Response(null, { status: 204 });
  }

  const submittedToken = await tokenFromJsonBody(request);
  if (!submittedToken || !tokensMatch(submittedToken, authToken)) {
    return textResponse("Unauthorized", 401, { "WWW-Authenticate": "Bearer" });
  }

  return new Response(null, {
    headers: {
      "cache-control": "no-store",
      "set-cookie": authCookie(authToken)
    },
    status: 204
  });
}

export function unauthorizedResponse(): Response {
  return textResponse("Unauthorized", 401, { "WWW-Authenticate": "Bearer" });
}

function bearerTokenFrom(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return undefined;
  }

  const token = authorization.slice("Bearer ".length).trim();
  return token ? token : undefined;
}

function cookieTokenFrom(request: Request, cookieName: string): string | undefined {
  return request.headers
    .get("cookie")
    ?.split(";")
    .map((cookie) => cookie.trim())
    .find((cookie) => cookieNameFrom(cookie) === cookieName)
    ?.split("=")
    .slice(1)
    .join("=");
}

function cookieNameFrom(cookie: string): string {
  const separatorIndex = cookie.indexOf("=");
  return separatorIndex === -1 ? cookie : cookie.slice(0, separatorIndex);
}

async function tokenFromJsonBody(request: Request): Promise<string | undefined> {
  try {
    const body = await request.json();
    if (typeof body !== "object" || body === null || !("token" in body)) {
      return undefined;
    }

    const token = body.token;
    return typeof token === "string" ? token : undefined;
  } catch {
    return undefined;
  }
}

function authCookie(authToken: string): string {
  return [
    `${ADMIN_AUTH_COOKIE}=${encodeURIComponent(authToken)}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax"
  ].join("; ");
}

function tokensMatch(actual: string, expected: string): boolean {
  const actualBytes = new TextEncoder().encode(safeDecodeURIComponent(actual));
  const expectedBytes = new TextEncoder().encode(expected);

  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
