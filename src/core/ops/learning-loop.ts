/** Personal Learning Loop operation cluster. */

import type { Operation, OperationContext } from './contract.ts';
import { OperationError } from './contract.ts';

function assertTrustedLocal(ctx: OperationContext, opName: string): void {
  if (ctx.remote !== false) {
    throw new OperationError('permission_denied', `${opName} requires a trusted local caller`);
  }
}

async function learningLoopCall<T>(
  fn: (mod: typeof import('../learning-loop.ts')) => Promise<T> | T,
): Promise<T> {
  const mod = await import('../learning-loop.ts');
  try {
    return await fn(mod);
  } catch (error) {
    if (error instanceof mod.LearningLoopError) {
      const permissionCodes = new Set(['forbidden', 'mode_off']);
      throw new OperationError(
        permissionCodes.has(error.code) ? 'permission_denied' : 'learning_loop_error',
        error.message,
      );
    }
    throw error;
  }
}

const learning_loop_get_mode: Operation = {
  name: 'learning_loop_get_mode',
  description: 'Read the trusted-local Personal Learning Loop mode. Absence resolves to off.',
  params: {}, scope: 'admin', localOnly: true,
  handler: async (ctx) => {
    assertTrustedLocal(ctx, 'learning_loop_get_mode');
    return learningLoopCall(async ({ resolveLearningLoopMode }) => ({ mode: await resolveLearningLoopMode(ctx.engine, ctx.config) }));
  },
};

const learning_loop_set_mode: Operation = {
  name: 'learning_loop_set_mode',
  description: 'Set the trusted-local Personal Learning Loop mode. Changing out of canary aborts an active run first.',
  params: { mode: { type: 'string', required: true, enum: ['off', 'capture', 'canary'] } },
  mutating: true, scope: 'admin', localOnly: true,
  handler: async (ctx, p) => {
    assertTrustedLocal(ctx, 'learning_loop_set_mode');
    return learningLoopCall((mod) => mod.setLearningLoopMode(ctx.engine, ctx.config, p.mode as import('../learning-loop.ts').LearningLoopMode, { config: ctx.config }));
  },
};

const learning_loop_inspect: Operation = {
  name: 'learning_loop_inspect',
  description: 'Inspect trusted-local replay-derived Personal Learning Loop run and cohort state.',
  params: {}, scope: 'admin', localOnly: true,
  handler: async (ctx) => {
    assertTrustedLocal(ctx, 'learning_loop_inspect');
    return learningLoopCall((mod) => {
      const state = mod.replayLearningLoop(mod.readLearningLoopLedger({ config: ctx.config }));
      return {
        active_run_id: state.active_run_id,
        event_count: state.events.length,
        runs: [...state.runs.values()].map((run) => ({
          run_id: run.run_id,
          terminal: run.terminal,
          cohort_size: run.cohort.length,
          cohort_sealed: run.sealed,
          baseline_source_manifest_hash: run.armed.baseline_discovery.source_manifest_hash,
        })),
      };
    });
  },
};

const learning_loop_arm: Operation = {
  name: 'learning_loop_arm',
  description: 'Arm one trusted-local ten-session Codex run without changing mode or activating live hooks.',
  params: {
    command_id: { type: 'string', required: true },
    authorized_client_id: { type: 'string', required: true },
    authorized_source_id: { type: 'string', required: true },
    source_id: { type: 'string', required: true },
    canonical_slug: { type: 'string', required: true },
    contract_version: { type: 'string', required: false, enum: ['1', '2'] },
  },
  mutating: true, scope: 'admin', localOnly: true,
  handler: async (ctx, p) => {
    assertTrustedLocal(ctx, 'learning_loop_arm');
    return learningLoopCall((mod) => {
      const arm = mod.armLearningLoop as (input: import('../learning-loop.ts').ArmLearningLoopInput) => Promise<unknown>;
      return arm({
      command_id: p.command_id as string,
      engine: ctx.engine,
      config: ctx.config,
      authorized_adapter: { client_id: p.authorized_client_id as string, source_id: p.authorized_source_id as string, provider: 'codex' },
      destination: { source_id: p.source_id as string, canonical_slug: p.canonical_slug as string },
        contract_version: p.contract_version === undefined ? 1 : Number(p.contract_version) as 1 | 2,
      });
    });
  },
};

const learning_loop_abort: Operation = {
  name: 'learning_loop_abort',
  description: 'Abort the active Personal Learning Loop run through a trusted-local owner control.',
  params: { command_id: { type: 'string', required: true } },
  mutating: true, scope: 'admin', localOnly: true,
  handler: async (ctx, p) => {
    assertTrustedLocal(ctx, 'learning_loop_abort');
    return learningLoopCall((mod) => mod.abortLearningLoop(ctx.engine, p.command_id as string, 'owner_abort', { config: ctx.config }));
  },
};

const learning_loop_resolve_transcript: Operation = {
  name: 'learning_loop_resolve_transcript',
  description: 'Resolve and hash one server-local Codex transcript through the trusted-local owner boundary.',
  params: { provider_session_id: { type: 'string', required: true }, source_id: { type: 'string', required: true } },
  scope: 'admin', localOnly: true,
  handler: async (ctx, p) => {
    assertTrustedLocal(ctx, 'learning_loop_resolve_transcript');
    return learningLoopCall((mod) => mod.resolveAuthoritativeTranscript({ engine: ctx.engine, config: ctx.config, expected_corpus_binding: mod.activeV2CorpusBinding({ config: ctx.config }), provider: 'codex', provider_session_id: p.provider_session_id as string, source_id: p.source_id as string }));
  },
};

const learning_loop_bind_session: Operation = {
  name: 'learning_loop_bind_session',
  description: 'Bind one completed Codex provider session to its adapter identity through a trusted-local owner control.',
  params: {
    command_id: { type: 'string', required: true }, client_id: { type: 'string', required: true },
    provider_session_id: { type: 'string', required: true }, source_id: { type: 'string', required: true },
  },
  mutating: true, scope: 'admin', localOnly: true,
  handler: async (ctx, p) => {
    assertTrustedLocal(ctx, 'learning_loop_bind_session');
    return learningLoopCall(async (mod) => {
      const sourceId = p.source_id as string;
      const providerSessionId = p.provider_session_id as string;
      await mod.resolveAuthoritativeTranscript({ engine: ctx.engine, config: ctx.config, expected_corpus_binding: mod.activeV2CorpusBinding({ config: ctx.config }), provider: 'codex', provider_session_id: providerSessionId, source_id: sourceId });
      return mod.bindLearningLoopSession(ctx.engine, p.command_id as string, { client_id: p.client_id as string, source_id: sourceId, provider: 'codex' }, providerSessionId, { config: ctx.config });
    });
  },
};

const learning_loop_submit_session_v1: Operation = {
  name: 'learning_loop_submit_session_v1',
  description: 'Submit bounded Codex session metadata from an authenticated, source- and session-bound adapter. GBrain resolves and hashes local transcript bytes.',
  params: {
    provider: { type: 'string', required: true, enum: ['codex'] }, provider_session_id: { type: 'string', required: true },
    source_id: { type: 'string', required: true }, completion_state: { type: 'string', required: true, enum: ['completed'] },
    completed_at: { type: 'string', required: true }, asserted_relative_path: { type: 'string' },
    asserted_size_bytes: { type: 'number' }, asserted_content_hash: { type: 'string' },
  },
  mutating: true, scope: 'write',
  handler: async (ctx, p) => learningLoopCall(async (mod) => {
    if (!ctx.auth?.clientId || !ctx.auth.sourceId || ctx.remote !== true) throw new mod.LearningLoopError('forbidden', 'Learning Loop adapter submission requires authenticated remote client identity');
    const sourceId = p.source_id as string;
    if (p.provider !== 'codex' || sourceId !== ctx.auth.sourceId || sourceId !== ctx.sourceId) throw new mod.LearningLoopError('forbidden', 'Provider or source identity does not match the authenticated adapter');
    const mode = await mod.resolveLearningLoopMode(ctx.engine, ctx.config);
    if (mode === 'off') return { status: 'disabled', mode };
    const adapter = { client_id: ctx.auth.clientId, source_id: sourceId, provider: 'codex' as const };
    mod.assertLearningLoopSessionBinding(adapter, p.provider_session_id as string, { config: ctx.config });
    const receipt = await mod.resolveAuthoritativeTranscript({
      engine: ctx.engine, config: ctx.config, provider: 'codex', provider_session_id: p.provider_session_id as string, source_id: sourceId,
      expected_corpus_binding: mod.activeV2CorpusBinding({ config: ctx.config }),
      asserted_relative_path: p.asserted_relative_path as string | undefined, asserted_completed_at: p.completed_at as string,
      asserted_size_bytes: p.asserted_size_bytes as number | undefined, asserted_content_hash: p.asserted_content_hash as string | undefined,
    });
    const currentMode = await mod.resolveLearningLoopMode(ctx.engine, ctx.config);
    if (currentMode === 'off') return { status: 'disabled' as const, mode: currentMode };
    return mod.recordSessionEvaluation({ engine: ctx.engine, mode, adapter, receipt }, { config: ctx.config });
  }),
};

const learning_loop_candidate: Operation = {
  name: 'learning_loop_candidate', description: 'Record a locally-derived Learning Loop candidate.',
  params: { run_id: { type: 'string', required: true }, source_id: { type: 'string', required: true }, identity: { type: 'object', required: true }, locators: { type: 'array', required: true, items: { type: 'object' } } },
  mutating: true, scope: 'write', localOnly: true,
  handler: async (ctx, p) => {
    assertTrustedLocal(ctx, 'learning_loop_candidate');
    if ('evidence' in p) throw new OperationError('permission_denied', 'Candidate evidence is server-derived and cannot be supplied by the caller');
    return learningLoopCall((mod) => mod.recordLearningCandidate({ engine: ctx.engine, config: ctx.config, run_id: p.run_id as string, source_id: p.source_id as string, identity: p.identity as import('../learning-loop-knowledge.ts').LearningClaimIdentity, locators: p.locators as import('../learning-loop.ts').TranscriptMessageLocator[] }));
  },
};

const learning_loop_authority: Operation = {
  name: 'learning_loop_authority', description: 'Record locally-derived direct-user or repetition authority.',
  params: { run_id: { type: 'string', required: true }, source_id: { type: 'string', required: true }, identity: { type: 'object', required: true }, authority: { type: 'string', required: true }, locators: { type: 'array', required: true, items: { type: 'object' } } },
  mutating: true, scope: 'write', localOnly: true,
  handler: async (ctx, p) => {
    assertTrustedLocal(ctx, 'learning_loop_authority');
    if ('evidence' in p) throw new OperationError('permission_denied', 'Authority evidence is server-derived and cannot be supplied by the caller');
    return learningLoopCall((mod) => mod.recordLearningAuthority({ engine: ctx.engine, config: ctx.config, run_id: p.run_id as string, source_id: p.source_id as string, identity: p.identity as import('../learning-loop-knowledge.ts').LearningClaimIdentity, authority: p.authority as 'direct_user' | 'repetition', locators: p.locators as import('../learning-loop.ts').TranscriptMessageLocator[] }));
  },
};

const learning_loop_activate: Operation = {
  name: 'learning_loop_activate', description: 'Activate one exactly authorized Learning Loop claim through the canonical personal page.',
  params: { run_id: { type: 'string', required: true }, source_id: { type: 'string', required: true }, canonical_slug: { type: 'string', required: true }, identity: { type: 'object', required: true }, authority: { type: 'string', required: true, enum: ['direct_user', 'repetition'] } },
  mutating: true, scope: 'write', localOnly: true,
  handler: async (ctx, p) => {
    assertTrustedLocal(ctx, 'learning_loop_activate');
    return learningLoopCall((mod) => mod.activateLearningClaim({ engine: ctx.engine, config: ctx.config, run_id: p.run_id as string, source_id: p.source_id as string, canonical_slug: p.canonical_slug as string, identity: p.identity as never, authority: p.authority as 'direct_user' | 'repetition' }));
  },
};

const learning_loop_correct: Operation = {
  name: 'learning_loop_correct', description: 'Apply a trusted-local correction that blocks the predecessor and activates its exact replacement.',
  params: { run_id: { type: 'string', required: true }, source_id: { type: 'string', required: true }, canonical_slug: { type: 'string', required: true }, predecessor: { type: 'object', required: true }, replacement: { type: 'object', required: true }, authority: { type: 'string', required: true, enum: ['direct_user', 'repetition'] } },
  mutating: true, scope: 'write', localOnly: true,
  handler: async (ctx, p) => {
    assertTrustedLocal(ctx, 'learning_loop_correct');
    return learningLoopCall((mod) => mod.correctLearningClaim({ engine: ctx.engine, config: ctx.config, run_id: p.run_id as string, source_id: p.source_id as string, canonical_slug: p.canonical_slug as string, predecessor: p.predecessor as never, replacement: p.replacement as never, authority: p.authority as 'direct_user' | 'repetition' }));
  },
};

const learning_loop_reverse: Operation = {
  name: 'learning_loop_reverse', description: 'Reinstate one exact correction-blocked claim through the trusted-local reversal protocol.',
  params: { run_id: { type: 'string', required: true }, source_id: { type: 'string', required: true }, canonical_slug: { type: 'string', required: true }, identity: { type: 'object', required: true }, authority_event_id: { type: 'string', required: true }, root_reversal_id: { type: 'string', required: false } },
  mutating: true, scope: 'write', localOnly: true,
  handler: async (ctx, p) => {
    assertTrustedLocal(ctx, 'learning_loop_reverse');
    return learningLoopCall((mod) => mod.reverseLearningClaim({ engine: ctx.engine, config: ctx.config, run_id: p.run_id as string, source_id: p.source_id as string, canonical_slug: p.canonical_slug as string, identity: p.identity as never, authority_event_id: p.authority_event_id as string, root_reversal_id: p.root_reversal_id as string | undefined }));
  },
};

export const learningLoopOperations: Operation[] = [
  learning_loop_get_mode, learning_loop_set_mode, learning_loop_inspect,
  learning_loop_arm, learning_loop_abort, learning_loop_resolve_transcript,
  learning_loop_bind_session, learning_loop_submit_session_v1,
  learning_loop_candidate, learning_loop_authority, learning_loop_activate,
  learning_loop_correct, learning_loop_reverse,
];
