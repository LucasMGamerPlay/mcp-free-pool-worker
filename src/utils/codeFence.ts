import { extname } from 'node:path';

const CODE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts']);

// a fence tag that means "this whole file is wrapped in a block of its own language"
const FENCE_TAGS: Record<string, string[]> = {
  '.md': ['md', 'markdown'],
  '.mdx': ['mdx', 'md', 'markdown'],
  '.py': ['python', 'py', 'python3'],
  '.go': ['go', 'golang'],
  '.rs': ['rust'],
  '.java': ['java'],
  '.kt': ['kotlin', 'kt'],
  '.cs': ['csharp', 'cs'],
  '.php': ['php'],
  '.rb': ['ruby', 'rb'],
  '.sql': ['sql'],
  '.css': ['css'],
  '.scss': ['scss'],
  '.html': ['html'],
  '.xml': ['xml'],
  '.yml': ['yaml', 'yml'],
  '.yaml': ['yaml', 'yml'],
  '.sh': ['bash', 'sh', 'shell', 'zsh'],
  '.ps1': ['powershell', 'ps1'],
  '.toml': ['toml'],
  '.json': ['json', 'jsonc'],
  '.jsonc': ['json', 'jsonc'],
};

/** Code files are always unwrapped; other files only when the tag matches their own language. */
export function normalizeOutput(filePath: string, raw: string): string {
  const ext = extname(filePath).toLowerCase();

  if (CODE_EXTENSIONS.has(ext)) return stripCodeFence(raw);

  const languages = FENCE_TAGS[ext];
  if (languages) {
    const whole = raw.trim().match(/^```([^\n]*)\n([\s\S]*?)\n?```$/);
    const tag = whole?.[1].trim().toLowerCase().split(/\s+/)[0] ?? '';
    // an untagged fence is left alone here: in a .md file it may be real content
    if (whole && languages.includes(tag)) return whole[2];
  }
  return raw.trimEnd() + '\n';
}

export function stripCodeFence(raw: string): string {
  const text = raw.trim();
  const whole = text.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  if (whole) return whole[1];

  const blocks = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)];
  if (blocks.length === 1) return blocks[0][1].replace(/\n+$/, '');
  return text;
}
