#!/usr/bin/env bash
# Capped per iteration, but the loop itself can only be stopped by killing it.
while true; do
  claude -p "keep going" --max-turns 5
  sleep 30
done
