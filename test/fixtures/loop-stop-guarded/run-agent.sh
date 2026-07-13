#!/usr/bin/env bash
# Every loop below evaluates something to decide it is done — none may be flagged.
while true; do
  claude -p "step" --max-turns 3
  if [ -f /tmp/agent.stop ]; then break; fi
done

until false; do
  claude -p "step" --max-turns 3 | grep -q DONE && exit 0
done

for ((;;)); do
  claude -p "step" --max-turns 3
  test -f ./STOP && return 0
done
