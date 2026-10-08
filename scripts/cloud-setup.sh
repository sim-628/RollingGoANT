#!/usr/bin/env bash
set -euo pipefail
cd /workspace/RollingGoANT
npm ci --cache /workspace/.cache/rollinggo-ant/npm --no-fund --no-audit
npm run build
npm test
