#!/usr/bin/env bash
# Fail closed when release metadata is inconsistent or does not advance the base.
#
# Shallow CI checkouts omit origin/master (detached PR heads) and HEAD^
# (depth-1 master pushes). Fetch those refs when missing; still fail closed
# if they cannot be resolved.

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

has_version() {
  git cat-file -e "${1}:VERSION" 2>/dev/null
}

quiet_fetch() {
  GIT_TERMINAL_PROMPT=0 git fetch --no-tags "$@"
}

ensure_origin_master() {
  if has_version origin/master; then
    return 0
  fi
  quiet_fetch --depth=1 origin +refs/heads/master:refs/remotes/origin/master >/dev/null 2>&1 || return 1
  has_version origin/master
}

ensure_parent() {
  if has_version HEAD^; then
    return 0
  fi
  quiet_fetch --deepen=1 >/dev/null 2>&1 || return 1
  has_version HEAD^
}

on_named_master() {
  local branch
  branch="$(git branch --show-current)"
  if [ "$branch" = "master" ]; then
    return 0
  fi
  # A named non-master branch wins over leftover CI env (GITHUB_REF).
  if [ -n "$branch" ]; then
    return 1
  fi
  # Detached CI master push: actions/checkout leaves no current branch.
  if [ "${GITHUB_REF:-}" = "refs/heads/master" ]; then
    return 0
  fi
  return 1
}

version="$(read_version_file VERSION)"
is_four_part_version "$version" || fail "VERSION must use MAJOR.MINOR.PATCH.MICRO, got '$version'"

package_version="$(node -e 'process.stdout.write(require("./package.json").version || "")')"
[ "$package_version" = "$version" ] || fail "package.json version '$package_version' does not match VERSION '$version'"

changelog_version="$(sed -nE 's/^## \[([^]]+)\].*/\1/p' CHANGELOG.md | head -1)"
[ -n "$changelog_version" ] || fail "CHANGELOG.md has no version heading"
[ "$changelog_version" = "$version" ] || fail "top CHANGELOG version '$changelog_version' does not match VERSION '$version'"

if on_named_master; then
  if ensure_origin_master && [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/master)" ]; then
    base_ref="origin/master"
  else
    base_ref="HEAD^"
    ensure_parent || fail "cannot read VERSION from base ref 'HEAD^'"
  fi
else
  ensure_origin_master || fail "cannot read VERSION from base ref 'origin/master'"
  base_ref="origin/master"
fi

base_version="$(git show "${base_ref}:VERSION" | tr -d '\r\n')"
is_four_part_version "$base_version" || fail "base VERSION at '$base_ref' is not four-part: '$base_version'"
version_gt "$version" "$base_version" || fail "VERSION '$version' must be strictly newer than '$base_version' at '$base_ref'"

echo "release-version check: ok ($base_version -> $version; base=$base_ref)"
