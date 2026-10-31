# Solider.uz change: production image for the Next.js app itself (not the
# E2B Agent sandbox -- that's docker/Dockerfile, a separate Kali-based image
# built and pushed by .github/workflows/docker-sandbox.yml). This image runs
# the web app on our own server instead of Vercel. Convex, Trigger.dev tasks
# and the Agent's E2B sandboxes stay on their own cloud services either way --
# this container only needs to serve Next.js pages and API routes.
FROM node:22-bookworm-slim AS base
RUN corepack enable

# ---- deps: install with the lockfile only, so this layer caches across
# code changes that don't touch dependencies. Only each workspace package's
# package.json is needed to resolve the lockfile -- packages/desktop (the
# Electron app) and packages/local aren't part of this image's build.
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/local/package.json ./packages/local/package.json
COPY packages/desktop/package.json ./packages/desktop/package.json
RUN pnpm install --frozen-lockfile

# ---- build: compile with standalone output ----
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV DOCKER_BUILD=true
ENV NEXT_TELEMETRY_DISABLED=1
# Build-time Convex/public env vars are injected via --build-arg in
# docker-compose.yml (see its build.args); they must be present at build
# time because Next.js inlines NEXT_PUBLIC_* values into the client bundle.
ARG NEXT_PUBLIC_CONVEX_URL
ARG NEXT_PUBLIC_CONVEX_SITE_URL
ARG NEXT_PUBLIC_WORKOS_REDIRECT_URI
ENV NEXT_PUBLIC_CONVEX_URL=$NEXT_PUBLIC_CONVEX_URL
ENV NEXT_PUBLIC_CONVEX_SITE_URL=$NEXT_PUBLIC_CONVEX_SITE_URL
ENV NEXT_PUBLIC_WORKOS_REDIRECT_URI=$NEXT_PUBLIC_WORKOS_REDIRECT_URI
RUN pnpm run build

# ---- runner: minimal runtime image ----
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN groupadd --system --gid 1001 nodejs && \
    useradd --system --uid 1001 --gid nodejs nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
CMD ["node", "server.js"]
