#!/bin/sh
# Container entrypoint: makes the data volume writable, then runs the server as the unprivileged "node" user.
# With BUCKET_NAME set, Litestream restores the database onto an empty volume, then streams every change to the bucket.
set -eu

# litestream.yml reads this too.
export RECALL_DATA_DIR="${RECALL_DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$RECALL_DATA_DIR"
  # Fly mounts new volumes owned by root.
  if [ "$(stat -c %U "$RECALL_DATA_DIR")" != "node" ]; then chown -R node:node "$RECALL_DATA_DIR"; fi
  exec setpriv --reuid=node --regid=node --init-groups -- sh "$0" "$@"
fi

if [ -z "${BUCKET_NAME:-}" ]; then
  exec node dist/server/src/index.js
fi

# Tigris, Fly's storage, uses the region "auto".
export AWS_REGION="${AWS_REGION:-auto}"
# Fails (and the machine retries) if the bucket can't be reached, rather than starting over with an empty database.
litestream restore -if-db-not-exists -if-replica-exists "$RECALL_DATA_DIR/recall.db"
exec litestream replicate -exec "node dist/server/src/index.js"
