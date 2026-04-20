# rigscore — AI dev environment hygiene checker.
# Draft image for ghcr.io/back-road-creative/rigscore (v1.1.0).
# The publish workflow is gated on workflow_dispatch only — flip the trigger
# in .github/workflows/docker-publish.yml when ready to ship.
FROM node:20-alpine

WORKDIR /app

# Copy only the runtime artefacts. Tests, fixtures, and worktrees are
# excluded via .dockerignore.
COPY package.json package-lock.json ./
COPY bin/ ./bin/
COPY src/ ./src/

RUN npm ci --omit=dev --no-audit --no-fund \
 && chmod +x /app/bin/rigscore.js

# Default working directory for scans. The image expects the caller to
# `docker run --rm -v "$PWD:/workspace" rigscore:latest /workspace`.
WORKDIR /workspace

ENTRYPOINT ["node", "/app/bin/rigscore.js"]
CMD ["/workspace"]
