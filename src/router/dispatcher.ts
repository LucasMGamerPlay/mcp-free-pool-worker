import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { readContextFiles, type ContextFile } from '../utils/fileReader.js';
import { log } from '../utils/logger.js';
import { estimateTokens } from '../utils/tokenCounter.js';
import { CircuitBreaker, parseRetryAfter } from './circuitBreaker.js';
import { KeyRotator } from './keyRotator.js';
import { loadState, saveState, statePath, type PoolState } from './stateStore.js';

export type TaskType = 'coding' | 'tests' | 'docs' | 'analysis' | 'refactor';

const providerSchema = z.object({
  id: z.string().min(1),
  base_url: z.string().url(),
  models: z.array(z.string().min(1)).min(1),
  env_key: z.string().min(1).nullish(),
  env_keys: z.string().min(1).nullish(),
  max_context: z.number().int().positive(),
  max_output: z.number().int().positive(),
  rpm: z.number().int().nonnegative().optional(),
});

const configSchema = z
  .object({
    version: z.literal(1),
    providers: z.array(providerSchema).min(1),
    routing: z.record(z.array(z.string())),
  })
  .superRefine((config, ctx) => {
    const ids = new Set(config.providers.map((provider) => provider.id));
    if (ids.size !== config.providers.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'provider ids must be unique' });
    }
    for (const [taskType, providers] of Object.entries(config.routing)) {
      for (const id of providers) {
        if (!ids.has(id)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `routing.${taskType} references unknown provider "${id}"` });
        }
      }
    }
  });

export type ProviderConfig = z.infer<typeof providerSchema>;
type PoolConfig = z.infer<typeof configSchema>;

export interface DelegateRequest {
  task_type: TaskType;
  role_instruction: string;
  task_description: string;
  context_files?: string[];
  deadline_ms?: number;
  max_output_tokens?: number;
  /** Return ok:false to discard this worker output and try the next model. */
  validate?: (content: string) => Promise<{ ok: boolean; skipped?: boolean; message?: string }>;
}

export interface AttemptLog {
  provider: string;
  model: string;
  status: 'http' | 'timeout' | 'network' | 'cooldown' | 'context' | 'no-key' | 'disabled' | 'invalid' | 'truncated';
  detail?: string;
}

export interface DelegateResult {
  content: string;
  provider: string;
  model: string;
  attempts: AttemptLog[];
  savedTokens: number;
}

interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

const projectRoot = findProjectRoot(dirname(fileURLToPath(import.meta.url)));
const ATTEMPT_TIMEOUT_MS = 45_000;
const DEFAULT_DEADLINE_MS = 90_000;
const MAX_KEY_RETRIES = 5;
// a 404 means the slug left the catalog: retrying it on every task is pure waste
const DEAD_MODEL_COOLDOWN_MS = 60 * 60_000;
// 402 is an exhausted quota, not a burst limit: a one minute retry just hammers it
const QUOTA_COOLDOWN_MS = 60 * 60_000;
// only permanent wording counts: transient messages like "model temporarily unavailable"
// must not bench a healthy model for an hour
const DEAD_MODEL_BODY =
  /not a valid model|invalid model|model[^"]{0,80}(not found|does not exist|no longer available|unavailable for free)/i;

const breakers = new Map<string, CircuitBreaker>();
const modelBreakers = new Map<string, CircuitBreaker>();
const rotators = new Map<string, KeyRotator | null>();
const mutexes = new Map<string, Mutex>();
const stats = { delegated: 0, failed: 0, savedTokens: 0 };

let cachedConfig: PoolConfig | null = null;
let persistedState: PoolState | null | undefined;

function persisted(): PoolState | null {
  if (persistedState === undefined) persistedState = loadState();
  return persistedState;
}

export function workspaceRoot(): string {
  return process.env.WORKSPACE_ROOT?.trim() || process.cwd();
}

export function configPath(): string {
  return process.env.FREE_POOL_CONFIG?.trim() || join(projectRoot, 'config', 'providers.json');
}

function loadConfig(): PoolConfig {
  if (cachedConfig) return cachedConfig;
  const path = configPath();

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`cannot read provider config at ${path}: ${(error as Error).message}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(`provider config is not valid JSON (${path}): ${(error as Error).message}`);
  }

  const parsed = configSchema.safeParse(json);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`)
      .join('; ');
    throw new Error(`invalid provider config at ${path}: ${details}`);
  }

  cachedConfig = parsed.data;
  log(`provider config loaded from ${path}`);
  return cachedConfig;
}

export function findProjectRoot(start: string): string {
  let dir = start;
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
}

function breakerFor(id: string): CircuitBreaker {
  let breaker = breakers.get(id);
  if (!breaker) {
    breaker = new CircuitBreaker();
    const saved = persisted()?.providers[id];
    if (saved) breaker.restore(saved);
    breakers.set(id, breaker);
  }
  return breaker;
}

function persistPool(): void {
  const state: PoolState = { version: 1, providers: {}, models: {} };
  for (const [id, breaker] of breakers) state.providers[id] = breaker.snapshot();
  for (const [key, breaker] of modelBreakers) state.models[key] = breaker.snapshot();
  saveState(state);
}

function modelBreakerFor(providerId: string, model: string): CircuitBreaker {
  const key = `${providerId}|${model}`;
  let breaker = modelBreakers.get(key);
  if (!breaker) {
    breaker = new CircuitBreaker();
    const saved = persisted()?.models[key];
    if (saved) breaker.restore(saved);
    modelBreakers.set(key, breaker);
  }
  return breaker;
}

function rotatorFor(provider: ProviderConfig): KeyRotator | null {
  if (rotators.has(provider.id)) return rotators.get(provider.id) ?? null;

  let keys = splitList(provider.env_keys ? process.env[provider.env_keys] : undefined);
  if (keys.length === 0 && provider.env_key) keys = splitList(process.env[provider.env_key]);

  const keyed = Boolean(provider.env_key || provider.env_keys);
  const rotator = keyed ? new KeyRotator(keys) : null;
  rotators.set(provider.id, rotator);
  return rotator;
}

function mutexFor(id: string): Mutex {
  let mutex = mutexes.get(id);
  if (!mutex) {
    mutex = new Mutex();
    mutexes.set(id, mutex);
  }
  return mutex;
}

class DeadlineError extends Error {
  constructor() {
    super('deadline exceeded');
    this.name = 'DeadlineError';
  }
}

/** Serializes calls so a provider never has more than one request in flight. */
class Mutex {
  private tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly retryAfterMs: number | null,
  ) {
    super(`HTTP ${status}`);
    this.name = 'ProviderHttpError';
  }
}

class TruncatedOutputError extends Error {
  constructor(readonly finishReason: string) {
    super(`output hit the token limit (finish_reason: ${finishReason})`);
    this.name = 'TruncatedOutputError';
  }
}

export function poolStatus(): unknown {
  const config = loadConfig();
  return {
    workspace_root: workspaceRoot(),
    config_file: configPath(),
    state_file: statePath(),
    providers: config.providers.map((provider) => {
      const breaker = breakerFor(provider.id);
      const rotator = rotatorFor(provider);
      return {
        id: provider.id,
        state: breaker.disabled ? 'disabled' : breaker.state(),
        disabled: breaker.disabled,
        cooldown_ms: breaker.cooldownRemainingMs(),
        keys_available: rotator ? rotator.available : null,
        models: provider.models.map((model) => {
          const modelBreaker = modelBreakerFor(provider.id, model);
          return { id: model, state: modelBreaker.state(), cooldown_ms: modelBreaker.cooldownRemainingMs() };
        }),
        rpm: provider.rpm ?? null,
      };
    }),
    stats: { ...stats },
    routing: config.routing,
  };
}

export async function runDelegation(request: DelegateRequest): Promise<DelegateResult> {
  const config = loadConfig();
  const files = await readContextFiles(workspaceRoot(), request.context_files ?? []);
  const messages = buildMessages(request.role_instruction, request.task_description, files);
  const inputTokens = estimateTokens(messages.map((message) => message.content).join('\n'));
  const deadline = Date.now() + (request.deadline_ms ?? DEFAULT_DEADLINE_MS);
  const maxTokens = Math.min(request.max_output_tokens ?? 4096, 16_000);
  const order = config.routing[request.task_type] ?? config.providers.map((provider) => provider.id);
  const attempts: AttemptLog[] = [];

  for (const providerId of order) {
    const provider = config.providers.find((candidate) => candidate.id === providerId);
    if (!provider) continue;

    const breaker = breakerFor(provider.id);
    if (breaker.disabled) {
      attempts.push({ provider: provider.id, model: '-', status: 'disabled', detail: breaker.disabled });
      continue;
    }
    const providerMaxTokens = Math.min(maxTokens, provider.max_output);
    if (inputTokens + providerMaxTokens > provider.max_context) {
      attempts.push({
        provider: provider.id,
        model: '-',
        status: 'context',
        detail: `${inputTokens}+${providerMaxTokens} > ${provider.max_context}`,
      });
      continue;
    }

    const rotator = rotatorFor(provider);
    if (rotator && !rotator.current()) {
      attempts.push({ provider: provider.id, model: '-', status: 'no-key' });
      continue;
    }

    if (breaker.state() === 'open') {
      attempts.push({
        provider: provider.id,
        model: '-',
        status: 'cooldown',
        detail: `${breaker.cooldownRemainingMs()}ms left`,
      });
      continue;
    }

    let providerCooled = false;
    for (const model of provider.models) {
      if (providerCooled) break;
      const modelBreaker = modelBreakerFor(provider.id, model);
      let keyRetries = 0;

      while (true) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          attempts.push({ provider: provider.id, model, status: 'timeout', detail: 'deadline exceeded' });
          providerCooled = true;
          break;
        }
        if (!modelBreaker.tryAcquire()) {
          attempts.push({
            provider: provider.id,
            model,
            status: 'cooldown',
            detail: `${modelBreaker.cooldownRemainingMs()}ms left`,
          });
          break;
        }

        const key = rotator?.current() ?? null;
        let deadlineBound = false;

        try {
          // recompute inside the queue: waiting here also spends the deadline
          const content = await mutexFor(provider.id).run(() => {
            const left = Math.min(deadline - Date.now(), ATTEMPT_TIMEOUT_MS);
            if (left <= 0) throw new DeadlineError();
            deadlineBound = left < ATTEMPT_TIMEOUT_MS;
            return callProvider(provider, model, key, messages, providerMaxTokens, AbortSignal.timeout(left));
          });
          modelBreaker.onSuccess();
          breaker.onSuccess();

          const validation = request.validate ? await request.validate(content) : null;
          if (validation && !validation.ok) {
            attempts.push({ provider: provider.id, model, status: 'invalid', detail: validation.message?.slice(0, 120) });
            break; // the model answered but the output is unusable: try the next one
          }

          stats.delegated += 1;
          const savedTokens = estimateTokens(content);
          stats.savedTokens += savedTokens;
          log(`delegated to ${provider.id}/${model}`);
          persistPool();
          return { content, provider: provider.id, model, attempts, savedTokens };
        } catch (error) {
          modelBreaker.release();

          if (error instanceof ProviderHttpError) {
            const canRetryKey = retryWithAnotherKey(error, rotator, keyRetries);
            attempts.push({
              provider: provider.id,
              model,
              status: 'http',
              detail: `HTTP ${error.status}: ${error.body.slice(0, 120)}`,
            });

            if (canRetryKey) {
              keyRetries += 1;
              continue;
            }
            if (error.status === 401 || error.status === 403) {
              if (rotator) {
                breaker.onInvalidKey(`HTTP ${error.status} on ${provider.id}`);
                providerCooled = true;
              }
              break;
            }
            if (error.status === 429 || error.status === 402) {
              modelBreaker.onRateLimit(error.retryAfterMs, error.status === 402 ? QUOTA_COOLDOWN_MS : undefined);
              break; // only this model is limited, try the next one
            }
            if (error.status >= 500) {
              modelBreaker.onServerError();
              break; // next model
            }
            if (error.status === 404 || (error.status === 400 && DEAD_MODEL_BODY.test(error.body))) {
              modelBreaker.onRateLimit(DEAD_MODEL_COOLDOWN_MS); // bad slug, not a load spike
              break;
            }
            break; // 400/422: bad payload, try the next model
          }

          const message = error instanceof Error ? error.message : String(error);
          if (error instanceof DeadlineError) {
            attempts.push({ provider: provider.id, model, status: 'timeout', detail: error.message });
            providerCooled = true;
            break; // out of budget: not the model's fault, so no cooldown
          }
          if (error instanceof TruncatedOutputError) {
            attempts.push({ provider: provider.id, model, status: 'truncated', detail: error.message });
            break; // the model worked, the answer just does not fit: try the next one
          }
          const isTimeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
          attempts.push({ provider: provider.id, model, status: isTimeout ? 'timeout' : 'network', detail: message });

          if (isTimeout) {
            if (deadlineBound) {
              // the budget ran out before the attempt even got its own timeout
              attempts.push({ provider: provider.id, model, status: 'timeout', detail: 'deadline exceeded' });
              providerCooled = true;
              break;
            }
            modelBreaker.onServerError(); // slow model, the provider may still be fine
            break;
          }
          breaker.onServerError();
          providerCooled = true;
          break;
        }
      }
    }
  }

  stats.failed += 1;
  persistPool();
  const summary = attempts
    .slice(-10)
    .map((attempt) => `${attempt.provider}/${attempt.model}: ${attempt.status}${attempt.detail ? ` (${attempt.detail})` : ''}`)
    .join('; ');
  // a provider that answered with unusable output is a different problem from an unreachable one
  const unusable = new Set(['invalid', 'truncated']);
  const skipped = new Set(['no-key', 'cooldown', 'disabled', 'context']);
  const rejectedCount = attempts.filter((attempt) => unusable.has(attempt.status)).length;
  const answeredButUnusable =
    rejectedCount > 0 && attempts.every((attempt) => unusable.has(attempt.status) || skipped.has(attempt.status));
  const headline = answeredButUnusable
    ? 'every provider that answered produced unusable output'
    : `no provider completed the task${rejectedCount > 0 ? ` (${rejectedCount} answer(s) rejected as unusable)` : ''}`;
  throw new Error(`${headline}. attempts: ${summary || 'none'}`);
}

function retryWithAnotherKey(error: ProviderHttpError, rotator: KeyRotator | null, retries: number): boolean {
  if (!rotator || retries >= MAX_KEY_RETRIES) return false;
  if (error.status === 401 || error.status === 403) {
    rotator.killCurrent();
    return rotator.current() !== null;
  }
  if (error.status === 429 || error.status === 402) {
    return rotator.available > 1 && rotator.rotate() !== null;
  }
  return false;
}

async function callProvider(
  provider: ProviderConfig,
  model: string,
  key: string | null,
  messages: ChatMessage[],
  maxTokens: number,
  signal: AbortSignal,
): Promise<string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;

  const response = await fetch(`${provider.base_url.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.2 }),
  });

  if (!response.ok) {
    const body = (await response.text()).slice(0, 400);
    const retryAfterMs =
      parseRetryAfter(response.headers.get('retry-after')) ??
      parseRetryAfter(response.headers.get('x-ratelimit-reset-requests'));
    throw new ProviderHttpError(response.status, body, retryAfterMs);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>;
  };
  const choice = data.choices?.[0];
  const content = choice?.message?.content;
  // A cut-off answer can still parse as valid code, so never let it reach the writer.
  if (choice?.finish_reason === 'length' || choice?.finish_reason === 'max_tokens') {
    throw new TruncatedOutputError(String(choice.finish_reason));
  }
  if (typeof content !== 'string' || !content.trim()) throw new Error('provider returned an empty completion');
  return content;
}

function buildMessages(role: string, task: string, files: ContextFile[]): ChatMessage[] {
  const context = files
    .map((file) => `--- FILE: ${file.path} ---\n${file.content}\n--- END FILE: ${file.path} ---`)
    .join('\n\n');
  const user = files.length > 0 ? `${task}\n\nContext files:\n\n${context}` : task;
  return [
    { role: 'system', content: role },
    { role: 'user', content: user },
  ];
}
