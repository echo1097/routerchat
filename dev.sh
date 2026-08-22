#!/bin/sh

set -eu

projectDir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
pythonBin="$projectDir/.venv/bin/python"
secretFile="${ROUTERCHAT_DEV_SECRET_FILE:-$HOME/.routerchat/dev-secret}"
frontendUrl="http://127.0.0.1:5173"
backendUrl="http://127.0.0.1:8000"
frontendPid=""
backendPid=""

cleanup() {
    exitCode=$?

    trap - EXIT INT TERM HUP

    if [ -n "$backendPid" ]; then
        kill "$backendPid" 2>/dev/null || true
    fi

    if [ -n "$frontendPid" ]; then
        kill "$frontendPid" 2>/dev/null || true
    fi

    if [ -n "$backendPid" ]; then
        wait "$backendPid" 2>/dev/null || true
    fi

    if [ -n "$frontendPid" ]; then
        wait "$frontendPid" 2>/dev/null || true
    fi

    exit "$exitCode"
}

waitForUrl() {
    targetUrl=$1
    processPid=$2
    processName=$3
    attempt=0

    while [ "$attempt" -lt 150 ]; do
        if curl --silent --output /dev/null --max-time 1 "$targetUrl"; then
            return 0
        fi

        if ! kill -0 "$processPid" 2>/dev/null; then
            printf '%s stopped before it was ready.\n' "$processName" >&2
            return 1
        fi

        attempt=$((attempt + 1))
        sleep 0.1
    done

    printf 'Timed out waiting for %s.\n' "$processName" >&2
    return 1
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

cd "$projectDir"

if [ ! -x "$pythonBin" ]; then
    printf 'RouterChat virtual environment is missing. Expected %s\n' "$pythonBin" >&2
    exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
    printf 'npm is required to launch the RouterChat frontend.\n' >&2
    exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
    printf 'curl is required to check when RouterChat is ready.\n' >&2
    exit 1
fi

if curl --silent --output /dev/null --max-time 1 "$frontendUrl"; then
    printf 'Port 5173 is already in use. Stop the existing frontend first.\n' >&2
    exit 1
fi

if curl --silent --output /dev/null --max-time 1 "$backendUrl/api/health"; then
    printf 'Port 8000 is already in use. Stop the existing backend first.\n' >&2
    exit 1
fi

if [ -e "$secretFile" ] || [ -L "$secretFile" ]; then
    printf 'Removing the stale developer credential.\n'
    rm -f -- "$secretFile"
fi

printf 'Starting the RouterChat frontend at %s\n' "$frontendUrl"
npm run dev &
frontendPid=$!
waitForUrl "$frontendUrl" "$frontendPid" "RouterChat frontend"

printf 'Starting the RouterChat backend at %s\n' "$backendUrl"
"$pythonBin" -m backend.local_access serve \
    --secret-file "$secretFile" \
    --base-url "$backendUrl" \
    --trusted-origin "$frontendUrl" &
backendPid=$!
waitForUrl "$backendUrl/api/health" "$backendPid" "RouterChat backend"

printf 'Authorizing the browser and opening RouterChat.\n'
"$pythonBin" -m backend.local_access open-browser \
    --secret-file "$secretFile" \
    --base-url "$frontendUrl"

printf '\nRouterChat is running. Press Ctrl+C to stop it.\n\n'

while kill -0 "$frontendPid" 2>/dev/null && kill -0 "$backendPid" 2>/dev/null; do
    sleep 1
done

printf 'A RouterChat developer process stopped unexpectedly.\n' >&2
exit 1
