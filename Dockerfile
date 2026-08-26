FROM node:22-alpine3.21 AS codex-builder

ENV NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false

# Codex ships one large static binary plus several interactive CLI helpers.
# This Hub only uses the x86-64 native binary's `app-server` command. Strip it
# in the builder and copy that single file into the runtime image.
RUN apk add --no-cache binutils \
    && npm install --global --omit=dev --no-audit --no-fund @openai/codex@0.149.1 \
    && native_codex="$(find /usr/local/lib/node_modules/@openai/codex \
         -type f -path '*/vendor/x86_64-unknown-linux-musl/bin/codex' -print -quit)" \
    && test -n "$native_codex" \
    && strip --strip-unneeded "$native_codex" \
    && install -m 0755 "$native_codex" /opt/codex \
    && /opt/codex --version \
    && rm -rf /root/.npm

FROM alpine:3.21

LABEL org.opencontainers.image.title="VWatch Quota Hub" \
      org.opencontainers.image.description="Low-memory multi-provider quota hub for VWatch" \
      org.opencontainers.image.source="https://github.com/xudong7587/vwatch-quota-hub"

RUN apk add --no-cache ca-certificates libstdc++ su-exec tzdata \
    && mkdir -p /app /data/providers/codex \
    && chown -R 1000:10 /app /data

COPY --from=codex-builder /usr/local/bin/node /usr/local/bin/node
COPY --from=codex-builder /opt/codex /usr/local/bin/codex

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
