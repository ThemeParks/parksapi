# Dev image for ParksAPI — Node 24 / npm 11 (see package.json "engines")
FROM node:24-slim

ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    TZ=UTC \
    HOME=/home/node

WORKDIR /app

# node:24-slim ships an unprivileged `node` user (uid/gid 1000) but does not
# select it. As root, everything the container writes into the bind mount is
# root-owned on a Docker host — .env, dist/, cache.sqlite, docs/ — and the
# developer then needs sudo to edit or delete their own files.
#
# Switching before `npm ci` rather than chowning afterwards keeps the image
# ~200 MB smaller: a `RUN chown -R /app` would duplicate the whole
# node_modules tree in a new layer. It also initialises the named node_modules
# volume as uid 1000, so the entrypoint's `npm ci` fallback still works.
#
# Rootless Podman maps container uid 1000 to a subuid rather than to the
# developer, so the Podman recipe in the Makefile header passes
# --userns=keep-id; the entrypoint says so too if the mount is unwritable.
RUN chown node:node /app
USER node

# Install deps first so the layer is cached independently of the source.
# --ignore-scripts skips the root "prepare": "tsc" hook, which cannot run yet
# (no sources at this point) and is not needed: tsx executes TypeScript directly.
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Baked-in sources, so the image is usable without a bind mount too.
COPY --chown=node:node . .

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["npm", "run", "dev"]
