import { describe, expect, test } from 'bun:test';
import { canonicalSha256 } from '../src/core/learning-loop.ts';
import {
  reduceLearningLoopReversal,
  replacementSetFingerprint,
  type BlockedClaimKey,
  type LearningLoopKnowledge,
  type LearningPointer,
  type LearningReversalAttempt,
} from '../src/core/learning-loop-knowledge.ts';

const blocked = 'a'.repeat(64) as BlockedClaimKey;
const replacement = { identity: 'b'.repeat(64) as BlockedClaimKey, canonical_slug: 'topics/example', row_num: 2 } satisfies LearningPointer;

function baseKnowledge(): LearningLoopKnowledge {
  return {
    brain_id: 'brain', source_id: 'source', canonical_slug: 'topics/example',
    managed_rows: {}, blocked_identities: [blocked],
    correction_lineages: {
      [blocked]: {
        blocked_identity: blocked,
        active_replacements: [replacement],
        replacement_set_fingerprint: replacementSetFingerprint([replacement]),
        lineage_generation: 3,
      },
    },
    reversal_attempts: {}, immutable_commit_markers: [], pending_delivery: null,
  };
}

function startedAttempt(overrides: Partial<LearningReversalAttempt> = {}): LearningReversalAttempt {
  return {
    root_reversal_id: 'reversal-test', attempt_no: 1, phase: 'started', blocked_identity: blocked,
    authority_event_id: 'authority-event', predecessor_generation: 3,
    predecessor_set_fingerprint: replacementSetFingerprint([replacement]),
    predecessor_replacements: [replacement], inherited_replacements: [replacement],
    ...overrides,
  };
}

describe('Learning Loop reversal reducer', () => {
  test('advances the durable phases with exact retry identity and lifts only on commit', () => {
    const started = reduceLearningLoopReversal(baseKnowledge(), { kind: 'start', attempt: startedAttempt() });
    expect(started.attempt.phase).toBe('started');
    expect(reduceLearningLoopReversal(started.next, { kind: 'start', attempt: startedAttempt() }).attempt).toEqual(started.attempt);

    const checkpoint = { lineage_generation: 4, replacement_set_fingerprint: replacementSetFingerprint([]), active_replacements: [] as LearningPointer[] };
    const retiredBase: LearningLoopKnowledge = {
      ...started.next,
      correction_lineages: {
        [blocked]: {
          blocked_identity: blocked, active_replacements: [],
          replacement_set_fingerprint: checkpoint.replacement_set_fingerprint, lineage_generation: checkpoint.lineage_generation,
        },
      },
    };
    const retired = reduceLearningLoopReversal(retiredBase, { kind: 'retired_checkpointed', checkpoint });
    expect(retired.attempt.phase).toBe('retired_checkpointed');
    expect(reduceLearningLoopReversal(retired.next, { kind: 'retired_checkpointed', checkpoint }).attempt).toEqual(retired.attempt);
    expect(() => reduceLearningLoopReversal(retired.next, { kind: 'retired_checkpointed', checkpoint: { ...checkpoint, lineage_generation: 5 } })).toThrow(/conflicts/);

    const checkpointHash = canonicalSha256(checkpoint);
    const rebuilt = reduceLearningLoopReversal(retired.next, { kind: 'rebuild_verified', proof_id: 'proof-1', checkpoint_hash: checkpointHash });
    expect(rebuilt.attempt.phase).toBe('rebuild_verified');
    expect(reduceLearningLoopReversal(rebuilt.next, { kind: 'rebuild_verified', proof_id: 'proof-1', checkpoint_hash: checkpointHash }).attempt).toEqual(rebuilt.attempt);

    const reinstated = { identity: blocked, canonical_slug: 'topics/example', row_num: 3 } satisfies LearningPointer;
    const finalStateHash = 'c'.repeat(64);
    const intent = reduceLearningLoopReversal(rebuilt.next, { kind: 'commit_intent', checkpoint_hash: checkpointHash, final_state_hash: finalStateHash, reinstated });
    expect(intent.attempt.phase).toBe('commit_intent');
    expect(() => reduceLearningLoopReversal(intent.next, { kind: 'commit_intent', checkpoint_hash: checkpointHash, final_state_hash: 'd'.repeat(64), reinstated })).toThrow(/conflicts/);

    const committed = reduceLearningLoopReversal(intent.next, { kind: 'committed', marker: `reversal-test:1:${finalStateHash}` });
    expect(committed.attempt.phase).toBe('committed');
    expect(committed.next.blocked_identities).toEqual([]);
    expect(committed.next.immutable_commit_markers).toEqual([`reversal-test:1:${finalStateHash}`]);
  });

  test('supersedes one attempt only with an atomically linked successor and inherited obligations', () => {
    const first = reduceLearningLoopReversal(baseKnowledge(), { kind: 'start', attempt: startedAttempt() });
    const successor = startedAttempt({ attempt_no: 2, predecessor_id: 'reversal-test:1' });
    const superseded = reduceLearningLoopReversal(first.next, { kind: 'supersede', successor });
    expect(superseded.next.reversal_attempts['reversal-test:1']).toMatchObject({ phase: 'superseded', successor_id: 'reversal-test:2' });
    expect(superseded.next.reversal_attempts['reversal-test:2']).toEqual(successor);
    expect(reduceLearningLoopReversal(superseded.next, { kind: 'supersede', successor }).attempt).toEqual(successor);
    expect(() => reduceLearningLoopReversal(superseded.next, { kind: 'supersede', successor: { ...successor, authority_event_id: 'other' } })).toThrow(/conflict/);
  });

  test('rejects phase skips and invalid checkpoint generations', () => {
    const started = reduceLearningLoopReversal(baseKnowledge(), { kind: 'start', attempt: startedAttempt() });
    const checkpoint = { lineage_generation: 3, replacement_set_fingerprint: replacementSetFingerprint([]), active_replacements: [] as LearningPointer[] };
    expect(() => reduceLearningLoopReversal(started.next, { kind: 'rebuild_verified', proof_id: 'proof', checkpoint_hash: canonicalSha256(checkpoint) })).toThrow(/phase/);
    expect(() => reduceLearningLoopReversal(started.next, { kind: 'retired_checkpointed', checkpoint })).toThrow(/checkpoint/);
  });
});
