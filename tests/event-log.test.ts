import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { openEventLog, type EventLog } from "../src/event-log";
import { createApp } from "../src/app";
const dirs: string[] = [];
const stores: EventLog[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const dir = await mkdtemp("/tmp/cloakhub-events-");
  dirs.push(dir);
  const events = openEventLog(dir);
  stores.push(events);
  return { dir, events };
}
test("history persists across reopening and paginates without skipping equal timestamps", async () => {
  const { dir, events } = await fixture();
  for (let i = 0; i < 5; i++)
    events.record({
      profile_id: i % 2 ? "other" : "work",
      type: "browser.stopped",
      message: "Browser stopped.",
      occurred_at: "2026-09-09T12:00:00.000Z",
      details: { reason: "idle timeout" }
    });
  stores.pop()!.close();
  const reopened = openEventLog(dir);
  stores.push(reopened);
  const first = reopened.list({ limit: 2 });
  const next = reopened.list({ limit: 2, before: first.next_before! });
  expect(first.events.map((e) => e.id)).toEqual([5, 4]);
  expect(next.events.map((e) => e.id)).toEqual([3, 2]);
  expect(
    reopened.list({
      profile_id: "work",
      type: "browser.stopped",
      since: "2026-09-09T12:00:00.000Z",
      until: "2026-09-09T12:00:00.000Z"
    }).events
  ).toHaveLength(3);
  expect(
    reopened.list({ since: "2026-09-09T12:00:01.000Z" }).events
  ).toHaveLength(0);
});
test("event endpoints enforce admin and UI auth, validate filters, and do not touch runtime", async () => {
  const { dir, events } = await fixture();
  events.record({
    profile_id: "deleted",
    type: "browser.stopped",
    message: "Browser stopped.",
    details: { reason: "idle timeout" }
  });
  const app = createApp(
    {
      dataRoot: dir,
      host: "localhost",
      port: 7788,
      maxRunningInstances: 10,
      authToken: "admin",
      browserBin: undefined
    },
    { events }
  );
  for (const path of ["/api/events", "/ui/events"]) {
    expect((await app.fetch(new Request(`http://hub${path}`))).status).toBe(
      401
    );
  }
  const get = (query: string) =>
    app.fetch(
      new Request(`http://hub/api/events${query}`, {
        headers: { Authorization: "Bearer admin" }
      })
    );
  for (const query of [
    "?limit=0",
    "?limit=201",
    "?before=1.5",
    "?since=bad",
    "?since=2026-09-10T00:00:00Z&until=2026-09-09T00:00:00Z"
  ])
    expect((await get(query)).status).toBe(400);
  const response = await get("?profile_id=deleted");
  expect(response.status).toBe(200);
  expect((await response.json()).events[0].details.reason).toBe("idle timeout");
  expect(response.headers.get("cache-control")).toBe("no-store");
});
