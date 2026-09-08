#!/usr/bin/env node
/**
 * Capture what the two local runtimes will say about themselves.
 *
 * R0 wrote this file by hand and, on the LM Studio side, recorded nothing but a
 * list of model names — while the README claimed the evidence held "the digest
 * of every model present". It did not, and it cannot: LM Studio exposes no
 * digest. This script replaces the hand-written snapshot with one that asks each
 * runtime and writes down exactly what came back.
 *
 * Where a runtime has nothing to say, the field is `null` next to a status
 * string naming the reason. A field quietly omitted reads as one that was
 * checked and found fine; a placeholder digest is worse still, because it would
 * survive a comparison it never actually made.
 *
 * Read-only. Nothing is downloaded, nothing is loaded, no model is pulled.
 *
 * Usage:
 *   node scripts/capture-environment.mjs
 *     [--llm-endpoint http://127.0.0.1:11434]
 *     [--embedding-endpoint http://127.0.0.1:1234]
 */

import { loopbackFetch } from './lib/localGuard.mjs';
import { environmentSnapshot, writeEvidence } from './lib/evidence.mjs';

const PROBE_TIMEOUT_MS = 10_000;

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const llmEndpoint = arg('llm-endpoint', 'http://127.0.0.1:11434');
const embeddingEndpoint = arg('embedding-endpoint', 'http://127.0.0.1:1234');

async function json(url) {
  const response = await loopbackFetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/** Ollama lists a manifest digest per model; that is real artifact identity. */
async function ollamaSnapshot(base) {
  const snapshot = {
    name: 'Ollama',
    endpoint: base,
    provider_protocol: 'ollama-native (/api/chat)',
    endpoint_class: 'loopback',
    version: null,
    version_status: null,
    models_present: [],
    models_status: null,
    digest_availability: 'reported: /api/tags returns a manifest digest per model',
  };

  try {
    const version = await json(`${base}/api/version`);
    snapshot.version = version.version ?? null;
    snapshot.version_status = version.version ? 'reported' : 'absent_from_response';
  } catch (error) {
    snapshot.version_status = `unavailable_from_runtime: GET /api/version failed: ${error.message}`;
  }

  try {
    const tags = await json(`${base}/api/tags`);
    snapshot.models_present = (tags.models ?? []).map((model) => ({
      id: model.name,
      digest: model.digest ?? null,
      digest_status: model.digest ? 'reported' : 'absent_from_response',
      quantization: model.details?.quantization_level ?? null,
      parameter_size: model.details?.parameter_size ?? null,
      family: model.details?.family ?? null,
      size_bytes: model.size ?? null,
      modified_at: model.modified_at ?? null,
      revision: null,
      revision_status:
        'unavailable_from_runtime: Ollama exposes no upstream model revision, only the local manifest digest',
    }));
    snapshot.models_status = 'reported';
  } catch (error) {
    snapshot.models_status = `unavailable_from_runtime: GET /api/tags failed: ${error.message}`;
  }

  return snapshot;
}

/** LM Studio has richer per-model metadata than the OpenAI route and no digest at all. */
async function lmStudioSnapshot(base) {
  const snapshot = {
    name: 'LM Studio',
    endpoint: base,
    provider_protocol: 'openai-compatible (/v1/embeddings)',
    endpoint_class: 'loopback',
    version: null,
    version_status:
      'unavailable_from_runtime: the local HTTP API exposes no version endpoint (/v1 and /api/v0 have no version route)',
    models_present: [],
    models_status: null,
    digest_availability:
      'unavailable_from_runtime: LM Studio reports no artifact digest or checksum for any model, loaded or listed',
  };

  try {
    const models = await json(`${base}/api/v0/models`);
    snapshot.models_present = (models.data ?? []).map((model) => ({
      id: model.id,
      digest: null,
      digest_status:
        'unavailable_from_runtime: LM Studio reports no artifact digest or checksum for a model',
      quantization: model.quantization ?? null,
      arch: model.arch ?? null,
      publisher: model.publisher ?? null,
      compatibility_type: model.compatibility_type ?? null,
      max_context_length: model.max_context_length ?? null,
      state: model.state ?? null,
      revision: null,
      revision_status: 'unavailable_from_runtime: LM Studio reports no upstream model revision',
    }));
    snapshot.models_status = 'reported';
  } catch (error) {
    snapshot.models_status = `unavailable_from_runtime: GET /api/v0/models failed: ${error.message}`;
  }

  return snapshot;
}

const [llm, embedding] = await Promise.all([
  ollamaSnapshot(llmEndpoint),
  lmStudioSnapshot(embeddingEndpoint),
]);

const body = {
  captured_at: new Date().toISOString(),
  captured_by: 'scripts/capture-environment.mjs',
  note: [
    'Recorded so a rerun can be compared to this one. Nothing here was downloaded by',
    'the spike: both runtimes and every model listed were already installed on this',
    'machine. Fields the runtime does not expose are null next to the reason, never',
    'omitted and never filled with a placeholder.',
  ].join(' '),
  machine: environmentSnapshot(),
  runtimes: { llm, embedding },
  models_used: {
    llm: 'llama3.1:8b',
    embedding: 'text-embedding-nomic-embed-text-v1.5',
  },
  digest_coverage: {
    llm: llm.models_present.every((model) => model.digest) ? 'complete' : 'partial_or_absent',
    embedding: 'absent',
    caveat:
      'Only the Ollama side has a digest. A rerun can prove it used the same rubric model artifact; it cannot prove the same embedding artifact, because LM Studio offers nothing to compare.',
  },
  downloads_performed: 0,
};

const file = writeEvidence('environment.json', body);
console.log(`environment -> ${file}`);
console.log(
  `  Ollama    version=${llm.version ?? 'null'} models=${llm.models_present.length} digests=${body.digest_coverage.llm}`,
);
console.log(
  `  LM Studio version=null models=${embedding.models_present.length} digests=${body.digest_coverage.embedding}`,
);
