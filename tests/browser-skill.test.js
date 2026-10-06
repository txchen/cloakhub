import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { listTargets, readConfig, resolveTarget, safeError, withBrowser } from "../skills/cloakhub-browser/scripts/browser.mjs";

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cloakhub-skill-"));
  roots.push(root);
  const config = {
    version: 1, defaultTarget: "work",
    targets: {
      work: { url: "https://work.example", profile: "research", tokenFile: "work.token" },
      personal: { url: "http://127.0.0.1:7788", profile: "personal", tokenEnv: "PERSONAL_TOKEN" }
    }
  };
  const path = join(root, "client.json");
  await writeFile(path, JSON.stringify(config));
  await writeFile(join(root, "work.token"), "work-secret\n");
  return { config, path };
}

describe("CloakHub browser skill client", () => {
  test("selects URL, profile, and credentials together with explicit > env > default precedence", async () => {
    const loaded = await fixture();
    const env = { CLOAKHUB_TARGET: "personal", PERSONAL_TOKEN: "personal-secret" };
    expect(await resolveTarget(loaded, undefined, {})).toMatchObject({
      endpoint: "wss://work.example/api/profiles/research/cdp", token: "work-secret"
    });
    expect(await resolveTarget(loaded, undefined, env)).toMatchObject({
      endpoint: "ws://127.0.0.1:7788/api/profiles/personal/cdp", token: "personal-secret"
    });
    expect((await resolveTarget(loaded, "work", env)).token).toBe("work-secret");
  });

  test("accepts an inline token without exposing it in target listings", async () => {
    const loaded = await fixture();
    loaded.config.targets.work = { url: "https://work.example", profile: "research", token: "inline-secret" };
    expect(listTargets(loaded.config)).toContainEqual({
      name: "work", url: "https://work.example", profile: "research", auth: "cdp_token", default: true
    });
    expect(JSON.stringify(listTargets(loaded.config))).not.toContain("inline-secret");
    const target = await resolveTarget(loaded, "work", {});
    expect(target.token).toBe("inline-secret");
    await withBrowser(target, async () => {}, async (_endpoint, options) => {
      expect(options.headers).toEqual({ Authorization: "Bearer inline-secret" });
      return {
        contexts: () => [{ setDefaultTimeout() {}, setDefaultNavigationTimeout() {} }],
        close: async () => {}
      };
    });
  });

  test("lists safe target metadata even when secret files are absent", async () => {
    const loaded = await fixture();
    await rm(join(loaded.path, "..", "work.token"));
    expect(listTargets(loaded.config)).toEqual([
      { name: "work", url: "https://work.example", profile: "research", auth: "cdp_token", default: true },
      { name: "personal", url: "http://127.0.0.1:7788", profile: "personal", auth: "cdp_token", default: false }
    ]);
    await expect(resolveTarget(loaded, "work", {})).rejects.toThrow("Cannot read");
  });

  test("runs the CLI when invoked through a symlinked skill directory", async () => {
    const loaded = await fixture();
    const link = join(loaded.path, "..", "linked-skill");
    await symlink(resolve(import.meta.dir, "../skills/cloakhub-browser"), link);
    const proc = Bun.spawnSync(["node", join(link, "scripts/browser.mjs"), "targets"], {
      env: { ...process.env, CLOAKHUB_CLIENT_CONFIG: loaded.path }
    });
    expect(proc.exitCode).toBe(0);
    expect(JSON.parse(proc.stdout.toString()).map((t) => t.name)).toEqual(["work", "personal"]);
  });

  test("does not guess a target or accept inherited object properties", async () => {
    const loaded = await fixture();
    delete loaded.config.defaultTarget;
    for (const alias of [undefined, "unknown", "toString"]) {
      await expect(resolveTarget(loaded, alias, {})).rejects.toThrow("No configured target");
    }
  });

  test("missing CDP credentials do not fall back to admin or anonymous access", async () => {
    const loaded = await fixture();
    await expect(resolveTarget(loaded, "personal", { CLOAKHUB_AUTH_TOKEN: "admin-secret" }))
      .rejects.toThrow("No connection was attempted");
    loaded.config.targets.personal = { url: "http://127.0.0.1:7788", profile: "personal" };
    expect(listTargets(loaded.config)[1].auth).toBe("none");
    const open = await resolveTarget(loaded, "personal", {});
    expect(open.token).toBeUndefined();
    let connected = false;
    await withBrowser(open, async () => {}, async (_endpoint, options) => {
      expect(options.headers).toEqual({});
      connected = true;
      return {
        contexts: () => [{ setDefaultTimeout() {}, setDefaultNavigationTimeout() {} }],
        close: async () => {}
      };
    });
    expect(connected).toBe(true);
    loaded.config.targets.personal.auth = "none";
    expect((await resolveTarget(loaded, "personal", {})).metadata.auth).toBe("none");
  });

  test("rejects malformed origins and ambiguous credential sources", async () => {
    const loaded = await fixture();
    for (const url of ["https://secret@work.example", "https://work.example/prefix", "https://work.example?token=secret", "file:///tmp/a"]) {
      loaded.config.targets.work.url = url;
      await expect(resolveTarget(loaded, "work", {})).rejects.toThrow("HTTP(S) origin");
    }
    loaded.config.targets.work.url = "https://work.example";
    loaded.config.targets.work.tokenEnv = "TOKEN";
    await expect(resolveTarget(loaded, "work", {})).rejects.toThrow("at most one");
    delete loaded.config.targets.work.tokenEnv;
    loaded.config.targets.work.auth = "none";
    await expect(resolveTarget(loaded, "work", {})).rejects.toThrow("at most one");
    delete loaded.config.targets.work.auth;
    loaded.config.targets.work.token = "inline-secret";
    await expect(resolveTarget(loaded, "work", {})).rejects.toThrow("at most one");
    delete loaded.config.targets.work.tokenFile;
    loaded.config.targets.work.token = "  ";
    await expect(resolveTarget(loaded, "work", {})).rejects.toThrow("missing or invalid");
  });

  test("loads an explicit config path and keeps malformed JSON out of errors", async () => {
    const loaded = await fixture();
    expect((await readConfig({ CLOAKHUB_CLIENT_CONFIG: loaded.path })).config).toEqual(loaded.config);
    await writeFile(loaded.path, '{"secret":"do-not-echo", BROKEN');
    try {
      await readConfig({ CLOAKHUB_CLIENT_CONFIG: loaded.path });
      throw new Error("expected rejection");
    } catch (error) {
      expect(error.message).toContain("Cannot read CloakHub");
      expect(error.message).not.toContain("do-not-echo");
    }
  });

  test("disconnects after script errors and never creates a replacement context", async () => {
    const target = await resolveTarget(await fixture(), "work", {});
    const context = { setDefaultTimeout() {}, setDefaultNavigationTimeout() {} };
    let disconnected = 0;
    const browser = { contexts: () => [context], close: async () => { disconnected++; } };
    const connect = async (endpoint, options) => {
      expect(endpoint).toBe(target.endpoint);
      expect(options.headers).toEqual({ Authorization: "Bearer work-secret" });
      expect(options.noDefaults).toBe(true);
      return browser;
    };
    await expect(withBrowser(target, async ({ context: actual }) => {
      expect(actual).toBe(context);
      throw new Error("action failed");
    }, connect)).rejects.toThrow("action failed");
    expect(disconnected).toBe(1);
    browser.contexts = () => [];
    await expect(withBrowser(target, async () => {}, connect)).rejects.toThrow("no default");
    expect(disconnected).toBe(2);
  });

  test("redacts repeated raw and URL-encoded tokens from connection failures", () => {
    expect(safeError(new Error("Bearer secret/a at ?token=secret%2Fa secret/a"), "secret/a"))
      .toBe("Bearer *** at ?token=*** ***");
  });
});
