FROM oven/bun:1.3.14-debian AS bun

FROM debian:bookworm-slim

ARG TARGETARCH

WORKDIR /app

ENV CLOAKHUB_DATA_DIR=/data \
    CLOAKHUB_HOST=0.0.0.0 \
    CLOAKHUB_PORT=7788 \
    CLOAKHUB_BROWSER_INSTALLER=bun \
    CLOAKHUB_BROWSER_VERSION=152.0.7977.82.1 \
    CLOAKHUB_BROWSER_CHANNEL=preview \
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
