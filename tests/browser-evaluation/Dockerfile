# A fixed laboratory environment, not a production image or automatic browser updater.
FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS node

FROM ghcr.io/txchen/cloakhub_free:0.8.4@sha256:961f1ac4b12c2c15569e7765bc09cbb0ebdad77892f52496b025c67b121bec33
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /suite
COPY --chmod=644 package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY --chmod=755 tests/browser-evaluation ./tests/browser-evaluation
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/node", "/suite/tests/browser-evaluation/run.mjs"]
CMD ["--help"]
