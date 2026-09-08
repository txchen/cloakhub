export async function request<T>(
  path: string,
  method = "GET",
  body?: unknown
): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(
      response.status === 401
        ? "Your session expired. Reload this page to sign in."
        : payload.error || `Request failed (${response.status}). Try again.`
    );
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
export function profilePath(id: string): string {
  return `/ui/profiles/${encodeURIComponent(id)}`;
}
