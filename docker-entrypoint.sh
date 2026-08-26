#!/bin/sh
set -eu

if [ "$(id -u)" = "0" ]; then
  run_uid="${PUID:-1000}"
  run_gid="${PGID:-10}"
  case "$run_uid" in
    ""|*[!0-9]*|0)
      echo "Error: PUID and PGID must be positive numeric IDs" >&2
      exit 1
      ;;
  esac
  case "$run_gid" in
    ""|*[!0-9]*|0)
      echo "Error: PUID and PGID must be positive numeric IDs" >&2
      exit 1
      ;;
  esac
  mkdir -p /data/providers/codex
  if ! chown -R "$run_uid:$run_gid" /data; then
    echo "Error: cannot make /data writable by PUID=$run_uid PGID=$run_gid" >&2
    exit 1
  fi
  umask 077
  exec su-exec "$run_uid:$run_gid" "$@"
fi

exec "$@"
