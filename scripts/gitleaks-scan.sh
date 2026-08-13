#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage:
  scripts/gitleaks-scan.sh --scope merge --base <ref>
  scripts/gitleaks-scan.sh --scope workspace
USAGE
}

SCOPE=""
BASE=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --scope)
      if [ "$#" -lt 2 ]; then
        usage
        exit 2
      fi
      SCOPE="$2"
      shift 2
      ;;
    --base)
      if [ "$#" -lt 2 ]; then
        usage
        exit 2
      fi
      BASE="$2"
      shift 2
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "gitleaks-scan: gitleaks is not installed" >&2
  exit 2
fi

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$ROOT" ]; then
  echo "gitleaks-scan: not a git repository" >&2
  exit 2
fi
cd "$ROOT"

case "$SCOPE" in
  merge)
    if [ -z "$BASE" ]; then
      usage
      exit 2
    fi
    if ! git rev-parse --verify --quiet "$BASE^{commit}" >/dev/null; then
      echo "gitleaks-scan: invalid base ref: $BASE" >&2
      exit 2
    fi
    MERGE_BASE="$(git merge-base "$BASE" HEAD)"
    exec gitleaks git . --config .gitleaks.toml --redact --no-banner --log-opts "$MERGE_BASE..HEAD"
    ;;
  workspace)
    if [ -n "$BASE" ]; then
      usage
      exit 2
    fi
    exec gitleaks dir . --config .gitleaks.toml --redact --no-banner
    ;;
  *)
    usage
    exit 2
    ;;
esac
