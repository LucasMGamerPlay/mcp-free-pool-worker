import test from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker, parseRetryAfter } from '../src/router/circuitBreaker.js';

function fakeClock(start = 1_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('opens on rate limit and blocks attempts until the cooldown ends', () => {
  const clock = fakeClock();
  const breaker = new CircuitBreaker(clock.now);

  assert.equal(breaker.state(), 'closed');
  assert.equal(breaker.tryAcquire(), true);

  breaker.onRateLimit(null);
  assert.equal(breaker.state(), 'open');
  assert.equal(breaker.tryAcquire(), false);

  clock.advance(59_999);
  assert.equal(breaker.tryAcquire(), false);

  clock.advance(1);
  assert.equal(breaker.state(), 'half-open');
});

test('half-open allows a single probe and doubles the cooldown on failure', () => {
  const clock = fakeClock();
  const breaker = new CircuitBreaker(clock.now);

  breaker.onRateLimit(null);
  clock.advance(60_000);

  assert.equal(breaker.tryAcquire(), true);
  assert.equal(breaker.tryAcquire(), false, 'only one probe at a time');

  breaker.release();
  breaker.onServerError();
  assert.equal(breaker.state(), 'open');
  assert.equal(breaker.cooldownRemainingMs(), 120_000);
  assert.equal(breaker.tryAcquire(), false);

  clock.advance(120_000);
  assert.equal(breaker.state(), 'half-open');
  assert.equal(breaker.tryAcquire(), true);

  breaker.onSuccess();
  assert.equal(breaker.state(), 'closed');
  assert.equal(breaker.failureCount, 0);
});

test('401/403 disables the provider permanently', () => {
  const clock = fakeClock();
  const breaker = new CircuitBreaker(clock.now);

  breaker.onInvalidKey('HTTP 401');
  assert.equal(breaker.disabled, 'HTTP 401');
  assert.equal(breaker.tryAcquire(), false);

  clock.advance(24 * 60 * 60 * 1_000);
  assert.equal(breaker.tryAcquire(), false);
});

test('a retry-after header wins over the default backoff', () => {
  const clock = fakeClock();
  const breaker = new CircuitBreaker(clock.now);

  breaker.onRateLimit(5_000);
  assert.equal(breaker.cooldownRemainingMs(), 5_000);
});

test('a quota exhaustion gets an hour, not the one-minute burst backoff', () => {
  const clock = fakeClock();
  const breaker = new CircuitBreaker(clock.now);

  breaker.onRateLimit(null, 3_600_000);
  assert.equal(breaker.cooldownRemainingMs(), 3_600_000, 'the 15 minute cap must not shrink the quota cooldown');

  clock.advance(3_600_000);
  breaker.tryAcquire();
  breaker.release();
  breaker.onRateLimit(null, 3_600_000);
  assert.equal(breaker.cooldownRemainingMs(), 3_600_000, 'a repeat stays at the quota base');
});

test('restores a persisted cooldown', () => {
  const clock = fakeClock();
  const first = new CircuitBreaker(clock.now);
  first.onRateLimit(null);

  const second = new CircuitBreaker(clock.now);
  second.restore(first.snapshot());
  assert.equal(second.state(), 'open');
  assert.equal(second.cooldownRemainingMs(), 60_000);
  assert.equal(second.tryAcquire(), false);

  const garbage = new CircuitBreaker(clock.now);
  garbage.restore({ failures: Number.NaN, openUntil: Number.POSITIVE_INFINITY });
  assert.equal(garbage.state(), 'closed');
});

test('parseRetryAfter understands seconds, durations and http dates', () => {
  assert.equal(parseRetryAfter('120'), 120_000);
  assert.equal(parseRetryAfter('1m2.4s'), 62_400);
  assert.equal(parseRetryAfter('250ms'), 250);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter(''), null);
  assert.equal(parseRetryAfter('nonsense'), null);

  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(parseRetryAfter('2026-01-01T00:00:05Z', now), 5_000);
});
