#!/bin/sh
set -eu

if [ "$(id -u)" = "0" ]; then
  mkdir -p /data/providers/codex
  if ! chown -R node:node /data; then
    echo "Error: cannot make /data writable by the node user" >&2
    exit 1
  fi
  umask 077
  exec su-exec node:node "$@"
fi

exec "$@"
