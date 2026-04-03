# Stage 1: Build
FROM node:22-slim AS builder

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy workspace config first for layer caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./

# Copy all package.json files (needed for pnpm install)
COPY packages/config/package.json packages/config/
COPY packages/core/package.json packages/core/
COPY packages/tool-server/package.json packages/tool-server/
COPY packages/channel-telegram/package.json packages/channel-telegram/
COPY packages/tool-weather-au/package.json packages/tool-weather-au/
COPY packages/tool-weather-eu/package.json packages/tool-weather-eu/
COPY packages/tool-weather-us/package.json packages/tool-weather-us/
COPY packages/tool-browse/package.json packages/tool-browse/
COPY packages/tool-browse-session/package.json packages/tool-browse-session/
COPY packages/tool-search/package.json packages/tool-search/

# Install dependencies (includes native builds like better-sqlite3)
RUN pnpm install --frozen-lockfile

# Copy source and build
COPY packages/ packages/
COPY tsconfig.base.json .
RUN pnpm build

# Stage 2: Production runtime
FROM node:22-slim AS runtime

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy workspace config
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Copy all package.json files
COPY packages/config/package.json packages/config/
COPY packages/core/package.json packages/core/
COPY packages/tool-server/package.json packages/tool-server/
COPY packages/channel-telegram/package.json packages/channel-telegram/

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Copy built output
COPY --from=builder /app/packages/config/dist/ packages/config/dist/
COPY --from=builder /app/packages/core/dist/ packages/core/dist/
COPY --from=builder /app/packages/tool-server/dist/ packages/tool-server/dist/
COPY --from=builder /app/packages/channel-telegram/dist/ packages/channel-telegram/dist/

# Create data directory for SQLite
RUN mkdir -p /app/data

# Config and secrets are mounted as volumes
VOLUME ["/app/config", "/app/secrets", "/app/data"]

# Health check
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:9090/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

EXPOSE 9090

ENV NODE_ENV=production
ENV GLOVE_CONFIG_DIR=/app/config
ENV GLOVE_SECRETS_DIR=/app/secrets

CMD ["node", "packages/core/dist/main.js"]
