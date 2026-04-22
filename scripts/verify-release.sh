#!/usr/bin/env bash
# verify-release.sh — download release assets for a rigscore tag and verify
# the build-provenance attestation via `gh attestation verify`.
#
# Usage:
#   scripts/verify-release.sh v0.9.0-rc1
#   scripts/verify-release.sh --help
#   scripts/verify-release.sh --dry-run
#
# Exits 0 on successful verification. Non-zero on any failure.

set -euo pipefail

OWNER="Back-Road-Creative"
REPO="rigscore"

usage() {
  cat <<'EOF'
verify-release.sh — verify a signed rigscore release.

USAGE:
  scripts/verify-release.sh <tag>
  scripts/verify-release.sh --help | -h
  scripts/verify-release.sh --dry-run

ARGS:
  <tag>        A release tag like v0.9.0-rc1. Must exist as a GitHub release.

FLAGS:
  --help, -h   Show this help and exit 0.
  --dry-run    Check prerequisites (gh CLI, auth) and exit 0 without
               downloading anything.

REQUIRES:
  - gh (GitHub CLI) authenticated: `gh auth status`
  - Network access to github.com

WHAT IT DOES:
  1. Downloads the release tarball + sbom.cdx.json into a tmp dir.
  2. Runs `gh attestation verify <tarball> --owner Back-Road-Creative`.
  3. Reports pass/fail and exits accordingly.

SEE ALSO:
  .github/workflows/release-provenance.yml — the workflow that produces
  the attestation this script verifies.
EOF
}

require_gh() {
  if ! command -v gh >/dev/null 2>&1; then
    echo "error: gh (GitHub CLI) is required but not installed." >&2
    echo "  install: https://cli.github.com/" >&2
    exit 2
  fi
  if ! gh auth status >/dev/null 2>&1; then
    echo "error: gh is not authenticated. Run: gh auth login" >&2
    exit 2
  fi
}

# -------- arg parsing --------
if [[ $# -eq 0 ]]; then
  usage
  exit 1
fi

case "${1:-}" in
  -h|--help)
    usage
    exit 0
    ;;
  --dry-run)
    require_gh
    echo "dry-run: gh is installed and authenticated. OK."
    exit 0
    ;;
  v*)
    TAG="$1"
    ;;
  *)
    echo "error: expected a tag starting with 'v' (e.g. v0.9.0-rc1), got: $1" >&2
    usage
    exit 1
    ;;
esac

require_gh

WORKDIR="$(mktemp -d -t rigscore-verify-XXXXXX)"
trap 'rm -rf "${WORKDIR}"' EXIT

echo "==> Downloading release assets for ${TAG} into ${WORKDIR}"
gh release download "${TAG}" \
  --repo "${OWNER}/${REPO}" \
  --dir "${WORKDIR}" \
  --pattern '*.tgz' \
  --pattern 'sbom.cdx.json'

TARBALL="$(find "${WORKDIR}" -maxdepth 1 -name '*.tgz' -print -quit)"
if [[ -z "${TARBALL}" ]]; then
  echo "error: no .tgz asset found on release ${TAG}" >&2
  exit 3
fi

echo "==> Tarball: $(basename "${TARBALL}")"
sha256sum "${TARBALL}"

if [[ -f "${WORKDIR}/sbom.cdx.json" ]]; then
  echo "==> SBOM present: sbom.cdx.json ($(wc -c < "${WORKDIR}/sbom.cdx.json") bytes)"
else
  echo "warn: sbom.cdx.json not found on release (verification continues)" >&2
fi

echo "==> Verifying attestation via gh attestation verify"
gh attestation verify "${TARBALL}" --owner "${OWNER}"

echo "==> OK: ${TAG} verified."
