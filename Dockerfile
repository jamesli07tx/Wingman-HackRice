# Cortex image (Fly.io). Build context = repo root so the pnpm workspace
# (shared/) is available. Console deploys to Vercel, not from here.
FROM node:24-slim
WORKDIR /app
RUN npm install -g pnpm@12.4.1

# Manifests first for layer caching
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY shared/package.json shared/
COPY cortex/package.json cortex/
RUN pnpm install --frozen-lockfile --filter "@wingman/cortex..."

COPY shared shared
COPY cortex cortex

ENV PORT=8080
EXPOSE 8080
CMD ["pnpm", "-F", "@wingman/cortex", "start"]
