import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SKILL = readFileSync(
  join(import.meta.dir, '..', 'skills/company-brainify/SKILL.md'),
  'utf8',
);

describe('company-brainify safety contract', () => {
  test('the purge clone consumes an explicit sanitized tree for both paths', () => {
    expect(SKILL).toContain('SANITIZED_TREE="${STAGING:-$(git rev-parse --show-toplevel)}"');
    expect(SKILL).toContain('SANITIZED_CARRIER="$WORK/sanitized-tree"');
    expect(SKILL).toContain('rsync -a "$SANITIZED_TREE/$d/" "$SANITIZED_CARRIER/$d/"');
    expect(SKILL).toContain('git clone <SHARED_REPO_URL> "$WORK/shared"');
    expect(SKILL).toContain('rsync -a "$SANITIZED_CARRIER/$d/" "./$d/"');
    expect(SKILL.indexOf('rsync -a "$SANITIZED_TREE/$d/"')).toBeLessThan(
      SKILL.indexOf('git clone <SHARED_REPO_URL> "$WORK/shared"'),
    );
    expect(SKILL).not.toContain(
      '[ -d "$STAGING/$d" ] && rsync -a "$STAGING/$d/" "./$d/"',
    );
  });

  test('in-place edits reconcile and verify the derived facts index', () => {
    expect(SKILL).toContain('gbrain sync --source "$SOURCE_ID"');
    expect(SKILL).toContain(
      'gbrain dream --source "$SOURCE_ID" --phase extract_facts --json',
    );
    expect(SKILL).toContain(
      'gbrain recall --source "$SOURCE_ID" --grep "$REMOVED_FACT_TEXT" --include-expired --json',
    );
    expect(SKILL).toContain('That readback must return zero rows.');
  });
});
