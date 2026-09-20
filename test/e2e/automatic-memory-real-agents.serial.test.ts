/** Opt-in subscription-backed door: synthetic isolated brain, fresh native
 * agents, no API keys, global config copies, or permission bypass. */
import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync, realpathSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedBrainForAgent } from '../helpers/agent-harness.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { renderAmbientInstructionBlock } from '../../src/core/bootstrap/instructions-block.ts';
import { writeSingleFact } from '../../src/core/facts/write-single.ts';
import { withEnv } from '../helpers/with-env.ts';

test.skipIf(process.env.GBRAIN_REAL_MEMORY_DOOR !== '1')('ordinary statement is saved and used by fresh Codex and Claude in different directories', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'gb-real-memory-')));
  const operatorHome = process.env.HOME!;
  const codexHome = join(home, 'codex');
  const source = 'session-briefs';
  const nonce = `amber-${crypto.randomUUID().slice(0, 8)}`;
  const correctedNonce = `indigo-${crypto.randomUUID().slice(0, 8)}`;
  const cli = join(import.meta.dir, '../../src/cli.ts');
  const dirs = ['writer', 'codex-reader', 'claude-reader'].map(name => join(home, name));
  const block = renderAmbientInstructionBlock({ mode: 'salient', transientTtl: '3d', visibility: 'world', serveUrl: 'stdio:isolated-test' });
  async function run(command: string[], cwd: string, env: Record<string, string | undefined>) {
    const child = Bun.spawn(command, { cwd, env, stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => child.kill(), 180_000);
    try {
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code, err + out).toBe(0);
      return out;
    } finally { clearTimeout(timer); child.kill(); }
  }
  try {
    mkdirSync(codexHome);
    dirs.forEach(dir => mkdirSync(dir));
    await seedBrainForAgent(home, source, { entity: 'Synthetic fixture', fact: 'This is an isolated test.', slug: 'fixtures/setup' });
    const db = join(home, '.gbrain/brain.pglite');
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: db });
    await engine.setConfig('memory.auto_writeback', 'salient');
    await engine.setConfig('facts.extraction_enabled', 'false');
    await engine.disconnect();
    // Reuse existing subscription authentication by reference; never read or
    // duplicate its contents. All mutable Codex state stays in this fixture.
    symlinkSync(join(operatorHome, '.codex/auth.json'), join(codexHome, 'auth.json'));
    const selection = readFileSync(join(operatorHome, '.codex/config.toml'), 'utf8').split('\n').filter(line => /^model(?:_reasoning_effort)?\s*=/.test(line)).join('\n');
    writeFileSync(join(codexHome, 'AGENTS.md'), block);
    writeFileSync(join(codexHome, 'config.toml'), `${selection}\napproval_policy = "never"\nsandbox_mode = "read-only"\n[mcp_servers.gbrain]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([cli, 'serve', '--surface', 'verbs', '--source-guard'])}\n[mcp_servers.gbrain.env]\nGBRAIN_HOME = ${JSON.stringify(home)}\nGBRAIN_SOURCE = "${source}"\n[mcp_servers.gbrain.tools.remember]\napproval_mode = "approve"\n[mcp_servers.gbrain.tools.forget]\napproval_mode = "approve"\n`);
    const codexEnv = { PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome, SHELL: '/bin/sh' };
    const written = await run(['codex', 'exec', '--skip-git-repo-check', '--json', `My standing preference is to use ${nonce} as the heading of every weekly report. A short acknowledgement is enough.`], dirs[0]!, codexEnv);
    expect(written).toContain('remember');
    const events = (text: string): any[] => text.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const originalCall = events(written).find(row => row.type === 'item.completed' && row.item?.type === 'mcp_tool_call' && row.item.tool === 'remember' && row.item.status === 'completed');
    expect(originalCall, written).toBeDefined();
    const writerSession = events(written).find(row => row.type === 'thread.started')?.thread_id;
    const correction = await run(['codex', 'exec', 'resume', '--skip-git-repo-check', '--json', writerSession, `Correction: my standing weekly report heading is ${correctedNonce}, replacing the previous heading.`], dirs[0]!, codexEnv);
    expect(events(correction).some(row => row.type === 'item.completed' && row.item?.tool === 'forget' && row.item.status === 'completed'), correction).toBe(true);
    await engine.connect({ database_path: db });
    const args = originalCall.item.arguments;
    await withEnv({ GBRAIN_HOME: home }, () => writeSingleFact(engine, source, { fact: args.fact, provenance: args.provenance, entity: args.entity, kind: args.kind, visibility: args.visibility }));
    const rows = await engine.executeRaw('SELECT fact FROM facts WHERE source_id = $1 AND expired_at IS NULL AND (valid_until IS NULL OR valid_until > NOW())', [source]);
    expect(JSON.stringify(rows), correction).toContain(correctedNonce);
    expect(JSON.stringify(rows)).not.toContain(nonce);
    await engine.disconnect();
    // Restore a cold database snapshot, then remove the original so neither
    // fresh reader can pass by accidentally opening the original data.
    const restored = join(home, '.gbrain/restored.pglite');
    cpSync(db, restored, { recursive: true });
    rmSync(db, { recursive: true });
    const configPath = join(home, '.gbrain/config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    writeFileSync(configPath, JSON.stringify({ ...config, database_path: restored }));
    const question = 'What exact heading should you use for my weekly report? Use my saved preference and answer with just the heading.';
    const recalled = await run(['codex', 'exec', '--skip-git-repo-check', '--json', question], dirs[1]!, codexEnv);
    expect(events(recalled).some(row => row.type === 'item.completed' && row.item?.type === 'mcp_tool_call' && ['recall', 'context_pack'].includes(row.item.tool) && JSON.stringify(row.item.result).includes(correctedNonce)), recalled).toBe(true);
    const messages = recalled.split('\n').flatMap(line => { try { const value = JSON.parse(line); return value.item?.type === 'agent_message' ? [value.item.text] : []; } catch { return []; } });
    expect(messages.join('\n')).toContain(correctedNonce);
    const mcp = join(home, 'mcp.json');
    writeFileSync(mcp, JSON.stringify({ mcpServers: { gbrain: { command: process.execPath, args: [cli, 'serve', '--surface', 'verbs', '--source-guard'], env: { GBRAIN_HOME: home, GBRAIN_SOURCE: source } } } }));
    const claude = await run(['claude', '-p', '--restricted', '--strict-mcp-config', '--mcp-config', mcp, '--tools', '', '--allowedTools', 'mcp__gbrain__recall,mcp__gbrain__context_pack', '--output-format', 'json', question], dirs[2]!, { PATH: process.env.PATH, HOME: operatorHome, USER: process.env.USER, LOGNAME: process.env.LOGNAME, TMPDIR: process.env.TMPDIR, SHELL: '/bin/sh' });
    expect(JSON.parse(claude).result).toContain(correctedNonce);
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 560_000);
