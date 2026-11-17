export type BreakerState = 'closed' | 'open' | 'half-open';

export interface BreakerOptions {
  cooldownMs?: number;
  maxCooldownMs?: number;
}

const DEFAULT_COOLDOWN_MS = 60_000;
const DEFAULT_MAX_COOLDOWN_MS = 15 * 60_000;

export class CircuitBreaker {
  private failures = 0;
  private openUntil = 0;
  private probeInFlight = false;
  private disabledReason: string | null = null;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly options: BreakerOptions = {},
  ) {}

  get disabled(): string | null {
    return this.disabledReason;
  }

  get failureCount(): number {
    return this.failures;
  }

  state(): BreakerState {
    if (this.disabledReason) return 'open';
    if (this.now() < this.openUntil) return 'open';
    return this.failures > 0 ? 'half-open' : 'closed';
  }

  /** Claims a slot. In half-open only a single probe is allowed. */
  tryAcquire(): boolean {
    if (this.disabledReason) return false;
    const current = this.state();
    if (current === 'open') return false;
    if (current === 'half-open') {
      if (this.probeInFlight) return false;
      this.probeInFlight = true;
    }
    return true;
  }

  release(): void {
    this.probeInFlight = false;
  }

  cooldownRemainingMs(): number {
    return Math.max(0, this.openUntil - this.now());
  }

  onSuccess(): void {
    this.failures = 0;
    this.openUntil = 0;
    this.probeInFlight = false;
  }

  onRateLimit(retryAfterMs?: number | null, baseCooldownMs?: number): void {
    this.open(retryAfterMs, baseCooldownMs);
  }

  onServerError(): void {
    this.open(null);
  }

  onInvalidKey(reason: string): void {
    this.disabledReason = reason;
    this.probeInFlight = false;
  }

  snapshot(): { failures: number; openUntil: number } {
    return { failures: this.failures, openUntil: this.openUntil };
  }

  restore(snapshot: { failures: number; openUntil: number }): void {
    this.failures = Number.isFinite(snapshot.failures) ? Math.max(0, Math.trunc(snapshot.failures)) : 0;
    this.openUntil = Number.isFinite(snapshot.openUntil) ? Math.max(0, Math.trunc(snapshot.openUntil)) : 0;
    this.probeInFlight = false;
  }

  private open(retryAfterMs?: number | null, baseCooldownMs?: number): void {
    this.failures += 1;
    const base = baseCooldownMs ?? this.options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    const cap = Math.max(this.options.maxCooldownMs ?? DEFAULT_MAX_COOLDOWN_MS, base);
    const backoff = Math.min(base * 2 ** (this.failures - 1), cap);
    const cooldown = retryAfterMs && retryAfterMs > 0 ? Math.max(retryAfterMs, 1_000) : backoff;
    this.openUntil = this.now() + cooldown;
    this.probeInFlight = false;
  }
}

const UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Handles "120", HTTP-date and Groq-style "1m2.4s" values. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1_000);

  const parts = /(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)/gi;
  let total = 0;
  let consumed = 0;
  let match: RegExpExecArray | null;
  while ((match = parts.exec(trimmed))) {
    total += Number(match[1]) * UNIT_MS[match[2].toLowerCase()];
    consumed = parts.lastIndex;
  }
  if (total > 0 && consumed === trimmed.length) return Math.round(total);

  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) return Math.max(0, date - now);
  return null;
}
