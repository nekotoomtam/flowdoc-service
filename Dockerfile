FROM node@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS node
FROM node AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY vendor ./vendor
COPY scripts/verifyVendor.mjs ./scripts/verifyVendor.mjs
RUN node scripts/verifyVendor.mjs && npm ci --ignore-scripts --no-audit --no-fund
COPY src ./src
RUN npm run build

FROM python@sha256:0a310eeecf4e1f5a0743f9a6520c90c88d089c903ca5fd283f501e3a805f5f89 AS runtime
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm
WORKDIR /app
COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && pip install --no-cache-dir -r node_modules/@flowdoc/core/runtime/requirements.txt
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY examples ./examples
RUN mkdir /app/temp /app/output /app/staging && chown -R 10001:10001 /app
USER 10001:10001
ENTRYPOINT ["node","dist/cli.js"]
CMD ["--help"]

FROM runtime AS verification
COPY --from=build /app/node_modules ./node_modules
COPY tests ./tests
ENTRYPOINT ["./node_modules/.bin/vitest","run","--no-file-parallelism"]
CMD []
