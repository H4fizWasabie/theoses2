#!/usr/bin/env bash
#
# Build a deployable bundle of the theoses2 long-running services
# (dashboard + telegram) for the VPS self-update pipeline.
#
# Unlike build-binaries.sh (which compiles the standalone `theoses` CLI with
# bun), the dashboard and telegram packages are plain tsc output that resolve
# their dependencies (including the theoses-coding-agent workspace package)
# through node_modules at runtime, so this produces a full pruned,
# production-only copy of the workspace rather than a single executable.
#
# Assumes it is run from a checkout where `npm ci` (with devDependencies) and
# `npm run build` have already completed for the workspace packages, e.g.
# chained after build-binaries.sh in the release workflow.
#
# Usage:
#   ./scripts/build-services.sh --out <dir>
#
# Output:
#   <dir>/theoses-services-linux-x64.tar.gz

set -euo pipefail

cd "$(dirname "$0")/.."

OUTPUT_DIR=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --out)
            OUTPUT_DIR="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

if [[ -z "$OUTPUT_DIR" ]]; then
    echo "--out <dir> is required"
    exit 1
fi
if [[ "$OUTPUT_DIR" != /* ]]; then
    OUTPUT_DIR="$(pwd)/$OUTPUT_DIR"
fi
mkdir -p "$OUTPUT_DIR"

# telegram is not part of the root `npm run build` chain, so build it explicitly.
echo "==> Building telegram package..."
(cd packages/telegram && npm run build)

echo "==> Pruning to production dependencies..."
npm ci --omit=dev --ignore-scripts

echo "==> Assembling services bundle..."
stage_root="$(mktemp -d)"
trap 'rm -rf "${stage_root}"' EXIT
bundle_root="${stage_root}/theoses-services"
mkdir -p "${bundle_root}"

cp package.json package-lock.json "${bundle_root}/"
cp -r node_modules "${bundle_root}/node_modules"

runtime_packages=(
    agent
    ai
    client
    coding-agent
    dashboard
    protocol
    server
    telegram
    telemetry
    tui
)

for pkg in "${runtime_packages[@]}"; do
    mkdir -p "${bundle_root}/packages/${pkg}"
    cp "packages/${pkg}/package.json" "${bundle_root}/packages/${pkg}/"
    if [[ -d "packages/${pkg}/dist" ]]; then
        cp -r "packages/${pkg}/dist" "${bundle_root}/packages/${pkg}/dist"
    fi
done

# tui ships prebuilt native addons outside dist/.
if [[ -d packages/tui/native ]]; then
    cp -r packages/tui/native "${bundle_root}/packages/tui/native"
fi

echo "==> Creating theoses-services-linux-x64.tar.gz..."
(cd "${stage_root}" && tar -czf "${OUTPUT_DIR}/theoses-services-linux-x64.tar.gz" theoses-services)

echo "==> Done: ${OUTPUT_DIR}/theoses-services-linux-x64.tar.gz"
