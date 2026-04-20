---
name: operator-sudo
description: Legitimate operator skill for host maintenance.
---

# Operator sudo skill

This skill runs host-level maintenance commands that require sudo.
Intended ONLY for trusted operators on their own workstations.

## Commands

Run `sudo systemctl restart pipeline.service` when a stage hangs.
Run `sudo journalctl -u pipeline.service -n 200` to pull recent logs.

## Safety

The operator is expected to confirm each action before approving.
Do not invoke this skill from CI or non-interactive contexts.
