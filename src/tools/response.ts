export function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

export function fail(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text' as const, text: `ERROR: ${message}` }], isError: true };
}

const SKIP_STATUSES = new Set(['no-key', 'cooldown', 'disabled', 'context']);

/** `attempts` holds failures and skips only; a provider that was never called is not a failure. */
export function fallbackNote(attempts: Array<{ status: string }>): string {
  if (attempts.length === 0) return '';

  const skipped = attempts.filter((attempt) => SKIP_STATUSES.has(attempt.status)).length;
  const failed = attempts.length - skipped;
  const parts = [
    failed > 0 ? `${failed} failed attempt(s)` : '',
    skipped > 0 ? `${skipped} provider(s) skipped` : '',
  ].filter(Boolean);

  return ` | fell back after ${parts.join(' and ')}`;
}
