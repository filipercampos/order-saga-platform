# syntax=docker/dockerfile:1.7
# One image for the whole monorepo; each Deployment runs a different entrypoint
# (SERVICE=order|inventory|payment|notification|ledger-stub). One artifact per commit
# keeps contracts and libs in lockstep across services.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY libs ./libs
COPY apps ./apps
COPY tools ./tools
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache tini
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
ENV SERVICE=order
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/health/live" || exit 1
# tini forwards SIGTERM so Nest shutdown hooks stop consumers and drain the outbox.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "exec node dist/apps/${SERVICE}/src/main.js"]
