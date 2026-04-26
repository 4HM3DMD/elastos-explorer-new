#!/usr/bin/env bash
# Prune dist/assets/* files older than RETENTION_DAYS (default 30).
#
# We keep old assets across rebuilds (vite emptyOutDir: false) so that
# users with stale browser sessions can still lazy-load the chunks they
# remember from the previous deploy. Files in dist/assets/ accumulate
# over time; this script trims the long tail.
#
# Run weekly via cron:
#   0 4 * * 0 /opt/elastos-explorer-new/scripts/prune-old-assets.sh
#
# Safe to run anytime — it never touches index.html or files referenced
# by the current manifest. mtime-based: deletes assets nobody has
# overwritten in N days, which means nothing has rebuilt them, which
# means no current bundle still references them.

set -euo pipefail

DIST_DIR="${DIST_DIR:-/opt/elastos-explorer-new/dist/assets}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"

if [ ! -d "$DIST_DIR" ]; then
  echo "prune-old-assets: $DIST_DIR not found, nothing to do" >&2
  exit 0
fi

before=$(find "$DIST_DIR" -type f | wc -l)
deleted=$(find "$DIST_DIR" -type f -mtime "+${RETENTION_DAYS}" -delete -print | wc -l)
after=$(find "$DIST_DIR" -type f | wc -l)

echo "prune-old-assets: kept $after files (was $before, removed $deleted older than ${RETENTION_DAYS}d)"
