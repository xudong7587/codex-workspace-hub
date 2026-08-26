FROM node:22-alpine3.21 AS codex-builder

ENV NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false

# Codex ships one large static binary plus several interactive CLI helpers.
# This Hub only uses `codex app-server` for account quota calls, so keep the
# main binary and remove code-mode, shell, search, and sandbox helpers.
RUN apk add --no-cache binutils \
    && npm install --global --omit=dev --no-audit --no-fund @openai/codex@0.149.1 \
    && find /usr/local/lib/node_modules/@openai/codex -type f -path '*/vendor/*/bin/codex' \
       -exec strip --strip-unneeded {} + \
    && find /usr/local/lib/node_modules/@openai/codex -type f \( \
         -name codex-code-mode-host \
         -o -path '*/codex-path/rg' \
         -o -path '*/codex-resources/bwrap' \
         -o -path '*/codex-resources/zsh/bin/zsh' \
       \) -delete \
    && codex --version \
    && rm -rf /root/.npm

FROM alpine:3.21

LABEL org.opencontainers.image.title="VWatch Quota Hub" \
      org.opencontainers.image.description="Low-memory multi-provider quota hub for VWatch" \
      org.opencontainers.image.source="https://github.com/xudong7587/vwatch-quota-hub"

RUN apk add --no-cache ca-certificates libstdc++ su-exec tzdata \
    && addgroup -g 1000 -S node \
    && adduser -u 1000 -S -D -H -G node node \
    && mkdir -p /app /data/providers/codex \
    && chown -R node:node /app /data

COPY --from=codex-builder /usr/local/bin/node /usr/local/bin/node
COPY --from=codex-builder /usr/local/bin/codex /usr/local/bin/codex
COPY --from=codex-builder /usr/local/lib/node_modules/@openai/codex /usr/local/lib/node_modules/@openai/codex

ENV NODE_ENV=production \
    NODE_OPTIONS="--max-old-space-size=32 --max-semi-space-size=2" \
    DATA_DIR=/data \
    CODEX_HOME=/data/providers/codex \
    HOME=/data \
    PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

WORKDIR /app

COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY docker-entrypoint.sh /usr/local/bin/vwatch-entrypoint

RUN chmod 0755 /usr/local/bin/vwatch-entrypoint

EXPOSE 17321
VOLUME ["/data"]

STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/vwatch-entrypoint"]
CMD ["node", "src/cli.js", "serve"]
