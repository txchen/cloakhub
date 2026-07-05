import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { loadConfigFromEnv } from "../src/config";

describe("loadConfigFromEnv", () => {
  test("uses documented defaults", () => {
    const config = loadConfigFromEnv({}, "/home/operator");

    expect(config).toEqual({
      authToken: undefined,
      browserBin: undefined,
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
        CLOAKHUB_DATA_DIR: "/data",
        CLOAKHUB_HOST: "0.0.0.0",
        CLOAKHUB_MAX_RUNNING_INSTANCES: "4",
        CLOAKHUB_PORT: "8899"
      },
      "/home/operator"
    );

    expect(config).toEqual({
      authToken: "admin-token",
      browserBin: "/opt/cloakbrowser/cloakbrowser",
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
  });
});
