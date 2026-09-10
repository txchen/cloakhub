import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
// Pin-dependent upstream test seam: the production installer uses the public ensureBinary API.
import { verifyProDownload, verifySignature } from "../node_modules/cloakbrowser/dist/download.js";

const manifest = await readFile(join(import.meta.dir, "fixtures/cloakbrowser-151/SHA256SUMS"));
const signature = await readFile(join(import.meta.dir, "fixtures/cloakbrowser-151/SHA256SUMS.sig"));
const originalFetch = globalThis.fetch;
const cleanup: string[] = [];
afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function fixtureManifestResponses() {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/SHA256SUMS.sig")) return new Response(signature);
    if (url.endsWith("/SHA256SUMS")) return new Response(manifest);
    throw new Error("Unexpected network request in verification test");
  }) as unknown as typeof fetch;
}

describe("official JS verifier on Bun", () => {
  test("accepts the real signed 151 manifest and rejects modified manifest/signature", () => {
    expect(() => verifySignature(manifest, signature)).not.toThrow();
    const altered = Buffer.from(manifest);
    altered[0] ^= 1;
    expect(() => verifySignature(altered, signature)).toThrow("signature verification failed");
    expect(() => verifySignature(manifest, Buffer.from(Buffer.alloc(64).toString("base64")))).toThrow("signature verification failed");
  });

  test("binds a valid signed manifest to the requested version", async () => {
    fixtureManifestResponses();
    await expect(verifyProDownload("/unused/archive", "151.0.7922.108.6")).rejects.toThrow("Version mismatch");
  });

  test("rejects an archive that does not match the authenticated SHA256", async () => {
    fixtureManifestResponses();
    const root = await mkdtemp(join(tmpdir(), "cloakhub-integrity-"));
    cleanup.push(root);
    const archive = join(root, "corrupt.tar.gz");
    await writeFile(archive, "not the authenticated browser archive");
    await expect(verifyProDownload(archive, "151.0.7922.108.4")).rejects.toThrow(/checksum|sha256/i);
  });
});
