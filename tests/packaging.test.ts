import { describe, expect, test } from "bun:test";

describe("Docker-first packaging", () => {
  test("Dockerfile exposes port 7788 and uses /data without runtime downloads", async () => {
    const dockerfile = await Bun.file("Dockerfile").text();

    expect(dockerfile).toContain("CLOAKHUB_DATA_DIR=/data");
    expect(dockerfile).toContain("CLOAKHUB_HOST=0.0.0.0");
    expect(dockerfile).toContain("CLOAKHUB_PORT=7788");
    expect(dockerfile).toContain("EXPOSE 7788");
    expect(dockerfile).toContain('VOLUME ["/data"]');
    expect(dockerfile).not.toMatch(/curl|wget|apt-get.*cloakbrowser|cloakbrowser.*download/i);
  });

  test("compose binds safely on loopback while the container listens on all interfaces", async () => {
    const compose = await Bun.file("docker-compose.yml").text();

    expect(compose).toContain("127.0.0.1:7788:7788");
    expect(compose).toContain("CLOAKHUB_HOST: 0.0.0.0");
    expect(compose).toContain("CLOAKHUB_DATA_DIR: /data");
    expect(compose).toContain("cloakhub-data:/data");
  });

  test("real runtime integration tests are opt-in for normal CI", async () => {
    const packageJson = await Bun.file("package.json").json();
    const integrationTest = await Bun.file("tests/real-runtime.integration.test.ts").text();

    expect(packageJson.scripts["integration:real-runtime"]).toContain("CLOAKHUB_RUN_REAL_RUNTIME_TESTS=true");
    expect(integrationTest).toContain('process.env.CLOAKHUB_RUN_REAL_RUNTIME_TESTS === "true"');
    expect(integrationTest).toContain("test.skip");
  });
});
