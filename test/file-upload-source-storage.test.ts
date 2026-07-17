import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { sourceScopedStorageKey, storedObjectKey } from '../src/core/storage.ts';

let engine: PGLiteEngine;
let root: string;
let storageRoot: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config)
     VALUES ('source-b', 'Source B', '{}')
     ON CONFLICT (id) DO NOTHING`,
  );
  root = mkdtempSync(join(tmpdir(), 'gbrain-file-source-storage-'));
  storageRoot = join(root, 'objects');
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(root, { recursive: true, force: true });
});

function context(sourceId: string): OperationContext {
  return {
    engine,
    config: {
      engine: 'pglite',
      storage: { backend: 'local', bucket: 'test', localPath: storageRoot },
    } as OperationContext['config'],
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
    sourceId,
  };
}

describe('file_upload physical storage source isolation', () => {
  test('same logical path in two sources keeps separate bytes and URLs', async () => {
    const defaultDir = join(root, 'default-input');
    const sourceBDir = join(root, 'source-b-input');
    mkdirSync(defaultDir, { recursive: true });
    mkdirSync(sourceBDir, { recursive: true });
    const defaultFile = join(defaultDir, 'shared.pdf');
    const sourceBFile = join(sourceBDir, 'shared.pdf');
    writeFileSync(defaultFile, 'default bytes');
    writeFileSync(sourceBFile, 'source b bytes');

    const upload = operationsByName.file_upload;
    const logicalPath = 'docs/shared.pdf';
    const first = await upload.handler(context('default'), {
      path: defaultFile,
      page_slug: 'docs',
    }) as { storage_path: string };
    const second = await upload.handler(context('source-b'), {
      path: sourceBFile,
      page_slug: 'docs',
    }) as { storage_path: string };

    expect(first.storage_path).toBe(logicalPath);
    expect(second.storage_path).toBe(logicalPath);

    const defaultRow = await engine.getFile('default', logicalPath);
    const sourceBRow = await engine.getFile('source-b', logicalPath);
    expect(defaultRow).not.toBeNull();
    expect(sourceBRow).not.toBeNull();

    const defaultKey = storedObjectKey(defaultRow!);
    const sourceBKey = storedObjectKey(sourceBRow!);
    expect(defaultKey).toBe(sourceScopedStorageKey('default', logicalPath));
    expect(sourceBKey).toBe(sourceScopedStorageKey('source-b', logicalPath));
    expect(defaultKey).not.toBe(sourceBKey);
    expect(readFileSync(join(storageRoot, defaultKey), 'utf8')).toBe('default bytes');
    expect(readFileSync(join(storageRoot, sourceBKey), 'utf8')).toBe('source b bytes');

    const fileUrl = operationsByName.file_url;
    const defaultUrl = await fileUrl.handler(context('default'), {
      storage_path: logicalPath,
    }) as { url: string };
    const sourceBUrl = await fileUrl.handler(context('source-b'), {
      storage_path: logicalPath,
    }) as { url: string };
    expect(defaultUrl.url).toBe(`gbrain:files/${defaultKey}`);
    expect(sourceBUrl.url).toBe(`gbrain:files/${sourceBKey}`);
  });

  test('legacy rows without an object-key marker keep their old path', () => {
    expect(storedObjectKey({ storage_path: 'legacy/file.pdf', metadata: {} }))
      .toBe('legacy/file.pdf');
  });
});
