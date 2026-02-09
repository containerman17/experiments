#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

IMAGE="containerman17/burner022026"
TAG="${1:-$(git rev-parse --short HEAD)}"

echo "Building ${IMAGE}:${TAG}"
docker build -t "${IMAGE}:${TAG}" -t "${IMAGE}:latest" .

echo "Pushing ${IMAGE}:${TAG}"
docker push "${IMAGE}:${TAG}"
docker push "${IMAGE}:latest"

echo "Done: ${IMAGE}:${TAG}"
