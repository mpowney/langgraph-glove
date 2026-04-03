# Stage 1: Build
FROM node:22-slim AS builder

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./

COPY packages/config/package.json packages/config/
COPY packages/tool-server/package.json packages/tool-server/
COPY packages/tool-memory/package.json packages/tool-memory/

COPY packages/core/package.json packages/core/
COPY packages/gateway/package.json packages/gateway/
COPY packages/channel-telegram/package.json packages/channel-telegram/
COPY packages/tool-weather-au/package.json packages/tool-weather-au/
COPY packages/tool-weather-eu/package.json packages/tool-weather-eu/
COPY packages/tool-weather-us/package.json packages/tool-weather-us/
COPY packages/tool-browse/package.json packages/tool-browse/
COPY packages/tool-browse-session/package.json packages/tool-browse-session/
COPY packages/tool-search/package.json packages/tool-search/
COPY packages/ui-web/package.json packages/ui-web/

RUN pnpm install --frozen-lockfile

COPY packages/config/ packages/config/
COPY packages/tool-server/ packages/tool-server/
COPY packages/tool-memory/ packages/tool-memory/

RUN pnpm --filter @langgraph-glove/config build && \
    pnpm --filter @langgraph-glove/tool-server build && \
    pnpm --filter @langgraph-glove/tool-memory build

# Stage 2: Runtime
FROM node:22-slim AS runtime

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/config/package.json packages/config/
COPY packages/tool-server/package.json packages/tool-server/
COPY packages/tool-memory/package.json packages/tool-memory/

RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/packages/config/dist/ packages/config/dist/
COPY --from=builder /app/packages/tool-server/dist/ packages/tool-server/dist/
COPY --from=builder /app/packages/tool-memory/dist/ packages/tool-memory/dist/

VOLUME ["/app/config", "/app/secrets", "/app/memories", "/app/data"]

ENV NODE_ENV=production
ENV GLOVE_CONFIG_DIR=/app/config
ENV GLOVE_SECRETS_DIR=/app/secrets

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3013/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

EXPOSE 3013

CMD ["node", "packages/tool-memory/dist/main.js"]
