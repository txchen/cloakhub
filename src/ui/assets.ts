const bundles = new Map<string, Promise<Blob>>();
const entries: Record<string, string> = {
  "/assets/app.js": "./client.ts",
  "/assets/viewer.js": "./viewer.ts",
  "/assets/login.js": "./login.ts"
};

export async function uiAssetResponse(
  request: Request,
  url: URL
): Promise<Response | undefined> {
  const entry = entries[url.pathname];
  const css = url.pathname === "/assets/app.css";
  if (!entry && !css) return;
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405 });
  let asset: Blob;
  if (css) asset = Bun.file(new URL("./styles.css", import.meta.url));
  else {
    let bundle = bundles.get(entry!);
    if (!bundle) {
      bundle = Bun.build({
        entrypoints: [new URL(entry!, import.meta.url).pathname],
        target: "browser",
        minify: true,
        external: ["/assets/novnc/*"]
      }).then((result) => {
        if (!result.success)
          throw new Error(result.logs.map((log) => log.message).join("\n"));
        return result.outputs[0]!;
      });
      bundles.set(entry!, bundle);
      void bundle.catch(() => bundles.delete(entry!));
    }
    asset = await bundle;
  }
  return new Response(request.method === "HEAD" ? null : asset, {
    headers: {
      "content-type": css
        ? "text/css; charset=utf-8"
        : "text/javascript; charset=utf-8",
      "cache-control": "no-cache"
    }
  });
}
