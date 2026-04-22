#!/usr/bin/env bash
# =============================================================================
# Rollback script for ela-explorer.
#
# Swaps the running container to a previously-built image. Useful when a fresh
# deploy introduces a regression (panic loop, startup failure, obviously-wrong
# behaviour) and you need to get back to a known-good state in under a minute.
#
# Usage:
#   ./rollback.sh                  # interactive: pick from recent image tags
#   ./rollback.sh <image-tag>      # non-interactive: roll to that tag
#   ./rollback.sh --dry-run        # show what would happen, change nothing
#   ./rollback.sh --list           # just list available images
#
# Assumes:
#   - docker compose file lives at ela-explorer/docker-compose.yml
#   - running container is named "ela-explorer"
#   - image name is "ela-explorer-explorer" (docker compose's default)
#
# What it does:
#   1. Lists the last 5 locally-cached images for ela-explorer-explorer
#   2. Either uses the tag you passed or prompts you to choose
#   3. Retags the chosen image as :latest (docker compose's expected tag)
#   4. Runs `docker compose up -d` to swap containers (preserving volumes)
#   5. Tails the last 30 log lines so you can confirm it came back healthy
#
# What it does NOT do:
#   - Touch the database (no schema rollback — Phase 3 migration system
#     will add that separately)
#   - Remove the bad image (you may want to investigate it)
#   - Pull from a remote registry (operates only on locally-cached images)
# =============================================================================
set -uo pipefail

IMAGE_NAME="ela-explorer-explorer"
COMPOSE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONTAINER_NAME="ela-explorer"

DRY_RUN=0
LIST_ONLY=0
TARGET_TAG=""

for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=1 ;;
        --list)    LIST_ONLY=1 ;;
        --help|-h)
            sed -n '3,27p' "$0"
            exit 0
            ;;
        -*) echo "Unknown option: $arg"; exit 2 ;;
        *) TARGET_TAG="$arg" ;;
    esac
done

# Build the image list. Columns: ID | tag | created | size
list_images() {
    docker images --no-trunc \
        --filter "reference=${IMAGE_NAME}" \
        --format '{{.ID}}|{{.Tag}}|{{.CreatedSince}}|{{.Size}}' \
        | head -5
}

readarray -t IMAGES < <(list_images)

if [[ ${#IMAGES[@]} -eq 0 ]]; then
    echo "No locally-cached ${IMAGE_NAME} images found."
    echo "Rollback needs a previously-built image to swap back to."
    exit 1
fi

echo "Recent ${IMAGE_NAME} images (most recent first):"
printf '  %-12s  %-20s  %-20s  %s\n' "IDX" "TAG" "AGE" "SIZE"
idx=0
for line in "${IMAGES[@]}"; do
    IFS='|' read -r id tag age size <<<"$line"
    short_id="${id#sha256:}"
    short_id="${short_id:0:12}"
    printf '  [%d] %-10s  %-20s  %-20s  %s\n' "$idx" "$short_id" "$tag" "$age" "$size"
    idx=$((idx+1))
done
echo

if [[ "$LIST_ONLY" -eq 1 ]]; then
    exit 0
fi

# Pick the target tag.
if [[ -z "$TARGET_TAG" ]]; then
    read -rp "Enter the image IDX [0..$((${#IMAGES[@]}-1))] or a tag name: " choice
    if [[ "$choice" =~ ^[0-9]+$ ]] && [[ "$choice" -lt "${#IMAGES[@]}" ]]; then
        IFS='|' read -r _ chosen_tag _ _ <<<"${IMAGES[$choice]}"
        TARGET_TAG="$chosen_tag"
    else
        TARGET_TAG="$choice"
    fi
fi

if [[ -z "$TARGET_TAG" || "$TARGET_TAG" == "<none>" ]]; then
    echo "No target tag selected. Aborting."
    exit 1
fi

FULL_IMAGE="${IMAGE_NAME}:${TARGET_TAG}"

# Verify the image exists locally.
if ! docker image inspect "$FULL_IMAGE" >/dev/null 2>&1; then
    echo "Image ${FULL_IMAGE} not found locally."
    echo "Run with --list to see available tags."
    exit 1
fi

echo
echo "=== Rollback plan ==="
echo "  Target image:  $FULL_IMAGE"
echo "  Retag as:      ${IMAGE_NAME}:latest"
echo "  Container:     $CONTAINER_NAME"
echo "  Compose dir:   $COMPOSE_DIR"
echo

if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "(dry run — no changes made)"
    exit 0
fi

read -rp "Proceed? [y/N] " yn
case "$yn" in
    [Yy]*) ;;
    *) echo "Aborted."; exit 1 ;;
esac

# Retag the chosen image as :latest — docker compose references :latest
# implicitly when no image field is set.
echo "Retagging ${FULL_IMAGE} -> ${IMAGE_NAME}:latest ..."
docker tag "$FULL_IMAGE" "${IMAGE_NAME}:latest"

# Recreate the container using the new :latest.
echo "Swapping container ..."
cd "$COMPOSE_DIR"
docker compose up -d --force-recreate --no-build

echo
echo "Waiting 10s for startup ..."
sleep 10

echo
echo "=== Last 30 log lines ==="
docker logs --tail 30 "$CONTAINER_NAME" 2>&1

echo
echo "=== Health check ==="
if curl -fsS --max-time 5 "http://127.0.0.1:8339/health" >/dev/null 2>&1; then
    echo "  /health: OK"
else
    echo "  /health: NOT RESPONDING — rollback target may also be broken, or the service needs longer to warm up."
    echo "  Run: docker logs --tail 200 $CONTAINER_NAME"
fi

echo
echo "Rollback done. If this brought the site back, investigate the failing"
echo "forward build before rolling forward again. If this ALSO broke things,"
echo "pick an even older tag with:  $0 --list"
