import { describe, expect, test } from 'bun:test';
import {
  decodeLearningLoopKnowledge,
  encodeLearningLoopKnowledge,
  learningLoopKnowledgeHash,
  parseLearningLoopFence,
  renderLearningLoopFence,
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
});
