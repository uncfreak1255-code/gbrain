import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = process.cwd();
const pluginCore = await import(pathToFileURL('/Users/sawbeck/.understand-anything/repo/understand-anything-plugin/packages/core/dist/index.js').href);
const { validateGraph, autoFixGraph, saveGraph, saveMeta } = pluginCore;

const scan = JSON.parse(fs.readFileSync(path.join(projectRoot, '.understand-anything/tmp/ua-scan-files.json'), 'utf8'));
const importMap = JSON.parse(fs.readFileSync(path.join(projectRoot, '.understand-anything/tmp/ua-import-map-output.json'), 'utf8')).importMap;
const structural = JSON.parse(fs.readFileSync(path.join(projectRoot, '.understand-anything/tmp/ua-file-extract-results-structural.json'), 'utf8'));
const gitHash = fs.readFileSync(path.join(projectRoot, '.git/HEAD'), 'utf8').startsWith('ref:')
  ? await (async () => {
      const ref = fs.readFileSync(path.join(projectRoot, '.git/HEAD'), 'utf8').trim().slice(5);
      return fs.readFileSync(path.join(projectRoot, '.git', ref), 'utf8').trim();
    })()
  : fs.readFileSync(path.join(projectRoot, '.git/HEAD'), 'utf8').trim();

const now = new Date().toISOString();
const structuralMap = new Map(structural.results.map((r) => [r.path, r]));

const ignoredPrefixes = ['.understand-anything/'];
const ignoredNames = new Set(['.DS_Store']);
const includedFiles = scan.files.filter((f) => !ignoredNames.has(f.path) && !ignoredPrefixes.some((p) => f.path.startsWith(p)));

const textLanguageWhitelist = new Set(['typescript', 'javascript', 'markdown', 'yaml', 'json', 'shell', 'sql', 'html', 'css', 'toml']);
const languages = [...new Set(includedFiles.map((f) => f.language).filter((lang) => textLanguageWhitelist.has(lang)))].sort();
const frameworks = ['Bun', 'Express', 'React', 'PGLite', 'Postgres', 'Model Context Protocol', 'GitHub Actions'];

function extnameSafe(p) {
  const ext = path.extname(p).replace(/^\./, '');
  return ext.toLowerCase();
}

function topicFromPath(filePath) {
  const base = path.basename(filePath);
  if (base === 'SKILL.md') return path.basename(path.dirname(filePath));
  if (base === 'index.ts' || base === 'index.js' || base === 'index.tsx' || base === 'index.jsx') {
    return path.basename(path.dirname(filePath)).replace(/[-_]+/g, ' ');
  }
  return base.replace(/\.[^.]+$/, '').replace(/[._-]+/g, ' ');
}

function prettyTopic(filePath) {
  const raw = topicFromPath(filePath)
    .replace(/\bts\b|\btsx\b|\bjs\b|\bjsx\b|\bmd\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return raw || filePath;
}

function complexityForLines(lines) {
  if (lines < 80) return 'simple';
  if (lines < 500) return 'moderate';
  return 'complex';
}

function nodeTypeFor(file) {
  const p = file.path;
  if (file.fileCategory === 'docs') return 'document';
  if (file.fileCategory === 'config') return 'config';
  if (file.fileCategory === 'infra') {
    if (p.startsWith('.github/workflows/') || p === '.gitlab-ci.yml' || p === 'Jenkinsfile' || p.startsWith('.circleci/')) return 'pipeline';
    if (p.endsWith('.tf') || p.endsWith('.tfvars') || p.includes('cloudformation') || p === 'Vagrantfile') return 'resource';
    return 'service';
  }
  if (file.fileCategory === 'data') {
    if (p.endsWith('.sql')) return 'table';
    if (p.endsWith('.graphql') || p.endsWith('.gql') || p.endsWith('.proto') || p.endsWith('.prisma')) return 'schema';
    if (p.toLowerCase().includes('openapi') || p.toLowerCase().includes('swagger')) return 'endpoint';
    return 'schema';
  }
  return 'file';
}

function nodeIdFor(type, filePath) {
  return `${type}:${filePath}`;
}

function summaryFor(file, nodeType) {
  const p = file.path;
  const topic = prettyTopic(p);
  if (p === 'README.md') return 'Top-level product and operator overview for GBrain, including positioning, install paths, and query model.';
  if (p === 'AGENTS.md') return 'Repo-local operating instructions for agents working on GBrain, including trust boundaries, install flow, and shipping rules.';
  if (p === 'CLAUDE.md') return 'Architecture reference and contributor guide covering key files, test layout, and trust boundaries.';
  if (p === 'INSTALL_FOR_AGENTS.md') return 'Step-by-step install and verification protocol that agents follow to set up GBrain correctly.';
  if (p === 'docs/architecture/brains-and-sources.md') return 'Architecture guide explaining GBrain\'s two-axis routing model: brain selection and source selection.';
  if (p === 'skills/conventions/brain-routing.md') return 'Agent-facing routing guide for deciding when to switch brains, sources, or stay local.';
  if (p === 'skills/RESOLVER.md') return 'Skill dispatcher instructions that map GBrain tasks to the correct agent skill surface.';
  if (p === 'src/cli.ts') return 'Main CLI entrypoint that parses arguments and routes into the GBrain command surface.';
  if (p.startsWith('src/commands/')) return `CLI command implementation for ${topic}.`;
  if (p.startsWith('src/core/search/')) return `Core retrieval logic for ${topic}.`;
  if (p.startsWith('src/core/ai/')) return `AI gateway and model-integration logic for ${topic}.`;
  if (p.startsWith('src/core/minions/')) return `Background worker and minion runtime logic for ${topic}.`;
  if (p.startsWith('src/core/')) return `Core brain runtime logic for ${topic}.`;
  if (p.startsWith('src/mcp/')) return `MCP server and tool-dispatch logic for ${topic}.`;
  if (p.startsWith('admin/src/')) return `Admin dashboard UI logic for ${topic}.`;
  if (p.startsWith('admin/')) return `Admin surface asset for ${topic}.`;
  if (p.endsWith('/SKILL.md')) return `Agent skill definition for ${topic}.`;
  if (p.startsWith('skills/')) return `Agent-surface documentation or support file for ${topic}.`;
  if (p.startsWith('docs/')) return `Project documentation covering ${topic}.`;
  if (p.startsWith('test/e2e/')) return `End-to-end test coverage for ${topic}.`;
  if (p.startsWith('test/')) return `Automated test coverage for ${topic}.`;
  if (p.startsWith('scripts/')) return `Project automation script for ${topic}.`;
  if (p.startsWith('tools/')) return `Contributor utility for ${topic}.`;
  if (p.startsWith('.github/workflows/')) return `GitHub Actions workflow for ${topic}.`;
  if (p === 'package.json') return 'Workspace package manifest defining the CLI entrypoint, scripts, and dependency surface for GBrain.';
  if (nodeType === 'document') return `Documentation covering ${topic}.`;
  if (nodeType === 'config') return `Configuration file for ${topic}.`;
  if (nodeType === 'pipeline') return `Pipeline configuration for ${topic}.`;
  if (nodeType === 'service') return `Service or deployment definition for ${topic}.`;
  if (nodeType === 'resource') return `Infrastructure resource definition for ${topic}.`;
  if (nodeType === 'table') return `SQL schema or migration surface for ${topic}.`;
  if (nodeType === 'schema') return `Schema or structured data definition for ${topic}.`;
  return `Source file for ${topic}.`;
}

function tagsFor(file, nodeType) {
  const p = file.path;
  const tags = new Set();
  const add = (tag) => tags.size < 5 && tag && tags.add(tag);

  if (nodeType === 'document') add('documentation');
  if (nodeType === 'config') add('configuration');
  if (nodeType === 'pipeline') add('ci-cd');
  if (nodeType === 'service') add('deployment');
  if (nodeType === 'resource') add('infrastructure');
  if (nodeType === 'schema') add('schema-definition');
  if (nodeType === 'table') add('database');
  if (p.startsWith('test/')) add('test');
  if (p.startsWith('src/commands/')) add('cli-command');
  if (p.startsWith('src/core/')) add('core-runtime');
  if (p.startsWith('src/mcp/')) add('mcp');
  if (p.startsWith('admin/')) add('admin-ui');
  if (p.startsWith('skills/')) add('agent-skill');
  if (p.startsWith('docs/')) add('docs');
  if (p.startsWith('scripts/')) add('automation');
  if (p.includes('autopilot')) add('autopilot');
  if (p.includes('doctor')) add('health');
  if (p.includes('sync')) add('sync');
  if (p.includes('search')) add('retrieval');
  if (p.includes('minions')) add('workers');
  if (p.includes('mcp')) add('mcp');
  if (p.includes('think')) add('synthesis');
  if (p.includes('config')) add('config');
  if (tags.size === 0) add('codebase');
  return [...tags];
}

function functionSummary(name, filePath) {
  return `Function ${name} defined in ${path.basename(filePath)}.`;
}
function classSummary(name, filePath) {
  return `Class or type ${name} defined in ${path.basename(filePath)}.`;
}

const nodes = [];
const edges = [];
const edgeKeys = new Set();
const fileNodeIdByPath = new Map();
const fileNodeTypeByPath = new Map();

for (const file of includedFiles) {
  const nodeType = nodeTypeFor(file);
  const id = nodeIdFor(nodeType, file.path);
  const node = {
    id,
    type: nodeType,
    name: path.basename(file.path),
    filePath: file.path,
    summary: summaryFor(file, nodeType),
    tags: tagsFor(file, nodeType),
    complexity: complexityForLines(file.sizeLines),
  };
  nodes.push(node);
  fileNodeIdByPath.set(file.path, id);
  fileNodeTypeByPath.set(file.path, nodeType);
}

for (const result of structural.results) {
  const parentId = fileNodeIdByPath.get(result.path);
  if (!parentId) continue;
  const parentComplexity = complexityForLines(result.totalLines || 0);
  const seenNames = new Set();
  for (const fn of result.functions || []) {
    const childId = `function:${result.path}:${fn.name}`;
    if (seenNames.has(childId)) continue;
    seenNames.add(childId);
    nodes.push({
      id: childId,
      type: 'function',
      name: fn.name,
      filePath: result.path,
      lineRange: [fn.startLine, fn.endLine],
      summary: functionSummary(fn.name, result.path),
      tags: ['function'],
      complexity: parentComplexity,
    });
    edges.push({ source: parentId, target: childId, type: 'contains', direction: 'forward', weight: 1 });
  }
  for (const cls of result.classes || []) {
    const childId = `class:${result.path}:${cls.name}`;
    if (seenNames.has(childId)) continue;
    seenNames.add(childId);
    nodes.push({
      id: childId,
      type: 'class',
      name: cls.name,
      filePath: result.path,
      lineRange: [cls.startLine, cls.endLine],
      summary: classSummary(cls.name, result.path),
      tags: ['class'],
      complexity: parentComplexity,
    });
    edges.push({ source: parentId, target: childId, type: 'contains', direction: 'forward', weight: 1 });
  }

  const localFns = new Set((result.functions || []).map((fn) => fn.name));
  for (const cg of result.callGraph || []) {
    if (!localFns.has(cg.caller) || !localFns.has(cg.callee)) continue;
    const source = `function:${result.path}:${cg.caller}`;
    const target = `function:${result.path}:${cg.callee}`;
    const key = `calls|${source}|${target}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    edges.push({ source, target, type: 'calls', direction: 'forward', weight: 0.8 });
  }
}

for (const [fromFile, targets] of Object.entries(importMap)) {
  const source = fileNodeIdByPath.get(fromFile);
  if (!source) continue;
  for (const targetPath of targets) {
    const target = fileNodeIdByPath.get(targetPath);
    if (!target || source === target) continue;
    const key = `imports|${source}|${target}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    edges.push({ source, target, type: 'imports', direction: 'forward', weight: 0.7 });
  }
}

const layerDefs = [
  ['Runtime Core', 'Core engine, storage, search, and background-runtime implementation.', (p) => p.startsWith('src/core/') || p === 'src/version.ts' || p === 'src/openclaw-context-engine.ts'],
  ['CLI Commands', 'Top-level CLI entrypoint and user-facing command implementations.', (p) => p === 'src/cli.ts' || p.startsWith('src/commands/')],
  ['MCP and Serving', 'Remote access surfaces, HTTP serving, and MCP wiring.', (p) => p.startsWith('src/mcp/') || p === 'src/commands/serve-http.ts' || p.includes('serve-http')],
  ['Admin UI', 'Admin dashboard frontend assets and pages.', (p) => p.startsWith('admin/')],
  ['Agent Skills and Protocols', 'Agent instructions, skills, and operating contracts for working with GBrain.', (p) => p.startsWith('skills/') || p === 'AGENTS.md' || p === 'CLAUDE.md' || p === 'INSTALL_FOR_AGENTS.md'],
  ['Documentation', 'Architecture, install, and usage documentation for operators and contributors.', (p) => p.startsWith('docs/') || p === 'README.md' || p === 'llms.txt' || p === 'llms-full.txt'],
  ['Tests and Verification', 'Unit and end-to-end proof surfaces that pin runtime and behavioral contracts.', (p) => p.startsWith('test/')],
  ['Evaluation and Benchmarks', 'Evaluation corpora, experiments, and benchmark helpers.', (p) => p.startsWith('eval/') || p.startsWith('evals/')],
  ['Automation Scripts', 'Contributor automation, build helpers, and repository utility tooling.', (p) => p.startsWith('scripts/') || p.startsWith('tools/') || p.startsWith('bin/')],
  ['Infrastructure and Config', 'Repository configuration, workflows, deployment files, and other operational scaffolding.', (p, type) => p.startsWith('.github/') || p.startsWith('supabase/') || ['config','pipeline','service','resource','schema','table','endpoint'].includes(type)],
  ['Miscellaneous', 'Files that do not fit the main architectural buckets but still belong to the repository surface.', () => true],
];

const layerBuckets = new Map(layerDefs.map(([name]) => [name, []]));
for (const file of includedFiles) {
  const nodeId = fileNodeIdByPath.get(file.path);
  const nodeType = fileNodeTypeByPath.get(file.path);
  for (const [name, _description, predicate] of layerDefs) {
    if (predicate(file.path, nodeType)) {
      layerBuckets.get(name).push(nodeId);
      break;
    }
  }
}
const layers = layerDefs.map(([name, description]) => ({
  id: `layer:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
  name,
  description,
  nodeIds: layerBuckets.get(name),
})).filter((layer) => layer.nodeIds.length > 0);

const stepSpecs = [
  ['Project Overview', 'Start with the high-level product story and the repo-local operating contract for agents installing or using GBrain.', ['README.md','AGENTS.md','INSTALL_FOR_AGENTS.md']],
  ['Architecture Model', 'Read the architecture references that explain how brains, sources, routing, and agent skills fit together before touching runtime code.', ['CLAUDE.md','docs/architecture/brains-and-sources.md','skills/conventions/brain-routing.md','skills/RESOLVER.md']],
  ['CLI Entry Surface', 'Follow how the binary boots, which scripts ship with it, and where user-facing commands enter the system.', ['package.json','src/cli.ts','src/commands/sources.ts']],
  ['Core Engine', 'These files define the storage engines, config model, and main operations surface that the rest of GBrain builds on.', ['src/core/engine.ts','src/core/pglite-engine.ts','src/core/config.ts','src/core/operations.ts']],
  ['Retrieval and Thinking', 'This step shows the retrieval stack and synthesis path that turn stored pages into answers instead of raw search hits.', ['src/core/search/hybrid.ts','src/core/think/index.ts','src/core/ai/gateway.ts']],
  ['Maintenance Loops', 'These files implement sync, doctor, autopilot, and cycle orchestration: the surfaces that keep the brain fresh without constant manual babysitting.', ['src/commands/sync.ts','src/commands/doctor.ts','src/commands/autopilot.ts','src/core/cycle.ts']],
  ['Remote Access and Admin', 'This is the MCP and HTTP serving surface, plus the admin UI and deploy docs for exposing GBrain outside the local CLI.', ['src/mcp/server.ts','src/commands/serve-http.ts','admin/src/App.tsx','docs/mcp/DEPLOY.md']],
  ['Proof Surfaces', 'End with the verification docs and representative tests that show how runtime truth gets pinned in practice.', ['docs/GBRAIN_VERIFY.md','test/e2e/status-pglite.test.ts','test/autopilot-health.test.ts']],
];
const tours = stepSpecs.map(([title, description, files], index) => ({
  order: index + 1,
  title,
  description,
  nodeIds: files.map((f) => fileNodeIdByPath.get(f)).filter(Boolean),
})).filter((step) => step.nodeIds.length > 0);

const graph = {
  version: '1.0.0',
  kind: 'codebase',
  project: {
    name: 'gbrain',
    languages,
    frameworks,
    description: 'Postgres-native personal and company brain with hybrid retrieval, synthesis, graph traversal, and agent-facing maintenance surfaces. This graph is structural-first so it stays usable on a very large repo.',
    analyzedAt: now,
    gitCommitHash: gitHash,
  },
  nodes,
  edges,
  layers,
  tour: tours,
};

let validation = validateGraph(graph);
let finalGraph = graph;
if (!validation.success || (validation.issues && validation.issues.length > 0)) {
  const fixed = autoFixGraph(graph);
  validation = validateGraph(fixed.data);
  if (validation.success && validation.data) finalGraph = validation.data;
}
if (!validation.success || !validation.data) {
  console.error(JSON.stringify(validation, null, 2));
  process.exit(1);
}
finalGraph = validation.data;
saveGraph(projectRoot, finalGraph);
saveMeta(projectRoot, {
  lastAnalyzedAt: now,
  gitCommitHash: gitHash,
  version: '1.0.0',
  analyzedFiles: includedFiles.length,
});

const byType = finalGraph.nodes.reduce((acc, node) => { acc[node.type] = (acc[node.type] || 0) + 1; return acc; }, {});
const byEdgeType = finalGraph.edges.reduce((acc, edge) => { acc[edge.type] = (acc[edge.type] || 0) + 1; return acc; }, {});
const summary = {
  filesIncluded: includedFiles.length,
  totalScanFiles: scan.totalFiles,
  nodes: finalGraph.nodes.length,
  edges: finalGraph.edges.length,
  layers: finalGraph.layers.map((l) => ({ name: l.name, count: l.nodeIds.length })),
  byType,
  byEdgeType,
  issues: validation.issues || [],
};
fs.writeFileSync(path.join(projectRoot, '.understand-anything/intermediate/ua-build-summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
