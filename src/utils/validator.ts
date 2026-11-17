import { execFileSync } from 'node:child_process';
import { extname } from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface ValidationResult {
  ok: boolean;
  skipped?: boolean;
  message?: string;
}

const JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts']);
const YAML_EXTENSIONS = new Set(['.yml', '.yaml']);

let pythonBinary: string | null | undefined;

export async function validateContent(filePath: string, content: string): Promise<ValidationResult> {
  const ext = extname(filePath).toLowerCase();

  if (ext === '.json') {
    try {
      JSON.parse(content);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: `invalid JSON: ${(error as Error).message}` };
    }
  }

  if (YAML_EXTENSIONS.has(ext)) {
    try {
      parseYaml(content);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: `invalid YAML: ${(error as Error).message.split('\n').slice(0, 3).join(' | ')}` };
    }
  }

  if (ext === '.py') {
    if (!findPython()) return { ok: true, skipped: true, message: 'python not found, syntax not checked' };
    return validatePython(content);
  }

  if (!JS_EXTENSIONS.has(ext)) {
    return { ok: true, skipped: true, message: `no validator for ${ext || 'extensionless'} files` };
  }

  let ts: typeof import('typescript');
  try {
    ts = await import('typescript');
  } catch {
    return { ok: true, skipped: true, message: 'typescript not installed, syntax not checked' };
  }

  const { diagnostics } = ts.transpileModule(content, {
    fileName: filePath,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.Preserve,
    },
  });

  const errors = (diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length === 0) return { ok: true };

  const message = errors
    .slice(0, 3)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
    .join(' | ');
  return { ok: false, message };
}

/** CPython's own parser, over stdin so no temp file is needed. */
function validatePython(content: string): ValidationResult {
  try {
    execFileSync(findPython()!, ['-c', 'import ast, sys; ast.parse(sys.stdin.read())'], {
      input: content,
      timeout: 10_000,
      stdio: ['pipe', 'ignore', 'pipe'],
      encoding: 'utf8',
    });
    return { ok: true };
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? (error as Error).message;
    return { ok: false, message: `invalid Python: ${stderr.trim().split('\n').slice(-1)[0] ?? 'parse error'}` };
  }
}

/** `null` means "probed and absent": python validation degrades to skipped. */
function findPython(): string | null {
  if (pythonBinary !== undefined) return pythonBinary;

  pythonBinary = null;
  for (const candidate of [process.env.PYTHON?.trim(), 'python', 'python3'].filter(Boolean) as string[]) {
    try {
      execFileSync(candidate, ['-c', 'import ast'], { timeout: 5_000, stdio: 'ignore' });
      pythonBinary = candidate;
      break;
    } catch {
      // try the next name
    }
  }
  return pythonBinary;
}
