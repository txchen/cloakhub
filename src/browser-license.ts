import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigError, type CloakHubEnv } from "./config";
import { CapacityUnavailableError } from "./runtime-capacity";

export interface LicenseLease {
  key: string;
  release(): void;
}

export interface BrowserLicensePool {
  capacity: number;
  acquire(): Promise<LicenseLease>;
}

export interface LicenseSeats {
  active: number;
  limit: number;
}

// Keep secrets out of app configuration, profile records, and launch arguments.
export async function loadBrowserLicenseKeys(
  env: CloakHubEnv = process.env,
  home = homedir()
): Promise<string[]> {
  let keys: unknown;
  if (env.CLOAKHUB_LICENSE_KEYS?.trim()) {
    try {
      keys = JSON.parse(env.CLOAKHUB_LICENSE_KEYS);
    } catch {
      throw new ConfigError("CLOAKHUB_LICENSE_KEYS must be a JSON array of nonempty strings");
    }
  } else if (env.CLOAKHUB_LICENSE_KEYS_FILE?.trim()) {
    try {
      keys = (await readFile(env.CLOAKHUB_LICENSE_KEYS_FILE.trim(), "utf8"))
        .split(/\r?\n/).map((key) => key.trim()).filter(Boolean);
    } catch {
      throw new ConfigError("Cannot read CLOAKHUB_LICENSE_KEYS_FILE");
    }
  } else if (env.CLOAKBROWSER_LICENSE_KEY?.trim()) {
    keys = [env.CLOAKBROWSER_LICENSE_KEY.trim()];
  } else {
    try {
      const key = (await readFile(join(home, ".cloakbrowser", "license.key"), "utf8")).trim();
      keys = key ? [key] : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new ConfigError("Cannot read ~/.cloakbrowser/license.key");
      }
      return [];
    }
  }
  if (!Array.isArray(keys) || !keys.length || keys.some((key) => typeof key !== "string" || !key.trim())) {
    throw new ConfigError("License configuration must contain nonempty keys");
  }
  return [...new Set((keys as string[]).map((key) => key.trim()))];
}

export function withoutLicenseSecrets(env: CloakHubEnv): CloakHubEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) =>
    !name.startsWith("CLOAKHUB_LICENSE_") &&
    !name.startsWith("CLOAKBROWSER_LICENSE_")
  ));
}

export async function queryLicenseSeats(key: string): Promise<LicenseSeats> {
  try {
    const response = await fetch("https://cloakbrowser.dev/api/license/session/count", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ license_key: key }),
      signal: AbortSignal.timeout(10000),
      redirect: "error"
    });
    if (!response.ok) throw new Error();
    const body = await response.json() as LicenseSeats;
    if (!Number.isInteger(body.active) || body.active < 0 ||
        !Number.isInteger(body.limit) || body.limit < 1) throw new Error();
    return { active: body.active, limit: body.limit };
  } catch {
    // Do not relay upstream bodies or exceptions: they may contain credentials.
    throw new LicenseCapacityError("CloakBrowser license quota unavailable or key rejected; check keys and retry");
  }
}

export class LicenseCapacityError extends CapacityUnavailableError {
  constructor(message = "CloakBrowser license capacity is full; retry after a Browser Instance stops") {
    super();
    this.name = "LicenseCapacityError";
    this.message = message;
  }
}

export async function createBrowserLicensePool(
  keys: string[],
  query: (key: string) => Promise<LicenseSeats> = queryLicenseSeats
): Promise<BrowserLicensePool> {
  const entries = [...new Set(keys)].map((key) => ({ key, used: 0, limit: 0, external: 0 }));
  const initial = await Promise.allSettled(entries.map((entry) => query(entry.key)));
  initial.forEach((result, index) => {
    if (result.status === "fulfilled") entries[index].limit = result.value.limit;
  });
  const capacity = entries.reduce((sum, entry) => sum + entry.limit, 0);
  if (!capacity) throw new LicenseCapacityError("No usable CloakBrowser license quota; check keys and connectivity");
  let queue = Promise.resolve();
  let cursor = 0;
  return {
    capacity,
    acquire() {
      const acquisition = queue.then(async () => {
        // Serialize query + reservation so simultaneous starts cannot claim the same local seat.
        const states = await Promise.allSettled(entries.map((entry) => query(entry.key)));
        let reachable = false;
        for (let offset = 0; offset < entries.length; offset++) {
          const index = (cursor + offset) % entries.length;
          const entry = entries[index];
          const state = states[index];
          if (state.status !== "fulfilled") continue;
          reachable = true;
          entry.external = entry.used === 0 ? state.value.active
            : Math.max(entry.external, state.value.active - entry.used);
          // Upstream count can lag a launch. Local reservations cover that window.
          // Other hosts can still race us: the binary remains the final quota authority.
          if (entry.used + entry.external >= state.value.limit) continue;
          entry.used++;
          cursor = (index + 1) % entries.length;
          let released = false;
          return {
            key: entry.key,
            release() {
              if (!released) { released = true; entry.used--; }
            }
          };
        }
        throw new LicenseCapacityError(reachable ? undefined : "CloakBrowser license quota unavailable or keys rejected; retry later");
      });
      queue = acquisition.then(() => undefined, () => undefined);
      return acquisition;
    }
  };
}
