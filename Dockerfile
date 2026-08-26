FROM node:22-alpine3.21

LABEL org.opencontainers.image.title="VWatch Quota Hub" \
      org.opencontainers.image.description="Low-memory multi-provider quota hub for VWatch" \
      org.opencontainers.image.source="https://github.com/xudong7587/vwatch-quota-hub"

RUN apk add --no-cache ca-certificates su-exec tzdata \
    && mkdir -p /app /data/providers/codex \
    && chown -R 1000:10 /app /data

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
COPY docker-entrypoint.sh /usr/local/bin/vwatch-entrypoint

RUN chmod 0755 /usr/local/bin/vwatch-entrypoint

EXPOSE 17321
VOLUME ["/data"]

STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/vwatch-entrypoint"]
CMD ["node", "src/cli.js", "serve"]
