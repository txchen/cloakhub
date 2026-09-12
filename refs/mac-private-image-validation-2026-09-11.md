# Personal Mac image validation — 2026-09-11

Built and tested the local `cloakhub:mac-private` image on linux/amd64, using
CloakBrowser stable `151.0.7922.108.6`. New profiles default to `macos`; explicit
and saved profile settings remain intact. See [build/run instructions](../docs/private-macos.md).

The image contains 46 real-font files totaling 57,735,740 bytes (55.06 MiB).
These came from the earlier Apple catalog/recovery experiment, not a direct
export from the user's MacBook. All 20 required font families were discoverable.
The local image size is 275,532,596 bytes (262.77 MiB), including application and
base layers; the browser binary is downloaded into the data volume separately.
No image was published and no existing production service was replaced.

## Validation

- Typecheck passed; full test suite: 210 passed, 10 skipped, zero failures.
  The skipped tests are opt-in integrations: nine require
  `CLOAKHUB_RUN_REAL_RUNTIME_TESTS=true` and one requires
  `CLOAKHUB_RUN_CDP_TESTS=true`. Those switches were not enabled for this run;
  the separate image workflows below do not replace all ten tests.
- Actual image/API/UI confirmed Mac defaults, explicit Linux selection and font
  isolation: Mac can load Helvetica Neue; Linux cannot load the private font.
- Browser workflows covered multilingual input, iframe, popup, upload/download,
  multiple CDP clients, cookie/localStorage/IndexedDB persistence after browser
  stop/auto-wake, and identity/cookie/localStorage persistence after container restart.
- Build rejects missing required fonts. Shell syntax, Compose configuration and
  whitespace checks passed.

Two newly created default Mac profiles were tested against public detectors:

| Seed | DeviceInfo isBot | Fingerprint tampering | ML score | Anomaly | VM | Anti-detect browser |
| --- | --- | --- | --- | --- | --- | --- |
| 20260909 | false | false | 0.2322 | 0 | false | false |
| 20260910 | false | false | 0.0748 | 0 | false | false |

Both sites returned HTTP 200 for both profiles. These observations support this
personal configuration, but two seeds and public detectors do not establish
reliability on every site. This final-image run used stable 151, not preview 152.
The display remains 1366×768; this does not validate a high-DPI Mac display
configuration or a complete modern macOS font inventory. Fonts can also change
the rendered fingerprint of an existing Mac profile.

The isolated validation container was stopped. Before shutdown it had no browser
or display processes or zombies; afterward the license endpoint reported zero
active sessions. The local image and isolated test data were retained.

## Sanitized evidence

- [Image/build metadata](mac-private-image-validation-2026-09-11/build.json)
- [Workflow results](mac-private-image-validation-2026-09-11/workflow.json)
- [UI and font isolation](mac-private-image-validation-2026-09-11/ui-and-isolation.json)
- [Detector fields](mac-private-image-validation-2026-09-11/detectors.json)
- [Cleanup](mac-private-image-validation-2026-09-11/cleanup.json)

Raw detector pages, credentials, fonts and profile data remain outside committed
evidence in ignored local storage.
