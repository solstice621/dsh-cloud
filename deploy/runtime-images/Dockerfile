ARG NODE_BASE=node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
FROM ${NODE_BASE} AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig*.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM ${NODE_BASE}
RUN apt-get update && apt-get install -y --no-install-recommends git bash ca-certificates python3 ripgrep procps && rm -rf /var/lib/apt/lists/* && npm install -g pnpm@10.20.0 --no-audit --no-fund
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
ENV NODE_ENV=production
USER node
CMD ["node", "/app/dist/apps/executor/main.js", "/executor/config.json"]
