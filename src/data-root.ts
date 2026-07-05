import { constants } from "node:fs";
import { access, mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface DataRootInfo {
  path: string;
}

export class DataRootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataRootError";
  }
}

export async function ensureDataRoot(dataRoot: string): Promise<DataRootInfo> {
  try {
    await mkdir(dataRoot, { recursive: true });

    const rootStat = await stat(dataRoot);
    if (!rootStat.isDirectory()) {
      throw new Error("path is not a directory");
    }

    await access(dataRoot, constants.R_OK | constants.W_OK | constants.X_OK);
    await verifyWritable(dataRoot);

    return { path: dataRoot };
  } catch (error) {
    throw new DataRootError(`Data Root "${dataRoot}" is unusable: ${errorMessage(error)}`);
  }
}

async function verifyWritable(dataRoot: string): Promise<void> {
  const probePath = join(
    dataRoot,
    `.cloakhub-write-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );

  await writeFile(probePath, "ok", { flag: "wx" });
  await unlink(probePath);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
