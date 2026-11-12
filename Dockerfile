# CloakHub image (linux/amd64 and linux/arm64).
#
# Bakes the license-free CloakBrowser build for the target architecture, downloaded
# from the CloakHub GitHub release for that exact build and verified by SHA-256. No
# license key is involved; concurrent Browser Instances are bounded only by
# CLOAKHUB_MAX_RUNNING_INSTANCES (default 10 here). The Hub is one static Go binary;
# the live viewer is Xvfb plus voxl (H.264 over WebSocket).

# esbuild bundles both voxl's web client and CloakHub's operator UI.
FROM debian:bookworm-slim AS esbuild
ARG TARGETARCH
ARG ESBUILD_VERSION=0.25.10
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates wget \
    && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) esbuild_arch=x64 ;; \
      arm64) esbuild_arch=arm64 ;; \
      *) echo "Unsupported architecture: $TARGETARCH"; exit 1 ;; \
    esac; \
    wget -q -O /tmp/esbuild.tgz \
      "https://registry.npmjs.org/@esbuild/linux-${esbuild_arch}/-/linux-${esbuild_arch}-${ESBUILD_VERSION}.tgz"; \
    tar -C /tmp -xzf /tmp/esbuild.tgz; \
    install -m 755 /tmp/package/bin/esbuild /usr/local/bin/esbuild

# voxl streams each Browser Instance's Xvfb display to the viewer. Built from the
# pinned crates.io release.
FROM rust:1.93-bookworm AS voxl
ARG VOXL_VERSION=0.3.4
RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config clang libclang-dev libx264-dev libyuv-dev libopus-dev libpulse-dev \
    && rm -rf /var/lib/apt/lists/*
COPY --from=esbuild /usr/local/bin/esbuild /usr/local/bin/esbuild
RUN cargo install --locked voxl-server --version "${VOXL_VERSION}" --root /opt/voxl

# The Hub: a static Go binary with the operator UI embedded.
FROM golang:1.27-bookworm AS hub
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY --from=esbuild /usr/local/bin/esbuild /usr/local/bin/esbuild
COPY cmd ./cmd
COPY internal ./internal
COPY src/ui ./src/ui
COPY scripts/build-ui.sh ./scripts/build-ui.sh
RUN ESBUILD=/usr/local/bin/esbuild ./scripts/build-ui.sh \
    && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/cloakhub ./cmd/cloakhub

FROM debian:bookworm-slim

ARG TARGETARCH
ARG BROWSER_VERSION=156.0.8078.47.1
ARG BROWSER_RELEASE_TAG=cloakbrowser-156.0.8078.47.1-patched
ARG BROWSER_SHA256_AMD64=6642660ea04842dc073662f99114d9217f1ef61640cca0f6425fc424c4929737
ARG BROWSER_SHA256_ARM64=c8028ff40ef2b3b1db1023cbbc914de393187cd7aef9c235390da9265488912c

WORKDIR /app

ENV CLOAKHUB_DATA_DIR=/data \
    CLOAKHUB_HOST=0.0.0.0 \
    CLOAKHUB_PORT=7788 \
    CLOAKHUB_TLS_PORT=7789 \
    CLOAKHUB_BROWSER_BIN=/opt/cloakbrowser/chrome \
    CLOAKHUB_MAX_RUNNING_INSTANCES=10 \
    CLOAKHUB_DEFAULT_PLATFORM=macos \
    CLOAKHUB_MACOS_FONTCONFIG_FILE=/app/macos-fonts.conf

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    wget \
    zstd \
    xclip \
    tini \
    util-linux \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdbus-1-3 libdrm2 libxkbcommon0 libatspi2.0-0 libxcomposite1 \
    libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 \
    libcairo2 libasound2 libx11-xcb1 libfontconfig1 libx11-6 \
    libxcb1 libxext6 libxshmfence1 libglib2.0-0 libgtk-3-0 \
    libpangocairo-1.0-0 libcairo-gobject2 libgdk-pixbuf-2.0-0 libxss1 libxtst6 \
    fontconfig fonts-liberation fonts-noto-color-emoji fonts-unifont fonts-freefont-ttf \
    fonts-ipafont-gothic fonts-wqy-zenhei fonts-tlwg-loma-otf fonts-urw-base35 \
    && rm -rf /var/lib/apt/lists/*

# Xvfb's libGL dependency chain ends in Mesa's DRI drivers and LLVM (~160 MB), which
# nothing here uses: Xvfb runs with GLX disabled and CloakBrowser renders WebGL with
# its bundled SwiftShader. A local placeholder package satisfies that dependency.
RUN set -eux; \
    mkdir -p /tmp/no-mesa-dri/DEBIAN; \
    printf '%s\n' \
      'Package: libgl1-mesa-dri' \
      'Version: 0~cloakhub' \
      "Architecture: $(dpkg --print-architecture)" \
      'Multi-Arch: same' \
      'Maintainer: CloakHub' \
      'Description: placeholder for Mesa DRI drivers (Xvfb runs without GLX)' \
      > /tmp/no-mesa-dri/DEBIAN/control; \
    dpkg-deb --build /tmp/no-mesa-dri /tmp/no-mesa-dri.deb; \
    dpkg -i /tmp/no-mesa-dri.deb; \
    apt-mark hold libgl1-mesa-dri; \
    rm -rf /tmp/no-mesa-dri /tmp/no-mesa-dri.deb; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      xvfb libx264-164 libyuv0 libopus0 libpulse0; \
    if dpkg-query -W -f='${Status}' libllvm15 2>/dev/null | grep -q 'ok installed'; then \
      echo "Mesa/LLVM was installed"; exit 1; \
    fi; \
    rm -rf /var/lib/apt/lists/*

COPY --from=voxl /opt/voxl/bin/voxl /usr/local/bin/voxl
RUN voxl --version

# Bake the license-free browser. The release asset is verified by SHA-256 before
# extraction so a moved or re-uploaded asset cannot silently change the build.
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) platform=linux-x64; sha256="$BROWSER_SHA256_AMD64" ;; \
      arm64) platform=linux-arm64; sha256="$BROWSER_SHA256_ARM64" ;; \
      *) echo "Unsupported architecture: $TARGETARCH"; exit 1 ;; \
    esac; \
    wget -q -O /tmp/cloakbrowser.tar.zst \
      "https://github.com/txchen/cloakhub/releases/download/${BROWSER_RELEASE_TAG}/cloakbrowser-${BROWSER_VERSION}-${platform}-nolicense-patched.tar.zst"; \
    echo "${sha256}  /tmp/cloakbrowser.tar.zst" | sha256sum -c -; \
    mkdir -p /opt/cloakbrowser; \
    tar -C /opt/cloakbrowser -I zstd --strip-components=1 -xf /tmp/cloakbrowser.tar.zst; \
    rm /tmp/cloakbrowser.tar.zst; \
    chmod +x /opt/cloakbrowser/chrome; \
    HOME=/tmp /opt/cloakbrowser/chrome --version

# Project files follow the browser layer to preserve it across code-only builds.
COPY fonts/macos /opt/cloakhub/fonts/macos
COPY scripts/macos-fonts.conf /app/macos-fonts.conf
COPY scripts/check-mac-fonts.sh /app/check-mac-fonts.sh
RUN FONTCONFIG_FILE=/app/macos-fonts.conf fc-cache -f \
    && FONTCONFIG_FILE=/app/macos-fonts.conf /app/check-mac-fonts.sh

COPY --from=hub /out/cloakhub /usr/local/bin/cloakhub

RUN mkdir -p /data

EXPOSE 7788 7789
VOLUME ["/data"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/cloakhub"]
