#!/usr/bin/env bash
# A real agent lives in this repo — but nothing in the loop's chain reaches it.
claude -p "review the diff" --max-turns 3
