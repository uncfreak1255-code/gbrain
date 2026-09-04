import { describe, expect, test } from 'bun:test';
import {
  decodeLearningLoopKnowledge,
  encodeLearningLoopKnowledge,
  learningLoopKnowledgeHash,
  makeLearningClaimIdentity,
  makeLearningManagedRow,
  parseLearningLoopFence,
  renderLearningLoopFence,
  validateLearningManagedRows,
} from '../src/core/learning-loop-knowledge.ts';

const value = { brain_id: 'brain', source_id: 'source', canonical_slug: 'people/alice', managed_rows: {}, blocked_identities: [], correction_lineages: {}, reversal_attempts: {}, immutable_commit_markers: [], pending_delivery: null } as const;

describe('Learning Loop metadata codec', () => {
  test('round trips canonical bytes and fence', () => {
    const raw = encodeLearningLoopKnowledge(value);
    expect(raw).toBe('{"blocked_identities":[],"brain_id":"brain","canonical_slug":"people/alice","correction_lineages":{},"immutable_commit_markers":[],"managed_rows":{},"pending_delivery":null,"reversal_attempts":{},"source_id":"source"}');
    const parsed = parseLearningLoopFence(`text\n${renderLearningLoopFence(value)}\n`);
    expect(parsed?.value).toEqual(value);
    expect(learningLoopKnowledgeHash(value)).toHaveLength(64);
  });

  test('rejects unknown or missing fields', () => {
    expect(() => decodeLearningLoopKnowledge('{"brain_id":"x","source_id":"s","canonical_slug":"a","managed_rows":{},"blocked_identities":[],"correction_lineages":{},"reversal_attempts":{},"immutable_commit_markers":[],"pending_delivery":null,"extra":1}')).toThrow('unknown field');
    expect(() => decodeLearningLoopKnowledge('{"brain_id":"x"}')).toThrow('missing field');
  });

  test('rejects malformed, duplicate, and non-canonical metadata fences', () => {
    const rendered = renderLearningLoopFence(value);
    expect(() => parseLearningLoopFence(rendered.replace('<!-- gbrain:learning-loop:v1:end -->', ''))).toThrow('malformed fence');
    expect(() => parseLearningLoopFence(`${rendered}\n${rendered}`)).toThrow('duplicate fence');
    const pretty = rendered.replace(encodeLearningLoopKnowledge(value), JSON.stringify(value, null, 2));
    expect(() => parseLearningLoopFence(pretty)).toThrow('non-canonical JSON');
  });

  test('round trips exact global, repository, and project managed identities', () => {
    const identities = [
      makeLearningClaimIdentity({ claim: 'Global preference', class: 'preference', scope: { kind: 'global' }, target: null, trigger: null }),
      makeLearningClaimIdentity({ claim: 'GitHub rule', class: 'constraint', scope: { kind: 'repository', target: 'repo:github.com/acme/widgets' }, target: 'repo:github.com/acme/widgets', trigger: null }),
      makeLearningClaimIdentity({ claim: 'Project goal', class: 'goal', scope: { kind: 'project', target: 'project:acme.widgets' }, target: 'project:acme.widgets', trigger: null }),
      makeLearningClaimIdentity({ claim: 'Pending loop', class: 'open_loop', scope: { kind: 'global' }, target: null, trigger: { kind: 'follow_up', id: 'loop-1', state: 'pending' } }),
    ];
    const managed_rows = Object.fromEntries(identities.map((identity, index) => [
      identity.claim_fingerprint!, makeLearningManagedRow(identity, index + 1, true, 'run-1'),
    ]));
    const encoded = encodeLearningLoopKnowledge({ ...value, managed_rows });
    expect(decodeLearningLoopKnowledge(encoded).managed_rows).toEqual(managed_rows);
    expect(parseLearningLoopFence(renderLearningLoopFence({ ...value, managed_rows }))?.value.managed_rows).toEqual(managed_rows);
  });

  test('forge-qualified repository targets remain distinct canonical bytes', () => {
    const make = (forge: string) => makeLearningClaimIdentity({ claim: 'Same target', class: 'lesson', scope: { kind: 'repository', target: `repo:${forge}/acme/widgets` }, target: `repo:${forge}/acme/widgets`, trigger: null });
    const github = make('github.com');
    const gitlab = make('gitlab.com');
    expect(github.claim_fingerprint).toBe('c78427c0aeb1f261d615e1719ff2e18f0a4b6784ffe3be13fab35c849d1838f1');
    expect(gitlab.claim_fingerprint).toBe('2a99982a5b9d7b0cb5dabd491b5784765a855d51a133c999695d06238a95c3e5');
    const makePage = (identity: typeof github) => encodeLearningLoopKnowledge({ ...value, canonical_slug: 'page', managed_rows: { [identity.claim_fingerprint!]: makeLearningManagedRow(identity, 1, true, 'run-1') } });
    const githubPage = makePage(github);
    const gitlabPage = makePage(gitlab);
    expect(githubPage).not.toBe(gitlabPage);
    expect(githubPage).toContain('"c78427c0aeb1f261d615e1719ff2e18f0a4b6784ffe3be13fab35c849d1838f1":{"active":true,"identity":{"claim":"Same target","claim_fingerprint":"c78427c0aeb1f261d615e1719ff2e18f0a4b6784ffe3be13fab35c849d1838f1","class":"lesson","scope":{"kind":"repository","target":"repo:github.com/acme/widgets"},"target":"repo:github.com/acme/widgets","trigger":null},"row_num":1,"run_id":"run-1"}');
  });

  test('rejects contradictory, ambiguous, malformed, and unknown managed-row state', () => {
    const identity = makeLearningClaimIdentity({ claim: 'Repo fact', class: 'lesson', scope: { kind: 'repository', target: 'repo:github.com/acme/widgets' }, target: 'repo:github.com/acme/widgets', trigger: null });
    const row = makeLearningManagedRow(identity, 1, true, 'run-1');
    const key = identity.claim_fingerprint!;
    const assertRejected = (candidate: unknown) => expect(() => validateLearningManagedRows(candidate)).toThrow();
    assertRejected({ [`${'0'.repeat(64)}`]: row });
    assertRejected({ [key]: { ...row, extra: true } });
    assertRejected({ [key]: { ...row, identity: { ...identity, target: null } } });
    assertRejected({ [key]: { ...row, identity: { ...identity, scope: { kind: 'global', target: identity.target } } } });
    assertRejected({ [key]: { ...row, identity: { ...identity, trigger: {} } } });
    assertRejected({ [key]: { ...row, active: 'true' } });
    assertRejected({ [key]: { ...row, identity: { ...identity, claim_fingerprint: undefined } } });
  });
});
