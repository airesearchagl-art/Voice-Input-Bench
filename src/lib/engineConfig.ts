import path from 'node:path';
import { AivisSpeechProvider } from '@/tts/AivisSpeechProvider';
import { LocalRunStore } from '@/storage/LocalRunStore';
import { LocalResultStore } from '@/storage/LocalResultStore';
import { LocalSessionStore } from '@/storage/LocalSessionStore';
import { LocalEvaluationStore } from '@/storage/LocalEvaluationStore';
import { DEFAULT_SEMANTIC_ENDPOINT } from '@/evaluation/semanticProvider';

/**
 * Local-first default: AivisSpeech Engine listens on 10101 out of the box, so
 * the app works with no `.env` at all. `AIVIS_ENGINE_URL` overrides it.
 */
export const DEFAULT_AIVIS_ENGINE_URL = 'http://127.0.0.1:10101';

/** Just the shape we read, so tests can pass a bare object. */
export type EnvLike = Record<string, string | undefined>;

export function getAivisEngineUrl(env: EnvLike = process.env): string {
  const raw = env.AIVIS_ENGINE_URL?.trim();
  return raw && raw.length > 0 ? raw : DEFAULT_AIVIS_ENGINE_URL;
}

export function getAivisEngineTimeoutMs(env: EnvLike = process.env): number | undefined {
  const raw = env.AIVIS_ENGINE_TIMEOUT_MS?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Runs root. Local-first: alongside the project, outside Git.
 * `VIB_RUNS_DIR` overrides it (tests point it at a temp directory).
 */
export function getRunsDir(env: EnvLike = process.env): string {
  const raw = env.VIB_RUNS_DIR?.trim();
  return raw && raw.length > 0 ? raw : path.join(process.cwd(), 'data', 'runs');
}

export function createRunStore(): LocalRunStore {
  return new LocalRunStore(getRunsDir());
}

/**
 * Results root. A separate tree from `data/runs/` on purpose: Phase 1 Runs are
 * immutable, and Phase 2 observations must not be able to land inside one.
 * `VIB_RESULTS_DIR` overrides it (tests point it at a temp directory).
 */
export function getResultsDir(env: EnvLike = process.env): string {
  const raw = env.VIB_RESULTS_DIR?.trim();
  return raw && raw.length > 0 ? raw : path.join(process.cwd(), 'data', 'results');
}

export function createResultStore(): LocalResultStore {
  return new LocalResultStore(getResultsDir());
}

/**
 * Sessions root. A third separate tree: a Benchmark Session references Runs and
 * Results by ID and must never be able to write inside either of them.
 * `VIB_SESSIONS_DIR` overrides it (tests point it at a temp directory).
 */
export function getSessionsDir(env: EnvLike = process.env): string {
  const raw = env.VIB_SESSIONS_DIR?.trim();
  return raw && raw.length > 0 ? raw : path.join(process.cwd(), 'data', 'sessions');
}

export function createSessionStore(): LocalSessionStore {
  return new LocalSessionStore(getSessionsDir());
}

/**
 * Evaluations root. A fourth separate tree: an Evaluation is derived from a Run
 * and a Result and must never be able to write inside either, nor inside the
 * Session tree. `VIB_EVALUATIONS_DIR` overrides it (tests point it at a temp
 * directory).
 */
export function getEvaluationsDir(env: EnvLike = process.env): string {
  const raw = env.VIB_EVALUATIONS_DIR?.trim();
  return raw && raw.length > 0 ? raw : path.join(process.cwd(), 'data', 'evaluations');
}

export function createEvaluationStore(): LocalEvaluationStore {
  return new LocalEvaluationStore(getEvaluationsDir());
}

/**
 * Where semantic-h3-v1 finds its local model.
 *
 * Configurable server-side because the port is a local detail, but the value is
 * still refused unless it is loopback. This getter deliberately does no
 * validation of its own, so exactly one place — the provider — decides what
 * "local" means. `VIB_SEMANTIC_ENDPOINT` overrides it.
 */
export function getSemanticEndpoint(env: EnvLike = process.env): string {
  const raw = env.VIB_SEMANTIC_ENDPOINT?.trim();
  return raw && raw.length > 0 ? raw : DEFAULT_SEMANTIC_ENDPOINT;
}

export function getSemanticTimeoutMs(env: EnvLike = process.env): number | undefined {
  const raw = env.VIB_SEMANTIC_TIMEOUT_MS?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Phase 1 has exactly one provider, so this is a two-line constructor call
 * rather than a Provider Factory. It exists only to keep the API routes
 * from repeating the env lookup.
 */
export function createAivisProvider(): AivisSpeechProvider {
  return new AivisSpeechProvider({
    baseUrl: getAivisEngineUrl(),
    timeoutMs: getAivisEngineTimeoutMs(),
  });
}
