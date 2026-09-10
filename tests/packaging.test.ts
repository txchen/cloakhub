import { describe, expect, test } from "bun:test";

describe("Docker-first packaging", () => {
  test("Dockerfile pins the installer and does not redistribute the browser", async () => {
    const dockerfile = await Bun.file("Dockerfile").text();

    expect(dockerfile).toContain("FROM oven/bun:1.3.14-debian AS bun");
    expect(dockerfile).toContain("FROM debian:bookworm-slim");
    const pkg = await Bun.file("package.json").json();
    expect(pkg.dependencies.cloakbrowser).toBe("0.5.10");
    expect(dockerfile).not.toContain("FROM python:");
    expect(dockerfile).not.toContain("pip install");
    expect(dockerfile).not.toContain("install-browser.py");
    expect(dockerfile).toContain("bun install --frozen-lockfile --production --omit=peer");
    expect(dockerfile).not.toContain("FROM cloakhq/cloakbrowser");
    expect(dockerfile).not.toMatch(/^(ARG|ENV) .*LICENSE_KEY/m);
    expect(dockerfile).toMatch(/^ARG TARGETARCH$/m);
    expect(dockerfile).not.toMatch(/^ARG TARGETARCH=/m);
  });

  test("Dockerfile exposes port 7788 and uses a persistent runtime browser cache", async () => {
    const dockerfile = await Bun.file("Dockerfile").text();

    expect(dockerfile).toContain("CLOAKHUB_DATA_DIR=/data");
    expect(dockerfile).toContain("CLOAKHUB_HOST=0.0.0.0");
    expect(dockerfile).toContain("CLOAKHUB_PORT=7788");
    expect(dockerfile).toContain("EXPOSE 7788");
    expect(dockerfile).toContain('VOLUME ["/data"]');
    expect(dockerfile).toContain("COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun");
    expect(dockerfile).toContain("CLOAKHUB_BROWSER_INSTALLER=bun");
    expect(dockerfile).toContain("CLOAKHUB_BROWSER_VERSION=151.0.7922.108.4");
    expect(dockerfile).toContain("kasmvncserver_bookworm");
    expect(dockerfile).toContain("xclip");
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/bin/tini", "--"]');
    expect(dockerfile).not.toContain("cloakbrowser[geoip]");
    expect(dockerfile).not.toContain("COPY --from=cloakbrowser");
    expect(dockerfile).not.toMatch(/CMD .*ensure_binary|ENTRYPOINT .*ensure_binary/i);
  });

  test("README documents deployment from the published image", async () => {
    const readme = await Bun.file("README.md").text();

    expect(readme).toContain("image: ghcr.io/txchen/cloakhub:0.6.1");
    expect(readme).toContain("docker compose pull");
    expect(readme).toContain("restart: unless-stopped");
    expect(readme).toContain("shm_size: 2gb");
    expect(readme).toContain('"${CLOAKHUB_BIND_ADDRESS:-127.0.0.1}:7788:7788"');
    expect(readme).toContain("CLOAKHUB_HOST: 0.0.0.0");
    expect(readme).toContain("CLOAKHUB_DATA_DIR: /data");
    expect(readme).toContain("./data:/data");
    expect(readme).toContain("docker compose up -d");
  });

  test("ARM64 Compose deployment is persistent and authenticated", async () => {
    const compose = await Bun.file("compose.arm64.yml").text();

    expect(compose).not.toContain("build:");
    expect(compose).toContain("image: ghcr.io/txchen/cloakhub:0.6.1");
    expect(compose).toContain("CLOAKHUB_LICENSE_KEYS_FILE: /run/secrets/cloakbrowser-keys");
    expect(compose).toContain("platform: linux/arm64");
    expect(compose).toContain("restart: unless-stopped");
    expect(compose).toContain("shm_size: 2gb");
    expect(compose).toContain('CLOAKHUB_AUTH_TOKEN: "${CLOAKHUB_AUTH_TOKEN:?');
    expect(compose).toContain('"${CLOAKHUB_BIND_ADDRESS:-127.0.0.1}:7788:7788"');
    expect(compose).toContain("./data:/data");
  });

  test("real runtime integration tests are opt-in for normal CI", async () => {
    const packageJson = await Bun.file("package.json").json();
    const integrationTest = await Bun.file("tests/real-runtime.integration.test.ts").text();

    expect(packageJson.scripts["integration:real-runtime"]).toContain("CLOAKHUB_RUN_REAL_RUNTIME_TESTS=true");
    expect(integrationTest).toContain('process.env.CLOAKHUB_RUN_REAL_RUNTIME_TESTS === "true"');
    expect(integrationTest).toContain("test.skip");
  });

  test("GitHub Actions builds pull requests and publishes release images to GHCR", async () => {
    const workflow = await Bun.file(".github/workflows/docker-image.yml").text();
    const requiredWorkflowSnippets = [
      "registry: ghcr.io",
      "packages: write",
      "docker/login-action@v3",
      "docker/setup-qemu-action@v3",
      "docker/metadata-action@v5",
      "docker/build-push-action@v6",
      "platforms: linux/amd64,linux/arm64",
      "images: ghcr.io/${{ github.repository }}",
      "push: ${{ github.event_name != 'pull_request' }}",
      "pull_request:",
      "tags:",
      "flavor: latest=false",
      "type=raw,value=latest,enable=${{ github.ref_type == 'tag' }}",
      "type=semver,pattern={{version}}",
    ];

    for (const snippet of requiredWorkflowSnippets) {
      expect(workflow).toContain(snippet);
    }
  });
});
