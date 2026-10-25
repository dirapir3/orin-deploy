# Orin: API server + web app + admin page in one container (built by Render from this repo).
# Secrets (GEMINI_API_KEY, ADMIN_PASSWORD, VAULT_KEY, ORIN_MASTER_KEY, ...) come from the host's
# environment settings, never from a baked-in .env.
FROM node:24-slim

ENV NODE_ENV=production \
    TRUST_PROXY=1 \
    DATA_DIR=/tmp/orin-data \
    ADMIN_ENV_FILE=/tmp/orin-data/admin.env \
    WEB_DIR=/app/web

WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --ignore-scripts
COPY server/tsconfig.json server/tsconfig.build.json ./
COPY server/src ./src
RUN npx tsc -p tsconfig.build.json && npm prune --omit=dev

# Prebuilt Expo web export (npx expo export -p web), served same-origin by the server.
COPY web ./web

# Render's free disk is temporary: /tmp/orin-data is wiped on every restart or redeploy.
RUN mkdir -p /tmp/orin-data && chown -R 1000:1000 /tmp/orin-data /app
USER 1000

EXPOSE 10000
CMD ["node", "dist/index.js"]
