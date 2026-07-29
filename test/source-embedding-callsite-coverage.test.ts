/**
 * Structural inventory for document-side embedding submissions.
 *
 * Source-owned content must acquire a durable source embedding lease before
 * each provider submission. Query vectors and provider smoke probes do not
 * represent stored source content and intentionally remain unguarded. This
 * exact callsite inventory makes a newly-added document embedding fail CI
 * until its owner classifies and guards it.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const ROOT = join(import.meta.dir, '..');
const SRC = join(ROOT, 'src');
const DOCUMENT_EMBED_EXPORTS = new Set([
  'embed',
  'embedOne',
  'embedBatch',
  'embedMultimodal',
  'embedMultimodalSafe',
]);

function isEmbeddingModule(moduleName: string): boolean {
  return /(?:^|\/)(?:embedding|ai\/gateway)(?:\.ts)?$/.test(moduleName);
}

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

function functionName(node: ts.Node): string {
  let current: ts.Node | undefined = node;
  while (current) {
    if (
      (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current))
      && current.name
    ) return current.name.getText();
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const parent = current.parent;
      if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
      if (ts.isPropertyAssignment(parent)) return parent.name.getText();
    }
    current = current.parent;
  }
  return '<top-level>';
}

function inventory(): string[] {
  const counts = new Map<string, number>();
  for (const path of tsFiles(SRC)) {
    const repoPath = relative(ROOT, path).replaceAll('\\', '/');
    // These two files implement the provider/wrapper primitives themselves;
    // their recursive/internal calls are not application touchpoints.
    if (repoPath === 'src/core/ai/gateway.ts' || repoPath === 'src/core/embedding.ts') continue;

    const text = readFileSync(path, 'utf8');
    const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const imports = new Map<string, string>();
    const namespaces = new Set<string>();
    for (const statement of sf.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const moduleName = statement.moduleSpecifier.text;
      if (!isEmbeddingModule(moduleName)) continue;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings) continue;
      if (ts.isNamespaceImport(bindings)) {
        namespaces.add(bindings.name.text);
        continue;
      }
      for (const specifier of bindings.elements) {
        const imported = specifier.propertyName?.text ?? specifier.name.text;
        if (DOCUMENT_EMBED_EXPORTS.has(imported)) imports.set(specifier.name.text, imported);
      }
    }

    // CLI probe paths deliberately lazy-import the gateway so `--help` and
    // offline commands do not initialize providers. Include destructured
    // dynamic imports in the same inventory; otherwise a new unguarded call
    // could evade the static-import allowlist just by changing import style.
    const collectDynamicImports = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node)
        && ts.isObjectBindingPattern(node.name)
        && node.initializer
      ) {
        const awaited = ts.isAwaitExpression(node.initializer)
          ? node.initializer.expression
          : node.initializer;
        if (
          ts.isCallExpression(awaited)
          && awaited.expression.kind === ts.SyntaxKind.ImportKeyword
          && awaited.arguments.length === 1
          && ts.isStringLiteral(awaited.arguments[0])
        ) {
          const moduleName = awaited.arguments[0].text;
          if (isEmbeddingModule(moduleName)) {
            for (const element of node.name.elements) {
              if (!ts.isIdentifier(element.name)) continue;
              const imported = element.propertyName && ts.isIdentifier(element.propertyName)
                ? element.propertyName.text
                : element.name.text;
              if (DOCUMENT_EMBED_EXPORTS.has(imported)) imports.set(element.name.text, imported);
            }
          }
        }
      }
      ts.forEachChild(node, collectDynamicImports);
    };
    collectDynamicImports(sf);

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const imported = imports.get(node.expression.text);
        if (imported) {
          const key = `${repoPath}:${functionName(node)}:${imported}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
      if (
        ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && namespaces.has(node.expression.expression.text)
        && DOCUMENT_EMBED_EXPORTS.has(node.expression.name.text)
      ) {
        const key = `${repoPath}:${functionName(node)}:${node.expression.name.text}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([key, count]) => `${key} x${count}`);
}

describe('source embedding provider callsite inventory', () => {
  test('every document-side call is either lease-guarded or explicitly query/smoke-only', () => {
    const sourceOwned = [
      'src/commands/embed.ts:embedBatchWithBackoff:embedBatch x2',
      'src/commands/embed.ts:embedOnePage:embedBatch x1',
      'src/commands/embed.ts:embedPage:embedBatch x1',
      'src/commands/reindex-multimodal.ts:runReindexMultimodal:embedMultimodalSafe x1',
      'src/core/contextual-retrieval-service.ts:tryBuildPhase1:embedBatch x2',
      'src/core/cycle/extract-facts.ts:runExtractFacts:embedBatch x1',
      // One guarded production branch plus the explicit engine-less smoke
      // fallback. Production callers are pinned to sourceId below.
      'src/core/facts/extract.ts:extractFactsFromTurn:embedOne x2',
      'src/core/import-file.ts:importCodeFile:embedBatch x1',
      'src/core/import-file.ts:importFromContent:embedBatch x1',
      'src/core/import-file.ts:importImageFile:embedMultimodal x1',
    ];
    const queryOrSmokeOnly = [
      'src/commands/doctor.ts:buildChecks:embedOne x1',
      'src/commands/models.ts:probeEmbeddingReachability:embed x1',
      'src/commands/providers.ts:runTest:embedOne x1',
      'src/core/init-embed-check.ts:liveTestEmbed:embed x1',
      // Image-as-query embeds caller bytes for immediate retrieval and does
      // not persist them as a source-owned document.
      'src/core/operations.ts:handler:embedMultimodal x1',
      'src/core/search/eval.ts:runQuery:embed x1',
    ];
    expect(inventory()).toEqual([...sourceOwned, ...queryOrSmokeOnly].sort());
  });

  test('guarded files keep the lease adapter and exact source threading', () => {
    const expectations: Array<[string, RegExp[]]> = [
      ['src/core/import-file.ts', [/withActiveSourceProviderLease/, /sourceId \?\? 'default'/]],
      ['src/core/contextual-retrieval-service.ts', [/withActiveSourceProviderLease/, /args\.sourceId/]],
      ['src/core/cycle/extract-facts.ts', [/withActiveSourceProviderLease/, /sourceId/]],
      ['src/core/facts/extract.ts', [/withActiveSourceProviderLease/, /input\.sourceId/]],
      ['src/commands/reindex-multimodal.ts', [/withActiveSourceProviderLease/, /page\.source_id/]],
      ['src/commands/embed.ts', [/withActiveSourceProviderLease/, /sourceId/]],
    ];
    for (const [repoPath, patterns] of expectations) {
      const text = readFileSync(join(ROOT, repoPath), 'utf8');
      for (const pattern of patterns) expect(text).toMatch(pattern);
    }

    // Both production fact-extraction callers know the exact DB source. The
    // engine-less smoke/eval calls intentionally omit it and never write.
    expect(readFileSync(join(ROOT, 'src/commands/extract-conversation-facts.ts'), 'utf8'))
      .toMatch(/sourceId: state\.sourceId/);
    expect(readFileSync(join(ROOT, 'src/core/facts/backstop.ts'), 'utf8'))
      .toMatch(/sourceId: ctx\.sourceId/);
  });
});
