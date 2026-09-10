import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserLicensePool, loadBrowserLicenseKeys, queryLicenseSeats, withoutLicenseSecrets } from "../src/browser-license";

const paths: string[] = [];
afterEach(async () => { await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe("browser license configuration", () => {
  test("supports a secret file, an env array, and the existing single-key file; deduplicates keys", async () => {
    const home = await mkdtemp(join(tmpdir(), "cloakhub-license-"));
    paths.push(home);
    await mkdir(join(home, ".cloakbrowser"));
    await writeFile(join(home, ".cloakbrowser/license.key"), "legacy-key\n");
    const secret = join(home, "keys");
    await writeFile(secret, "key-a\r\nkey-b\n\n key-a \n");
    expect(await loadBrowserLicenseKeys({}, home)).toEqual(["legacy-key"]);
    expect(await loadBrowserLicenseKeys({ CLOAKHUB_LICENSE_KEYS_FILE: secret }, home)).toEqual(["key-a", "key-b"]);
    expect(await loadBrowserLicenseKeys({ CLOAKHUB_LICENSE_KEYS: '["key-c", "key-c"]', CLOAKHUB_LICENSE_KEYS_FILE: secret }, home)).toEqual(["key-c"]);
    expect(await loadBrowserLicenseKeys({ CLOAKBROWSER_LICENSE_KEY: " env-key " }, home)).toEqual(["env-key"]);
  });

  test("rejects malformed explicit configuration without echoing its contents", async () => {
    for (const raw of ['["sensitive-key", null]', 'sensitive-key', '[]', '{}']) {
      const error = await loadBrowserLicenseKeys({ CLOAKHUB_LICENSE_KEYS: raw }).catch(e => e);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).not.toContain("sensitive-key");
    }
    await expect(loadBrowserLicenseKeys({ CLOAKHUB_LICENSE_KEYS_FILE: "/does/not/exist" })).rejects.toThrow("Cannot read");
    expect(withoutLicenseSecrets({ PATH: "/bin", CLOAKBROWSER_LICENSE_KEY: "secret", CLOAKHUB_LICENSE_KEYS: "all-keys" })).toEqual({ PATH: "/bin" });
  });
});

describe("browser license allocation", () => {
  test("three independent one-seat keys allow exactly three simultaneous local leases despite stale upstream counts", async () => {
    const pool = await createBrowserLicensePool(["a", "b", "c", "a"], async () => ({ active: 0, limit: 1 }));
    expect(pool.capacity).toBe(3);
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => pool.acquire()));
    const leases = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
    expect(new Set(leases.map(lease => lease.key)).size).toBe(3);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    leases[0].release();
    leases[0].release();
    const replacement = await pool.acquire();
    expect(replacement.key).toBe(leases[0].key);
    await expect(pool.acquire()).rejects.toThrow("capacity is full");
  });

  test("one multi-seat key uses its returned quota, including external occupancy and lower limits", async () => {
    let state = { active: 1, limit: 3 };
    const pool = await createBrowserLicensePool(["paid"], async () => state);
    expect(pool.capacity).toBe(3);
    const first = await pool.acquire();
    const second = await pool.acquire();
    await expect(pool.acquire()).rejects.toThrow("capacity is full");
    second.release();
    state = { active: 3, limit: 3 };
    await expect(pool.acquire()).rejects.toThrow("capacity is full");
    state = { active: 0, limit: 1 };
    await expect(pool.acquire()).rejects.toThrow("capacity is full");
    first.release();
    await expect(pool.acquire()).resolves.toMatchObject({ key: "paid" });
  });

  test("an unavailable key does not stop a working key; unavailable quotas never mean unlimited", async () => {
    let available = true;
    const pool = await createBrowserLicensePool(["unavailable", "working"], async key => {
      if (key === "unavailable" || !available) throw new Error("upstream secret");
      return { active: 0, limit: 1 };
    });
    const lease = await pool.acquire();
    expect(lease.key).toBe("working");
    lease.release();
    available = false;
    await expect(pool.acquire()).rejects.toThrow("quota unavailable");
    available = true;
    await expect(pool.acquire()).resolves.toMatchObject({ key: "working" });
  });

  test("HTTP failures, redirects, unknown counts and malformed quota data produce sanitized errors", async () => {
    const original = globalThis.fetch;
    try {
      for (const body of [{ active: null, limit: 3 }, { active: 0, limit: null }, { active: true, limit: 3 }, { active: 0, limit: -1 }]) {
        globalThis.fetch = (async () => Response.json(body)) as unknown as typeof fetch;
        await expect(queryLicenseSeats("secret-key")).rejects.toThrow("quota unavailable");
      }
      globalThis.fetch = (async () => { throw new Error("secret-key"); }) as unknown as typeof fetch;
      const error = await queryLicenseSeats("secret-key").catch(e => e);
      expect(error.message).not.toContain("secret-key");
    } finally { globalThis.fetch = original; }
  });
});
