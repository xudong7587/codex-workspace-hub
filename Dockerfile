FROM node:24-bookworm-slim

LABEL org.opencontainers.image.title="VWatch Quota Hub" \
      org.opencontainers.image.description="Low-memory multi-provider quota hub for VWatch" \
      org.opencontainers.image.source="https://github.com/xudong7587/vwatch-quota-hub"

ENV NODE_ENV=production \
    DATA_DIR=/data \
    CODEX_HOME=/data/providers/codex \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false

# Keep the Codex CLI version explicit: app-server schemas can change between releases.
RUN npm install --global --omit=dev --no-audit --no-fund @openai/codex@0.149.1 \
    && codex --version \
    && npm cache clean --force \
    && mkdir -p "${CODEX_HOME}" \
    && chown -R node:node /data

# Apply the small heap only at runtime; npm needs a normal heap while the image
# installs the pinned Codex package.
ENV NODE_OPTIONS="--max-old-space-size=32 --max-semi-space-size=2"

WORKDIR /app

COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public

USER node

EXPOSE 17321
VOLUME ["/data"]

STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "src/cli.js"]
CMD ["serve"]
