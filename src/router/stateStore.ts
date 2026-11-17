import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface BreakerSnapshot {
  failures: number;
  openUntil: number;
}

export interface PoolState {
  version: 1;
  providers: Record<string, BreakerSnapshot>;
  models: Record<string, BreakerSnapshot>;
}

export function statePath(): string {
  const override = process.env.FREE_POOL_STATE?.trim();
  if (override) return override;
  const base = process.env.XDG_CACHE_HOME?.trim() || join(homedir(), '.cache');
  return join(base, 'mcp-free-pool', 'state.json');
}

export function loadState(path: string = statePath()): PoolState | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as PoolState;
    if (parsed?.version !== 1 || !isRecord(parsed.providers)) return null;
    if (!isRecord(parsed.models)) parsed.models = {};
    return parsed;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Never throws: the cache must not break a delegation. */
export function saveState(state: PoolState, path: string = statePath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.tmp`;
    writeFileSync(temp, JSON.stringify(state), 'utf8');
    renameSync(temp, path);
  } catch {
    // ignore cache write errors
  }
}
