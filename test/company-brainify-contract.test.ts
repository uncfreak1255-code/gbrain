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

  test('manual facts reconciliation pauses and restores every installed autopilot schedule', () => {
    const status = SKILL.indexOf('gbrain autopilot --status --json');
    const installedRecord = SKILL.indexOf('AUTOPILOT_WAS_INSTALLED="<true-or-false from schedule.installed>"');
    const activeRecord = SKILL.indexOf('AUTOPILOT_WAS_RUNNING="<true-false-or-null from active>"');
    const pause = SKILL.indexOf('if [ "$AUTOPILOT_WAS_INSTALLED" = "true" ]; then');
    const stop = SKILL.indexOf('gbrain autopilot --uninstall');
    const verifyStopped = SKILL.indexOf('must report inactive/uninstalled');
    const recordDaemon = SKILL.indexOf('Record the daemon PID from the lock before uninstall');
    const stopDaemon = SKILL.indexOf('kill -TERM "$AUTOPILOT_PID"');
    const verifyOwner = SKILL.indexOf('autopilot lock PID does not match saved repository — ABORT');
    const verifyNoLock = SKILL.indexOf('autopilot lock still held — ABORT');
    const dream = SKILL.indexOf('gbrain dream --source "$SOURCE_ID" --phase extract_facts --json');
    const restore = SKILL.lastIndexOf('if [ "$AUTOPILOT_WAS_INSTALLED" = "true" ]; then');
    const restart = SKILL.indexOf('gbrain autopilot --install --target "$AUTOPILOT_TARGET" --repo "$AUTOPILOT_REPO"');
    const verifyRunning = SKILL.indexOf('must also report active=true');

    expect(status).toBeGreaterThanOrEqual(0);
    expect(installedRecord).toBeGreaterThan(status);
    expect(activeRecord).toBeGreaterThan(installedRecord);
    expect(pause).toBeGreaterThan(activeRecord);
    expect(recordDaemon).toBeGreaterThan(activeRecord);
    expect(stop).toBeGreaterThan(recordDaemon);
    expect(verifyStopped).toBeGreaterThan(stop);
    expect(stopDaemon).toBeGreaterThan(verifyStopped);
    expect(verifyOwner).toBeGreaterThan(stopDaemon);
    expect(verifyNoLock).toBeGreaterThan(verifyOwner);
    expect(dream).toBeGreaterThan(verifyNoLock);
    expect(restore).toBeGreaterThan(dream);
    expect(restart).toBeGreaterThan(restore);
    expect(verifyRunning).toBeGreaterThan(restart);
    expect(SKILL).toContain('AUTOPILOT_REPO="<exact --repo path from $HOME/.gbrain/autopilot-run.sh>"');
    expect(SKILL).toContain('GBRAIN_HOME_RAW="${GBRAIN_HOME:-$HOME}"');
    expect(SKILL).toContain('AUTOPILOT_HOME="$(printf \'%s\' "$GBRAIN_HOME_RAW" | sed -e \'s/^[[:space:]]*//\' -e \'s/[[:space:]]*$//\')/.gbrain"');
    expect(SKILL).toContain('must report installed with original target/repo');
    expect(SKILL).toContain('must also report active=true');
    expect(SKILL).toContain('kill -TERM "$AUTOPILOT_PID"');
    expect(SKILL).toContain('for attempt in $(seq 1 45); do');
    expect(SKILL).toContain('SIGTERM handler can drain workers for up to 35 seconds');
    expect(SKILL).toContain('AUTOPILOT_PID="$(cat "$AUTOPILOT_LOCK" 2>/dev/null || true)"');
    expect(SKILL).toContain('AUTOPILOT_LOCK="$AUTOPILOT_HOME/autopilot.lock"');
    expect(SKILL).toContain('*" --repo $AUTOPILOT_REPO"|*" --repo $AUTOPILOT_REPO "*)');
    expect(SKILL).not.toContain('ps -ww -Ao pid=,command=');
    expect(SKILL).not.toContain('AUTOPILOT_REPO="$(gbrain config get sync.repo_path)"');
    expect(SKILL).not.toContain('gbrain autopilot --status --json  # must report active again');
    expect(SKILL).not.toContain('gbrain eval dream-quality');
  });

  test('history purge materializes every remote branch before rewriting', () => {
    const fetchRefs = SKILL.indexOf("'+refs/heads/*:refs/remotes/origin/*'");
    const remoteRefsBefore = SKILL.indexOf('REMOTE_REFS_BEFORE="$WORK/remote-refs-before.txt"');
    const materialize = SKILL.indexOf("git for-each-ref --format='%(refname:strip=3)' refs/remotes/origin/");
    const branchGate = SKILL.indexOf('NONDEFAULT_BRANCH="$(grep -Fxv "$DEFAULT_BRANCH"');
    const applyCarrier = SKILL.indexOf('rsync -a --delete "$SANITIZED_CARRIER/$d/"');
    const filterRepo = SKILL.indexOf('git filter-repo --invert-paths');

    expect(fetchRefs).toBeGreaterThanOrEqual(0);
    expect(remoteRefsBefore).toBeGreaterThan(fetchRefs);
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

  test('history purge updates only snapshotted refs atomically', () => {
    expect(SKILL).toContain('PUSH_LEASES=()');
    expect(SKILL).toContain('PUSH_REFS=()');
    expect(SKILL).toContain('PUSH_LEASES+=( "--force-with-lease=$ref:$old_sha" )');
    expect(SKILL).toContain('PUSH_REFS+=( "$ref:$ref" )');
    expect(SKILL).toContain('PUSH_REFS+=( ":$ref" )');
    expect(SKILL).toContain('git push --atomic "${PUSH_LEASES[@]}" origin "${PUSH_REFS[@]}"');
    expect(SKILL).not.toContain('git push --prune');
    expect(SKILL).not.toContain('git push --force-with-lease --prune origin');
    expect(SKILL).toContain('git ls-remote --refs origin');
    expect(SKILL).toContain('REMOTE_REFS_BEFORE_PUSH="$WORK/remote-refs-before-push.txt"');
    expect(SKILL).toContain('diff -u "$REMOTE_REFS_BEFORE" "$REMOTE_REFS_BEFORE_PUSH"');
    expect(SKILL).toContain('remote refs changed during purge — ABORT, do not force-push');
    expect(SKILL).toContain('REMOTE_REFS_AFTER="$WORK/remote-refs-after.txt"');
    expect(SKILL).toContain('path_commits="$(git log --all --format=%H -- "$d" | sort -u)"');
    expect(SKILL).toContain('BACKUP_PATH_FILE="${BACKUP_PATH%.git}.path"');
    expect(SKILL).toContain('BACKUP_PATH_FILE="${BACKUP_PATH_FILE:?set the exact per-run pointer path from Step 1\'s confirmation card}"');
    expect(SKILL).not.toContain('BACKUP_PATH_FILE="$HOME/.gbrain/backups/brainify-backup-path.txt"');
    expect(SKILL).toContain('Per-run cleanup pointer: $BACKUP_PATH_FILE');
    expect(SKILL).toContain('do not use a shared/fixed pointer');
    expect(SKILL).toContain('rm -f -- "$BACKUP_PATH_FILE"');
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
    expect(BLOG_INGEST).toContain('git ls-files --error-unmatch -- "$SOURCE_PATH"');
    expect(BLOG_INGEST).toContain('git diff --cached --name-only -- "$SOURCE_PATH"');
    expect(BLOG_INGEST).toContain('git commit -m "Remove gated husk source"');
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

  test('new skill workflows do not publish from unattended instructions', () => {
    expect(SKILL).not.toContain('git push -u origin main');
    expect(SKILL).toContain('READY TO PUBLISH: use the normal ship path');
    expect(SKILL).toContain('current-turn publication approval');
    expect(BULK_MANIFEST).not.toContain('&& git push');
    expect(BULK_MANIFEST).toContain('Heartbeat jobs are commit-only.');
    expect(BULK_MANIFEST).toContain('current operator approval');
    expect(BULK_MANIFEST).not.toContain('direct per-item JSON updates with a');
    expect(BULK_MANIFEST).toContain('one explicitly named coordinator');
  });

  test('public fact-check examples stay generic', () => {
    expect(FACT_CHECK).toContain('alice-example');
    expect(FACT_CHECK).toContain('charlie-example');
    expect(FACT_CHECK).toContain('## Lessons from Verification Failures');
    expect(FACT_CHECK).not.toContain('## Lessons from Famous Failures');
    expect(FACT_CHECK).toContain('The trust-failure pattern');
    expect(FACT_CHECK).toContain('The uneven-standard pattern');
    expect(FACT_CHECK).toContain('The too-neat-story pattern');
  });

  test('company-brainify guards use canonical paths and full-scope verification', () => {
    expect(SKILL).toContain('PERSONAL_REAL="$(cd "$PERSONAL" && pwd -P)"');
    expect(SKILL).toContain('SANITIZED_TREE_REAL="$(cd "$SANITIZED_TREE" && pwd -P)"');
    expect(SKILL).toContain('[ "$SANITIZED_TREE_REAL" != "$PERSONAL_REAL" ]');
    expect(SKILL).toContain('SHARED_REAL="$(cd "$(git rev-parse --show-toplevel)" && pwd -P)"');
    expect(SKILL).toContain('[ "$SHARED_REAL" != "$PERSONAL_REAL" ]');
    expect(SKILL).toContain('TARGET_REAL="$(cd "$(git rev-parse --show-toplevel)" && pwd -P)"');
    expect(SKILL).toContain('[ "$TARGET_REAL" != "$PERSONAL_REAL" ]');
    expect(SKILL).not.toContain('[ "$SANITIZED_TREE" != "$PERSONAL" ]');
    expect(SKILL).not.toContain('[ "$(git rev-parse --show-toplevel)" != "$PERSONAL" ]');
    expect(SKILL).toContain("grep -rn -E '^[a-z_]*(score|rating|skill)[a-z_]*: *[0-9]' people/ meetings/ daily/ companies/ projects/ analysis/");
    expect(SKILL).toContain("grep -rn -E '\\+1[0-9]{10}|\\([0-9]{3}\\) [0-9]{3}-[0-9]{4}' people/ meetings/ daily/ companies/ projects/ analysis/");
  });
});
