/**
 * Bounded reranker comparison receipt for two explicit models against the
 * existing LongMemEval mini fixture.
 *
 * Design goals:
 * - deterministic: fixed fixture, fixed question slice, no answer generation
 * - small: direct reranker calls over rendered session pages, no full benchmark
 * - honest: marks a model blocked when the reranker endpoint is unreachable
 *
 * Usage:
 *   bun scripts/eval-reranker-receipt.ts
 *   bun scripts/eval-reranker-receipt.ts --output docs/eval/results/qwen3-reranker-mini-2026-06-16/receipt.json
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import { loadConfig } from '../src/core/config.ts';
import { buildGatewayConfig } from '../src/core/ai/build-gateway-config.ts';
import { configureGateway, resetGateway, rerank } from '../src/core/ai/gateway.ts';
import {
  haystackToPages,
  type LongMemEvalQuestion,
  type LongMemEvalSession,
  type LongMemEvalTurn,
} from '../src/eval/longmemeval/adapter.ts';

interface Args {
  fixturePath: string;
  outputPath: string;
  limit: number;
  topK: number;
  timeoutMs: number;
  models: string[];
  baseUrlByModel: Record<string, string>;
}

interface QuestionResult {
  question_id: string;
  question_type: string;
  answer_session_ids: string[];
  retrieved_session_ids: string[];
  recall_hit: boolean;
  top1_hit: boolean;
}

interface ModelReceipt {
  model: string;
  ok: boolean;
  error?: string;
  questions_run: number;
  recall_at_k: number;
  top1_hit_rate: number;
  question_results: QuestionResult[];
}

const DEFAULT_MODELS = [
  'llama-server-reranker:qwen3-reranker-0.6b',
  'llama-server-reranker:qwen3-reranker-4b',
];

function parseArgs(argv: string[]): Args {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const today = new Date().toISOString().slice(0, 10);
  const outPath = join(
    repoRoot,
    'docs',
    'eval',
    'results',
    `qwen3-reranker-mini-${today}`,
    'receipt.json',
  );
  const args: Args = {
    fixturePath: join(repoRoot, 'test', 'fixtures', 'longmemeval-mini.jsonl'),
    outputPath: outPath,
    limit: 5,
    topK: 5,
    timeoutMs: 30_000,
    models: [...DEFAULT_MODELS],
    baseUrlByModel: {},
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fixture') args.fixturePath = resolve(argv[++i]);
    else if (a === '--output') args.outputPath = resolve(argv[++i]);
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--top-k') args.topK = Number(argv[++i]);
    else if (a === '--timeout-ms') args.timeoutMs = Number(argv[++i]);
    else if (a === '--models') {
      args.models = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    }
    else if (a === '--model-base-url') {
      const raw = argv[++i];
      const eq = raw.indexOf('=');
      if (eq === -1) throw new Error(`--model-base-url expects model=url, got: ${raw}`);
      const model = raw.slice(0, eq).trim();
      const url = raw.slice(eq + 1).trim();
      if (!model || !url) throw new Error(`--model-base-url expects model=url, got: ${raw}`);
      args.baseUrlByModel[model] = url;
    }
  }
  return args;
}

function loadFixture(fixturePath: string, limit: number): LongMemEvalQuestion[] {
  const lines = readFileSync(fixturePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .slice(0, limit);
  return lines.map((line) => JSON.parse(line) as LongMemEvalQuestion);
}

function repoRelativePath(repoRoot: string, filePath: string): string {
  const rel = relative(repoRoot, filePath);
  return rel.startsWith('..') ? filePath : rel;
}

function normalizeSessions(question: LongMemEvalQuestion): LongMemEvalSession[] {
  const sessions: LongMemEvalSession[] = [];
  const ids = question.haystack_session_ids ?? [];
  for (let i = 0; i < question.haystack_sessions.length; i++) {
    const item = question.haystack_sessions[i] as LongMemEvalSession | LongMemEvalTurn[];
    if (Array.isArray(item)) {
      sessions.push({
        session_id: ids[i] ?? `lme_${question.question_id}_${i}`,
        turns: item,
      });
      continue;
    }
    sessions.push({
      session_id: item.session_id ?? `lme_${question.question_id}_${i}`,
      turns: item.turns,
    });
  }
  return sessions;
}

function sanitizeSessionIdForSlug(sessionId: string): string {
  return sessionId.toLowerCase().replace(/[_.]/g, '-').replace(/[^a-z0-9-]/g, '-');
}

function sessionSlugsForQuestion(question: LongMemEvalQuestion): string[] {
  return normalizeSessions(question).map((session) => `chat/${sanitizeSessionIdForSlug(session.session_id)}`);
}

function answerSlugsForQuestion(question: LongMemEvalQuestion): string[] {
  return question.answer_session_ids.map((id) => `chat/${sanitizeSessionIdForSlug(id)}`);
}

async function runModelReceipt(
  model: string,
  questions: LongMemEvalQuestion[],
  topK: number,
  timeoutMs: number,
  defaultBaseUrl: string,
  baseUrlByModel: Record<string, string>,
  gatewayCfg: ReturnType<typeof buildGatewayConfig>,
): Promise<ModelReceipt> {
  const questionResults: QuestionResult[] = [];
  const modelBaseUrl = baseUrlByModel[model] ?? defaultBaseUrl;

  try {
    configureGateway({
      ...gatewayCfg,
      base_urls: {
        ...gatewayCfg.base_urls,
        'llama-server-reranker': modelBaseUrl,
      },
    });
    for (const question of questions) {
      const pages = haystackToPages(question);
      const sessionSlugs = sessionSlugsForQuestion(question);
      const answerSlugs = answerSlugsForQuestion(question);
      const results = await rerank({
        model,
        query: question.question,
        documents: pages.map((page) => page.content),
        topN: topK,
        timeoutMs,
      });
      const retrievedSessionIds = results
        .map((row) => sessionSlugs[row.index])
        .filter((slug): slug is string => Boolean(slug));
      const gt = new Set(answerSlugs);
      const recallHit = retrievedSessionIds.some((slug) => gt.has(slug));
      const top1Hit = retrievedSessionIds.length > 0 ? gt.has(retrievedSessionIds[0]) : false;
      questionResults.push({
        question_id: question.question_id,
        question_type: question.question_type,
        answer_session_ids: answerSlugs,
        retrieved_session_ids: retrievedSessionIds,
        recall_hit: recallHit,
        top1_hit: top1Hit,
      });
    }
  } catch (error) {
    return {
      model,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      questions_run: questionResults.length,
      recall_at_k: 0,
      top1_hit_rate: 0,
      question_results: questionResults,
    };
  }

  const recallHits = questionResults.filter((row) => row.recall_hit).length;
  const top1Hits = questionResults.filter((row) => row.top1_hit).length;
  const denom = questionResults.length || 1;
  return {
    model,
    ok: true,
    questions_run: questionResults.length,
    recall_at_k: recallHits / denom,
    top1_hit_rate: top1Hits / denom,
    question_results: questionResults,
  };
}

function summarize(models: ModelReceipt[]): { status: string; winner: string | null; note: string } {
  const okModels = models.filter((model) => model.ok);
  if (okModels.length < 2) {
    return {
      status: 'blocked',
      winner: null,
      note: 'Comparison blocked: fewer than two reranker models completed.',
    };
  }
  const ranked = [...okModels].sort((a, b) => {
    if (b.recall_at_k !== a.recall_at_k) return b.recall_at_k - a.recall_at_k;
    if (b.top1_hit_rate !== a.top1_hit_rate) return b.top1_hit_rate - a.top1_hit_rate;
    return a.model.localeCompare(b.model);
  });
  const winner = ranked[0]!;
  const runnerUp = ranked[1]!;
  const tied = winner.recall_at_k === runnerUp.recall_at_k &&
    winner.top1_hit_rate === runnerUp.top1_hit_rate;
  return {
    status: tied ? 'tie' : 'ok',
    winner: tied ? null : winner.model,
    note: tied
      ? 'Both rerankers produced the same bounded fixture score.'
      : `Winner by recall@k then top1-hit-rate: ${winner.model}.`,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const questions = loadFixture(args.fixturePath, args.limit);
  const cfg = loadConfig();
  if (!cfg) {
    throw new Error('No gbrain config loaded; cannot configure embedding/reranker gateway.');
  }

  const gatewayCfg = buildGatewayConfig(cfg);
  const defaultBaseUrl =
    gatewayCfg.base_urls?.['llama-server-reranker'] ??
    process.env.LLAMA_SERVER_RERANKER_BASE_URL ??
    'http://127.0.0.1:8081/v1';

  try {
    const modelReceipts: ModelReceipt[] = [];
    for (const model of args.models) {
      modelReceipts.push(await runModelReceipt(
        model,
        questions,
        args.topK,
        args.timeoutMs,
        defaultBaseUrl,
        args.baseUrlByModel,
        gatewayCfg,
      ));
    }
    const summary = summarize(modelReceipts);
    const receipt = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      fixture_path: repoRelativePath(resolve(dirname(fileURLToPath(import.meta.url)), '..'), args.fixturePath),
      questions_considered: questions.length,
      top_k: args.topK,
      timeout_ms: args.timeoutMs,
      reranker_base_url: defaultBaseUrl,
      reranker_base_url_by_model: args.baseUrlByModel,
      summary,
      models: modelReceipts,
    };

    mkdirSync(dirname(args.outputPath), { recursive: true });
    writeFileSync(args.outputPath, JSON.stringify(receipt, null, 2) + '\n', 'utf8');
    process.stdout.write(args.outputPath + '\n');
  } finally {
    resetGateway();
  }
}

await main();
