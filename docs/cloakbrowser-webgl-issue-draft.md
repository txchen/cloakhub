# Issue draft: WebGL unavailable on GPU-less Linux Docker with 155/156; 154 works with the same configuration

Status: submitted and verified open at https://github.com/CloakHQ/CloakBrowser/issues/636. The local attachment checklist below was omitted from the published issue.

## Summary

We see a WebGL compatibility regression in our GPU-less Linux x64 Docker setup when replacing CloakBrowser 154.0.8037.57.2 with 155.0.8059.39.1 or 156.0.8078.47.1.

With the same application image and launch configuration, 154 creates WebGL and WebGL2 contexts and reads pixels successfully. Both 155 and 156 return null for both context types. Their browser logs report Vulkan/SwANGLE initialization failures.

We have not established whether this is a browser regression, a changed runtime dependency, or an incompatibility with our existing launch flags. Could you advise on the supported configuration for GPU-less containers?

## Versions tested

| Binary | Result in our container |
|---|---|
| 154.0.8037.57.2 | WebGL/WebGL2 work |
| 155.0.8059.39.1 | Both contexts return null |
| 156.0.8078.47.1 | Both contexts return null |

We have **not** tested 155.0.8059.39.2. This report is not a claim about that stable build.

The 155 and 156 archives came from the official downloader and passed Ed25519 signature and SHA-256 verification. We checked the full versions using the binary's `--version`, not just the CDP version.

## Environment and launch configuration

- Linux x64, Debian bookworm-based Docker image.
- Our application image is `cloakhub:0.9.0`, a local browser manager image. We mounted each complete extracted browser directory read-only and selected its executable explicitly.
- No host GPU passed through to the container.
- CPU quota: 4 cores. Shared memory: 2 GiB.
- Headed mode uses a virtual display through KasmVNC. We also tested native headless mode.
- Fresh profiles, same fonts and configuration for each version, no external stealth plugin.
- Browser sessions ran serially with a valid license.

The manager adds these flags **in headed mode only**:

```text
--disable-gpu
--disable-dev-shm-usage
--use-gl=angle
--use-angle=swiftshader
```

In headless mode, it adds `--headless=new` instead of those four flags. The launch configuration also includes `--no-sandbox`.

These are the relevant graphics/mode flags, not a complete standalone launch command. The manager also configures the user-data directory, remote debugging, persona, seed and locale. We have not yet reduced this to a standalone Docker reproducer outside the manager, or tested alternative graphics flags.

In particular, please let us know whether the headed combination of `--disable-gpu` and SwiftShader is no longer supported. The failure also occurs in our headless path, which does not add those four headed flags.

## Observations and repeatability

On October 15, 2026 UTC, we compared 154.0.8037.57.2 and 155.0.8059.39.1 in the same environment. We ran two rounds with the version order reversed:

- 154: both contexts worked in all 12 profile runs. A clear/readPixels probe returned `[64, 128, 191, 255]` with `getError() === 0`.
- 155: both contexts returned null in all 12 profile runs.

On November 2, 2026 UTC, we repeated the comparison with 155.0.8059.39.1 and 156.0.8078.47.1, again reversing the version order:

- Both versions returned null for both contexts in all 12 profile runs per version.
- This covered macOS, Linux and Windows personas in headed mode, plus macOS in headless mode.
- SannySoft independently reported `Canvas has no webgl context` for its WebGL Vendor and Renderer checks.

These are results for one container environment, not for native Windows/macOS or GPU-backed Linux.

## Page-side probe

The local test uses separate canvases for WebGL and WebGL2. This avoids requesting incompatible context types from the same canvas.

The following snippet expresses the same context/clear/readPixels check used by our test:

```js
const results = {};
for (const type of ['webgl', 'webgl2']) {
  const canvas = document.createElement('canvas');
  canvas.width = 8;
  canvas.height = 8;
  const gl = canvas.getContext(type);
  if (!gl) {
    results[type] = null;
    continue;
  }
  gl.clearColor(0.25, 0.5, 0.75, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  const pixel = new Uint8Array(4);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  results[type] = { pixel: [...pixel], error: gl.getError() };
}
console.log(results);
```

## Browser errors from 156

```text
ANGLE Display::initialize error 0: Internal Vulkan error (-3):
Initialization of an object could not be completed for implementation-specific reasons,
in ../../third_party/angle/src/libANGLE/renderer/vulkan/vk_renderer.cpp, initialize:2530.

eglInitialize SwANGLE failed with error EGL_NOT_INITIALIZED
Exiting GPU process due to errors during initialization
```

## Questions

1. Did 155/156 change SwiftShader/Vulkan dependencies or sandbox requirements on Linux?
2. What flags and container dependencies do you recommend for headed and headless use without a host GPU?
3. Is this a known issue, and is 155.0.8059.39.2 expected to address it?

We can test a recommended configuration and provide further redacted diagnostics. We have not included license keys, CDP tokens, user data, public IP addresses or visitor IDs.

---

## Local attachment checklist, remove before posting

Start with the GPU log excerpt rather than the full anti-detection report:

- `docs/evidence/preview-156/gpu-errors.log`
- `docs/evidence/preview-155/gpu-errors.log`

Supporting local reports:

- `docs/preview-155-antidetection.md`
- `docs/preview-156-antidetection.md`

Before posting, consider adding the test image ID, Docker/host kernel versions and a standalone reproducer. Do not attach raw `environment.json`, profile metadata, container env files or unreviewed logs. Keep Fingerprint scores and IPHey behavior out of this issue unless requested; they do not establish the cause of the graphics failure.
