# CloakHub image (linux/amd64 and linux/arm64).
#
# Bakes the license-free CloakBrowser build for the target architecture, downloaded
# from the CloakHub GitHub release for that exact build and verified by SHA-256. At
# runtime no license key is required and Hub runs with CLOAKHUB_LICENSE_MODE=none, so
# concurrent Browser Instances are bounded only by CLOAKHUB_MAX_RUNNING_INSTANCES
# (default 10 here). The live viewer is Xvfb plus voxl (H.264 over WebSocket).

FROM oven/bun:1.3.14-debian AS bun

# voxl streams each Browser Instance's Xvfb display to the viewer as H.264 over a
# WebSocket. Built from the pinned crates.io release; esbuild bundles its web client.
FROM rust:1.93-bookworm AS voxl
ARG TARGETARCH
ARG VOXL_VERSION=0.3.4
ARG ESBUILD_VERSION=0.25.10
RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config clang libclang-dev libx264-dev libyuv-dev libopus-dev libpulse-dev \
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
RUN cargo install --locked voxl-server --version "${VOXL_VERSION}" --root /opt/voxl

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
    CLOAKHUB_LICENSE_MODE=none \
    CLOAKHUB_BROWSER_BIN=/opt/cloakbrowser/chrome \
    CLOAKHUB_MAX_RUNNING_INSTANCES=10 \
    CLOAKHUB_DEFAULT_PLATFORM=macos \
    CLOAKHUB_MACOS_FONTCONFIG_FILE=/app/macos-fonts.conf \
    NODE_ENV=production

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

RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb libx264-164 libyuv0 libopus0 libpulse0 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=voxl /opt/voxl/bin/voxl /usr/local/bin/voxl
RUN voxl --version

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

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
COPY package.json bun.lock ./
# Downloader-only use: exclude optional automation peers resolved by the dev lockfile.
RUN bun install --frozen-lockfile --production --omit=peer

COPY fonts/macos /opt/cloakhub/fonts/macos
COPY scripts/macos-fonts.conf /app/macos-fonts.conf
COPY scripts/check-mac-fonts.ts /app/check-mac-fonts.ts
RUN FONTCONFIG_FILE=/app/macos-fonts.conf fc-cache -f \
    && FONTCONFIG_FILE=/app/macos-fonts.conf bun /app/check-mac-fonts.ts

COPY src ./src
COPY tsconfig.json ./

RUN mkdir -p /data

EXPOSE 7788
VOLUME ["/data"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "run", "src/server.ts"]
