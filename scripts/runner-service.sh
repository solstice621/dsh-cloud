#!/bin/bash
set -euo pipefail
node_bin="$1"
entrypoint="$2"
env_file="$3"
export CLOUD_RUNNER_CONFIG="$4"
set -a
source "$env_file"
set +a
exec "$node_bin" "$entrypoint"
