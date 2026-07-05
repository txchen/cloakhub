# CloakBrowser-only binary discovery

CloakHub will only launch a CloakBrowser Binary, discovered from `CLOAKHUB_BROWSER_BIN`, then a known packaged Docker path, then a `cloakbrowser` executable on `PATH` for development. It will not fall back to stock Chrome or Chromium, because the product depends on CloakBrowser-specific fingerprint behavior. CloakHub will not auto-download the binary at runtime in v1; Docker images may download/provide it during image build.
