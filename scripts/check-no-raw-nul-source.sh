#!/usr/bin/env bash
# CI guard: source and test text files must not contain literal NUL bytes.
#
# A raw NUL inside a .ts file makes otherwise normal source look binary to git,
# ripgrep, code indexing, and review tools. Use escaped string syntax (`\0`)
# when runtime code needs a NUL separator.

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

files=$(
  git ls-files \
    'src/**/*.ts' 'src/**/*.js' 'src/**/*.json' 'src/**/*.sql' 'src/**/*.md' \
    'test/**/*.ts' 'test/**/*.js' 'test/**/*.json' 'test/**/*.md' \
  2>/dev/null | sort -u
)

hits=""
total=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  [ -f "$f" ] || continue
  total=$((total + 1))
  found=$(
    perl -ne 'if (index($_, chr(0)) >= 0) { print "$ARGV:$.: raw NUL byte\n" }' "$f"
  )
  if [ -n "$found" ]; then
    hits="${hits}${found}"$'\n'
  fi
done <<< "$files"

if [ -n "$hits" ]; then
  echo "ERROR: raw NUL bytes found in source/test text files:" >&2
  printf '%s' "$hits" >&2
  echo >&2
  echo "Fix: replace literal NUL bytes with escaped source syntax, usually \\0." >&2
  exit 1
fi

echo "raw-NUL source check: ok ($total files)"
