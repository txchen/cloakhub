FROM oven/bun:1.3.14-debian AS bun

FROM cloakhq/cloakbrowser:latest

ARG TARGETARCH=amd64

WORKDIR /app

ENV CLOAKHUB_DATA_DIR=/data \
    CLOAKHUB_HOST=0.0.0.0 \
    CLOAKHUB_PORT=7788 \
    NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    wget \
    xclip \
    && rm -rf /var/lib/apt/lists/*

RUN wget -q https://github.com/kasmtech/KasmVNC/releases/download/v1.3.3/kasmvncserver_bookworm_1.3.3_${TARGETARCH}.deb \
    && apt-get update \
    && apt-get install -y --no-install-recommends -f ./kasmvncserver_bookworm_1.3.3_${TARGETARCH}.deb \
    && rm kasmvncserver_bookworm_1.3.3_${TARGETARCH}.deb \
    && rm -rf /var/lib/apt/lists/*

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN mkdir -p /opt/cloakbrowser \
    && browser_path="$(find /root/.cloakbrowser -maxdepth 2 -type f -name chrome | sort | tail -n 1)" \
    && ln -s "$browser_path" /opt/cloakbrowser/cloakbrowser \
    && /opt/cloakbrowser/cloakbrowser --version

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src
COPY tsconfig.json ./

RUN mkdir -p /data

EXPOSE 7788
VOLUME ["/data"]

ENTRYPOINT []
CMD ["bun", "run", "src/server.ts"]
