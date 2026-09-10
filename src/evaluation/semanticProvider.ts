import {
  SEMANTIC_RUBRIC_V1_SHA256,
  SEMANTIC_RUBRIC_V1_TEMPLATE,
} from './semanticPrompt';
import { sha256OfText } from '@/lib/hash';

/**
 * The local model contract semantic-h3-v1 is allowed to run under.
 *
 * Every value here is server-fixed. None of it is ever read from a request:
 * a client that could name the model, the digest, the prompt or the sampling
 * parameters could ask for a verdict from something the Human Gate never saw,
 * and the stored Evaluation would still claim the approved contract.
 *
 * The provider is deliberately narrow. One runtime, one model, one quantization,
 * one prompt, one request shape, loopback only. Anything else is not a degraded
 * mode to fall back to — it is a different measurement, so it Fails Closed.
 */

export const SEMANTIC_PROVIDER_CONTRACT = 'ollama-pinned-v1';

/** Ollama native chat, not the OpenAI-compatible shim. */
export const SEMANTIC_PROVIDER_PROTOCOL = 'ollama-native (/api/chat)';

export const SEMANTIC_RUNTIME_NAME = 'Ollama';
export const SEMANTIC_RUNTIME_VERSION = '0.33.3';

export const SEMANTIC_MODEL_ID = 'llama3.1:8b';
export const SEMANTIC_MODEL_DIGEST =
  '46e0c10c039e019119339687c3c1757cc81b9da49709a3b3924863ba87ca666e';
export const SEMANTIC_MODEL_QUANTIZATION = 'Q4_K_M';

/** Three full runs, greedy decoding, enough tokens for the JSON object. */
export const SEMANTIC_REQUEST_REPEATS = 3;
export const SEMANTIC_REQUEST_TEMPERATURE = 0;
export const SEMANTIC_REQUEST_NUM_PREDICT = 600;

/**
 * `top_p` and `seed` are deliberately not sent.
 *
 * The spike measured this exact request, and adding a parameter it never sent
 * would make the production runs a different experiment. They are recorded as
 * unset rather than omitted, so a reader never has to guess whether the field
 * was forgotten or intentionally left to the runtime.
 */
export const SEMANTIC_REQUEST_TOP_P = 'unset (runtime default)';
export const SEMANTIC_REQUEST_SEED = 'unset (uncontrolled)';

export const DEFAULT_SEMANTIC_ENDPOINT = 'http://127.0.0.1:11434';
export const DEFAULT_SEMANTIC_TIMEOUT_MS = 300_000;

/** Probe calls are short; a hung preflight must not look like a slow model. */
const PREFLIGHT_TIMEOUT_MS = 10_000;

/**
 * Hostnames that mean "this machine", matched exactly.
 *
 * Exact match is the whole point. Suffix or substring matching would accept
 * `localhost.example.com` and `127.0.0.1.attacker.test`, both of which are
 * ordinary DNS names someone else controls. Names are never resolved either:
 * a name that resolves to loopback today can resolve elsewhere tomorrow, and
 * the check would have passed on the wrong day.
 */
export const SEMANTIC_ALLOWED_HOSTS: readonly string[] = ['127.0.0.1', 'localhost', '::1', '[::1]'];

export type SemanticProviderErrorKind =
  /** Endpoint is not loopback, or a response tried to redirect off it. */
  | 'SEMANTIC_ENDPOINT_NOT_LOOPBACK'
  /** Nothing answered, or it did not answer like Ollama. */
  | 'SEMANTIC_RUNTIME_UNAVAILABLE'
  | 'SEMANTIC_RUNTIME_VERSION_MISMATCH'
  | 'SEMANTIC_MODEL_NOT_FOUND'
  | 'SEMANTIC_MODEL_DIGEST_MISMATCH'
  | 'SEMANTIC_MODEL_QUANTIZATION_MISMATCH'
  /** The production prompt constant no longer hashes to the approved value. */
  | 'SEMANTIC_PROMPT_MISMATCH';

export class SemanticProviderError extends Error {
  readonly kind: SemanticProviderErrorKind;
  readonly detail?: string;

  constructor(kind: SemanticProviderErrorKind, message: string, detail?: string) {
    super(message);
    this.name = 'SemanticProviderError';
    this.kind = kind;
    this.detail = detail;
  }
}

/** The real one, named so the injected shape and the default cannot diverge. */
const globalFetch: SemanticFetchLike = (url, init) => fetch(url, init);

function fail(kind: SemanticProviderErrorKind, message: string, detail?: string): never {
  throw new SemanticProviderError(kind, message, detail);
}

/** Is this hostname one of the four spellings of "this machine"? */
export function isLoopbackHost(hostname: unknown): boolean {
  if (typeof hostname !== 'string' || hostname.length === 0) return false;
  return SEMANTIC_ALLOWED_HOSTS.includes(hostname.toLowerCase());
}

/**
 * The host exactly as the endpoint spells it, before URL parsing rewrites it.
 *
 * `new URL()` does IPv4 arithmetic. It turns `http://2130706433`, `http://127.1`
 * and `http://0177.0.0.1` all into hostname `127.0.0.1`, so a check that read
 * only the parsed hostname would accept spellings the approved contract lists
 * as refusals. Those forms do land on loopback, so this is not a hole someone
 * reaches through from outside — but the contract names four exact spellings,
 * and an address that has to be decoded before it reads as loopback is not one
 * of them. Comparing the host as written keeps the allowlist a comparison
 * rather than a computation.
 */
function rawHostOf(endpoint: string): string | null {
  const trimmed = endpoint.trim();
  const schemeEnd = trimmed.indexOf('://');
  if (schemeEnd < 0) return null;

  let authority = trimmed.slice(schemeEnd + 3);
  for (const terminator of ['/', '?', '#']) {
    const at = authority.indexOf(terminator);
    if (at >= 0) authority = authority.slice(0, at);
  }

  const userinfoEnd = authority.lastIndexOf('@');
  const hostAndPort = userinfoEnd >= 0 ? authority.slice(userinfoEnd + 1) : authority;

  // A bracketed IPv6 literal keeps its brackets; its colons are not a port.
  if (hostAndPort.startsWith('[')) {
    const close = hostAndPort.indexOf(']');
    return close < 0 ? null : hostAndPort.slice(0, close + 1);
  }

  const portAt = hostAndPort.indexOf(':');
  return portAt >= 0 ? hostAndPort.slice(0, portAt) : hostAndPort;
}

/**
 * Parse an endpoint and refuse it unless it is loopback http(s).
 *
 * Returns the parsed URL only on success, so a caller never holds a URL it is
 * not allowed to fetch. `0.0.0.0`, integer and octal spellings of an IPv4
 * address, userinfo URLs and every external DNS name land here as a refusal,
 * because none of them is one of the four allowed hostnames.
 */
export function assertLoopbackEndpoint(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return fail(
      'SEMANTIC_ENDPOINT_NOT_LOOPBACK',
      'Semantic endpoint is not a URL.',
      `endpoint=${endpoint}`,
    );
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return fail(
      'SEMANTIC_ENDPOINT_NOT_LOOPBACK',
      'Semantic endpoint must be http or https.',
      `endpoint=${endpoint} protocol=${url.protocol}`,
    );
  }

  // Credentials in the URL are a way to make a host string read like one thing
  // and resolve like another, so they are refused outright rather than ignored.
  if (url.username.length > 0 || url.password.length > 0) {
    return fail(
      'SEMANTIC_ENDPOINT_NOT_LOOPBACK',
      'Semantic endpoint must not carry userinfo.',
      `endpoint=${endpoint}`,
    );
  }

  if (!isLoopbackHost(url.hostname)) {
    return fail(
      'SEMANTIC_ENDPOINT_NOT_LOOPBACK',
      `Semantic endpoint is not loopback: ${url.hostname}`,
      `allowed=${SEMANTIC_ALLOWED_HOSTS.join(' / ')}`,
    );
  }

  // The parsed hostname agreeing is not enough: it may have been computed from
  // a spelling the contract refuses. The endpoint must also *read* as loopback.
  const rawHost = rawHostOf(endpoint);
  if (rawHost === null || !isLoopbackHost(rawHost)) {
    return fail(
      'SEMANTIC_ENDPOINT_NOT_LOOPBACK',
      `Semantic endpoint is not written as a loopback host: ${rawHost ?? '(no host)'}`,
      `allowed=${SEMANTIC_ALLOWED_HOSTS.join(' / ')}`,
    );
  }

  return url;
}

/** The four Ollama paths this evaluator is allowed to call. */
export const SEMANTIC_ALLOWED_PATHS: readonly string[] = [
  '/api/version',
  '/api/tags',
  '/api/show',
  '/api/chat',
];

/**
 * Fetch a loopback URL without ever following a redirect.
 *
 * `redirect: 'manual'` plus an explicit 3xx refusal is what stops a loopback
 * URL from being a doorway: without it, a compromised or misconfigured local
 * listener could answer `302 https://elsewhere/` and the fetch would quietly
 * carry the reference and hypothesis text off the machine. The initial URL
 * being loopback says nothing about where a redirect chain ends.
 */
async function loopbackFetch(
  base: URL,
  pathname: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: SemanticFetchLike,
): Promise<Response> {
  if (!SEMANTIC_ALLOWED_PATHS.includes(pathname)) {
    return fail(
      'SEMANTIC_ENDPOINT_NOT_LOOPBACK',
      `Semantic provider may not call ${pathname}.`,
      `allowed=${SEMANTIC_ALLOWED_PATHS.join(' / ')}`,
    );
  }

  const url = assertLoopbackEndpoint(new URL(pathname, base.origin).toString());

  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    return fail(
      'SEMANTIC_RUNTIME_UNAVAILABLE',
      `Semantic runtime did not answer ${pathname}.`,
      message,
    );
  }

  // `redirect: 'manual'` surfaces a redirect as an opaque response in some
  // runtimes and as a plain 3xx in others. Both mean the same thing here.
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    return fail(
      'SEMANTIC_ENDPOINT_NOT_LOOPBACK',
      `Semantic runtime tried to redirect ${pathname}.`,
      `status=${response.status} location=${response.headers.get('location') ?? '(none)'}`,
    );
  }

  return response;
}

async function readJson(response: Response, pathname: string): Promise<unknown> {
  if (!response.ok) {
    return fail(
      'SEMANTIC_RUNTIME_UNAVAILABLE',
      `Semantic runtime answered ${pathname} with HTTP ${response.status}.`,
    );
  }
  try {
    return (await response.json()) as unknown;
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    return fail('SEMANTIC_RUNTIME_UNAVAILABLE', `Semantic runtime ${pathname} was not JSON.`, message);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** What preflight confirmed, recorded verbatim into the Evaluation. */
export interface SemanticRuntimeFacts {
  endpoint_class: 'loopback';
  provider_protocol: typeof SEMANTIC_PROVIDER_PROTOCOL;
  runtime: { name: typeof SEMANTIC_RUNTIME_NAME; version: string };
  model: { id: string; digest: string; quantization: string };
  prompt: { id: string; sha256: string };
}

/**
 * The one call this module makes to the outside world.
 *
 * Injected in tests so the whole suite runs with Ollama stopped, exactly like
 * the TTS provider. Live-runtime checks are a separate manual smoke.
 */
export type SemanticFetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface SemanticProviderDeps {
  endpoint?: string;
  timeoutMs?: number;
  fetchImpl?: SemanticFetchLike;
}

/**
 * Confirm the whole contract before anything is written.
 *
 * Order matters. Transport is checked before the runtime is asked anything, and
 * the model is checked before a single token is generated, so a mismatch never
 * costs a model call and never produces half an Evaluation. The prompt is
 * checked here too: it is part of the approved contract exactly like the model
 * digest, and it is the one part that can drift from an ordinary source edit.
 */
export async function preflightSemanticProvider(
  deps: SemanticProviderDeps = {},
): Promise<SemanticRuntimeFacts> {
  const promptSha = sha256OfText(SEMANTIC_RUBRIC_V1_TEMPLATE);
  if (promptSha !== SEMANTIC_RUBRIC_V1_SHA256) {
    fail(
      'SEMANTIC_PROMPT_MISMATCH',
      'The production prompt no longer matches the approved semantic-rubric-v1.',
      `expected=${SEMANTIC_RUBRIC_V1_SHA256} actual=${promptSha}`,
    );
  }

  const base = assertLoopbackEndpoint(deps.endpoint ?? DEFAULT_SEMANTIC_ENDPOINT);
  const timeoutMs = deps.timeoutMs ?? PREFLIGHT_TIMEOUT_MS;
  const fetchImpl = deps.fetchImpl ?? globalFetch;

  const versionBody = asRecord(
    await readJson(await loopbackFetch(base, '/api/version', { method: 'GET' }, timeoutMs, fetchImpl), '/api/version'),
  );
  const version = versionBody?.version;
  if (typeof version !== 'string' || version.length === 0) {
    fail('SEMANTIC_RUNTIME_UNAVAILABLE', 'Semantic runtime did not report a version.');
  }
  if (version !== SEMANTIC_RUNTIME_VERSION) {
    fail(
      'SEMANTIC_RUNTIME_VERSION_MISMATCH',
      `Semantic runtime is ${SEMANTIC_RUNTIME_NAME} ${version}, not ${SEMANTIC_RUNTIME_VERSION}.`,
    );
  }

  const tagsBody = asRecord(
    await readJson(await loopbackFetch(base, '/api/tags', { method: 'GET' }, timeoutMs, fetchImpl), '/api/tags'),
  );
  const models = Array.isArray(tagsBody?.models) ? (tagsBody.models as unknown[]) : [];
  const entry = models
    .map(asRecord)
    .find((model): model is Record<string, unknown> => model?.name === SEMANTIC_MODEL_ID);
  if (!entry) {
    fail(
      'SEMANTIC_MODEL_NOT_FOUND',
      `Semantic runtime does not have ${SEMANTIC_MODEL_ID}.`,
      'No model is downloaded and no fallback model is used.',
    );
  }

  const digest = entry.digest;
  if (typeof digest !== 'string' || digest !== SEMANTIC_MODEL_DIGEST) {
    fail(
      'SEMANTIC_MODEL_DIGEST_MISMATCH',
      `${SEMANTIC_MODEL_ID} is not the approved build.`,
      `expected=${SEMANTIC_MODEL_DIGEST} actual=${typeof digest === 'string' ? digest : '(absent)'}`,
    );
  }

  const shownBody = asRecord(
    await readJson(
      await loopbackFetch(
        base,
        '/api/show',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: SEMANTIC_MODEL_ID }),
        },
        timeoutMs,
        fetchImpl,
      ),
      '/api/show',
    ),
  );
  const quantization = asRecord(shownBody?.details)?.quantization_level;
  if (typeof quantization !== 'string' || quantization !== SEMANTIC_MODEL_QUANTIZATION) {
    fail(
      'SEMANTIC_MODEL_QUANTIZATION_MISMATCH',
      `${SEMANTIC_MODEL_ID} is not ${SEMANTIC_MODEL_QUANTIZATION}.`,
      `actual=${typeof quantization === 'string' ? quantization : '(absent)'}`,
    );
  }

  return {
    endpoint_class: 'loopback',
    provider_protocol: SEMANTIC_PROVIDER_PROTOCOL,
    runtime: { name: SEMANTIC_RUNTIME_NAME, version },
    model: {
      id: SEMANTIC_MODEL_ID,
      digest: SEMANTIC_MODEL_DIGEST,
      quantization: SEMANTIC_MODEL_QUANTIZATION,
    },
    prompt: { id: 'semantic-rubric-v1', sha256: SEMANTIC_RUBRIC_V1_SHA256 },
  };
}

/**
 * One `/api/chat` call. Returns the raw assistant text, nothing interpreted.
 *
 * Transport failures are thrown, not swallowed: the caller decides whether a
 * failed run becomes invalid run evidence, because that choice belongs to the
 * H3 policy and not to the socket.
 */
export async function semanticChat(
  requestBody: string,
  deps: SemanticProviderDeps = {},
): Promise<string> {
  const base = assertLoopbackEndpoint(deps.endpoint ?? DEFAULT_SEMANTIC_ENDPOINT);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_SEMANTIC_TIMEOUT_MS;

  const response = await loopbackFetch(
    base,
    '/api/chat',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: requestBody,
    },
    timeoutMs,
    deps.fetchImpl ?? globalFetch,
  );

  const body = asRecord(await readJson(response, '/api/chat'));
  const content = asRecord(body?.message)?.content;
  if (typeof content !== 'string') {
    fail('SEMANTIC_RUNTIME_UNAVAILABLE', 'Semantic runtime returned no message content.');
  }
  return content;
}
