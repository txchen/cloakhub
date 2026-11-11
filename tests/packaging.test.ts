import { describe, expect, test } from "bun:test";

const AMD64_ASSET_SHA = "6642660ea04842dc073662f99114d9217f1ef61640cca0f6425fc424c4929737";
const ARM64_ASSET_SHA = "c8028ff40ef2b3b1db1023cbbc914de393187cd7aef9c235390da9265488912c";

describe("Docker-first packaging", () => {
  test("one Dockerfile serves amd64 and arm64 with pinned dependencies", async () => {
    const dockerfile = await Bun.file("Dockerfile").text();

    expect(dockerfile).toContain("FROM golang:1.27-bookworm AS hub");
    expect(dockerfile).toContain("FROM debian:bookworm-slim");
    expect(dockerfile).not.toContain("oven/bun");
    const pkg = await Bun.file("package.json").json();
    expect(pkg.version).toBe("1.1.0");
    expect(pkg.dependencies?.cloakbrowser).toBeUndefined();
    expect(dockerfile).not.toContain("FROM python:");
    expect(dockerfile).not.toContain("pip install");
    expect(dockerfile).not.toContain("bun install");
    expect(dockerfile).toContain("CGO_ENABLED=0 go build -trimpath");
    expect(dockerfile).toContain("ESBUILD=/usr/local/bin/esbuild ./scripts/build-ui.sh");
    expect(dockerfile).not.toContain("FROM cloakhq/cloakbrowser");
    expect(dockerfile).not.toMatch(/^(ARG|ENV) .*LICENSE_KEY/m);
    expect(dockerfile).toMatch(/^ARG TARGETARCH$/m);
    expect(dockerfile).not.toMatch(/^ARG TARGETARCH=/m);
    for (const retired of ["Dockerfile.free", "Dockerfile.free.arm64", "compose.free.yml"]) {
      expect(await Bun.file(retired).exists()).toBe(false);
    }
  });

  test("Dockerfile bakes the verified license-free browser for each architecture", async () => {
    const dockerfile = await Bun.file("Dockerfile").text();

    expect(dockerfile).not.toContain("CLOAKHUB_LICENSE_");
    expect(dockerfile).toContain("CLOAKHUB_BROWSER_BIN=/opt/cloakbrowser/chrome");
    expect(dockerfile).toContain("CLOAKHUB_MAX_RUNNING_INSTANCES=10");
    expect(dockerfile).toContain("CLOAKHUB_DEFAULT_PLATFORM=macos");
    expect(dockerfile).toContain("ARG BROWSER_RELEASE_TAG=cloakbrowser-156.0.8078.47.1-patched");
    expect(dockerfile).toContain("cloakbrowser-${BROWSER_VERSION}-${platform}-nolicense-patched.tar.zst");
    expect(dockerfile).toContain(`ARG BROWSER_SHA256_AMD64=${AMD64_ASSET_SHA}`);
    expect(dockerfile).toContain(`ARG BROWSER_SHA256_ARM64=${ARM64_ASSET_SHA}`);
    expect(dockerfile).toContain("amd64) platform=linux-x64;");
    expect(dockerfile).toContain("arm64) platform=linux-arm64;");
    expect(dockerfile).toContain("sha256sum -c -");
    expect(dockerfile).not.toContain("CLOAKHUB_BROWSER_INSTALLER");
  });

  test("Dockerfile exposes port 7788 and ships the voxl viewer runtime", async () => {
    const dockerfile = await Bun.file("Dockerfile").text();

    expect(dockerfile).toContain("CLOAKHUB_DATA_DIR=/data");
    expect(dockerfile).toContain("CLOAKHUB_HOST=0.0.0.0");
    expect(dockerfile).toContain("CLOAKHUB_PORT=7788");
    expect(dockerfile).toContain("EXPOSE 7788");
    expect(dockerfile).toContain('VOLUME ["/data"]');
    expect(dockerfile).toContain("COPY --from=hub /out/cloakhub /usr/local/bin/cloakhub");
    expect(dockerfile).toContain('CMD ["/usr/local/bin/cloakhub"]');
    expect(dockerfile).toContain("/app/check-mac-fonts.sh");
    // The runtime image has no Bun, so release smoke checks must not need it.
    expect(await Bun.file("scripts/smoke-image.sh").text()).not.toMatch(/\bbun\b/);
    expect(dockerfile).not.toContain("kasmvncserver");
    expect(dockerfile).toContain("cargo install --locked voxl-server");
    expect(dockerfile).toContain("COPY --from=voxl /opt/voxl/bin/voxl /usr/local/bin/voxl");
    expect(dockerfile).toContain("xvfb");
    // Xvfb runs without GLX, so Mesa's DRI drivers and LLVM stay out of the image.
    expect(dockerfile).toContain("'Package: libgl1-mesa-dri'");
    expect(dockerfile).toContain("apt-mark hold libgl1-mesa-dri");
    expect(dockerfile).toContain("xclip");
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/bin/tini", "--"]');
    expect(dockerfile).not.toMatch(/CMD .*ensure_binary|ENTRYPOINT .*ensure_binary/i);
  });

  test("the image installs binaries before any project files", async () => {
    const full = await Bun.file("Dockerfile").text();
    // Build stages copy sources freely; the runtime stage must keep binaries first.
    const dockerfile = full.slice(full.lastIndexOf("\nFROM "));
    const binaryEnd = dockerfile.indexOf("HOME=/tmp /opt/cloakbrowser/chrome --version");
    expect(binaryEnd).toBeGreaterThan(0);
    for (const copy of dockerfile.matchAll(/^COPY (.*)$/gm)) {
      if (copy[1]!.startsWith("--from=")) continue;
      expect(copy.index!).toBeGreaterThan(binaryEnd);
    }
  });

  test("README documents deployment from the published image", async () => {
    const readme = await Bun.file("README.md").text();

    expect(readme).toContain("image: ghcr.io/txchen/cloakhub:1.1.0");
    expect(readme).not.toContain("cloakhub_free");
    expect(readme).toContain("docker compose pull");
    expect(readme).toContain("restart: unless-stopped");
    expect(readme).toContain("shm_size: 2gb");
    expect(readme).toContain('"${CLOAKHUB_BIND_ADDRESS:-127.0.0.1}:7788:7788"');
    expect(readme).toContain("./data:/data");
    expect(readme).toContain("docker compose up -d");
  });

  test("Compose examples need no license secret", async () => {
    for (const file of ["compose.yml", "compose.arm64.yml"]) {
      const compose = await Bun.file(file).text();
      expect(compose).not.toContain("build:");
      expect(compose).toContain("image: ghcr.io/txchen/cloakhub:1.1.0");
      expect(compose).not.toContain("CLOAKHUB_LICENSE_KEYS_FILE");
      expect(compose).not.toContain("cloakbrowser-keys");
      expect(compose).toContain("restart: unless-stopped");
      expect(compose).toContain("shm_size: 2gb");
      expect(compose).toContain('CLOAKHUB_AUTH_TOKEN: "${CLOAKHUB_AUTH_TOKEN:?');
      expect(compose).toContain('"${CLOAKHUB_BIND_ADDRESS:-127.0.0.1}:7788:7788"');
      expect(compose).toContain("./data:/data");
    }
    expect(await Bun.file("compose.arm64.yml").text()).toContain("platform: linux/arm64");
  });

  test("real runtime integration tests are opt-in for normal CI", async () => {
    const packageJson = await Bun.file("package.json").json();
    const integrationTest = await Bun.file("internal/integration/realruntime_test.go").text();
    const runner = await Bun.file("scripts/real-runtime-tests.sh").text();

    expect(packageJson.scripts["integration:real-runtime"]).toBe("./scripts/real-runtime-tests.sh");
    expect(runner).toContain("CLOAKHUB_RUN_REAL_RUNTIME_TESTS=true");
    expect(integrationTest).toContain('os.Getenv("CLOAKHUB_RUN_REAL_RUNTIME_TESTS") != "true"');
    expect(integrationTest).toContain("t.Skip(");
  });

  test("continuous builds never push on pull requests", async () => {
    const workflow = await Bun.file(".github/workflows/docker-image.yml").text();
    for (const snippet of [
      "registry: ghcr.io",
      "packages: write",
      "docker/build-push-action@v6",
      "file: Dockerfile",
      "images: ghcr.io/${{ github.repository }}",
      "push: ${{ github.event_name != 'pull_request' }}",
      "pull_request:",
      "flavor: latest=false"
    ]) {
      expect(workflow).toContain(snippet);
    }
    expect(workflow).not.toContain("_free");
  });

  test("releases build and smoke-test both native architectures before merging", async () => {
    const workflow = await Bun.file(".github/workflows/release.yml").text();
    expect(workflow).toContain('tags: ["v*"]');
    expect(workflow).toContain('test "$GITHUB_REF_NAME" = "v$VERSION"');
    expect(workflow).toContain("runner: ubuntu-24.04-arm");
    expect(workflow).toContain("runner: ubuntu-24.04");
    expect(workflow).toContain("needs: test");
    expect(workflow).toContain("needs: build");
    expect(workflow).toContain('bash scripts/smoke-image.sh "$IMAGE" "$EXPECTED"');
    expect(workflow).toContain('docker buildx imagetools create -t "$IMAGE:$VERSION" -t "$IMAGE:$MINOR" -t "$IMAGE:latest" "$AMD64" "$ARM64"');
    expect(workflow).not.toContain("_free");
  });
});
