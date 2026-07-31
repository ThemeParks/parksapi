# Dev image for ParksAPI — Node 24 / npm 11 (see package.json "engines")
FROM node:24-slim

ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    TZ=UTC

WORKDIR /app

# Install deps first so the layer is cached independently of the source.
# --ignore-scripts skips the root "prepare": "tsc" hook, which cannot run yet
# (no sources at this point) and is not needed: tsx executes TypeScript directly.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Baked-in sources, so the image is usable without a bind mount too.
COPY . .

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["npm", "run", "dev"]
