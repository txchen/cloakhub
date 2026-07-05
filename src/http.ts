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
