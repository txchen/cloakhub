import { describe, expect, test } from "bun:test";

import { createShutdownHandle } from "../src/server";

describe("CloakHub server shutdown", () => {
  test("stops HTTP, shuts down Browser Instances, and closes the repository once", async () => {
    const calls: string[] = [];
    const idleTimer = setInterval(() => undefined, 60_000);
    idleTimer.unref();
    const handle = createShutdownHandle({
      browserRuntime: {
        shutdown: async () => {
          calls.push("runtime");
        }
      },
      closeRepository: () => {
        calls.push("repository");
      },
      idleTimer,
      stopServer: () => {
        calls.push("server");
      }
    });

    await Promise.all([handle.shutdown(), handle.shutdown()]);

    expect(calls).toEqual(["server", "runtime", "repository"]);
  });

  test("closes the repository even when Browser Instance shutdown reports an error", async () => {
    const calls: string[] = [];
    const idleTimer = setInterval(() => undefined, 60_000);
    idleTimer.unref();
    const handle = createShutdownHandle({
      browserRuntime: {
        shutdown: async () => {
          calls.push("runtime");
          throw new Error("runtime shutdown failed");
        }
      },
      closeRepository: () => {
        calls.push("repository");
      },
      idleTimer,
      stopServer: () => {
        calls.push("server");
      }
    });

    await expect(handle.shutdown()).rejects.toThrow("runtime shutdown failed");

    expect(calls).toEqual(["server", "runtime", "repository"]);
  });
});
