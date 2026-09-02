import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquirePageLock } from './page-lock.ts';
import { parseLearningLoopFence, isLearningTransitionPermit, type LearningTransitionPermit } from './learning-loop-knowledge.ts';

export type CanonicalWriterMode = 'ordinary_content' | 'non_lineage_fact' | 'learning_transition' | 'checkout_rebuild';
export interface SourceQualifiedCanonicalTarget { brain_id: string; source_id: string; canonical_slug: string; configured_root: string; }
export type CanonicalWriteTarget = SourceQualifiedCanonicalTarget;
export interface SourceWriteLease { readonly __brand: 'SourceWriteLease'; readonly brain_id: string; readonly source_id: string; readonly configured_root: string; readonly root_realpath: string; readonly token: string; readonly dev: number; readonly ino: number; }
export interface CanonicalWriteOptions { mode: CanonicalWriterMode; lockRoot?: string; sourceLease: SourceWriteLease; transitionPermit?: LearningTransitionPermit; beforeRename?: () => void; }
const liveLeases = new WeakSet<object>();
const FACTS = /<!--- gbrain:facts:begin -->[\s\S]*?<!--- gbrain:facts:end -->/g;
const META = /<!-- gbrain:learning-loop:v1:begin -->[\s\S]*?<!-- gbrain:learning-loop:v1:end -->/g;
function validateTarget(t: SourceQualifiedCanonicalTarget): void {
  const parts = t.canonical_slug.split('/');
  if (!t.brain_id || !t.source_id || !t.canonical_slug || t.canonical_slug.includes('\0') || isAbsolute(t.canonical_slug) || parts.some(x => !x || x === '..' || x === '.')) {
    throw new Error('invalid canonical target');
  }
}
function markerCount(s: string, marker: string): number { return s.split(marker).length - 1; }
function blocks(s: string): [string, string] { const f = [...s.matchAll(FACTS)], m = [...s.matchAll(META)]; const malformed = markerCount(s, '<!--- gbrain:facts:begin -->') !== f.length || markerCount(s, '<!--- gbrain:facts:end -->') !== f.length || markerCount(s, '<!-- gbrain:learning-loop:v1:begin -->') !== m.length || markerCount(s, '<!-- gbrain:learning-loop:v1:end -->') !== m.length; if (malformed || f.length > 1 || m.length > 1 || (m.length && !parseLearningLoopFence(m[0][0]))) throw new Error('malformed or duplicate protected fence'); return [f[0]?.[0] ?? '', m[0]?.[0] ?? '']; }
function prepare(input: string, old: string, mode: CanonicalWriterMode, permit?: LearningTransitionPermit): string {
  const previous = blocks(old);
  const next = blocks(input);
  const managed = Boolean(previous[1]);
  if (!managed && next[1]) {
    throw new Error('managed_state_unavailable: metadata creation requires the lineage reducer');
  }
  if (managed && mode === 'learning_transition') {
    const previousKnowledge = parseLearningLoopFence(previous[1])!.value;
    const nextKnowledge = parseLearningLoopFence(next[1] ?? '')?.value;
    if (!permit || !isLearningTransitionPermit(permit, previousKnowledge, nextKnowledge)) {
      throw new Error('managed_state_unavailable: transition permit required');
    }
    return input;
  }
  if (managed && next.some((value, index) => value && value !== previous[index])) {
    throw new Error('managed_state_unavailable: protected fence changed');
  }
  let output = input;
  for (let index = 0; index < 2; index++) {
    if (previous[index]) {
      output = next[index] ? output.replace(next[index], previous[index]) : `${output.trimEnd()}\n\n${previous[index]}\n`;
    }
  }
  const staged = blocks(output);
  if (managed && (staged[0] !== previous[0] || staged[1] !== previous[1])) {
    throw new Error('managed_state_unavailable: staged fences changed');
  }
  return output;
}

function atomic(
  path: string,
  bytes: string,
  root: string,
  validateLease: () => void,
  beforeRename?: () => void,
): void {
  const lexicalParent = dirname(path);
  const parent = realpathSync(lexicalParent);
  if (!contained(parent, root)) throw new Error('canonical target rebind');
  const parentIdentity = statSync(parent);
  const destination = join(parent, basename(path));
  const tmp = join(parent, `.${basename(path)}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    beforeRename?.();
    validateLease();
    const checkedParent = statSync(parent);
    if (checkedParent.dev !== parentIdentity.dev || checkedParent.ino !== parentIdentity.ino || !contained(destination, root)) {
      throw new Error('canonical target rebind');
    }
    fd = openSync(tmp, 'wx', 0o600);
    writeFileSync(fd, bytes, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    blocks(bytes);
    validateLease();
    const currentParent = statSync(parent);
    if (currentParent.dev !== parentIdentity.dev || currentParent.ino !== parentIdentity.ino || !contained(destination, root)) {
      throw new Error('canonical target rebind');
    }
    renameSync(tmp, destination);
    validateLease();
    const directory = openSync(parent, 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch (error) {
    if (fd !== undefined) try { closeSync(fd); } catch { /* noop */ }
    try { unlinkSync(tmp); } catch { /* noop */ }
    throw error;
  }
}
function contained(p:string,r:string):boolean { const rel=relative(resolve(r),resolve(p)); return rel===''||(!rel.startsWith('..')&&!isAbsolute(rel)); }
export async function withSourceWriteLease<T>(target: SourceQualifiedCanonicalTarget, fn: (lease: SourceWriteLease) => Promise<T>, opts: { sourceLock: (target: SourceQualifiedCanonicalTarget) => Promise<() => Promise<void>> }): Promise<T> { const release=await opts.sourceLock(target); try { const configured_root=resolve(target.configured_root), root_realpath=realpathSync(configured_root), st=statSync(root_realpath); if(!st.isDirectory())throw new Error('canonical root unavailable'); const lease=Object.freeze({__brand:'SourceWriteLease' as const,brain_id:target.brain_id,source_id:target.source_id,configured_root,root_realpath,token:randomUUID(),dev:st.dev,ino:st.ino}); liveLeases.add(lease); try{return await fn(lease);}finally{liveLeases.delete(lease);} } finally { await release(); } }
function checkLease(t:SourceQualifiedCanonicalTarget,l:SourceWriteLease):void { const configured=resolve(t.configured_root), real=realpathSync(configured), st=statSync(real); if(!l || !liveLeases.has(l) || l.__brand!=='SourceWriteLease' || l.brain_id!==t.brain_id || l.source_id!==t.source_id || l.configured_root!==configured || l.root_realpath!==real || l.dev!==st.dev || l.ino!==st.ino) throw new Error('invalid or stale SourceWriteLease'); }
export async function writeCanonicalPage(target: SourceQualifiedCanonicalTarget, content: string, options: CanonicalWriteOptions): Promise<string> {
  validateTarget(target);
  checkLease(target, options.sourceLease);
  const root = options.sourceLease.root_realpath;
  const path = join(root, `${target.canonical_slug}.md`);
  const lock = await acquirePageLock(target.canonical_slug, { lockRoot: options.lockRoot, brainId: target.brain_id, sourceId: target.source_id });
  if (!lock) throw new Error('canonical page is busy');
  try {
    const current = (() => {
      try { return readFileSync(path, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
    })();
    const currentKnowledge = parseLearningLoopFence(current)?.value;
    if (currentKnowledge && (currentKnowledge.brain_id !== target.brain_id || currentKnowledge.source_id !== target.source_id || currentKnowledge.canonical_slug !== target.canonical_slug)) {
      throw new Error('managed_state_unavailable: metadata target mismatch');
    }
    const staged = prepare(content, current, options.mode, options.transitionPermit);
    atomic(path, staged, root, () => checkLease(target, options.sourceLease), options.beforeRename);
    const readback = readFileSync(path, 'utf8');
    if (readback !== staged) throw new Error('canonical readback mismatch');
    return readback;
  } finally {
    await lock.release();
  }
}
export const commitCanonicalPage=writeCanonicalPage;
