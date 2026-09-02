import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

interface Site {
  file: string;
  symbol: string;
  primitive: string;
  count: number;
  lines: number[];
  classification: string;
  boundary: string;
  reason: string;
  allowed_columns?: string[];
}

const root = join(import.meta.dir, '..');
const inventory = JSON.parse(
  readFileSync(join(import.meta.dir, 'fixtures/learning-loop-writer-inventory.json'), 'utf8'),
) as { schema_version: number; sites: Site[] };

const FILE_MUTATORS = new Set([
  'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'rename', 'renameSync',
  'unlink', 'unlinkSync', 'copyFile', 'copyFileSync', 'cp', 'cpSync', 'rm', 'rmSync',
  'createWriteStream',
]);
const PAGE_MUTATORS = new Set([
  'importFromContent', 'importFromFile', 'importFile', 'withImportTransaction', 'putPage',
  'deletePage', 'deletePages', 'softDeletePage', 'restorePage', 'purgeDeletedPages',
  'revertToVersion', 'updateSlug', 'refreshPageBody',
]);
const RAW_MUTATORS = new Set(['executeRaw', 'executeRawDirect', 'runMigration']);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

function directCallName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression) && ts.isStringLiteralLike(expression.argumentExpression)) {
    return expression.argumentExpression.text;
  }
  return null;
}

function receiverRootIdentifier(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    return receiverRootIdentifier(expression.expression);
  }
  return null;
}

function ownerSymbol(node: ts.Node): string {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if ((ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)
      || ts.isGetAccessorDeclaration(current) || ts.isSetAccessorDeclaration(current)) && current.name) {
      return current.name.getText();
    }
    if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current))
      && ts.isVariableDeclaration(current.parent)) return current.parent.name.getText();
  }
  return '<module>';
}

export function scanMutationSitesFromSource(sourceText: string, file = '<fixture>'): Array<Pick<Site, 'file' | 'symbol' | 'primitive' | 'count' | 'lines'>> {
  const counts = new Map<string, Pick<Site, 'file' | 'symbol' | 'primitive' | 'count' | 'lines'>>();
  const add = (file: string, symbol: string, primitive: string, line: number): void => {
    const key = `${file}\0${symbol}\0${primitive}`;
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
      existing.lines.push(line);
    } else counts.set(key, { file, symbol, primitive, count: 1, lines: [line] });
  };

  {
    const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
    const aliases = new Map<string, string>();
    const resolveName = (expression: ts.Expression): string | null => {
      const direct = directCallName(expression);
      return direct ? aliases.get(direct) ?? direct : null;
    };
    const collectAliases = (node: ts.Node): void => {
        if (ts.isImportSpecifier(node)) {
          const imported = node.propertyName?.text ?? node.name.text;
        if (FILE_MUTATORS.has(imported) || PAGE_MUTATORS.has(imported) || RAW_MUTATORS.has(imported)) aliases.set(node.name.text, imported);
      }
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const target = resolveName(node.initializer);
        if (target && (FILE_MUTATORS.has(target) || PAGE_MUTATORS.has(target) || RAW_MUTATORS.has(target)) && ts.isIdentifier(node.name)) {
          aliases.set(node.name.text, target);
        }
        if (ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            const imported = element.propertyName?.getText(source) ?? element.name.getText(source);
            if ((FILE_MUTATORS.has(imported) || PAGE_MUTATORS.has(imported) || RAW_MUTATORS.has(imported)) && ts.isIdentifier(element.name)) {
              aliases.set(element.name.text, imported);
            }
          }
        }
      }
      ts.forEachChild(node, collectAliases);
    };
    collectAliases(source);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const name = resolveName(node.expression);
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        if (name && FILE_MUTATORS.has(name)) add(file, ownerSymbol(node), `fs:${name}`, line);
        if (name && PAGE_MUTATORS.has(name)) add(file, ownerSymbol(node), `db:${name}`, line);
        if (ts.isElementAccessExpression(node.expression)
          && !ts.isStringLiteralLike(node.expression.argumentExpression)
          && /(?:fs|engine|database|client|query|transaction|tx)$/i.test(
            receiverRootIdentifier(node.expression.expression) ?? '',
          )) {
          throw new Error(`unresolved computed mutation call: ${file}:${line}`);
        }
        if (name && RAW_MUTATORS.has(name)) {
          const sql = node.arguments[0];
          if (sql && ts.isTemplateExpression(sql)) {
            const shape = `${sql.head.text}${sql.templateSpans.map(span => `__DYNAMIC__${span.literal.text}`).join('')}`;
            if (/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:ONLY\s+)?__DYNAMIC__/i.test(shape)) {
              add(file, ownerSymbol(node), 'sql:dynamic_table:mutation', line);
            }
          }
        }
      }
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
        for (const match of node.getText(source).matchAll(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:ONLY\s+)?pages\b/gi)) {
          add(file, ownerSymbol(node), `sql:${match[1].toLowerCase().replace(/\s+/g, '_')}:pages`, source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  return [...counts.values()].sort((left, right) =>
    `${left.file}\0${left.symbol}\0${left.primitive}`.localeCompare(`${right.file}\0${right.symbol}\0${right.primitive}`));
}

function scanProductionSites(): Array<Pick<Site, 'file' | 'symbol' | 'primitive' | 'count' | 'lines'>> {
  const merged = new Map<string, Pick<Site, 'file' | 'symbol' | 'primitive' | 'count' | 'lines'>>();
  for (const path of sourceFiles(join(root, 'src'))) {
    for (const site of scanMutationSitesFromSource(readFileSync(path, 'utf8'), relative(root, path))) {
      const key = `${site.file}\0${site.symbol}\0${site.primitive}`;
      const prior = merged.get(key);
      if (prior) { prior.count += site.count; prior.lines.push(...site.lines); }
      else merged.set(key, { ...site, lines: [...site.lines] });
    }
  }
  return [...merged.values()].sort((left, right) =>
    `${left.file}\0${left.symbol}\0${left.primitive}`.localeCompare(`${right.file}\0${right.symbol}\0${right.primitive}`));
}

describe('Learning Loop Phase 3 writer inventory', () => {
  test('classifies every exact production filesystem and page-row mutation site', () => {
    expect(inventory.schema_version).toBe(2);
    expect(inventory.sites.map(({ file, symbol, primitive, count, lines }) => ({ file, symbol, primitive, count, lines })))
      .toEqual(scanProductionSites());
  });

  test('requires a concrete boundary and exact derived-column allowlist', () => {
    const keys = inventory.sites.map(site => `${site.file}\0${site.symbol}\0${site.primitive}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const site of inventory.sites) {
      expect(site.file.startsWith('src/')).toBe(true);
      expect(site.symbol.length).toBeGreaterThan(0);
      expect(site.classification.length).toBeGreaterThan(0);
      expect(site.boundary.length).toBeGreaterThan(0);
      expect(site.reason.length).toBeGreaterThan(20);
      if (site.classification === 'derived_only') expect(site.allowed_columns?.length).toBeGreaterThan(0);
      else expect(site.allowed_columns).toBeUndefined();
    }
  });

  test('detects aliased raw page SQL mutation calls', () => {
    const sites = scanMutationSitesFromSource(
      'function f(engine: any, table: string) { const raw = engine.executeRaw; raw(`UPDATE ${table} SET x = 1`); }',
    );
    expect(sites.some(site => site.primitive === 'sql:dynamic_table:mutation')).toBe(true);
  });

  test('rejects unresolved computed mutations on nested receivers', () => {
    expect(() => scanMutationSitesFromSource(
      'function f(fs: any, method: string) { fs.promises[method]("x"); }',
    )).toThrow('unresolved computed mutation call');
  });
});
