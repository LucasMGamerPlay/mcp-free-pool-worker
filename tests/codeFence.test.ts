import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOutput, stripCodeFence } from '../src/utils/codeFence.js';

test('code files lose the fence whatever the tag says', () => {
  assert.equal(stripCodeFence('```ts\nexport const a = 1;\n```'), 'export const a = 1;');
  assert.equal(normalizeOutput('src/a.ts', '```typescript\nexport const a = 1;\n```'), 'export const a = 1;');
  assert.equal(normalizeOutput('a.js', 'Here it is:\n```js\nconst a = 1;\n```\n'), 'const a = 1;');
});

test('a markdown file wrapped in its own language is unwrapped', () => {
  const body = '# Title\n\nSome text.\n\n```bash\nnpm test\n```';
  assert.equal(normalizeOutput('README.md', '```markdown\n' + body + '\n```'), body);
});

test('fences inside a markdown file are kept when the tag does not match', () => {
  const body = '# Title\n\n```bash\nnpm test\n```';
  assert.equal(normalizeOutput('README.md', '```bash\nnpm test\n```\n'), '```bash\nnpm test\n```\n');
  assert.equal(normalizeOutput('README.md', body), body + '\n');
});

test('an untagged fence is not treated as a wrapper for non-code files', () => {
  assert.equal(normalizeOutput('notes.md', '```\njust text\n```\n'), '```\njust text\n```\n');
});

test('other languages are unwrapped only with a matching tag', () => {
  assert.equal(normalizeOutput('tools/x.py', '```python\nprint(1)\n```'), 'print(1)');
  assert.equal(normalizeOutput('q.sql', '```sql\nSELECT 1;\n```'), 'SELECT 1;');
  assert.equal(normalizeOutput('c.yaml', '```yaml\nk: v\n```'), 'k: v');
  assert.equal(normalizeOutput('c.yaml', '```toml\nk = 1\n```'), '```toml\nk = 1\n```\n');
});

test('plain output is kept and ends with a newline', () => {
  assert.equal(normalizeOutput('README.md', '# Title\n\nText'), '# Title\n\nText\n');
  assert.equal(normalizeOutput('a.css', 'body { color: red }\n\n\n'), 'body { color: red }\n');
});
