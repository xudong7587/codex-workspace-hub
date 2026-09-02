FROM node:22-alpine3.21 AS node-runtime

RUN apk add --no-cache binutils \
    && strip --strip-unneeded /usr/local/bin/node \
    && node --version

FROM alpine:3.21

LABEL org.opencontainers.image.title="Codex Workspace Hub" \
      org.opencontainers.image.description="Low-memory encrypted Codex development snapshot and quota hub" \
      org.opencontainers.image.source="https://github.com/xudong7587/codex-workspace-hub"

RUN apk add --no-cache ca-certificates libstdc++ su-exec tzdata \
    && mkdir -p /app /data/providers/codex \
    && chown -R 1000:10 /app /data

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node

ENV NODE_ENV=production \
    NODE_OPTIONS="--max-old-space-size=32 --max-semi-space-size=2" \
    DATA_DIR=/data \
    CODEX_HOME=/data/providers/codex \
    HOME=/data \
    PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

WORKDIR /app

COPY --chown=1000:10 package.json ./
COPY --chown=1000:10 src ./src
COPY --chown=1000:10 public ./public
COPY docker-entrypoint.sh /usr/local/bin/cw-entrypoint

RUN chmod 0755 /usr/local/bin/cw-entrypoint

EXPOSE 17321
VOLUME ["/data"]

STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/cw-entrypoint"]
CMD ["node", "src/cli.js", "serve"]
