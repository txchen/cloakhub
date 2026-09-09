export function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
      ...headers
    },
    status
  });
}

export function textResponse(body: string, status: number, headers: HeadersInit = {}): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      ...headers
    },
    status
  });
}

const ERROR_CODES: Record<number, string> = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  404: "NOT_FOUND",
  405: "METHOD_NOT_ALLOWED",
  409: "CONFLICT",
  426: "UPGRADE_REQUIRED",
  500: "INTERNAL_ERROR",
  503: "SERVICE_UNAVAILABLE"
};

export function apiErrorResponse(
  message: string,
  status: number,
  code = ERROR_CODES[status] ?? "INTERNAL_ERROR",
  retryable = false,
  headers: HeadersInit = {}
): Response {
  return jsonResponse(
    { error: message, code, message, retryable },
    status,
    { ...headers, "cache-control": "no-store" }
  );
}

// Keep errors from routing/auth consistent with errors from application handlers.
export async function normalizeApiError(response: Response): Promise<Response> {
  if (response.status < 400) return response;
  const raw = await response.text();
  let body: { error?: string; code?: string; retryable?: boolean } = {};
  try {
    body = JSON.parse(raw);
  } catch {
    // Plain-text routing error.
  }
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  const result = apiErrorResponse(
    typeof body?.error === "string" ? body.error : raw,
    response.status,
    body?.code,
    body?.retryable === true
  );
  headers.set("cache-control", "no-store");
  return new Response(result.body, { status: response.status, headers });
}

export function publicRequestUrl(requestUrl: URL, headers: Headers = new Headers()): URL {
  const url = new URL(requestUrl);
  const host = headers.get("x-forwarded-host");
  const protocol = headers.get("x-forwarded-proto");
  if (host) url.host = host;
  if (protocol === "http" || protocol === "https") url.protocol = `${protocol}:`;
  return url;
}
