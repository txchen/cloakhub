import { describe, expect, test } from "bun:test";

import {
  normalizeCreateProfileInput,
  redactCdpTokens,
  redactProfileSecrets,
  resolveSleepPolicy,
  validateProfileId
} from "../src/profile";

describe("Browser Profile validation", () => {
  test("accepts v1 Profile IDs", () => {
    expect(validateProfileId("work")).toEqual({ ok: true, profile_id: "work" });
    expect(validateProfileId("work_2026")).toEqual({ ok: true, profile_id: "work_2026" });
  });

  test("rejects invalid Profile IDs", () => {
    expect(validateProfileId("Work")).toEqual({
      error: "Profile ID must match ^[a-z][a-z0-9_]*$",
      ok: false
    });
    expect(validateProfileId("1work")).toEqual({
      error: "Profile ID must match ^[a-z][a-z0-9_]*$",
      ok: false
    });
  });

  test("accepts the supported launch/profile field set", () => {
    expect(
      normalizeCreateProfileInput({
        clipboard_sync: false,
        color_scheme: "dark",
        custom_launch_args: ["--disable-webgl"],
        fingerprint_seed: "seed-1",
        geoip: "US",
        gpu_renderer: "Mesa",
        gpu_vendor: "Intel",
        hardware_concurrency: 8,
        headless: true,
        human_preset: "balanced",
        humanize: true,
        locale: "en-US",
        platform: "linux",
        profile_id: "work",
        proxy: "proxy.example:8080:user:secret",
        screen_height: 1080,
        screen_width: 1920,
        sleep_policy: { mode: "minutes", minutes: 45 },
        tags: [{ color: "#1f6feb", name: "client" }],
        timezone: "America/Los_Angeles",
        user_agent: "Mozilla/5.0"
      })
    ).toMatchObject({
      clipboard_sync: false,
      custom_launch_args: ["--disable-webgl"],
      profile_id: "work",
      proxy: "http://user:secret@proxy.example:8080",
      sleep_policy: { mode: "minutes", minutes: 45 },
      tags: [{ color: "#1f6feb", name: "client" }]
    });
  });

  test("rejects invalid proxy, screen dimensions, tag colors, and CloakHub-owned launch flags", () => {
    expect(() =>
      normalizeCreateProfileInput({ profile_id: "work", proxy: "http://proxy.example" })
    ).toThrow("proxy must include a hostname and port");

    expect(() =>
      normalizeCreateProfileInput({ profile_id: "work", proxy: "proxy.example:" })
    ).toThrow("proxy must include a hostname and port");

    expect(() =>
      normalizeCreateProfileInput({ profile_id: "work", proxy: "proxy.example:not-a-port" })
    ).toThrow("proxy port must be numeric");

    expect(() =>
      normalizeCreateProfileInput({ profile_id: "work", screen_width: 0 })
    ).toThrow("screen_width must be an integer between 100 and 10000");

    expect(() =>
      normalizeCreateProfileInput({
        profile_id: "work",
        custom_launch_args: ["--remote-debugging-port=9222"]
      })
    ).toThrow("custom_launch_args cannot include CloakHub-owned flag --remote-debugging-port");

    expect(() =>
      normalizeCreateProfileInput({
        profile_id: "work",
        custom_launch_args: ["--remote-debugging-pipe"]
      })
    ).toThrow("custom_launch_args cannot include CloakHub-owned flag --remote-debugging-pipe");

    expect(() =>
      normalizeCreateProfileInput({
        profile_id: "work",
        custom_launch_args: ["--window-size=800,800"]
      })
    ).toThrow("custom_launch_args cannot include CloakHub-owned flag --window-size");

    expect(() =>
      normalizeCreateProfileInput({
        profile_id: "work",
        tags: [{ color: "blue", name: "client" }]
      })
    ).toThrow("tag color must be a hex color");

    expect(() =>
      normalizeCreateProfileInput({
        profile_id: "work",
        sleep_policy: { mode: "minutes", minutes: 0 }
      })
    ).toThrow("sleep_policy.minutes must be an integer between 1 and 1440");

    expect(() =>
      normalizeCreateProfileInput({
        profile_id: "work",
        sleep_policy: { mode: "minutes", minutes: 1441 }
      })
    ).toThrow("sleep_policy.minutes must be an integer between 1 and 1440");

    expect(() =>
      normalizeCreateProfileInput({
        profile_id: "work",
        sleep_policy: { mode: "minutes" }
      })
    ).toThrow("sleep_policy.minutes must be an integer between 1 and 1440");

    expect(() =>
      normalizeCreateProfileInput({
        profile_id: "work",
        sleep_policy: { mode: "minutes", minutes: 1.5 }
      })
    ).toThrow("sleep_policy.minutes must be an integer between 1 and 1440");

    expect(() =>
      normalizeCreateProfileInput({
        profile_id: "work",
        sleep_policy: { mode: "unsupported" }
      })
    ).toThrow("sleep_policy.mode must be default, minutes, or never");
  });

  test("defaults fingerprint seed and redacts proxy credentials from messages", () => {
    const profile = normalizeCreateProfileInput({ profile_id: "work" });

    expect(profile.fingerprint_seed).toMatch(/^[0-9]{5}$/);
    expect(
      redactProfileSecrets("launch failed for http://user:secret@proxy.example:8080")
    ).toBe("launch failed for http://user:***@proxy.example:8080");
  });

  test("redacts CDP Tokens from messages and token-bearing URLs", () => {
    expect(
      redactCdpTokens(
        "failed to fetch /api/profiles/work/cdp/json/version?token=profile-token with Bearer profile-token",
        ["profile-token"]
      )
    ).toBe("failed to fetch /api/profiles/work/cdp/json/version?token=*** with Bearer ***");
  });

  test("resolves Sleep Policy from global default, per-profile minutes, or never-sleep", () => {
    expect(resolveSleepPolicy({ mode: "default" }, 30)).toEqual({
      blocks_sleep: false,
      effective_minutes: 30,
      mode: "default"
    });
    expect(resolveSleepPolicy({ mode: "minutes", minutes: 45 }, 30)).toEqual({
      blocks_sleep: false,
      effective_minutes: 45,
      mode: "minutes"
    });
    expect(resolveSleepPolicy({ mode: "never" }, 30)).toEqual({
      blocks_sleep: true,
      effective_minutes: null,
      mode: "never"
    });
  });
});
