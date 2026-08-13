import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SKILL = readFileSync(
  join(import.meta.dir, '..', 'skills/company-brainify/SKILL.md'),
  'utf8',
);
const INGEST_GATE = readFileSync(
  join(import.meta.dir, '..', 'skills/brain-ingest-gate/SKILL.md'),
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

  test('all intended shareable pages enter scope before sensitivity triage', () => {
    const completeScope = SKILL.indexOf(
      "find people/ meetings/ daily/ companies/ projects/ analysis/ \\",
    );
    const sensitivityTriage = SKILL.indexOf('Sensitivity hits are a separate triage list');

    expect(completeScope).toBeGreaterThanOrEqual(0);
    expect(sensitivityTriage).toBeGreaterThan(completeScope);
    expect(SKILL).toContain("-type f -name '*.md' -print 2>/dev/null | sort -u > /tmp/brainify-scope.txt");
    expect(SKILL).not.toContain('>> /tmp/brainify-scope.txt');
  });

  test('brain-ingest gate uses the supported retrieval command', () => {
    expect(INGEST_GATE).toContain('gbrain query "<name>" --limit 10');
    expect(INGEST_GATE).toContain('gbrain query "<core claim>" --limit 5');
    expect(INGEST_GATE).toContain('gbrain query "<core claim>" --limit 3');
    expect(INGEST_GATE).not.toContain('gbrain search "');
  });

  test('history purge updates, prunes, and verifies every branch and tag ref', () => {
    expect(SKILL).toContain('git push --force --prune origin');
    expect(SKILL).toContain("'refs/heads/*:refs/heads/*'");
    expect(SKILL).toContain("'refs/tags/*:refs/tags/*'");
    expect(SKILL).toContain('git ls-remote --refs origin');
    expect(SKILL).toContain('REMOTE_REFS_AFTER="$WORK/remote-refs-after.txt"');
    expect(SKILL).toContain('path_commits="$(git log --all --format=%H -- "$d" | sort -u)"');
  });
});
