import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { INTERNAL_CDP_PORT_RANGE, INTERNAL_DISPLAY_NUMBER_RANGE, INTERNAL_VNC_PORT_RANGE, loadConfigFromEnv } from "../src/config";

describe("loadConfigFromEnv", () => {
  test("validates deployment region defaults before starting", () => {
    expect(loadConfigFromEnv({
      CLOAKHUB_DEFAULT_TIMEZONE: "Asia/Tokyo", CLOAKHUB_DEFAULT_LOCALE: "ja-JP"
    }).creationRegion).toEqual({ timezone: "Asia/Tokyo", locale: "ja-JP" });
    expect(() => loadConfigFromEnv({ CLOAKHUB_DEFAULT_TIMEZONE: "Not/AZone" })).toThrow();
    expect(() => loadConfigFromEnv({ CLOAKHUB_DEFAULT_LOCALE: "not_a_locale" })).toThrow();
  });
  test("uses documented defaults", () => {
    const config = loadConfigFromEnv({}, "/home/operator");

    expect(config).toEqual({
      creationRegion: { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, locale: "en-US" },
      authToken: undefined,
      browserBin: undefined,
      diskCacheSizeMb: 256,
      dataRoot: join("/home/operator", ".cloakhub", "data"),
      host: "127.0.0.1",
      maxRunningInstances: 10,
      port: 7788
    });
  });

  test("uses environment overrides", () => {
    const config = loadConfigFromEnv(
      {
        CLOAKHUB_AUTH_TOKEN: "admin-token",
        CLOAKHUB_BROWSER_BIN: "/opt/cloakbrowser/cloakbrowser",
        CLOAKHUB_DISK_CACHE_SIZE_MB: "128",
        CLOAKHUB_DATA_DIR: "/data",
        CLOAKHUB_HOST: "0.0.0.0",
        CLOAKHUB_MAX_RUNNING_INSTANCES: "4",
        CLOAKHUB_PORT: "8899"
      },
      "/home/operator"
    );

    expect(config).toEqual({
      creationRegion: { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, locale: "en-US" },
      authToken: "admin-token",
      browserBin: "/opt/cloakbrowser/cloakbrowser",
      diskCacheSizeMb: 128,
      dataRoot: "/data",
      host: "0.0.0.0",
      maxRunningInstances: 4,
      port: 8899
    });
  });

  test("fails clearly for invalid numeric configuration", () => {
    expect(() => loadConfigFromEnv({ CLOAKHUB_PORT: "not-a-port" }, "/home/operator")).toThrow(
      "CLOAKHUB_PORT must be an integer between 1 and 65535"
    );

    expect(() =>
      loadConfigFromEnv({ CLOAKHUB_MAX_RUNNING_INSTANCES: "0" }, "/home/operator")
    ).toThrow("CLOAKHUB_MAX_RUNNING_INSTANCES must be a positive integer");

    expect(() =>
      loadConfigFromEnv({ CLOAKHUB_MAX_RUNNING_INSTANCES: "101" }, "/home/operator")
    ).toThrow("CLOAKHUB_MAX_RUNNING_INSTANCES must be no more than 100");
  });

  test("rejects invalid cache sizes instead of falling back to automatic sizing", () => {
    for (const value of ["0", "-1", "1.5", "NaN", "Infinity", "2048"]) {
      expect(() => loadConfigFromEnv({ CLOAKHUB_DISK_CACHE_SIZE_MB: value })).toThrow("CLOAKHUB_DISK_CACHE_SIZE_MB");
    }
    expect(loadConfigFromEnv({ CLOAKHUB_DISK_CACHE_SIZE_MB: " " }).diskCacheSizeMb).toBe(256);
  });

  test("documents fixed internal resource ranges used for Running Instance capacity", () => {
    expect(INTERNAL_CDP_PORT_RANGE).toEqual({ endInclusive: 5199, start: 5100 });
    expect(INTERNAL_DISPLAY_NUMBER_RANGE).toEqual({ endInclusive: 199, start: 100 });
    expect(INTERNAL_VNC_PORT_RANGE).toEqual({ endInclusive: 5999, start: 5900 });
  });
});
