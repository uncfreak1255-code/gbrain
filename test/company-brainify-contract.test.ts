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
const CORRECTION_PIPELINE = readFileSync(
  join(import.meta.dir, '..', 'skills/correction-pipeline/SKILL.md'),
  'utf8',
);
const CONTEXT_AUDIT = readFileSync(
  join(import.meta.dir, '..', 'skills/context-audit/SKILL.md'),
  'utf8',
);
const BLOG_INGEST = readFileSync(
  join(import.meta.dir, '..', 'skills/blog-ingest/SKILL.md'),
  'utf8',
);
const BRAIN_LINK_DISCIPLINE = readFileSync(
  join(import.meta.dir, '..', 'skills/brain-link-discipline/SKILL.md'),
  'utf8',
);
const BULK_INGEST = readFileSync(
  join(import.meta.dir, '..', 'skills/bulk-ingestion/SKILL.md'),
  'utf8',
);
const BULK_MANIFEST = readFileSync(
  join(import.meta.dir, '..', 'skills/bulk-ingestion/MANIFEST-PATTERN.md'),
  'utf8',
);
const RESOLVE_BEFORE_ASKING = readFileSync(
  join(import.meta.dir, '..', 'skills/resolve-before-asking/SKILL.md'),
  'utf8',
);
const FACT_CHECK = readFileSync(join(import.meta.dir, '..', 'skills/fact-check/SKILL.md'), 'utf8');
const CONVERSATION_ARCHIVE = readFileSync(
  join(import.meta.dir, '..', 'skills/conversation-archive/SKILL.md'),
  'utf8',
);
const SKILL_AUTOBENCH = readFileSync(join(import.meta.dir, '..', 'skills/skill-autobench/SKILL.md'), 'utf8');
const DRAFT_IN_VOICE = readFileSync(join(import.meta.dir, '..', 'skills/draft-in-voice/SKILL.md'), 'utf8');
const RESEARCH_COMPENDIUM = readFileSync(
  join(import.meta.dir, '..', 'skills/research-compendium/SKILL.md'),
  'utf8',
);

describe('company-brainify safety contract', () => {
  test('the purge clone consumes an explicit sanitized tree for both paths', () => {
    expect(SKILL).toContain('SANITIZED_TREE="${STAGING:-$(git rev-parse --show-toplevel)}"');
    expect(SKILL).toContain('SANITIZED_CARRIER="$WORK/sanitized-tree"');
    expect(SKILL).toContain('rsync -a "$SANITIZED_TREE/$d/" "$SANITIZED_CARRIER/$d/"');
    expect(SKILL).toContain('git clone <SHARED_REPO_URL> "$WORK/shared"');
    expect(SKILL).toContain('rsync -a --delete "$SANITIZED_CARRIER/$d/" "./$d/"');
    expect(SKILL).toContain('git rm -r --ignore-unmatch -- "$d"');
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
    expect(SKILL).toContain('-type f -print 2>/dev/null | sort -u > /tmp/brainify-scope.txt');
    expect(SKILL).toContain(
      "-type f ! -name '*.md' -print 2>/dev/null | sort -u > /tmp/brainify-nonmarkdown.txt",
    );
    expect(SKILL).toContain('ABORT: non-Markdown files require type-aware review or gated exclusion');
    expect(SKILL).toContain('non-Markdown file remains unreviewed');
    expect(SKILL).not.toContain('>> /tmp/brainify-scope.txt');
    expect(SKILL).toContain('BRAIN="<absolute path to the checkout being sanitized>"');
    expect(SKILL).toContain('gbrain sources current --json');
    expect(SKILL).toContain('BRAIN_SOURCE_ID="<registered source id whose local_path is exactly $BRAIN>"');
    expect(SKILL).toContain('--source-id "$BRAIN_SOURCE_ID"');
    expect(SKILL).toContain('gbrain call --source "$BRAIN_SOURCE_ID" takes_search');
    expect(SKILL.indexOf('cd "$BRAIN"')).toBeLessThan(SKILL.indexOf('gbrain sources current --json'));
  });

  test('manual facts reconciliation pauses and restores autopilot safely', () => {
    const status = SKILL.indexOf('gbrain autopilot --status --json');
    const stop = SKILL.indexOf('gbrain autopilot --uninstall');
    const verifyStopped = SKILL.indexOf('must report inactive/uninstalled');
    const dream = SKILL.indexOf('gbrain dream --source "$SOURCE_ID" --phase extract_facts --json');
    const restart = SKILL.indexOf('gbrain autopilot --install --target "$AUTOPILOT_TARGET" --repo "$AUTOPILOT_REPO"');
    const verifyRunning = SKILL.indexOf('must report active again');

    expect(status).toBeGreaterThanOrEqual(0);
    expect(stop).toBeGreaterThan(status);
    expect(verifyStopped).toBeGreaterThan(stop);
    expect(dream).toBeGreaterThan(verifyStopped);
    expect(restart).toBeGreaterThan(dream);
    expect(verifyRunning).toBeGreaterThan(restart);
    expect(SKILL).toContain('AUTOPILOT_REPO="<exact --repo path from $HOME/.gbrain/autopilot-run.sh>"');
    expect(SKILL).not.toContain('AUTOPILOT_REPO="$(gbrain config get sync.repo_path)"');
    expect(SKILL).not.toContain('gbrain eval dream-quality');
  });

  test('history purge materializes every remote branch before rewriting', () => {
    const fetchRefs = SKILL.indexOf("'+refs/heads/*:refs/remotes/origin/*'");
    const materialize = SKILL.indexOf("git for-each-ref --format='%(refname:strip=3)' refs/remotes/origin/");
    const branchGate = SKILL.indexOf('NONDEFAULT_BRANCH="$(grep -Fxv "$DEFAULT_BRANCH"');
    const applyCarrier = SKILL.indexOf('rsync -a --delete "$SANITIZED_CARRIER/$d/"');
    const filterRepo = SKILL.indexOf('git filter-repo --invert-paths');

    expect(fetchRefs).toBeGreaterThanOrEqual(0);
    expect(materialize).toBeGreaterThan(fetchRefs);
    expect(SKILL).toContain('git branch "$branch" "refs/remotes/origin/$branch"');
    expect(branchGate).toBeGreaterThan(materialize);
    expect(branchGate).toBeLessThan(filterRepo);
    expect(SKILL).toContain('needs its own sanitized carrier');
    expect(applyCarrier).toBeGreaterThan(materialize);
    expect(filterRepo).toBeGreaterThan(applyCarrier);
    expect(SKILL).toContain('BRANCHES_AFTER_FILTER="$WORK/branches-after-filter.txt"');
    expect(SKILL).toContain('git checkout --force "$branch"');
    expect(SKILL).toContain('CLEAN_READD_COMMITS="$WORK/clean-readd-commits.txt"');
    expect(SKILL).toContain('git checkout --force "$DEFAULT_BRANCH"');
    expect(SKILL).toContain('grep -Fxq "$path_commit" "$CLEAN_READD_COMMITS"');
  });

  test('staging retrieval is indexed and explicitly source-scoped', () => {
    const init = SKILL.indexOf('git -C "$STAGING" init -b main');
    const register = SKILL.indexOf('gbrain sources add "$STAGING_SOURCE_ID" --path "$STAGING" --no-federated');
    const sync = SKILL.indexOf('gbrain sync --source "$STAGING_SOURCE_ID"');
    const verifyQuery = SKILL.indexOf('gbrain query "what is alice-example\'s compensation" --source-id "$VERIFY_SOURCE_ID"');
    const verifyTakes = SKILL.indexOf('gbrain call --source "$VERIFY_SOURCE_ID" takes_search');

    expect(init).toBeGreaterThanOrEqual(0);
    expect(register).toBeGreaterThan(init);
    expect(sync).toBeGreaterThan(register);
    expect(verifyQuery).toBeGreaterThan(sync);
    expect(verifyTakes).toBeGreaterThan(verifyQuery);
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
    expect(SKILL).toContain('BACKUP_PATH_FILE="$HOME/.gbrain/backups/brainify-backup-path.txt"');
    expect(SKILL).toContain('BACKUP_PATH="$(<"$HOME/.gbrain/backups/brainify-backup-path.txt")"; rm -rf -- "$BACKUP_PATH"');
  });

  test('CI merge scan fetches history needed by merge-base', () => {
    const workflow = readFileSync(join(import.meta.dir, '..', '.github/workflows/test.yml'), 'utf8');
    expect(workflow).toContain('git fetch origin master');
    expect(workflow).not.toContain('git fetch origin master --depth=1');
  });

  test('new skill workflows use supported retrieval and deletion gates', () => {
    expect(CORRECTION_PIPELINE).toContain('gbrain query "<relevant terms>" --limit 10');
    expect(CORRECTION_PIPELINE).toContain('gbrain query "<wrong claim terms>" --limit 20');
    expect(CORRECTION_PIPELINE).not.toContain('gbrain search "');

    expect(CONTEXT_AUDIT).toContain('gbrain query "context audit report" --limit 10');
    expect(CONTEXT_AUDIT).toContain('gbrain get <slug>');
    expect(CONTEXT_AUDIT).not.toContain('gbrain recall "context audit report"');

    expect(BLOG_INGEST).toContain('../data-loss-gate/SKILL.md');
    expect(BLOG_INGEST).toContain('exact slugs, count, size, location, reason');
    expect(BLOG_INGEST).toContain('require typed `yes`/`do it`');
    expect(BLOG_INGEST).toContain('gbrain delete <slug>');
    expect(BLOG_INGEST).toContain('gbrain restore <slug>');
    expect(BLOG_INGEST).toContain('git rm -- "$SOURCE_PATH"');
    expect(BLOG_INGEST).toContain('gbrain sync --no-pull --no-embed');

    expect(BRAIN_LINK_DISCIPLINE).toContain('ENCODED_BRANCH="$(printf \'%s\' "$BRANCH" | jq -sRr @uri)"');
    expect(BRAIN_LINK_DISCIPLINE).toContain('contents/<repo-relative-path>?ref=$ENCODED_BRANCH');

    expect(BULK_INGEST).toContain('"cwd": "/absolute/path/to/brain-repo"');
    expect(BULK_MANIFEST).toContain('"cwd": "/absolute/path/to/brain-repo"');
    expect(BULK_MANIFEST).not.toContain('"cmd": "cd <brain-repo> &&');

    expect(RESOLVE_BEFORE_ASKING).toContain('gbrain query "{entity}" --limit 5');
    expect(RESOLVE_BEFORE_ASKING).toContain('gbrain mounts list --json');
    expect(RESOLVE_BEFORE_ASKING).toContain('GBRAIN_BRAIN_ID="$BRAIN_ID" gbrain query');
    expect(RESOLVE_BEFORE_ASKING).toContain("for SOURCE_ID in $(printf '%s' \"$SOURCES_JSON\" | jq -r '.sources[].id')");
    expect(RESOLVE_BEFORE_ASKING).toContain('--source "$SOURCE_ID"');
    expect(RESOLVE_BEFORE_ASKING).toContain('GBRAIN_BRAIN_ID="$BRAIN_ID" gbrain sources list --json');
    expect(RESOLVE_BEFORE_ASKING).not.toContain('gbrain search "{entity}"');
    expect(FACT_CHECK).not.toContain('gbrain search "<entity>"');
    expect(CONVERSATION_ARCHIVE).not.toContain('gbrain search "');
    expect(SKILL_AUTOBENCH).not.toContain('gbrain search "');
    expect(DRAFT_IN_VOICE).not.toContain('gbrain search "');
    expect(RESEARCH_COMPENDIUM).not.toContain('gbrain search <terms>');
  });
});
