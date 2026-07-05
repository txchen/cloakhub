FROM oven/bun:1.3.14-debian

WORKDIR /app

ENV CLOAKHUB_DATA_DIR=/data \
    CLOAKHUB_HOST=0.0.0.0 \
    CLOAKHUB_PORT=7788 \
    NODE_ENV=production

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src
COPY tsconfig.json ./

RUN mkdir -p /data

EXPOSE 7788
VOLUME ["/data"]

CMD ["bun", "run", "src/server.ts"]
