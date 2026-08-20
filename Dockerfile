FROM node:24.16.0-bookworm-slim@sha256:ca520832af80fa37a57c14077ed0fcdd83b5aefccc356059fdc3a9a05b78ae1f AS build

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

FROM node:24.16.0-bookworm-slim@sha256:ca520832af80fa37a57c14077ed0fcdd83b5aefccc356059fdc3a9a05b78ae1f AS production-dependencies

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
COPY --from=production-dependencies /usr/local/bin/node /usr/local/bin/node
COPY --from=production-dependencies /lib/x86_64-linux-gnu/ld-linux-x86-64.so.2 /lib/x86_64-linux-gnu/ld-linux-x86-64.so.2
COPY --from=production-dependencies /lib/x86_64-linux-gnu/libc.so.6 /lib/x86_64-linux-gnu/libc.so.6
COPY --from=production-dependencies /lib/x86_64-linux-gnu/libdl.so.2 /lib/x86_64-linux-gnu/libdl.so.2
COPY --from=production-dependencies /lib/x86_64-linux-gnu/libgcc_s.so.1 /lib/x86_64-linux-gnu/libgcc_s.so.1
COPY --from=production-dependencies /lib/x86_64-linux-gnu/libm.so.6 /lib/x86_64-linux-gnu/libm.so.6
COPY --from=production-dependencies /lib/x86_64-linux-gnu/libpthread.so.0 /lib/x86_64-linux-gnu/libpthread.so.0
COPY --from=production-dependencies /lib/x86_64-linux-gnu/libstdc++.so.6 /lib/x86_64-linux-gnu/libstdc++.so.6
COPY --from=production-dependencies /lib/x86_64-linux-gnu/libstdc++.so.6.0.30 /lib/x86_64-linux-gnu/libstdc++.so.6.0.30
COPY --from=production-dependencies /lib64/ld-linux-x86-64.so.2 /lib64/ld-linux-x86-64.so.2
COPY --from=production-dependencies --chown=1000:1000 /production/package.json /production/package-lock.json ./
COPY --from=production-dependencies --chown=1000:1000 /production/node_modules ./node_modules
COPY --from=build --chown=1000:1000 /runtime-dist ./dist

USER 1000:1000
STOPSIGNAL SIGTERM
ENTRYPOINT ["node","dist/composition/main.js"]
