FROM rust:1.92-slim-bookworm AS rust-builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config libssl-dev cmake gcc g++ \
    && rm -rf /var/lib/apt/lists/* \
    && rustup target add wasm32-wasip2 \
    && cargo install wasm-tools

WORKDIR /repo
COPY Cargo.toml Cargo.lock ./
COPY build.rs build.rs
COPY src/ src/
COPY tests/ tests/
COPY migrations/ migrations/
COPY registry/ registry/
COPY channels-src/ channels-src/
COPY wit/ wit/
RUN cargo build --release --bin superwave-agent

FROM node:20-bookworm-slim AS web-builder

WORKDIR /repo/apps/web
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci
COPY apps/web/ ./
RUN npm run build

FROM node:20-bookworm-slim AS runner

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libssl3 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=rust-builder /repo/target/release/superwave-agent /usr/local/bin/superwave-agent
COPY --from=rust-builder /repo/migrations /app/migrations
COPY --from=web-builder /repo/apps/web/.next/standalone ./
COPY --from=web-builder /repo/apps/web/.next/static /app/apps/web/.next/static
COPY --from=web-builder /repo/apps/web/public /app/apps/web/public

ENV NODE_ENV=production
ENV PORT=3100
ENV SUPERWAVE_CLI_BIN=/usr/local/bin/superwave-agent

EXPOSE 3100

CMD ["node", "apps/web/server.js"]
