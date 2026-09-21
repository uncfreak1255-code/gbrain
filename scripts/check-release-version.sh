#!/usr/bin/env bash
# Fail closed when release metadata is inconsistent or does not advance the base.

set -euo pipefail

ROOT="${GBRAIN_RELEASE_ROOT:-$(git rev-parse --show-toplevel)}"
cd "$ROOT"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

read_version_file() {
  local path="$1"
  [ -f "$path" ] || fail "missing $path"
  tr -d '\r\n' < "$path"
}

is_four_part_version() {
  [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

version_gt() {
  local current="$1" base="$2"
  local -a current_parts base_parts
  IFS=. read -r -a current_parts <<< "$current"
  IFS=. read -r -a base_parts <<< "$base"
  local i current_part base_part
  for i in 0 1 2 3; do
    current_part=$((10#${current_parts[$i]}))
    base_part=$((10#${base_parts[$i]}))
    if (( current_part > base_part )); then return 0; fi
    if (( current_part < base_part )); then return 1; fi
  done
  return 1
}

version="$(read_version_file VERSION)"
is_four_part_version "$version" || fail "VERSION must use MAJOR.MINOR.PATCH.MICRO, got '$version'"

package_version="$(node -e 'process.stdout.write(require("./package.json").version || "")')"
[ "$package_version" = "$version" ] || fail "package.json version '$package_version' does not match VERSION '$version'"

changelog_version="$(sed -nE 's/^## \[([^]]+)\].*/\1/p' CHANGELOG.md | head -1)"
[ -n "$changelog_version" ] || fail "CHANGELOG.md has no version heading"
[ "$changelog_version" = "$version" ] || fail "top CHANGELOG version '$changelog_version' does not match VERSION '$version'"

if [ "$(git branch --show-current)" = "master" ]; then
  base_ref="HEAD^"
else
  base_ref="origin/master"
fi

git cat-file -e "${base_ref}:VERSION" 2>/dev/null || fail "cannot read VERSION from base ref '$base_ref'"
base_version="$(git show "${base_ref}:VERSION" | tr -d '\r\n')"
is_four_part_version "$base_version" || fail "base VERSION at '$base_ref' is not four-part: '$base_version'"
version_gt "$version" "$base_version" || fail "VERSION '$version' must be strictly newer than '$base_version' at '$base_ref'"

echo "release-version check: ok ($base_version -> $version; base=$base_ref)"
