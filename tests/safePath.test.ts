import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { safeResolve, safeResolveExisting, UnsafePathError } from '../src/utils/safePath.js';

const root = resolve('fixture-root');

test('accepts paths inside the root', () => {
  assert.equal(safeResolve(root, 'src/a.ts'), resolve(root, 'src/a.ts'));
  assert.equal(safeResolve(root, 'src/../src/a.ts'), resolve(root, 'src/a.ts'));
});

test('accepts absolute paths inside the root', () => {
  assert.equal(safeResolve(root, resolve(root, 'a.ts')), resolve(root, 'a.ts'));
});

test('rejects traversal outside the root', () => {
  assert.throws(() => safeResolve(root, '../secret.txt'), UnsafePathError);
  assert.throws(() => safeResolve(root, '..'), UnsafePathError);
  assert.throws(() => safeResolve(root, resolve(root, '../outside.ts')), UnsafePathError);
});

test('rejects sensitive files', () => {
  const blocked = [
    '.env',
    '.env.local',
    'config/.env.production',
    'keys/server.pem',
    'id_rsa',
    'credentials.json',
    '.git/config',
    'app.key',
    '.npmrc',
    'home/.netrc',
    '.pypirc',
    '.git-credentials',
    '.aws/credentials',
    '.ssh/config',
    '.docker/config.json',
    'infra/terraform.tfstate',
    'terraform.tfstate.backup',
    'app.jks',
    'release.keystore',
    'vault.kdbx',
  ];
  for (const candidate of blocked) {
    assert.throws(() => safeResolve(root, candidate), UnsafePathError, candidate);
  }
});

test('still accepts ordinary dotfiles', () => {
  for (const candidate of ['.editorconfig', '.github/workflows/ci.yml', '.gitignore']) {
    assert.equal(safeResolve(root, candidate), resolve(root, candidate), candidate);
  }
});

test('rejects empty paths', () => {
  assert.throws(() => safeResolve(root, ''), UnsafePathError);
  assert.throws(() => safeResolve(root, '   '), UnsafePathError);
});

test('reads follow links and still stay inside the root', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'free-pool-link-'));
  const outside = mkdtempSync(join(tmpdir(), 'free-pool-out-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  writeFileSync(join(dir, 'ok.txt'), 'ok');
  writeFileSync(join(dir, '.env'), 'SECRET=1');
  writeFileSync(join(outside, 'secret.txt'), 'SECRET');

  // junctions need no privileges on Windows and behave as directory symlinks elsewhere
  symlinkSync(outside, join(dir, 'outside-link'), 'junction');
  symlinkSync(dir, join(dir, 'alias'), 'junction');

  assert.equal(safeResolveExisting(dir, 'ok.txt'), realpathSync(join(dir, 'ok.txt')));
  assert.throws(
    () => safeResolveExisting(dir, 'outside-link/secret.txt'),
    UnsafePathError,
    'a link that leaves the root is still rejected',
  );
  assert.throws(
    () => safeResolveExisting(dir, 'alias/.env'),
    UnsafePathError,
    'a link to a blocked file is rejected by its real name',
  );
  assert.throws(
    () => safeResolve(dir, 'outside-link/new.ts'),
    UnsafePathError,
    'a write through a link that leaves the root is rejected before it happens',
  );
  assert.equal(safeResolve(dir, 'not-yet-created/new.ts'), join(dir, 'not-yet-created', 'new.ts'));
});
