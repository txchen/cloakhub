import { describe, expect, test } from "bun:test";

import {
  CapacityUnavailableError,
  createRuntimeCapacity,
  type RuntimeCapacityRunningInstance
} from "../src/runtime-capacity";
import type { BrowserProfile } from "../src/profile";

describe("RuntimeCapacity", () => {
  test("reserves fixed ports and displays without reusing running or reserved resources", async () => {
    const capacity = createRuntimeCapacity({
      cdpPortStart: 5100,
      displayNumberStart: 100,
      maxRunningInstances: 3,
      vncPortStart: 5900
    });
    const running = [
      runningInstance(profile({ headless: false, profile_id: "old" }), {
        cdpPort: 5100,
        displayNumber: 100,
        vncPort: 5900
      })
    ];

    expect(await capacity.reserve(profile({ headless: false, profile_id: "next" }), context(running))).toEqual(
      {
        cdpPort: 5101,
        display: ":101",
        displayNumber: 101,
        vncPort: 5901
      }
    );
    expect(await capacity.reserve(profile({ profile_id: "third" }), context(running))).toEqual({
      cdpPort: 5102
    });
  });

  test("preempts the least-recently-active eligible Browser Instance", async () => {
    const preempted: string[] = [];
    const capacity = createRuntimeCapacity({
      maxRunningInstances: 2,
      monotonicNow: () => 120_000
    });
    const running = [
      runningInstance(profile({ profile_id: "old" }), { lastActivityMs: 10 }),
      runningInstance(profile({ profile_id: "recent" }), { lastActivityMs: 100 })
    ];

    await capacity.reserve(profile({ profile_id: "next" }), {
      preempt: async (candidate) => {
        preempted.push(candidate.profile_id);
        running.splice(
          running.findIndex((entry) => entry.profile.profile_id === candidate.profile_id),
          1
        );
      },
      runningInstances: () => running
    });

    expect(preempted).toEqual(["old"]);
  });

  test("protects active CDP Sessions and recent Manual Input from Capacity Preemption", async () => {
    const capacity = createRuntimeCapacity({
      maxRunningInstances: 2,
      monotonicNow: () => 30_000
    });
    const running = [
      runningInstance(profile({ profile_id: "cdp" }), { activeCdpSessionCount: 1 }),
      runningInstance(profile({ headless: false, profile_id: "manual" }), { lastManualInputObservedMs: 10_000 })
    ];

    await expect(capacity.reserve(profile({ profile_id: "next" }), context(running))).rejects.toThrow(
      CapacityUnavailableError
    );
  });

  test("counts pending reservations until they are released", async () => {
    const capacity = createRuntimeCapacity({ maxRunningInstances: 1 });

    await capacity.reserve(profile({ profile_id: "first" }), context([]));
    await expect(capacity.reserve(profile({ profile_id: "second" }), context([]))).rejects.toThrow(
      CapacityUnavailableError
    );

    capacity.release("first");

    expect(await capacity.reserve(profile({ profile_id: "second" }), context([]))).toEqual({
      cdpPort: 5101
    });
  });
});

function context(running: RuntimeCapacityRunningInstance[]) {
  return {
    preempt: async () => undefined,
    runningInstances: () => running
  };
}

function runningInstance(
  profile: BrowserProfile,
  overrides: Partial<RuntimeCapacityRunningInstance> = {}
): RuntimeCapacityRunningInstance {
  return {
    activeCdpSessionCount: 0,
    cdpPort: 5100,
    profile,
    ...overrides
  };
}

function profile(overrides: Partial<BrowserProfile>): BrowserProfile {
  return {
    clipboard_sync: true,
    cdp_token: null,
    color_scheme: "system",
    created_at: "2026-01-01T00:00:00.000Z",
    custom_launch_args: [],
    display_name: overrides.profile_id ?? "work",
    fingerprint_seed: "12345",
    geoip: "",
    gpu_renderer: "",
    gpu_vendor: "",
    hardware_concurrency: 4,
    headless: true,
    human_preset: "",
    humanize: false,
    instance_status: "stopped",
    last_activity_at: null,
    last_delete_error: null,
    last_launch_error: null,
    last_launch_failed_at: null,
    last_manual_input_at: null,
    last_started_at: null,
    last_stop_reason: null,
    last_stopped_at: null,
    locale: "",
    notes: "",
    platform: "macos",
    profile_id: "work",
    proxy: "",
    screen_height: 1080,
    screen_width: 1920,
    sleep_policy: { mode: "default" },
    sleep_policy_status: { blocks_sleep: false, effective_minutes: 30, mode: "default" },
    timezone: "",
    updated_at: "2026-01-01T00:00:00.000Z",
    user_agent: "",
    ...overrides
  };
}
