#!/usr/bin/env bash
# CI guard (#1647 / #171): every trigger function in the canonical schema base
# files MUST pin `SET search_path`. Without it, an unqualified reference inside
# the function body resolves through the caller's search_path, so a same-named
# object in a user-controlled schema could shadow it. Migration v121 ALTERs
# existing brains; this guard keeps fresh-install function definitions correct
# so a NEW trigger function can't reintroduce the gap. Mirrors the
# check-jsonb-pattern.sh guard philosophy (a written rule caused the disease;
# a guard cures it).
#
# Scope: schema base files only (src/schema.sql, src/core/pglite-schema.ts).
# Historical migration bodies in migrate.ts are append-only and not rescanned;
# the runtime doctor probe (pg_proc.proconfig) covers the live post-migration
# state on real brains.
#
# Usage: scripts/check-search-path.sh
# Exit:  0 when all trigger functions pin search_path, 1 otherwise.

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

FILES="src/schema.sql src/core/pglite-schema.ts src/core/schema-embedded.ts"

# Trigger headers may span several lines. Read each file as one record and
# inspect the complete header through its AS delimiter so multiline functions
# cannot evade the guard.
BAD="$(perl -0777 -ne '
  while (/CREATE OR REPLACE FUNCTION\s+([a-z_]+)\(\)\s+RETURNS\s+trigger(.*?)(?=\bAS\s+\\?\$[A-Za-z_]*\\?\$)/gsi) {
    my ($name, $options) = ($1, $2);
    next if $options =~ /SET\s+search_path\s*=/i;
    my $prefix = substr($_, 0, $-[0]);
    my $line = 1 + ($prefix =~ tr/\n/\n/);
    print "$ARGV:$line:$name\n";
  }
' $FILES)"

if [ -n "$BAD" ]; then
  echo "ERROR: trigger function(s) missing SET search_path in schema base files:"
  echo "$BAD"
  echo
  echo "Add 'SET search_path = pg_catalog, public, pg_temp' to the function header, e.g.:"
  echo "  CREATE OR REPLACE FUNCTION foo() RETURNS trigger SET search_path = pg_catalog, public, pg_temp AS \$\$"
  echo "See #1647 / #171."
  exit 1
fi

echo "OK: all trigger functions in schema base files pin search_path"
