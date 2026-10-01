FROM oven/bun:1.3.14-debian AS bun

FROM debian:bookworm-slim

ARG TARGETARCH

WORKDIR /app

ENV CLOAKHUB_DATA_DIR=/data \
    CLOAKHUB_HOST=0.0.0.0 \
    CLOAKHUB_PORT=7788 \
    CLOAKHUB_BROWSER_BIN=/opt/cloakbrowser/chrome \
    CLOAKHUB_DEFAULT_PLATFORM=macos \
    CLOAKHUB_MACOS_FONTCONFIG_FILE=/app/macos-fonts.conf \
    NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    wget \
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

RUN wget -q https://github.com/kasmtech/KasmVNC/releases/download/v1.3.3/kasmvncserver_bookworm_1.3.3_${TARGETARCH}.deb \
    && apt-get update \
    && apt-get install -y --no-install-recommends -f ./kasmvncserver_bookworm_1.3.3_${TARGETARCH}.deb \
    && rm kasmvncserver_bookworm_1.3.3_${TARGETARCH}.deb \
    && rm -rf /var/lib/apt/lists/*

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

# Install the public browser before any project files so code-only releases reuse
# the binary layer. Upstream's latest public build differs by architecture.
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) version=146.0.7680.177.5; platform=linux-x64; sha256=4a12bcde95fa1bb1beef2b41ab5e5c27c36be78e3be3d0dac8c64d705216670e ;; \
      arm64) version=146.0.7680.177.4; platform=linux-arm64; sha256=8b71ce53b4fd131327331a31fba3835d71882d19bfaabde78dd0f5390bd16f45 ;; \
      *) echo "Unsupported architecture: $TARGETARCH"; exit 1 ;; \
    esac; \
    wget -q -O /tmp/cloakbrowser.tar.gz \
      "https://github.com/CloakHQ/cloakbrowser/releases/download/chromium-v${version}/cloakbrowser-${platform}.tar.gz"; \
    echo "${sha256}  /tmp/cloakbrowser.tar.gz" | sha256sum -c -; \
    mkdir -p /opt/cloakbrowser; \
    tar -C /opt/cloakbrowser -xzf /tmp/cloakbrowser.tar.gz; \
    rm /tmp/cloakbrowser.tar.gz; \
    chmod +x /opt/cloakbrowser/chrome; \
    HOME=/tmp /opt/cloakbrowser/chrome --version

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
