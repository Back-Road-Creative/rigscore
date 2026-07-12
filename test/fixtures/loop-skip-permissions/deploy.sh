#!/usr/bin/env bash
set -euo pipefail
# One-shot agent call — no loop, but every permission prompt is bypassed.
claude -p "apply the pending migration" --dangerously-skip-permissions
