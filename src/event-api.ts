import type { EventLog, EventQuery } from "./event-log";
import { apiErrorResponse } from "./http";

export function eventLogResponse(
  request: Request,
  url: URL,
  events?: EventLog
): Response {
  if (request.method !== "GET")
    return new Response(null, { status: 405, headers: { Allow: "GET" } });
  if (!events)
    return apiErrorResponse("Event log is unavailable", 503, "INTERNAL_ERROR");
  const query: EventQuery = {};
  for (const key of ["profile_id", "type"] as const) {
    const value = url.searchParams.get(key);
    if (value) query[key] = value;
  }
  for (const key of ["since", "until"] as const) {
    const value = url.searchParams.get(key);
    if (value) {
      if (
        !/^\d{4}-\d{2}-\d{2}T/.test(value) ||
        !Number.isFinite(Date.parse(value))
      )
        return apiErrorResponse(`Invalid ${key} timestamp`, 400, "BAD_REQUEST");
      query[key] = new Date(value).toISOString();
    }
  }
  if (query.since && query.until && query.since > query.until)
    return apiErrorResponse(
      "Start time must precede end time",
      400,
      "BAD_REQUEST"
    );
  for (const key of ["before", "limit"] as const) {
    const value = url.searchParams.get(key);
    if (value !== null) {
      const number = Number(value);
      if (
        !/^\d+$/.test(value) ||
        !Number.isSafeInteger(number) ||
        number < 1 ||
        (key === "limit" && number > 200)
      )
        return apiErrorResponse(`Invalid ${key}`, 400, "BAD_REQUEST");
      query[key] = number;
    }
  }
  return Response.json(events.list(query), {
    headers: { "cache-control": "no-store" }
  });
}
