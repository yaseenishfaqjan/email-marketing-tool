# The platform runs as one image; the API and the worker are the same code
# started with different commands.
#
# Every dependency here is pure JavaScript, so there is no build toolchain to
# install and no native module to compile — the image stays small and builds
# in seconds.

FROM node:22-alpine

WORKDIR /app

# Dependencies first, so a code change does not re-install node_modules.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY . .

ENV NODE_ENV=production

# Run as the node user rather than root. The process needs to read its own
# code and talk to Postgres and SES; it has no business writing to the image.
USER node

EXPOSE 8080

CMD ["node", "src/server.mjs"]
