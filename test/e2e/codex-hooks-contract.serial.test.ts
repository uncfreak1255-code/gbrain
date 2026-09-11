/** Real Codex hook trust + event contract, with a local synthetic Responses
 * server. No credentials, paid requests, or operator configuration. This is
 * host-contract proof; it does not claim model memory behavior. */
import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeCodexHooks } from '../../src/core/bootstrap/codex-hooks.ts';

const codex = Bun.which('codex');
test.skipIf(!codex)('native Codex delivers prompt context and fires turn checkpoints with persisted trust', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gb-codex-contract-')));
  const codexHome = join(dir, 'codex');
  mkdirSync(codexHome);
  const events = join(dir, 'events');
  const bin = join(dir, 'gbrain');
  const brainHome = join(dir, '.gbrain');
  mkdirSync(brainHome);
  writeFileSync(join(brainHome, 'config.json'), JSON.stringify({ engine: 'pglite', database_path: join(dir, 'unused-test-db'), memory: { auto_writeback: 'salient' } }));
  const cli = join(import.meta.dir, '../../src/cli.ts');
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$2" >> '${events}'\nif [ "$2" = user-prompt ]; then\n  cat >/dev/null\n  printf '%s\\n' '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"synthetic-recall-context-719"}}'\nelse\n  cat > '${dir}/payload-'\"$2\"'.json'\n  exec env GBRAIN_HOME='${dir}' GBRAIN_STOP_PUSH=0 '${process.execPath}' '${cli}' "$@" < '${dir}/payload-'"$2"'.json'\nfi\n`, { mode: 0o700 });
  let requestText = '';
  let interrupting = false;
  let requestArrived!: () => void;
  const stalledRequest = new Promise<void>(resolve => { requestArrived = resolve; });
  let releaseRequest: (() => void) | undefined;
  let interrupted: ReturnType<typeof Bun.spawn> | undefined;
  let compacted: ReturnType<typeof Bun.spawn> | undefined;
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(req) {
      requestText += await req.text();
      if (interrupting) {
        requestArrived();
        await new Promise<void>(resolve => { releaseRequest = resolve; });
      }
      const message = { id: 'msg_test', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Acknowledged.', annotations: [] }] };
      const response = { id: 'resp_test', object: 'response', created_at: 1, status: 'completed', model: 'synthetic', output: [message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
      const rows = [
        { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } },
        { type: 'response.output_text.delta', item_id: 'msg_test', output_index: 0, content_index: 0, delta: 'Acknowledged.' },
        { type: 'response.output_item.done', output_index: 0, item: message },
        { type: 'response.completed', response },
      ];
      return new Response(rows.map(row => `event: ${row.type}\ndata: ${JSON.stringify(row)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  writeFileSync(join(codexHome, 'config.toml'), `model = "synthetic"\nmodel_provider = "synthetic"\n[model_providers.synthetic]\nname = "Synthetic local contract test"\nbase_url = "http://127.0.0.1:${server.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n`);
  writeCodexHooks({ gbrainBin: bin, sourceId: 'session-briefs', hooksPath: join(codexHome, 'hooks.json'), configPath: join(codexHome, 'config.toml') });
  const statement = 'My weekly reports use the synthetic codeword amber-719.';
  const child = Bun.spawn([codex!, 'exec', '--skip-git-repo-check', '--json', '-s', 'read-only', statement], {
    cwd: dir, env: { PATH: process.env.PATH, HOME: dir, CODEX_HOME: codexHome, SHELL: '/bin/sh' }, stdout: 'pipe', stderr: 'pipe',
  });
  const timer = setTimeout(() => child.kill(), 30_000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, stderr + stdout).toBe(0);
    expect(requestText.includes('synthetic-recall-context-719'), stderr + (existsSync(events) ? readFileSync(events, 'utf8') : 'NO_HOOK_EVENTS')).toBe(true);
    const fired = existsSync(events) ? readFileSync(events, 'utf8').trim().split('\n') : [];
    expect(fired).toContain('user-prompt');
    expect(fired).toContain('stop');
    const corpus = join(brainHome, 'transcripts/corpus');
    const banked = existsSync(corpus) ? readdirSync(corpus).filter(f => f.includes('.wb-')) : [];
    expect(banked.length, existsSync(join(brainHome, 'integrations/hooks/heartbeat.jsonl')) ? readFileSync(join(brainHome, 'integrations/hooks/heartbeat.jsonl'), 'utf8') : stderr).toBe(1);
    expect(banked[0]).toContain('.src-session-briefs.txt');
    expect(readFileSync(join(corpus, banked[0]!), 'utf8')).toContain(statement);
    // Interrupt while the host is waiting for a response: no assistant Stop
    // exists yet, so only the native Interrupt checkpoint can retain this turn.
    interrupting = true;
    const progress = 'The synthetic migration is complete and its checksum is amber-827.';
    interrupted = Bun.spawn([codex!, 'exec', '--skip-git-repo-check', '--json', '-s', 'read-only', progress], {
      cwd: dir, env: { PATH: process.env.PATH, HOME: dir, CODEX_HOME: codexHome, SHELL: '/bin/sh' }, stdout: 'pipe', stderr: 'pipe',
    });
    await Promise.race([stalledRequest, Bun.sleep(10_000).then(() => { throw new Error('second native request did not arrive'); })]);
    interrupted.kill('SIGINT');
    await interrupted.exited;
    expect(readFileSync(events, 'utf8')).toContain('compact');
    const retained = readdirSync(corpus).filter(f => f.endsWith('.txt')).map(f => readFileSync(join(corpus, f), 'utf8')).join('\n');
    expect(retained).toContain(progress);
    releaseRequest?.();
    interrupting = false;
    rmSync(join(dir, 'payload-compact.json'), { force: true });
    const sessionId = stdout.split('\n').flatMap(line => { try { const row = JSON.parse(line); return row.type === 'thread.started' ? [row.thread_id] : []; } catch { return []; } })[0];
    const compactionChild = Bun.spawn([codex!, 'exec', 'resume', '--skip-git-repo-check', '--json', '-c', 'model_auto_compact_token_limit=1', sessionId, 'Continue the synthetic report.'], {
      cwd: dir, env: { PATH: process.env.PATH, HOME: dir, CODEX_HOME: codexHome, SHELL: '/bin/sh' }, stdout: 'pipe', stderr: 'pipe',
    });
    compacted = compactionChild;
    const [compactOut, compactErr, compactCode] = await Promise.all([new Response(compactionChild.stdout).text(), new Response(compactionChild.stderr).text(), compactionChild.exited]);
    expect(compactCode, compactErr + compactOut).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'payload-compact.json'), 'utf8')).hook_event_name).toBe('PreCompact');
  } finally {
    clearTimeout(timer);
    child.kill();
    interrupted?.kill();
    compacted?.kill();
    releaseRequest?.();
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 40_000);
