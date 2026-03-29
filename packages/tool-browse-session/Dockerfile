# Stage 1: Build
FROM node:22-slim AS builder

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy workspace root config (needed for pnpm install)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./

# Copy package.json files for workspace packages this tool depends on
COPY packages/config/package.json packages/config/
COPY packages/tool-server/package.json packages/tool-server/
COPY packages/tool-browse-session/package.json packages/tool-browse-session/

# Stub out other workspace packages so pnpm lockfile resolves
COPY packages/core/package.json packages/core/
COPY packages/gateway/package.json packages/gateway/
COPY packages/channel-telegram/package.json packages/channel-telegram/
COPY packages/tool-weather-au/package.json packages/tool-weather-au/
COPY packages/tool-weather-eu/package.json packages/tool-weather-eu/
COPY packages/tool-weather-us/package.json packages/tool-weather-us/
COPY packages/tool-browse/package.json packages/tool-browse/
COPY packages/tool-search/package.json packages/tool-search/

RUN pnpm install --frozen-lockfile

# Copy source and build only what we need
COPY packages/config/ packages/config/
COPY packages/tool-server/ packages/tool-server/
COPY packages/tool-browse-session/ packages/tool-browse-session/

RUN pnpm --filter @langgraph-glove/config build && \
    pnpm --filter @langgraph-glove/tool-server build && \
    pnpm --filter @langgraph-glove/tool-browse-session build

# Stage 2: Runtime (Playwright image includes Node.js + Chromium)
FROM mcr.microsoft.com/playwright:v1.52.0-noble AS runtime

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy workspace config
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Copy package.json files for runtime resolution
COPY packages/config/package.json packages/config/
COPY packages/tool-server/package.json packages/tool-server/
COPY packages/tool-browse-session/package.json packages/tool-browse-session/

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Copy built output
COPY --from=builder /app/packages/config/dist/ packages/config/dist/
COPY --from=builder /app/packages/tool-server/dist/ packages/tool-server/dist/
COPY --from=builder /app/packages/tool-browse-session/dist/ packages/tool-browse-session/dist/

VOLUME ["/app/config", "/app/secrets"]

ENV NODE_ENV=production
ENV GLOVE_CONFIG_DIR=/app/config
ENV GLOVE_SECRETS_DIR=/app/secrets

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3011/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

EXPOSE 3011

CMD ["node", "packages/tool-browse-session/dist/main.js"]
