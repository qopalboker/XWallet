# syntax=docker/dockerfile:1.6
# ─────────────────────────────────────────────────────────────────────────
# Multi-stage Dockerfile برای wallet-service.
# یه image واحد که هم api و هم worker توش هست؛ command مشخص می‌کنه چی اجرا بشه.
# ─────────────────────────────────────────────────────────────────────────

ARG NODE_VERSION=20.18.0

# ─── Stage 1: deps (با dev deps برای build) ───
FROM node:${NODE_VERSION}-slim AS deps

WORKDIR /app

# build deps برای native modules (bcrypt, tiny-secp256k1, ...)
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund


# ─── Stage 2: build ───
FROM deps AS build

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

RUN npm run build


# ─── Stage 3: prod deps فقط ───
FROM node:${NODE_VERSION}-slim AS prod-deps

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund


# ─── Stage 4: runtime ───
FROM node:${NODE_VERSION}-slim AS runtime

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    PORT=3000

WORKDIR /app

# tini برای signal handling صحیح در PID 1
RUN apt-get update && apt-get install -y --no-install-recommends \
      tini ca-certificates wget \
    && rm -rf /var/lib/apt/lists/*

# user بدون root
RUN groupadd --system --gid 1001 nodeapp \
 && useradd --system --uid 1001 --gid nodeapp --no-create-home nodeapp

COPY --chown=nodeapp:nodeapp --from=prod-deps /app/node_modules ./node_modules
COPY --chown=nodeapp:nodeapp --from=build /app/dist ./dist
COPY --chown=nodeapp:nodeapp public ./public
COPY --chown=nodeapp:nodeapp package.json ./

USER nodeapp

EXPOSE 3000

# Healthcheck داخلی (اگه docker swarm/standalone اجرا می‌کنی)
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:${PORT}/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]

# پیش‌فرض = api؛ برای worker در compose override می‌شه
CMD ["node", "dist/src/api/server.js"]
