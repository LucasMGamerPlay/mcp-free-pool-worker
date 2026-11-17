/**
 * stdout is the JSON-RPC channel of the stdio transport. Never log there.
 */
export function log(message: string, ...extra: unknown[]): void {
  const suffix = extra.length ? ' ' + extra.map(stringify).join(' ') : '';
  process.stderr.write(`${new Date().toISOString()} [free-pool] ${message}${suffix}\n`);
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
