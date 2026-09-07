#!/usr/bin/env node
/**
 * Method A — local embedding cosine similarity.
 *
 * Embeds each side of every probe on a local runtime and records the cosine
 * similarity. It records both readings of the input — raw and
 * surface-normalized — because one of the questions this spike has to answer is
 * which of the two a semantic method should be fed.
 *
 * It deliberately does **not** pick a threshold. A threshold is a production
 * decision about how much false-preserved risk is acceptable, and this script's
 * job is to hand that decision the numbers it needs — in particular the
 * similarity of the hard negatives, which is where an embedding-only method
 * either survives or does not.
 *
 * No model is downloaded. If the named embedding model is not already on the
 * machine the run stops as UNAVAILABLE_ON_CURRENT_MACHINE and reports PARTIAL.
 *
 * Usage:
 *   node scripts/run-embedding.mjs [--endpoint http://127.0.0.1:1234] [--model <id>]
 */

import { NotLoopbackError, assertLoopbackEndpoint, loopbackFetch } from './lib/localGuard.mjs';
import { loadProbes, modelInputFor } from './lib/probes.mjs';
import { environmentSnapshot, mean, median, writeEvidence } from './lib/evidence.mjs';
import { surfaceNormalizeMirror } from './lib/surfaceNormalizeMirror.mjs';
import { lmStudioRuntimeInfo } from './lib/runtimeInfo.mjs';

const DEFAULT_ENDPOINT = 'http://127.0.0.1:1234';
const DEFAULT_MODEL = 'text-embedding-nomic-embed-text-v1.5';
const REQUEST_TIMEOUT_MS = 60_000;

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const endpoint = arg('endpoint', DEFAULT_ENDPOINT);
const model = arg('model', DEFAULT_MODEL);

function cosine(a, b) {
  if (a.length !== b.length) throw new Error(`vector length mismatch: ${a.length} vs ${b.length}`);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) throw new Error('zero-magnitude embedding');
  return dot / denominator;
}

/** Is the model already loaded here? Never triggers a download. */
async function listModels(base) {
  const response = await loopbackFetch(`${base}/v1/models`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GET /v1/models -> HTTP ${response.status}`);
  const body = await response.json();
  return (body.data ?? []).map((entry) => entry.id);
}

async function embed(base, text) {
  const response = await loopbackFetch(`${base}/v1/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, input: text }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`POST /v1/embeddings -> HTTP ${response.status}: ${await response.text()}`);
  }
  const body = await response.json();
  const vector = body?.data?.[0]?.embedding;
  // Fail Closed on a malformed response rather than scoring a shape we did not
  // ask for. A silently empty vector would become a similarity of NaN and then
  // a row in a results table.
  if (!Array.isArray(vector) || vector.length === 0 || !vector.every(Number.isFinite)) {
    throw new Error('embedding response did not contain a finite numeric vector');
  }
  return vector;
}

async function main() {
  const startedAt = new Date().toISOString();
  let base;
  try {
    base = assertLoopbackEndpoint(endpoint).origin;
  } catch (error) {
    if (error instanceof NotLoopbackError) {
      console.error(`REFUSED  ${error.message}`);
      process.exit(2);
    }
    throw error;
  }

  const { probes, sha256, corpus } = loadProbes();

  let available;
  try {
    available = await listModels(base);
  } catch (error) {
    const evidence = {
      method: 'embedding',
      status: 'UNAVAILABLE_ON_CURRENT_MACHINE',
      reason: `local endpoint not reachable: ${error.message}`,
      endpoint: base,
      model,
      probes_sha256: sha256,
      started_at: startedAt,
      environment: environmentSnapshot(),
    };
    console.error(`UNAVAILABLE  ${evidence.reason}`);
    console.error(`evidence -> ${writeEvidence('embedding-unavailable.json', evidence)}`);
    process.exit(3);
  }

  if (!available.includes(model)) {
    const evidence = {
      method: 'embedding',
      status: 'UNAVAILABLE_ON_CURRENT_MACHINE',
      reason: `model ${model} is not present on this machine`,
      note: 'No model is downloaded by this spike. Load the model locally and rerun, or report PARTIAL.',
      endpoint: base,
      model,
      available_models: available,
      probes_sha256: sha256,
      started_at: startedAt,
      environment: environmentSnapshot(),
    };
    console.error(`UNAVAILABLE  ${evidence.reason}`);
    console.error(`evidence -> ${writeEvidence('embedding-unavailable.json', evidence)}`);
    process.exit(3);
  }

  const results = [];
  const latencies = [];

  for (const probe of probes) {
    const input = modelInputFor(probe);
    const variants = {
      raw: { reference: input.reference, hypothesis: input.hypothesis },
      surface: {
        reference: surfaceNormalizeMirror(input.reference),
        hypothesis: surfaceNormalizeMirror(input.hypothesis),
      },
    };

    const similarity = {};
    let dimensions = null;
    for (const [variant, texts] of Object.entries(variants)) {
      const began = performance.now();
      const [a, b] = [await embed(base, texts.reference), await embed(base, texts.hypothesis)];
      latencies.push(performance.now() - began);
      dimensions = a.length;
      similarity[variant] = cosine(a, b);
    }

    // The proposed label is attached only now, after every request has been made.
    results.push({
      id: probe.id,
      category: probe.category,
      hard_negative: probe.hard_negative,
      proposed_label: probe.gold.label,
      proposed_reason_code: probe.gold.reason_code,
      cosine_raw: similarity.raw,
      cosine_surface: similarity.surface,
      dimensions,
    });

    console.log(
      `${probe.id.padEnd(4)} ${probe.gold.label.padEnd(9)} raw=${similarity.raw.toFixed(4)} surface=${similarity.surface.toFixed(4)} ${probe.hard_negative ? 'HARD-NEG' : ''}`,
    );
  }

  const runtime = await lmStudioRuntimeInfo(base, model);

  const evidence = {
    method: 'embedding',
    status: 'OK',
    gold_provenance: corpus.gold_provenance,
    scoring_caveat:
      'Any accuracy computed from this file is provisional accuracy against proposed labels. The labels have not been confirmed by a human.',
    ...runtime,
    // The vectors themselves are not written anywhere. They are large, they are
    // derived from customer text, and nothing downstream needs them: the
    // similarity is the measurement.
    vectors_persisted: false,
    probes_sha256: sha256,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    environment: environmentSnapshot(),
    latency_ms: {
      per_pair_mean: Math.round(mean(latencies) ?? 0),
      per_pair_median: Math.round(median(latencies) ?? 0),
    },
    results,
  };

  console.log(`\nevidence -> ${writeEvidence('embedding-results.json', evidence)}`);
}

await main();
