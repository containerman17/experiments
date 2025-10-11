#!/bin/bash
set -e

RESULTS_DIR="./test_results"
mkdir -p "$RESULTS_DIR"

declare -a TESTS=(
    "rhel8:v1.13.2:avalanche-rhel8-v1.13.2"
    "rhel8:v1.13.3:avalanche-rhel8-v1.13.3"
    "rhel8-fixed:v1.13.3:avalanche-rhel8-v1.13.3-fixed"
    "rhel9:v1.13.2:avalanche-rhel9-v1.13.2"
    "rhel9:v1.13.3:avalanche-rhel9-v1.13.3"
)

build_test() {
    local DOCKERFILE=$1
    local VERSION=$2
    local IMAGE_NAME=$3
    local TEST_NAME="${DOCKERFILE}_${VERSION}"
    
    echo "Building ${TEST_NAME}..."
    
    docker build \
        --build-arg AVALANCHE_VERSION="${VERSION}" \
        -t "${IMAGE_NAME}" \
        -f "Dockerfile.${DOCKERFILE}" \
        . 2>&1 | tee "$RESULTS_DIR/${TEST_NAME}_docker_build.log"
    
    CONTAINER_ID=$(docker create "${IMAGE_NAME}")
    docker cp "${CONTAINER_ID}:/build/build.log" "$RESULTS_DIR/${TEST_NAME}_avalanche_build.log" 2>/dev/null || true
    docker cp "${CONTAINER_ID}:/build/build.status" "$RESULTS_DIR/${TEST_NAME}_status.txt" 2>/dev/null || true
    docker rm "${CONTAINER_ID}" > /dev/null
    
    if [ -f "$RESULTS_DIR/${TEST_NAME}_status.txt" ]; then
        STATUS=$(cat "$RESULTS_DIR/${TEST_NAME}_status.txt")
        echo "${TEST_NAME}: ${STATUS}"
    fi
}

for test in "${TESTS[@]}"; do
    IFS=':' read -r dockerfile version image_name <<< "$test"
    build_test "$dockerfile" "$version" "$image_name"
done

echo ""
echo "Results:"
grep -h "BUILD_" "$RESULTS_DIR"/*.txt | sort | uniq -c
echo ""
echo "Details in $RESULTS_DIR/"