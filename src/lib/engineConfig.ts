import { AivisSpeechProvider } from '@/tts/AivisSpeechProvider';

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
 * Phase 1 has exactly one provider, so this is a two-line constructor call
 * rather than a Provider Factory. It exists only to keep the three API routes
 * from repeating the env lookup.
 */
export function createAivisProvider(): AivisSpeechProvider {
  return new AivisSpeechProvider({
    baseUrl: getAivisEngineUrl(),
    timeoutMs: getAivisEngineTimeoutMs(),
  });
}
