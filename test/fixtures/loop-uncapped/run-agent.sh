#!/usr/bin/env bash
# Canonical failure: no iteration cap, no stop condition, no timeout.
while true; do
  claude -p "keep fixing the failing tests"
done
