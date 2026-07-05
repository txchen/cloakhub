export function textResponse(body: string, status: number, headers: HeadersInit = {}): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      ...headers
    },
    status
  });
}
