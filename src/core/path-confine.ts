/**
 * Shared symlink-safe path-confinement + dotfile-trust helpers.
 *
 * Consolidates the realpath-containment idiom that previously lived only in
 * `sources-ops.ts` (`isPathContained`) and `validateUploadPath`
 * (`operations.ts`), and adds `isTrustedDotfile` — the multi-user-host trust
 * gate for walk-up routing dotfiles (`.gbrain-source` / `.gbrain-mount`).
 *
 * Threat model (POSIX multi-user host): an attacker who can write into a
 * shared ancestor directory of the victim's CWD (`/tmp`, `/var/tmp`,
 * `/dev/shm`, shared NFS/SMB, CI runner volumes, container bind-mounts) can
 * plant a routing dotfile that silently retargets the victim's reads/writes
 * to the attacker's source/brain. The walk-up resolvers must therefore refuse
 * a dotfile they can't prove the victim (or root) owns. (#418/#419)
 *
 * Fail-closed: any stat/realpath error → not trusted / not contained. The one
 * documented exception is platforms without numeric uid (Windows), where the
 * multi-user-POSIX threat model does not apply and `isTrustedDotfile` trusts
 * by default so existing single-user setups keep working.
 */

import {
  realpathSync, existsSync, lstatSync, openSync, fstatSync, readFileSync,
  closeSync, constants, type Stats,
} from 'fs';
import { resolve as resolvePath, relative, isAbsolute, dirname, basename, join } from 'path';

/**
 * Symlink-safe path confinement: realpath BOTH sides, then a separator-aware
 * prefix check. A plain `startsWith()` on un-resolved paths would let a
 * `parent/skills` symlink → `/etc` (or `$GBRAIN_HOME/clones/<id>` → `/etc`)
 * bypass the boundary; resolving first defeats that.
 *
 * Returns true iff `child` exists AND its realpath is `parent`'s realpath or a
 * real subtree of it. Returns false if either path is unresolvable (missing /
 * permission) or the resolved child escapes — fail-closed.
 */
export function isPathContained(child: string, parent: string): boolean {
  let resolvedChild: string;
  let resolvedParent: string;
  try {
    resolvedChild = realpathSync(child);
    resolvedParent = realpathSync(parent);
  } catch {
    return false; // missing / unresolvable path → not contained
  }
  // `relative()` is separator-aware on every supported platform, unlike a
  // hard-coded `/` prefix check on Windows.
  const rel = relative(resolvedParent, resolvedChild);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Trust gate for a walk-up routing dotfile, given its `lstatSync` Stats.
 *
 * The caller MUST pass an `lstatSync` result, never `statSync` — `lstat` does
 * not follow symlinks, so a planted symlink redirect is visible here as
 * `isSymbolicLink()` instead of being followed-then-trusted.
 *
 * Rejects three classes of untrusted file:
 *   1. symlinks — an attacker-planted redirect to a file they control;
 *   2. foreign-owned — `uid` is neither the caller's nor root's (an attacker
 *      can't `chown` a file to the victim, so foreign ownership means planted;
 *      root-owned is trusted — root is the system admin and can write anywhere
 *      regardless);
 *   3. group/world-writable (`mode & 0o022`) — another account in a shared
 *      group can clobber it later even when ownership is currently legitimate.
 *
 * On platforms without `process.getuid` (Windows) returns true: the
 * multi-user-POSIX threat model does not apply and ownership is unknowable.
 */
export function isTrustedDotfile(stats: Stats): boolean {
  // Symlinks are never trusted, including on platforms without numeric uid.
  // This check must precede the Windows ownership fallback.
  if (stats.isSymbolicLink()) return false;
  // No numeric uid (Windows) → can't verify ownership; threat model N/A.
  if (typeof process.getuid !== 'function') return true;
  const myUid = process.getuid();
  // Foreign-owned (not me, not root) → planted. Root-owned is trusted.
  if (stats.uid !== myUid && stats.uid !== 0) return false;
  // Group/world-writable → another account may be able to retarget it later.
  if ((stats.mode & 0o022) !== 0) return false;
  return true;
}

/**
 * Open and read a routing dotfile without following its final symlink.
 * The pre-open lstat supplies the Windows no-symlink guard; O_NOFOLLOW closes
 * the POSIX lstat/open swap window, and fstat applies ownership/mode checks to
 * the actual opened file descriptor rather than a pathname snapshot.
 */
export function readTrustedDotfile(path: string): string | null {
  let fd: number | null = null;
  try {
    if (lstatSync(path).isSymbolicLink()) return null;
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stats = fstatSync(fd);
    if (!stats.isFile() || !isTrustedDotfile(stats)) return null;
    return readFileSync(fd, 'utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best-effort */ }
    }
  }
}

/**
 * Resolve a path through symlinks, falling back to lexical `resolve()` when the
 * path doesn't exist (stale registration). Used by the registered-path prefix
 * matchers so a symlinked CWD can't create a false prefix match against a
 * registered `local_path` / mount path while still tolerating a registered path
 * that no longer exists on disk.
 */
export function realpathOrResolve(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolvePath(p);
  }
}

/**
 * Containment check for a write TARGET that may not exist yet (a new page file).
 * `isPathContained` requires the child to already exist; this instead realpaths
 * the deepest EXISTING ancestor of `target` (catching a symlinked intermediate
 * directory that escapes the tree) and re-attaches the not-yet-created tail
 * lexically, then confirms the result stays within `root`.
 *
 * Defense-in-depth for the write-through FS sink (#1647-slug / codex #6):
 * `validateSlug` already rejects `..`/backslash/control/%2e in the slug, so this
 * guards a pre-existing hostile row or a symlinked source-tree subdirectory.
 */
export function isWriteTargetContained(target: string, root: string): boolean {
  const resolvedRoot = realpathOrResolve(root);
  let existing = resolvePath(target);
  const tail: string[] = [];
  for (let i = 0; i < 4096 && !existsSync(existing); i++) {
    tail.unshift(basename(existing));
    const parent = dirname(existing);
    if (parent === existing) break; // filesystem root
    existing = parent;
  }
  const base = realpathOrResolve(existing);
  const finalPath = tail.length ? join(base, ...tail) : base;
  const rel = relative(resolvedRoot, finalPath);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
