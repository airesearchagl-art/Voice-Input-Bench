import { loopbackFetch } from './localGuard.mjs';

/**
 * What produced a number, recorded as precisely as the runtime will say.
 *
 * A model verdict cannot be recomputed from the inputs the way a character
 * distance can. The strongest claim available is "this runtime, at this version,
 * running this model artifact, answered this" — so anything the runtime exposes
 * is captured, and anything it does not is written down as `null` with the
 * reason rather than left out.
 *
 * A missing field that looks like an oversight is worse than a missing field
 * that says why it is missing: the first invites a reader to assume it was
 * checked.
 */

const PROBE_TIMEOUT_MS = 10_000;

async function tryJson(url) {
  const response = await loopbackFetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function unavailable(reason) {
  return { value: null, status: 'unavailable_from_runtime', reason };
}

/** Ollama: version from `/api/version`, artifact identity from `/api/show` and `/api/tags`. */
export async function ollamaRuntimeInfo(base, modelId) {
  const info = {
    provider_protocol: 'ollama-native (/api/chat)',
    endpoint_class: 'loopback',
    endpoint: base,
    runtime: { name: 'Ollama', version: null, version_status: null },
    model: {
      id: modelId,
      digest: null,
      digest_status: null,
      quantization: null,
      parameter_size: null,
      family: null,
      format: null,
      revision: null,
      revision_status: null,
    },
  };

  try {
    const version = await tryJson(`${base}/api/version`);
    info.runtime.version = version.version ?? null;
    info.runtime.version_status = version.version ? 'reported' : 'absent_from_response';
  } catch (error) {
    const missing = unavailable(`GET /api/version failed: ${error.message}`);
    info.runtime.version = missing.value;
    info.runtime.version_status = `${missing.status}: ${missing.reason}`;
  }

  try {
    const tags = await tryJson(`${base}/api/tags`);
    const entry = (tags.models ?? []).find((model) => model.name === modelId);
    if (entry) {
      info.model.digest = entry.digest ?? null;
      info.model.digest_status = entry.digest ? 'reported' : 'absent_from_response';
      info.model.size_bytes = entry.size ?? null;
      info.model.modified_at = entry.modified_at ?? null;
    } else {
      const missing = unavailable(`model ${modelId} not listed by /api/tags`);
      info.model.digest_status = `${missing.status}: ${missing.reason}`;
    }
  } catch (error) {
    info.model.digest_status = `unavailable_from_runtime: GET /api/tags failed: ${error.message}`;
  }

  try {
    const shown = await tryJson(`${base}/api/show`);
    void shown;
  } catch {
    // `/api/show` needs a body; the POST below is the real call.
  }

  try {
    const response = await loopbackFetch(`${base}/api/show`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: modelId }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (response.ok) {
      const shown = await response.json();
      info.model.quantization = shown.details?.quantization_level ?? null;
      info.model.parameter_size = shown.details?.parameter_size ?? null;
      info.model.family = shown.details?.family ?? null;
      info.model.format = shown.details?.format ?? null;
      // Ollama exposes no upstream revision or commit for a pulled model; the
      // manifest digest above is the only artifact identity it offers.
      info.model.revision = null;
      info.model.revision_status =
        'unavailable_from_runtime: Ollama exposes no upstream model revision, only the local manifest digest';
    } else {
      info.model.revision_status = `unavailable_from_runtime: POST /api/show -> HTTP ${response.status}`;
    }
  } catch (error) {
    info.model.revision_status = `unavailable_from_runtime: POST /api/show failed: ${error.message}`;
  }

  return info;
}

/** LM Studio: richer model metadata on `/api/v0/models`, no digest and no version endpoint. */
export async function lmStudioRuntimeInfo(base, modelId) {
  const info = {
    provider_protocol: 'openai-compatible (/v1/embeddings)',
    endpoint_class: 'loopback',
    endpoint: base,
    runtime: {
      name: 'LM Studio',
      version: null,
      version_status:
        'unavailable_from_runtime: the local HTTP API exposes no version endpoint (/v1 and /api/v0 have no version route)',
    },
    model: {
      id: modelId,
      digest: null,
      digest_status:
        'unavailable_from_runtime: LM Studio reports no artifact digest or checksum for a loaded model',
      quantization: null,
      arch: null,
      publisher: null,
      compatibility_type: null,
      max_context_length: null,
      revision: null,
      revision_status:
        'unavailable_from_runtime: LM Studio reports no upstream model revision',
    },
  };

  try {
    const models = await tryJson(`${base}/api/v0/models`);
    const entry = (models.data ?? []).find((model) => model.id === modelId);
    if (entry) {
      info.model.quantization = entry.quantization ?? null;
      info.model.arch = entry.arch ?? null;
      info.model.publisher = entry.publisher ?? null;
      info.model.compatibility_type = entry.compatibility_type ?? null;
      info.model.max_context_length = entry.max_context_length ?? null;
    } else {
      info.model.metadata_status = `unavailable_from_runtime: model ${modelId} not listed by /api/v0/models`;
    }
  } catch (error) {
    info.model.metadata_status = `unavailable_from_runtime: GET /api/v0/models failed: ${error.message}`;
  }

  return info;
}
