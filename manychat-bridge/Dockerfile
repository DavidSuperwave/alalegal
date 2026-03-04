# ──────────────────────────────────────────────────────────────
# ALA Legal — ManyChat Bridge Dockerfile
# Multi-stage build: install deps on builder, copy to slim runner
# ──────────────────────────────────────────────────────────────

# ── Stage 1: dependencies ──────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app

# Copy package files and install production dependencies only
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts

# ── Stage 2: runtime image ─────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

# Non-root user for security
RUN addgroup -S bridge && adduser -S bridge -G bridge

# Copy installed modules and application code
COPY --from=deps /app/node_modules ./node_modules
COPY bridge.js ./

# Change ownership
RUN chown -R bridge:bridge /app
USER bridge

# Expose bridge port (matches BRIDGE_PORT env var, default 4000)
EXPOSE 4000

# Healthcheck via the /health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:4000/health || exit 1

CMD ["node", "bridge.js"]
