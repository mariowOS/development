#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22.12 or newer is required." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required. Install or repair Node.js, then try again." >&2
  exit 1
fi

if [ ! -d node_modules/electron ]; then
  echo "Dependencies are not installed. Run npm install first." >&2
  exit 1
fi

echo "booting mariowOS gui..."
exec npm run start-os
