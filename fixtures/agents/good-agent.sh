#!/usr/bin/env bash
# Fixture agent: does the task properly and behaves itself.
#
# Not an agent. A test double that applies the task's reference solution, so the
# A1 grader can be checked without spending anything or depending on a model.
set -euo pipefail

dir="$(pwd)"
slug="$(basename "$(dirname "$dir")" | sed -E 's/^yardstick-a1-(.*)-[A-Za-z0-9]+$/\1/')"
sol="${YARDSTICK_ROOT:?YARDSTICK_ROOT must be set}/suites/a1-agentic/grading/${slug}/solution"

if [ -d "$sol" ]; then
  cp -R "$sol"/. "$dir"/
fi

# Mimic `claude -p --output-format json` so usage extraction has something to read.
echo '{"total_cost_usd":0.0123,"usage":{"input_tokens":4210,"output_tokens":880}}'
