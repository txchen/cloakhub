import { homedir } from "node:os";
import { join } from "node:path";

export type CloakHubEnv = Record<string, string | undefined>;

export interface CloakHubConfig {
  authToken?: string;
  browserBin?: string;
  dataRoot: string;
  host: string;
  maxRunningInstances: number;
  port: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 7788;
export const DEFAULT_MAX_RUNNING_INSTANCES = 10;

export function loadConfigFromEnv(
  env: CloakHubEnv = process.env,
  homeDirectory = homedir()
): CloakHubConfig {
  return {
    authToken: emptyToUndefined(env.CLOAKHUB_AUTH_TOKEN),
    browserBin: emptyToUndefined(env.CLOAKHUB_BROWSER_BIN),
    dataRoot: emptyToUndefined(env.CLOAKHUB_DATA_DIR) ?? join(homeDirectory, ".cloakhub", "data"),
    host: emptyToUndefined(env.CLOAKHUB_HOST) ?? DEFAULT_HOST,
    maxRunningInstances: parsePositiveInteger(
      env.CLOAKHUB_MAX_RUNNING_INSTANCES,
      "CLOAKHUB_MAX_RUNNING_INSTANCES",
      DEFAULT_MAX_RUNNING_INSTANCES
    ),
    port: parsePort(env.CLOAKHUB_PORT)
  };
}

function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parsePort(value: string | undefined): number {
  const parsed = parseInteger(value, DEFAULT_PORT);

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new ConfigError("CLOAKHUB_PORT must be an integer between 1 and 65535");
  }

  return parsed;
}

function parsePositiveInteger(value: string | undefined, name: string, defaultValue: number): number {
  const parsed = parseInteger(value, defaultValue);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ConfigError(`${name} must be a positive integer`);
  }

  return parsed;
}

function parseInteger(value: string | undefined, defaultValue: number): number {
  return value === undefined || value.trim() === "" ? defaultValue : Number(value);
}
