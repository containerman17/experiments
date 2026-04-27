#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/.."

LOG="log/$(date +%Y-%m-%d).md"
[ -f "$LOG" ] || echo "# $(date +%Y-%m-%d)" > "$LOG"

echo "=== plan.md ==="
if [ -f plan.md ]; then cat plan.md; else echo "(empty — write the first plan)"; fi
echo
echo "=== current.md ==="
if [ -f current.md ]; then cat current.md; else echo "(no active task)"; fi
echo
echo "=== log/ ==="
ls log/ 2>/dev/null || echo "(empty)"
echo
echo "=== wiki/ ==="
ls wiki/ 2>/dev/null || echo "(empty)"
echo
echo "=== ideas/ ==="
ls ideas/ 2>/dev/null || echo "(empty)"
echo
echo "=== recent decisions ==="
if [ -f decisions.md ]; then grep "^## " decisions.md | tail -5; else echo "(none yet)"; fi
