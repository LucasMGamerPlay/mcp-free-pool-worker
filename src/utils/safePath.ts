import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

export class UnsafePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafePathError';
  }
}

const BLOCKED: RegExp[] = [
  /(^|\/)\.env(\.[^/]*)?$/i,
  /\.(pem|key|p12|pfx|crt|jks|keystore|kdbx)$/i,
  /(^|\/)\.git(\/|$)/i,
  /(^|\/)\.(npmrc|netrc|pypirc|git-credentials)$/i,
  /(^|\/)\.(aws|docker|ssh)(\/|$)/i,
  /(^|\/)terraform\.tfstate(\.[^/]*)?$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|\/)credentials(\.[^/]*)?$/i,
  /(^|\/)secrets?(\.[^/]*)?$/i,
];

// A symlinked parent directory inside the root can point anywhere, so writes check
// the real path of the closest existing ancestor before handing the path back.
export function safeResolve(root: string, candidate: string): string {
  if (!candidate || candidate.trim() === '') throw new UnsafePathError('empty path');

  const absolute = resolve(root, candidate);
  assertInside(root, absolute, candidate);
  assertAllowed(absolute, candidate);

  const realDir = realAncestor(dirname(absolute));
  if (realDir && existsSync(root)) {
    const realRoot = realpathSync(root);
    assertInside(realRoot, join(realDir, basename(absolute)), candidate);
    assertAllowed(join(realDir, basename(absolute)), candidate);
  }
  return absolute;
}

/** For reads: follows symlinks, then re-checks the real path against the root and the blocklist. */
export function safeResolveExisting(root: string, candidate: string): string {
  const absolute = safeResolve(root, candidate);

  let real: string;
  let realRoot: string;
  try {
    real = realpathSync(absolute);
    realRoot = realpathSync(root);
  } catch {
    return absolute; // missing file: the caller reports it
  }

  assertInside(realRoot, real, candidate);
  assertAllowed(real, candidate);
  return real;
}

function realAncestor(path: string): string | null {
  let dir = path;
  for (let depth = 0; depth < 40; depth += 1) {
    if (existsSync(dir)) {
      try {
        return realpathSync(dir);
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function assertInside(root: string, absolute: string, candidate: string): void {
  const rel = relative(root, absolute);
  if (rel === '' || isAbsolute(rel) || rel.split(/[\\/]/)[0] === '..') {
    throw new UnsafePathError(`path escapes the workspace root: ${candidate}`);
  }
}

function assertAllowed(absolute: string, candidate: string): void {
  const normalized = absolute.replace(/\\/g, '/');
  for (const pattern of BLOCKED) {
    if (pattern.test(normalized)) throw new UnsafePathError(`blocked path: ${candidate}`);
  }
}
