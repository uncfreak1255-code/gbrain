import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const cli = resolve(import.meta.dir, '../node_modules/js-yaml/bin/js-yaml.js');
const yamlVersion = JSON.parse(readFileSync(resolve(import.meta.dir, '../node_modules/js-yaml/package.json'), 'utf8')).version;
function run(args: string[], input = ''): string {
  return execFileSync(process.execPath, ['run', cli, ...args], {
    input, encoding: 'utf8', timeout: 5_000, env: process.env,
  });
}

test('YAML CLI retains version and help with the formatter-free argument parser', () => {
  expect(run(['--version']).trim()).toBe(yamlVersion);
  expect(run(['--help'])).toContain('--compact');
});

test('YAML CLI preserves legacy scalar parsing and JSON-to-YAML output', () => {
  expect(JSON.parse(run([], 'value: 012\ncode: "001"\n'))).toEqual({ value: 10, code: '001' });
  const yaml = run([], '{"value":10,"code":"001"}');
  expect(JSON.parse(run([], yaml))).toEqual({ value: 10, code: '001' });
});
