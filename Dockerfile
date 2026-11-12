# YouTube app image. Multi-stage: build everything, then a runtime stage with production
# dependencies and the three built dist folders. Runs as `node` on a read-only root
# filesystem: only DATA_DIR (/data) is written. Pure Node: no Python sidecar.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/package.json
COPY server/package.json server/package.json
COPY client/package.json client/package.json
# The vendored Bar Games SDK and game kit tarballs (file: dependencies).
COPY vendor ./vendor
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY shared/package.json shared/package.json
COPY server/package.json server/package.json
COPY client/package.json client/package.json
COPY vendor ./vendor
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/shared/dist shared/dist
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/client/dist client/dist

# The image runs as uid 1000. A ./data bind mount that root created on an existing host
# needs `sudo chown -R 1000:1000 ./data` first.
RUN mkdir -p /data && chown node:node /data
USER node

ENV PORT=3006
ENV DATA_DIR=/data
EXPOSE 3006

# The healthcheck lives in docker-compose.yml only, so the two can't drift.
CMD ["node", "server/dist/index.js"]
