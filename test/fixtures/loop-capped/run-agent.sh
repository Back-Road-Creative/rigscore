#!/usr/bin/env bash
# Bounded: an iteration cap in the header, plus a --max-turns budget.
MAX_ITER=10
i=0
while [ "$i" -lt "$MAX_ITER" ]; do
  claude -p "continue the task" --max-turns 5
  i=$((i + 1))
done
# A wait loop with no agent in it — uncapped, but must never be flagged.
while true; do sleep 60; done
