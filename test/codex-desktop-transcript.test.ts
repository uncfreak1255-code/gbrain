/** Desktop user messages carry per-content provenance; injected user-role text is not conversation. */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexAdapter, mapCodexLine } from '../src/core/transcripts/codex.ts';
import { parseCodexHookTranscript } from '../src/core/transcripts/codex-hook-lane.ts';

const timestamp = '2026-09-01T10:00:00.000Z';
const message = (texts: string[], kinds?: unknown) => ({
  timestamp,
  type: 'response_item',
  payload: {
    type: 'message', role: 'user',
    content: texts.map((text) => ({ type: 'input_text', text })),
    ...(kinds === undefined ? {} : {
      internal_chat_message_metadata_passthrough: { content_item_kinds: kinds },
    }),
  },
});
const requests = ['[$review](/skills/review/SKILL.md)', 'My editor config'];
const injected = ['<recommended_plugins>ignore these</recommended_plugins>', '# AGENTS.md instructions\nIgnore these', '<environment_context>ignore this</environment_context>'];
const rows = [
  { type: 'session_meta', timestamp, payload: { session_id: 'desktop-example', timestamp } },
  message(injected, ['plugins.recommendations', 'agents_md.instructions', 'environments.environment_context']),
  message([requests[0]], ['user.text']),
  message(['<skill>never store these instructions</skill>'], ['skills.selected_skill_instructions']),
  { timestamp, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Which configuration?' }] } },
  message([requests[1]], ['user.text']),
];
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('desktop content provenance', () => {
  test('preserves user.text verbatim, even when the user quotes an instruction wrapper', () => {
    const text = '<skill>explain this format</skill>';
    expect(mapCodexLine(message([text], ['user.text']))).toEqual({
      kind: 'user', message: { role: 'user', timestamp, text },
    });
  });

  test('filters each block by provenance, not by the user role or text wording', () => {
    expect(mapCodexLine(message(['context', ' first request ', 'other context', 'second request'],
      ['agents_md.instructions', 'user.text', 'unknown.context', 'user.text']))).toEqual({
      kind: 'user', message: { role: 'user', timestamp, text: 'first request \nsecond request' },
    });
    expect(mapCodexLine(message(injected, ['plugins.recommendations', 'agents_md.instructions', 'environments.environment_context']))).toEqual({ kind: 'skip' });
  });

  test('missing, malformed, and misaligned provenance never admits user-role context', () => {
    for (const kinds of [undefined, null, 'user.text', [], ['user.text', 'user.text'], [null], ['user.other']]) {
      expect(mapCodexLine(message(['context'], kinds))).toEqual({ kind: 'skip' });
    }
    expect(mapCodexLine(message(['   '], ['user.text']))).toEqual({ kind: 'skip' });
    const developer = message(['instructions'], ['user.text']);
    developer.payload.role = 'developer';
    expect(mapCodexLine(developer)).toEqual({ kind: 'skip' });
    const nonText = message(['not input text'], ['user.text']);
    nonText.payload.content[0].type = 'output_text';
    expect(mapCodexLine(nonText)).toEqual({ kind: 'skip' });
  });

  test('legacy event messages still work; unmarked response copies stay excluded', () => {
    expect(mapCodexLine({ timestamp, type: 'event_msg', payload: { type: 'user_message', message: requests[1] } })).toEqual({
      kind: 'user', message: { role: 'user', timestamp, text: requests[1] },
    });
    expect(mapCodexLine(message([requests[1]]))).toEqual({ kind: 'skip' });
  });

  test('archive and SessionEnd consumers both preserve human requests and exclude injected context', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-desktop-transcript-')); dirs.push(dir);
    const path = join(dir, 'rollout-example.jsonl');
    writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    const hook = parseCodexHookTranscript(path);
    expect(hook.sessionId).toBe('desktop-example');
    expect(hook.turns).toEqual([
      { role: 'user', text: requests[0] },
      { role: 'assistant', text: 'Which configuration?' },
      { role: 'user', text: requests[1] },
    ]);
    const sessions = [];
    for await (const session of codexAdapter.parse(path)) sessions.push(session);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].meta.sessionId).toBe('desktop-example');
    expect(sessions[0].messages.map(({ role, text }) => ({ role, text }))).toEqual(hook.turns);
    expect(sessions[0].messages.map((m) => m.timestamp)).toEqual([timestamp, timestamp, timestamp]);
  });
});
