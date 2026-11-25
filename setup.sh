#!/usr/bin/env bash
#
# Oxyide Forge — one-command local development setup.
#
# Usage:
#   bash setup.sh                  Full setup + start dev server
#   bash setup.sh --check          Validate prerequisites only (no changes)
#   bash setup.sh --skip-migrations  Skip prisma migrate deploy
#   bash setup.sh --port 4000      Override PORT (default 3000)
#
# This script delegates to the single cross-platform implementation in
# scripts/setup.mjs (exposed as `npm run setup`), so Unix and Windows
# onboarding can never silently diverge. All behavior documented below lives
# in that file:
#
# The workflow is idempotent: re-running it never overwrites an existing
# .env, never resets the database, and never leaves unmanaged processes
# behind. It prints secrets never, and fails with a non-zero exit on any
# error. Windows customers without Bash use `npm run setup` directly.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

exec node "$SCRIPT_DIR/scripts/setup.mjs" "$@"
