FROM node:24.18.1-alpine3.23@sha256:ba63d8e0b5d4cbc6db9da12ea77ddb35a4783ad653a092ef115cc383526d4369 AS build

WORKDIR /build
COPY package.json package-lock.json .node-version .npm-version ./
RUN test "$(node --version)" = "v$(tr -d '\r\n' < .node-version)" \
    && test "$(npm --version)" = "$(tr -d '\r\n' < .npm-version)" \
    && npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build \
    && npm run artifact:smoke \
    && mkdir /runtime-dist \
    && cd dist \
    && find . -type f -name '*.js' -exec cp --parents '{}' /runtime-dist/ \;

FROM node:24.18.1-alpine3.23@sha256:ba63d8e0b5d4cbc6db9da12ea77ddb35a4783ad653a092ef115cc383526d4369 AS production-dependencies

WORKDIR /production
COPY package.json package-lock.json .node-version .npm-version ./
RUN test "$(node --version)" = "v$(tr -d '\r\n' < .node-version)" \
    && test "$(npm --version)" = "$(tr -d '\r\n' < .npm-version)" \
    && npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && rm -rf node_modules/pg-cloudflare/src node_modules/pg-protocol/src \
    && find node_modules/pg-protocol -type f -name '*.test.*' -delete \
    && find node_modules -type f \( -name '*.d.ts' -o -name '*.map' \) -delete \
    && node -e "require('pg')" \
    && rm -rf /root/.npm

RUN mkdir -p /runtime-rootfs/lib/apk/db /runtime-rootfs/etc /runtime-rootfs/usr/lib /runtime-rootfs/usr/local/bin \
    && cp /usr/local/bin/node /runtime-rootfs/usr/local/bin/node \
    && cp /lib/ld-musl-x86_64.so.1 /runtime-rootfs/lib/ld-musl-x86_64.so.1 \
    && cp /usr/lib/libgcc_s.so.1 /runtime-rootfs/usr/lib/libgcc_s.so.1 \
    && cp -P /usr/lib/libstdc++.so.6 /runtime-rootfs/usr/lib/libstdc++.so.6 \
    && cp /usr/lib/libstdc++.so.6.0.34 /runtime-rootfs/usr/lib/libstdc++.so.6.0.34 \
    && cp /etc/alpine-release /etc/os-release /runtime-rootfs/etc/ \
    && awk 'BEGIN { RS=""; ORS="\n\n" } /(^|\n)P:(musl|libgcc|libstdc\+\+)(\n|$)/ { print }' \
       /lib/apk/db/installed > /runtime-rootfs/lib/apk/db/installed \
    && test "$(grep -c '^P:' /runtime-rootfs/lib/apk/db/installed)" = 3 \
    && chown -R 1000:1000 /runtime-rootfs/usr/local/bin/node

FROM scratch AS runtime

ARG OCI_CREATED=1970-01-01T00:00:00Z
ARG OCI_REVISION=unknown
ARG OCI_SOURCE=https://github.com/cromles/zinesh-protocol-v2
ARG OCI_VERSION=2.0.0

LABEL org.opencontainers.image.created=$OCI_CREATED \
      org.opencontainers.image.revision=$OCI_REVISION \
      org.opencontainers.image.source=$OCI_SOURCE \
      org.opencontainers.image.version=$OCI_VERSION

ENV NODE_ENV=production
ENV PATH=/usr/local/bin
ENV HOME=/nonexistent
WORKDIR /app
COPY --from=production-dependencies /runtime-rootfs /
COPY --from=production-dependencies --chown=1000:1000 /production/package.json /production/package-lock.json ./
COPY --from=production-dependencies --chown=1000:1000 /production/node_modules ./node_modules
COPY --from=build --chown=1000:1000 /runtime-dist ./dist

USER 1000:1000
STOPSIGNAL SIGTERM
ENTRYPOINT ["node","dist/composition/main.js"]
