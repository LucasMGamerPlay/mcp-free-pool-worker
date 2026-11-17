import { readFile, stat } from 'node:fs/promises';
import { safeResolveExisting } from './safePath.js';

const MAX_FILE_BYTES = 1_000_000;
const MAX_TOTAL_BYTES = 3_000_000;

export interface ContextFile {
  path: string;
  content: string;
}

export async function readContextFiles(root: string, paths: string[]): Promise<ContextFile[]> {
  const files: ContextFile[] = [];
  let total = 0;

  for (const requested of paths) {
    const absolute = safeResolveExisting(root, requested);
    const info = await stat(absolute);
    if (!info.isFile()) throw new Error(`not a file: ${requested}`);
    if (info.size > MAX_FILE_BYTES) throw new Error(`file too large (${info.size} bytes): ${requested}`);
    if (total + info.size > MAX_TOTAL_BYTES) throw new Error(`context exceeds ${MAX_TOTAL_BYTES} bytes`);

    const content = await readFile(absolute, 'utf8');
    if (content.includes('\u0000')) throw new Error(`binary file: ${requested}`);

    total += info.size;
    files.push({ path: requested, content });
  }
  return files;
}
