import { describe, expect, it } from 'vitest';
import {
  SEMANTIC_MODEL_DIGEST,
  SEMANTIC_MODEL_ID,
  SEMANTIC_MODEL_QUANTIZATION,
  SEMANTIC_RUNTIME_VERSION,
  SemanticProviderError,
  assertLoopbackEndpoint,
  isLoopbackHost,
  preflightSemanticProvider,
  semanticChat,
  type SemanticFetchLike,
} from './semanticProvider';

/**
 * The transport and the pinned model contract.
 *
 * Nothing here reaches Ollama: `fetchImpl` is injected, so the whole suite runs
 * with the runtime stopped. The live-runtime check is a separate manual smoke,
 * because "it worked against the machine I had" is not a test.
 *
 * What is being defended is narrow and worth stating plainly. This evaluator
 * sends the operator's reference and hypothesis text to a model. That is only
 * acceptable while the model is provably on this machine, so every way of
 * making a non-local address look local has its own case below.
 */

const ENDPOINT = 'http://127.0.0.1:11434';

interface RecordedCall {
  url: string;
  method: string;
  redirect: RequestRedirect | undefined;
  body: string | undefined;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const HEALTHY_ROUTES: Record<string, () => Response> = {
  '/api/version': () => jsonResponse({ version: SEMANTIC_RUNTIME_VERSION }),
  '/api/tags': () =>
    jsonResponse({
      models: [
        { name: 'some-other-model:latest', digest: 'f'.repeat(64) },
        { name: SEMANTIC_MODEL_ID, digest: SEMANTIC_MODEL_DIGEST },
      ],
    }),
  '/api/show': () => jsonResponse({ details: { quantization_level: SEMANTIC_MODEL_QUANTIZATION } }),
  '/api/chat': () => jsonResponse({ message: { content: '{}' } }),
};

function fakeFetch(overrides: Record<string, () => Response> = {}): {
  fetchImpl: SemanticFetchLike;
  calls: RecordedCall[];
} {
  const routes = { ...HEALTHY_ROUTES, ...overrides };
  const calls: RecordedCall[] = [];
  const fetchImpl: SemanticFetchLike = async (url, init) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      redirect: init.redirect,
      body: typeof init.body === 'string' ? init.body : undefined,
    });
    const handler = routes[new URL(url).pathname];
    if (!handler) throw new Error(`unexpected request: ${url}`);
    return handler();
  };
  return { fetchImpl, calls };
}

async function expectRefusal(promise: Promise<unknown>, kind: string): Promise<void> {
  await expect(promise).rejects.toThrow(SemanticProviderError);
  await promise.catch((caught: unknown) => {
    expect((caught as SemanticProviderError).kind).toBe(kind);
  });
}

describe('only a loopback endpoint is accepted', () => {
  it('accepts exactly the four spellings of this machine', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]']) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  it('refuses a DNS name that merely starts or ends with a loopback name', () => {
    // Both are ordinary names someone else controls. A substring or suffix
    // match would have accepted them.
    expect(isLoopbackHost('localhost.example.com')).toBe(false);
    expect(isLoopbackHost('127.0.0.1.attacker.test')).toBe(false);
    expect(isLoopbackHost('notlocalhost')).toBe(false);
  });

  it('refuses 0.0.0.0 and alternative spellings of an IPv4 address', () => {
    // 2130706433 and 0177.0.0.1 both resolve to 127.0.0.1 in some stacks, and
    // neither is one of the four allowed strings. The point of an allowlist is
    // that it does not do arithmetic.
    for (const host of ['0.0.0.0', '2130706433', '0177.0.0.1', '127.1']) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });

  it('refuses an endpoint that is only loopback after URL normalization', () => {
    // The allowlist must not do arithmetic on the caller's behalf. `new URL()`
    // rewrites every one of these to hostname 127.0.0.1, so a gate that trusted
    // the parsed hostname would have accepted all three even though none of
    // them is one of the four approved spellings.
    for (const endpoint of [
      'http://2130706433:11434',
      'http://0177.0.0.1:11434',
      'http://127.1:11434',
    ]) {
      expect(new URL(endpoint).hostname).toBe('127.0.0.1');
      expect(() => assertLoopbackEndpoint(endpoint)).toThrow(SemanticProviderError);
    }
  });

  it('accepts the approved loopback endpoints as written', () => {
    for (const endpoint of [
      'http://127.0.0.1:11434',
      'http://localhost:11434',
      'http://[::1]:11434',
      'http://LOCALHOST:11434',
      'http://127.0.0.1',
    ]) {
      expect(() => assertLoopbackEndpoint(endpoint)).not.toThrow();
    }
  });

  it('refuses an external endpoint', () => {
    expect(() => assertLoopbackEndpoint('http://ollama.example.com:11434')).toThrow(
      SemanticProviderError,
    );
  });

  it('refuses a userinfo URL', () => {
    // `http://127.0.0.1@evil.test/` has hostname evil.test, and the part that
    // reads as loopback is a username.
    expect(() => assertLoopbackEndpoint('http://127.0.0.1@evil.test/')).toThrow(
      SemanticProviderError,
    );
  });

  it('refuses a non-http protocol and an unparseable endpoint', () => {
    expect(() => assertLoopbackEndpoint('file:///etc/passwd')).toThrow(SemanticProviderError);
    expect(() => assertLoopbackEndpoint('not a url')).toThrow(SemanticProviderError);
  });

  it('refuses to preflight against a non-loopback endpoint, without asking it anything', async () => {
    const { fetchImpl, calls } = fakeFetch();
    await expectRefusal(
      preflightSemanticProvider({ endpoint: 'http://192.168.1.10:11434', fetchImpl }),
      'SEMANTIC_ENDPOINT_NOT_LOOPBACK',
    );
    expect(calls).toHaveLength(0);
  });
});

describe('a redirect is never followed', () => {
  it('asks for manual redirect handling on every call', async () => {
    const { fetchImpl, calls } = fakeFetch();
    await preflightSemanticProvider({ endpoint: ENDPOINT, fetchImpl });
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.redirect).toBe('manual');
  });

  it('refuses a 3xx that points at an external host', async () => {
    // Without this the loopback check would be a doorway: the URL that was
    // verified is not the URL the text would end up at.
    const { fetchImpl } = fakeFetch({
      '/api/version': () =>
        new Response(null, { status: 302, headers: { location: 'https://evil.test/api/version' } }),
    });
    await expectRefusal(
      preflightSemanticProvider({ endpoint: ENDPOINT, fetchImpl }),
      'SEMANTIC_ENDPOINT_NOT_LOOPBACK',
    );
  });

  it('refuses a redirect on the chat call too', async () => {
    const { fetchImpl } = fakeFetch({
      '/api/chat': () =>
        new Response(null, { status: 307, headers: { location: 'https://evil.test/api/chat' } }),
    });
    await expectRefusal(
      semanticChat('{}', { endpoint: ENDPOINT, fetchImpl }),
      'SEMANTIC_ENDPOINT_NOT_LOOPBACK',
    );
  });
});

describe('the runtime and model contract is pinned', () => {
  it('passes when everything matches, and reports what it confirmed', async () => {
    const { fetchImpl, calls } = fakeFetch();
    const facts = await preflightSemanticProvider({ endpoint: ENDPOINT, fetchImpl });

    expect(facts.endpoint_class).toBe('loopback');
    expect(facts.runtime).toEqual({ name: 'Ollama', version: SEMANTIC_RUNTIME_VERSION });
    expect(facts.model).toEqual({
      id: SEMANTIC_MODEL_ID,
      digest: SEMANTIC_MODEL_DIGEST,
      quantization: SEMANTIC_MODEL_QUANTIZATION,
    });
    expect(facts.prompt.id).toBe('semantic-rubric-v1');

    // Only the known Ollama paths, and no generation during preflight.
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/api/version',
      '/api/tags',
      '/api/show',
    ]);
  });

  it('refuses a runtime that reports a different version', async () => {
    const { fetchImpl } = fakeFetch({ '/api/version': () => jsonResponse({ version: '0.34.0' }) });
    await expectRefusal(
      preflightSemanticProvider({ endpoint: ENDPOINT, fetchImpl }),
      'SEMANTIC_RUNTIME_VERSION_MISMATCH',
    );
  });

  it('refuses a runtime that is not answering', async () => {
    const { fetchImpl } = fakeFetch({
      '/api/version': () => {
        throw new Error('ECONNREFUSED');
      },
    });
    await expectRefusal(
      preflightSemanticProvider({ endpoint: ENDPOINT, fetchImpl }),
      'SEMANTIC_RUNTIME_UNAVAILABLE',
    );
  });

  it('refuses when the model is not installed, and never downloads it', async () => {
    const { fetchImpl, calls } = fakeFetch({
      '/api/tags': () => jsonResponse({ models: [{ name: 'llama3.2:3b', digest: 'a'.repeat(64) }] }),
    });
    await expectRefusal(
      preflightSemanticProvider({ endpoint: ENDPOINT, fetchImpl }),
      'SEMANTIC_MODEL_NOT_FOUND',
    );
    // No pull, and no quietly grading with whatever else is installed.
    const paths = calls.map((call) => new URL(call.url).pathname);
    expect(paths).not.toContain('/api/pull');
    expect(paths).not.toContain('/api/chat');
  });

  it('refuses a model with the right name and the wrong digest', async () => {
    const { fetchImpl } = fakeFetch({
      '/api/tags': () =>
        jsonResponse({ models: [{ name: SEMANTIC_MODEL_ID, digest: 'b'.repeat(64) }] }),
    });
    await expectRefusal(
      preflightSemanticProvider({ endpoint: ENDPOINT, fetchImpl }),
      'SEMANTIC_MODEL_DIGEST_MISMATCH',
    );
  });

  it('refuses a model quantized differently', async () => {
    const { fetchImpl } = fakeFetch({
      '/api/show': () => jsonResponse({ details: { quantization_level: 'Q8_0' } }),
    });
    await expectRefusal(
      preflightSemanticProvider({ endpoint: ENDPOINT, fetchImpl }),
      'SEMANTIC_MODEL_QUANTIZATION_MISMATCH',
    );
  });

  it('refuses when the runtime will not say how the model was quantized', async () => {
    const { fetchImpl } = fakeFetch({ '/api/show': () => jsonResponse({ details: {} }) });
    await expectRefusal(
      preflightSemanticProvider({ endpoint: ENDPOINT, fetchImpl }),
      'SEMANTIC_MODEL_QUANTIZATION_MISMATCH',
    );
  });

  it('sends the request body verbatim to /api/chat and returns the assistant text', async () => {
    const { fetchImpl, calls } = fakeFetch({
      '/api/chat': () => jsonResponse({ message: { content: 'hello' } }),
    });
    const body = JSON.stringify({ model: SEMANTIC_MODEL_ID });

    await expect(semanticChat(body, { endpoint: ENDPOINT, fetchImpl })).resolves.toBe('hello');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body).toBe(body);
  });
});
