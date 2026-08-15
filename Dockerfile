# Dev image for ParksAPI — Node 24 / npm 11 (see package.json "engines")
FROM node:24-slim

# HOME and the npm cache must be writable by whatever uid runs the image. The
# image advertises a bare `docker run --user`, and that uid need not be `node`
# or have a passwd entry at all — /tmp is 1777, /home/node is not.
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    TZ=UTC \
    HOME=/tmp \
    npm_config_cache=/tmp/.npm

WORKDIR /app

# node:24-slim ships an unprivileged `node` user (uid 1000) but does not select
# it. Switching before `npm ci` rather than chowning afterwards keeps the image
# ~200 MB smaller. Compose overrides this with the host's uid/gid.
RUN chown node:node /app
USER node

# Install deps first so the layer is cached independently of the source.
# --ignore-scripts skips the root "prepare": "tsc" hook, which cannot run here
# (no sources at this point) and is not needed: tsx executes TypeScript
# directly. The entrypoint skips it too, so no install ever produces dist/ —
# `make compile` is what does.
#
# npm leaves its own cache and node's compile cache under /tmp owned by this
# build's uid, where any other uid the image runs as cannot write. Removing
# them costs nothing (the npm one is emptied anyway) and /tmp is 1777, so both
# are recreated for whoever runs.
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --ignore-scripts && npm cache clean --force \
    && rm -rf /tmp/.npm /tmp/node-compile-cache \
    && sha256sum package-lock.json | cut -d' ' -f1 > node_modules/.parksapi-deps

# Baked-in sources, so the image is usable without a bind mount too.
COPY --chown=node:node . .

COPY --chmod=0755 parksapi-entrypoint.sh /usr/local/bin/parksapi-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/parksapi-entrypoint.sh"]
CMD ["npm", "run", "dev", "--", "--list"]
