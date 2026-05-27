# rigscore — AI dev environment hygiene checker.
# Image published at ghcr.io/back-road-creative/rigscore on tag pushes via
# .github/workflows/docker-publish.yml. VERSION is templated in by the
# workflow so OCI labels always match the actual release.
ARG VERSION=dev

# Pinned to the multi-arch manifest-list digest so the build is
# reproducible across architectures. Refresh procedure (e.g. once per
# minor Node release):
#   curl -s https://hub.docker.com/v2/repositories/library/node/tags/20-alpine \
#     | python3 -c "import json,sys; print(json.load(sys.stdin)['digest'])"
# Then update the digest below and bump the comment.
# Resolved 2026-05-27 — node:20-alpine
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293

ARG VERSION

# OCI labels — required for provenance tooling and registry metadata.
LABEL org.opencontainers.image.title="rigscore"
LABEL org.opencontainers.image.description="AI dev environment configuration hygiene checker"
LABEL org.opencontainers.image.source="https://github.com/Back-Road-Creative/rigscore"
LABEL org.opencontainers.image.url="https://github.com/Back-Road-Creative/rigscore"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.version="${VERSION}"

# Non-root user — created before WORKDIR so /app can be owned by it. rigscore
# only reads files, so the caller's mounted /workspace must be world-readable
# from the host (e.g. `docker run --rm -v "$PWD:/workspace" rigscore /workspace`
# works on any cwd whose contents the `rigscore` user inside the container can
# read — which matches the default permission bits on most dev repos).
RUN addgroup -S rigscore && adduser -S rigscore -G rigscore

WORKDIR /app

# Copy only the runtime artefacts. Tests, fixtures, and worktrees are
# excluded via .dockerignore.
COPY package.json package-lock.json ./
COPY bin/ ./bin/
COPY src/ ./src/

RUN npm ci --omit=dev --no-audit --no-fund \
 && chmod +x /app/bin/rigscore.js \
 && chown -R rigscore:rigscore /app

# Default working directory for scans. The image expects the caller to
# `docker run --rm -v "$PWD:/workspace" rigscore:latest /workspace`.
WORKDIR /workspace

USER rigscore

ENTRYPOINT ["node", "/app/bin/rigscore.js"]
CMD ["/workspace"]
