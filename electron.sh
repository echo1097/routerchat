#!/bin/sh

set -eu

projectDir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
pythonBin="$projectDir/.venv/bin/python"
electronBin="$projectDir/node_modules/.bin/electron"

cd "$projectDir"

if [ ! -x "$pythonBin" ]; then
    printf 'RouterChat virtual environment is missing. Expected %s\n' "$pythonBin" >&2
    exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
    printf 'npm is required to launch the RouterChat desktop app.\n' >&2
    exit 1
fi

if [ ! -x "$electronBin" ]; then
    printf 'Electron is not installed yet. Installing the project packages.\n'
    npm install
fi

printf 'Building the frontend and opening the RouterChat desktop app.\n'
exec npm run electron
