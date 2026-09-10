import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalRunStore } from '@/storage/LocalRunStore';
import { LocalResultStore } from '@/storage/LocalResultStore';
import { LocalEvaluationStore } from '@/storage/LocalEvaluationStore';
import { saveManualSttResult } from '@/results/saveResult';
import { BUILT_IN_TOOL_NAMES } from '@/results/tools';
import { GET as getEvaluations, POST as postEvaluation } from './evaluations/route';
import { GET as getEvaluation } from './evaluations/[evaluationId]/route';

/**
 * HTTP-boundary checks for the raw character Evaluation surface. No AivisSpeech
 * Engine is contacted; the Run is written directly with the Phase 1 store.
 */

const RUN_ID = '20260907T060000000Z-aaaaaaaa';
const RESULT_ID = '20260907T060100000Z-bbbbbbbb';
const LEGACY_RESULT_ID = '20260907T060200000Z-cccccccc';
const MISSING_RESULT_ID = '20260907T060300000Z-dddddddd';
const MISSING_EVALUATION_ID = '20260907T060400000Z-eeeeeeee';
const NOW = new Date('2026-09-07T06:00:00.000Z');

const SOURCE_TEXT = '天井高は二千七百ミリを確保してください。';
const TRANSCRIPT = '天井高は2700ミリを確保してください。';
/** The same sentence with the wrong number: a supported Critical mismatch. */
const WRONG_VALUE_TRANSCRIPT = '天井高は2600ミリを確保してください。';
const VETO_RESULT_ID = '20260907T060500000Z-ffffffff';
const AUDIO = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45]);
const PROVIDER_QUERY = Buffer.from('{"schema_version":1,"segments":[]}\n', 'utf8');

function sha(bytes: Uint8Array | string): string {
  return createHash('sha256')
    .update(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes)
    .digest('hex');
}

function manifest(runId: string): Record<string, unknown> {
  return {
    schema_version: 2,
    run_id: runId,
    test_id: 'numbers-units-001',
    generated_at: NOW.toISOString(),
    source: { file: 'source.txt', encoding: 'utf-8', line_endings: 'lf', sha256: sha(SOURCE_TEXT) },
    provider: {
      id: 'aivisspeech',
      engine_name: 'AivisSpeech',
      engine_version: '1.1.0-dev',
      engine_url: 'http://127.0.0.1:10101',
    },
    model: { uuid: 'm', name: 'まお', version: '1.2.0' },
    voice: { speaker_uuid: 's', speaker_name: 'まお', style_id: 1, style_name: 'ノーマル' },
    settings: { speed_scale: 1, volume_scale: 1, sample_rate: 44100, stereo: false },
    segmentation: { strategy: 'none', target_max_chars: 450, segment_count: 1 },
    provider_query: { file: 'provider-query.json', sha256: sha(PROVIDER_QUERY) },
    audio: {
      file: 'audio.wav',
      content_type: 'audio/wav',
      sha256: sha(AUDIO),
      bytes: AUDIO.byteLength,
    },
    reproducibility: { canonical_artifact: true, bit_exact_regeneration_expected: false },
  };
}

let runsRoot: string;
let resultsRoot: string;
let sessionsRoot: string;
let evaluationsRoot: string;

async function writeRun(): Promise<void> {
  await new LocalRunStore(runsRoot).saveRun(RUN_ID, {
    sourceText: SOURCE_TEXT,
    audio: AUDIO,
    providerQueryJson: PROVIDER_QUERY,
    manifestJson: Buffer.from(`${JSON.stringify(manifest(RUN_ID), null, 2)}\n`, 'utf8'),
  });
}

async function saveVetoResult(): Promise<void> {
  await saveManualSttResult(
    {
      runId: RUN_ID,
      toolId: 'aqua-voice',
      deliveryPath: 'speaker-to-mic',
      rawTranscript: WRONG_VALUE_TRANSCRIPT,
    },
    {
      runStore: new LocalRunStore(runsRoot),
      resultStore: new LocalResultStore(resultsRoot),
      now: () => NOW,
      resultId: VETO_RESULT_ID,
    },
  );
}

async function saveSealedResult(): Promise<void> {
  await saveManualSttResult(
    {
      runId: RUN_ID,
      toolId: 'windows-standard-voice-input',
      deliveryPath: 'speaker-to-mic',
      rawTranscript: TRANSCRIPT,
    },
    {
      runStore: new LocalRunStore(runsRoot),
      resultStore: new LocalResultStore(resultsRoot),
      now: () => NOW,
      resultId: RESULT_ID,
    },
  );
}

async function saveLegacyResult(): Promise<void> {
  const legacy = {
    schema_version: 1,
    result_id: LEGACY_RESULT_ID,
    run_id: RUN_ID,
    captured_at: NOW.toISOString(),
    tool: {
      id: 'windows-standard-voice-input',
      name: BUILT_IN_TOOL_NAMES['windows-standard-voice-input'],
      version: null,
    },
    capture: { method: 'manual-paste', delivery_path: 'speaker-to-mic' },
    run_evidence: {
      manifest_schema_version: 2,
      test_id: 'numbers-units-001',
      source_sha256: sha(SOURCE_TEXT),
      audio_sha256: sha(AUDIO),
    },
    transcript: {
      file: 'transcript.txt',
      encoding: 'utf-8',
      line_endings: 'lf',
      sha256: sha(TRANSCRIPT),
      bytes: Buffer.byteLength(TRANSCRIPT, 'utf8'),
    },
  };
  await new LocalResultStore(resultsRoot).saveResult(LEGACY_RESULT_ID, {
    transcriptText: TRANSCRIPT,
    resultJson: Buffer.from(`${JSON.stringify(legacy, null, 2)}\n`, 'utf8'),
  });
}

function postRequest(body: unknown): Request {
  return new Request('http://localhost/api/evaluations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function getRequest(query: string): Request {
  return new Request(`http://localhost/api/evaluations${query}`);
}

function detailContext(evaluationId: string) {
  return { params: Promise.resolve({ evaluationId }) };
}

beforeEach(async () => {
  runsRoot = await mkdtemp(path.join(tmpdir(), 'vib-eroute-runs-'));
  resultsRoot = await mkdtemp(path.join(tmpdir(), 'vib-eroute-results-'));
  sessionsRoot = await mkdtemp(path.join(tmpdir(), 'vib-eroute-sessions-'));
  evaluationsRoot = await mkdtemp(path.join(tmpdir(), 'vib-eroute-evaluations-'));
  process.env.VIB_RUNS_DIR = runsRoot;
  process.env.VIB_RESULTS_DIR = resultsRoot;
  process.env.VIB_SESSIONS_DIR = sessionsRoot;
  process.env.VIB_EVALUATIONS_DIR = evaluationsRoot;
});

afterEach(async () => {
  delete process.env.VIB_SEMANTIC_ENDPOINT;
  delete process.env.VIB_RUNS_DIR;
  delete process.env.VIB_RESULTS_DIR;
  delete process.env.VIB_SESSIONS_DIR;
  delete process.env.VIB_EVALUATIONS_DIR;
  for (const root of [runsRoot, resultsRoot, sessionsRoot, evaluationsRoot]) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('POST /api/evaluations', () => {
  it('creates a sealed Evaluation from a sealed Result', async () => {
    await writeRun();
    await saveSealedResult();

    const response = await postEvaluation(postRequest({ resultId: RESULT_ID }));
    expect(response.status).toBe(201);

    const body = (await response.json()) as {
      ok: true;
      evaluationId: string;
      evaluation: {
        schema_version: number;
        evaluator: Record<string, string>;
        run_id: string;
        result_id: string;
        metrics: { edit_distance: number; cer: number; exact_match: boolean };
        integrity: { algorithm: string; semantic_sha256: string };
      };
      referenceText: string;
      hypothesisText: string;
    };

    expect(body.ok).toBe(true);
    expect(body.evaluation).toMatchObject({
      schema_version: 1,
      evaluator: { id: 'raw-char-v1', unit: 'unicode-code-point', normalization: 'none' },
      run_id: RUN_ID,
      result_id: RESULT_ID,
    });
    expect(body.evaluation.integrity.algorithm).toBe('sha256');
    expect(body.evaluation.metrics.exact_match).toBe(false);
    expect(body.evaluation.metrics.edit_distance).toBeGreaterThan(0);
    expect(body.referenceText).toBe(SOURCE_TEXT);
    expect(body.hypothesisText).toBe(TRANSCRIPT);
  });

  it('rejects a body with no resultId', async () => {
    await writeRun();
    const response = await postEvaluation(postRequest({}));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { kind: string } };
    expect(body.error.kind).toBe('BAD_REQUEST');
  });

  it('rejects a body that is not JSON', async () => {
    const response = await postEvaluation(
      new Request('http://localhost/api/evaluations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      }),
    );
    expect(response.status).toBe(400);
  });

  it('refuses a legacy v1 Result with 409', async () => {
    await writeRun();
    await saveLegacyResult();

    const response = await postEvaluation(postRequest({ resultId: LEGACY_RESULT_ID }));
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { kind: string } };
    expect(body.error.kind).toBe('EVALUATION_RESULT_NOT_SEALED');
  });

  it('reports an unknown Result as 404', async () => {
    await writeRun();
    const response = await postEvaluation(postRequest({ resultId: MISSING_RESULT_ID }));
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { kind: string } };
    expect(body.error.kind).toBe('EVALUATION_RESULT_UNREADABLE');
  });
});

describe('GET /api/evaluations', () => {
  it('requires runId', async () => {
    const response = await getEvaluations(getRequest(''));
    expect(response.status).toBe(400);
  });

  it('lists the Evaluations for one Run', async () => {
    await writeRun();
    await saveSealedResult();
    await postEvaluation(postRequest({ resultId: RESULT_ID }));

    const response = await getEvaluations(getRequest(`?runId=${RUN_ID}`));
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      ok: true;
      runId: string;
      evaluations: Array<{ status: string; evaluationId: string; referenceText?: string }>;
    };
    expect(body.runId).toBe(RUN_ID);
    expect(body.evaluations).toHaveLength(1);
    expect(body.evaluations[0]!.status).toBe('verified');
    expect(body.evaluations[0]!.referenceText).toBe(SOURCE_TEXT);
  });

  it('returns an empty list for a Run with no Evaluations', async () => {
    await writeRun();
    const body = (await (await getEvaluations(getRequest(`?runId=${RUN_ID}`))).json()) as {
      evaluations: unknown[];
    };
    expect(body.evaluations).toEqual([]);
  });

  it('fails closed on an unknown Run', async () => {
    const response = await getEvaluations(getRequest(`?runId=${RUN_ID}`));
    expect(response.status).toBe(404);
  });
});

describe('GET /api/evaluations/<evaluation-id>', () => {
  async function createOne(): Promise<string> {
    await writeRun();
    await saveSealedResult();
    const body = (await (await postEvaluation(postRequest({ resultId: RESULT_ID }))).json()) as {
      evaluationId: string;
    };
    return body.evaluationId;
  }

  it('returns one verified Evaluation with both texts', async () => {
    const evaluationId = await createOne();

    const response = await getEvaluation(
      new Request(`http://localhost/api/evaluations/${evaluationId}`),
      detailContext(evaluationId),
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      ok: true;
      evaluation: {
        evaluation_id: string;
        evaluator: { id: string; unit: string; normalization: string };
      };
      referenceText: string;
      hypothesisText: string;
    };
    expect(body.evaluation.evaluation_id).toBe(evaluationId);
    expect(body.evaluation.evaluator).toEqual({
      id: 'raw-char-v1',
      unit: 'unicode-code-point',
      normalization: 'none',
    });
    expect(body.referenceText).toBe(SOURCE_TEXT);
    expect(body.hypothesisText).toBe(TRANSCRIPT);
  });

  it('reports a missing Evaluation as 404', async () => {
    await writeRun();
    const response = await getEvaluation(
      new Request(`http://localhost/api/evaluations/${MISSING_EVALUATION_ID}`),
      detailContext(MISSING_EVALUATION_ID),
    );
    expect(response.status).toBe(404);
  });

  it('reports a tampered Evaluation as 409 rather than returning its numbers', async () => {
    const evaluationId = await createOne();
    const store = new LocalEvaluationStore(evaluationsRoot);
    const file = store.resolveEvaluationFile(evaluationId);
    const stored = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    (stored.metrics as Record<string, unknown>).cer = 0;
    await writeFile(file, `${JSON.stringify(stored, null, 2)}\n`);

    const response = await getEvaluation(
      new Request(`http://localhost/api/evaluations/${evaluationId}`),
      detailContext(evaluationId),
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { kind: string } };
    expect(body.error.kind).toBe('EVALUATION_INTEGRITY_MISMATCH');
  });
});

describe('POST /api/evaluations with an evaluator', () => {
  it('defaults to raw-char-v1 when no evaluator is named', async () => {
    await writeRun();
    await saveSealedResult();

    const response = await postEvaluation(postRequest({ resultId: RESULT_ID }));
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      evaluation: { schema_version: number; evaluator: { id: string } };
    };
    expect(body.evaluation.schema_version).toBe(1);
    expect(body.evaluation.evaluator.id).toBe('raw-char-v1');
  });

  it('runs critical-info-v1 when asked for it', async () => {
    await writeRun();
    await saveSealedResult();

    const response = await postEvaluation(
      postRequest({ resultId: RESULT_ID, evaluatorId: 'critical-info-v1' }),
    );
    expect(response.status).toBe(201);

    const body = (await response.json()) as {
      evaluation: {
        schema_version: number;
        evaluator: { id: string; unit: string; normalization: string };
        metrics: {
          reference_entities: number;
          matched: number;
          missing: number;
          extra: number;
          preservation_rate: number;
        };
        missing: Array<{ surface: string }>;
        extra: Array<{ surface: string }>;
      };
    };

    expect(body.evaluation.schema_version).toBe(2);
    expect(body.evaluation.evaluator).toEqual({
      id: 'critical-info-v1',
      scope: 'numeric-unit-time',
      number_grammar: 'number-grammar-v1',
      unit_aliases: 'unit-alias-v1',
      matching: 'canonical-multiset-v1',
      separator_policy: 'space-fullwidth-space-v1',
    });
    // The source says 二千七百ミリ and the transcript says 2700ミリ — the same
    // fact, spelled differently.
    expect(body.evaluation.metrics).toMatchObject({
      reference_entities: 1,
      matched: 1,
      missing: 0,
      extra: 0,
      preservation_rate: 1,
    });
  });

  it('refuses an evaluator it does not implement', async () => {
    await writeRun();
    await saveSealedResult();

    const response = await postEvaluation(
      postRequest({ resultId: RESULT_ID, evaluatorId: 'llm-grader-v1' }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { kind: string; message: string } };
    expect(body.error.kind).toBe('BAD_REQUEST');
    expect(body.error.message).toContain('critical-info-v1');
  });

  it('refuses a non-string evaluator', async () => {
    await writeRun();
    await saveSealedResult();
    const response = await postEvaluation(postRequest({ resultId: RESULT_ID, evaluatorId: 7 }));
    expect(response.status).toBe(400);
  });

  it('refuses a legacy v1 Result for critical-info-v1 as well', async () => {
    await writeRun();
    await saveLegacyResult();

    const response = await postEvaluation(
      postRequest({ resultId: LEGACY_RESULT_ID, evaluatorId: 'critical-info-v1' }),
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { kind: string } };
    expect(body.error.kind).toBe('EVALUATION_RESULT_NOT_SEALED');
  });

  it('lists a raw-char and a critical Evaluation for the same Run', async () => {
    await writeRun();
    await saveSealedResult();
    await postEvaluation(postRequest({ resultId: RESULT_ID }));
    await postEvaluation(postRequest({ resultId: RESULT_ID, evaluatorId: 'critical-info-v1' }));

    const body = (await (await getEvaluations(getRequest(`?runId=${RUN_ID}`))).json()) as {
      evaluations: Array<{ status: string; evaluation?: { evaluator: { id: string } } }>;
    };
    expect(body.evaluations).toHaveLength(2);
    expect(body.evaluations.every((entry) => entry.status === 'verified')).toBe(true);
    expect(body.evaluations.map((entry) => entry.evaluation?.evaluator.id).sort()).toEqual([
      'critical-info-v1',
      'raw-char-v1',
    ]);
  });

  it('returns one verified critical Evaluation with both texts', async () => {
    await writeRun();
    await saveSealedResult();
    const created = (await (
      await postEvaluation(postRequest({ resultId: RESULT_ID, evaluatorId: 'critical-info-v1' }))
    ).json()) as { evaluationId: string };

    const response = await getEvaluation(
      new Request(`http://localhost/api/evaluations/${created.evaluationId}`),
      detailContext(created.evaluationId),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      evaluation: { schema_version: number };
      referenceText: string;
      hypothesisText: string;
    };
    expect(body.evaluation.schema_version).toBe(2);
    expect(body.referenceText).toBe(SOURCE_TEXT);
    expect(body.hypothesisText).toBe(TRANSCRIPT);
  });
});

describe('POST /api/evaluations with the surface evaluator', () => {
  it('runs surface-normalized-char-v1 when asked for it', async () => {
    await writeRun();
    await saveSealedResult();

    const response = await postEvaluation(
      postRequest({ resultId: RESULT_ID, evaluatorId: 'surface-normalized-char-v1' }),
    );
    expect(response.status).toBe(201);

    const body = (await response.json()) as {
      evaluation: {
        schema_version: number;
        evaluator: { id: string; unit: string; normalization: string };
        normalized: {
          reference: { sha256: string; chars: number };
          hypothesis: { sha256: string; chars: number };
        };
        metrics: { cer: number; edit_distance: number; exact_match: boolean };
      };
    };

    expect(body.evaluation.schema_version).toBe(3);
    expect(body.evaluation.evaluator).toEqual({
      id: 'surface-normalized-char-v1',
      unit: 'unicode-code-point',
      normalization_profile: 'surface-normalize-v1',
      width_mapping: 'fullwidth-ascii-range-v1',
      case_fold: 'ascii-lower-v1',
      punctuation_aliases: 'punctuation-alias-v1',
      space_policy: 'ascii-space-trim-collapse-v1',
      line_break_policy: 'preserve-lf-v1',
      distance: 'levenshtein-code-point-sdi-v1',
    });
    expect(body.evaluation.normalized.reference.chars).toBeGreaterThan(0);
    // 二千七百ミリ against 2700ミリ is a real difference, not typography.
    expect(body.evaluation.metrics.exact_match).toBe(false);
    expect(body.evaluation.metrics.edit_distance).toBeGreaterThan(0);
  });

  it('refuses a legacy v1 Result for the surface evaluator as well', async () => {
    await writeRun();
    await saveLegacyResult();

    const response = await postEvaluation(
      postRequest({ resultId: LEGACY_RESULT_ID, evaluatorId: 'surface-normalized-char-v1' }),
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { kind: string } };
    expect(body.error.kind).toBe('EVALUATION_RESULT_NOT_SEALED');
  });

  it('names every implemented evaluator when refusing an unknown one', async () => {
    await writeRun();
    await saveSealedResult();

    const response = await postEvaluation(
      postRequest({ resultId: RESULT_ID, evaluatorId: 'semantic-similarity-v1' }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { kind: string; message: string } };
    expect(body.error.kind).toBe('BAD_REQUEST');
    expect(body.error.message).toContain('raw-char-v1');
    expect(body.error.message).toContain('surface-normalized-char-v1');
    expect(body.error.message).toContain('critical-info-v1');
    // The fourth layer has to be offered here too. A refusal that lists three of
    // four evaluators tells an operator the one they wanted does not exist.
    expect(body.error.message).toContain('semantic-h3-v1');
  });

  it('lists all three Evaluations for the same Run', async () => {
    await writeRun();
    await saveSealedResult();
    await postEvaluation(postRequest({ resultId: RESULT_ID }));
    await postEvaluation(
      postRequest({ resultId: RESULT_ID, evaluatorId: 'surface-normalized-char-v1' }),
    );
    await postEvaluation(postRequest({ resultId: RESULT_ID, evaluatorId: 'critical-info-v1' }));

    const body = (await (await getEvaluations(getRequest(`?runId=${RUN_ID}`))).json()) as {
      evaluations: Array<{ status: string; evaluation?: { evaluator: { id: string } } }>;
    };
    expect(body.evaluations).toHaveLength(3);
    expect(body.evaluations.every((entry) => entry.status === 'verified')).toBe(true);
    expect(body.evaluations.map((entry) => entry.evaluation?.evaluator.id).sort()).toEqual([
      'critical-info-v1',
      'raw-char-v1',
      'surface-normalized-char-v1',
    ]);
  });

  it('returns the normalized pair alongside the raw texts', async () => {
    await writeRun();
    await saveSealedResult();
    const created = (await (
      await postEvaluation(
        postRequest({ resultId: RESULT_ID, evaluatorId: 'surface-normalized-char-v1' }),
      )
    ).json()) as { evaluationId: string };

    const response = await getEvaluation(
      new Request(`http://localhost/api/evaluations/${created.evaluationId}`),
      detailContext(created.evaluationId),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      evaluation: { schema_version: number };
      referenceText: string;
      hypothesisText: string;
      normalized: { reference: string; hypothesis: string };
    };
    expect(body.evaluation.schema_version).toBe(3);
    expect(body.referenceText).toBe(SOURCE_TEXT);
    expect(body.hypothesisText).toBe(TRANSCRIPT);
    expect(body.normalized.reference).toBe(SOURCE_TEXT.replace('。', '.'));
    expect(body.normalized.hypothesis).toBe(TRANSCRIPT.replace('。', '.'));
  });
});

/**
 * The fourth evaluator over HTTP.
 *
 * Every case here is hermetic. The accepted path uses a Result the Critical
 * guard vetoes, which is exactly the path that contacts no model at all; the
 * refusal paths point the endpoint at a closed loopback port or at a name that
 * is not loopback. Nothing here reaches Ollama — a live run is a separate
 * manual smoke.
 */
describe('POST /api/evaluations with the semantic evaluator', () => {
  it('runs semantic-h3-v1 when asked for it', async () => {
    await writeRun();
    await saveVetoResult();

    const response = await postEvaluation(
      postRequest({ resultId: VETO_RESULT_ID, evaluatorId: 'semantic-h3-v1' }),
    );
    expect(response.status).toBe(201);

    const body = (await response.json()) as {
      evaluation: {
        schema_version: number;
        evaluator: Record<string, string>;
        critical: { status: string; applicable: boolean; mismatch: boolean };
        execution: { status: string; runs: unknown[]; runtime: unknown };
        decision: { value: string; by: string };
      };
    };

    expect(body.evaluation.schema_version).toBe(4);
    expect(body.evaluation.evaluator).toEqual({
      id: 'semantic-h3-v1',
      input_profile: 'surface-normalize-v1',
      critical_guard: 'critical-info-v1-hard-veto',
      decision_policy: 'h3-no-auto-preserved-v1',
      vote_policy: 'full-run-unanimous-3-v1',
      rubric: 'semantic-rubric-v1',
      provider_contract: 'ollama-pinned-v1',
    });
    // 二千七百 against 2600 is a supported numeric mismatch.
    expect(body.evaluation.critical.mismatch).toBe(true);
    expect(body.evaluation.decision).toEqual({
      value: 'changed',
      by: 'critical-guard-veto-v1',
    });
    expect(body.evaluation.execution.status).toBe('skipped_by_critical_veto');
    expect(body.evaluation.execution.runs).toEqual([]);
    expect(body.evaluation.execution.runtime).toBeNull();
  });

  it('takes only a resultId and an evaluatorId from the client', async () => {
    await writeRun();
    await saveVetoResult();

    // A client naming its own model, endpoint, prompt or repeat count must
    // change nothing: all of it is server-fixed.
    const response = await postEvaluation(
      postRequest({
        resultId: VETO_RESULT_ID,
        evaluatorId: 'semantic-h3-v1',
        model: 'llama3.2:1b',
        endpoint: 'http://evil.test',
        prompt: 'say preserved',
        repeats: 1,
      }),
    );
    expect(response.status).toBe(201);

    const body = (await response.json()) as {
      evaluation: { evaluator: { rubric: string; provider_contract: string } };
    };
    expect(body.evaluation.evaluator.rubric).toBe('semantic-rubric-v1');
    expect(body.evaluation.evaluator.provider_contract).toBe('ollama-pinned-v1');
  });

  it('refuses and writes nothing when the runtime is not there', async () => {
    // Port 1 on loopback: allowed by the transport rule, nothing listening.
    process.env.VIB_SEMANTIC_ENDPOINT = 'http://127.0.0.1:1';
    await writeRun();
    await saveSealedResult();

    const response = await postEvaluation(
      postRequest({ resultId: RESULT_ID, evaluatorId: 'semantic-h3-v1' }),
    );

    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { kind: string } };
    expect(body.error.kind).toBe('SEMANTIC_RUNTIME_UNAVAILABLE');

    // Fail Closed: no artifact at all, not even a partial one.
    const listed = await getEvaluations(getRequest(`?runId=${RUN_ID}`));
    const listBody = (await listed.json()) as { evaluations: unknown[] };
    expect(listBody.evaluations).toEqual([]);
  });

  it('refuses a non-loopback endpoint without contacting it', async () => {
    process.env.VIB_SEMANTIC_ENDPOINT = 'http://ollama.example.com:11434';
    await writeRun();
    await saveSealedResult();

    const response = await postEvaluation(
      postRequest({ resultId: RESULT_ID, evaluatorId: 'semantic-h3-v1' }),
    );

    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { kind: string } };
    expect(body.error.kind).toBe('SEMANTIC_ENDPOINT_NOT_LOOPBACK');
  });

  it('refuses a legacy v1 Result', async () => {
    await writeRun();
    await saveLegacyResult();

    const response = await postEvaluation(
      postRequest({ resultId: LEGACY_RESULT_ID, evaluatorId: 'semantic-h3-v1' }),
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { kind: string } };
    expect(body.error.kind).toBe('EVALUATION_RESULT_NOT_SEALED');
  });

  it('names semantic-h3-v1 among the evaluators a client may ask for', async () => {
    const response = await postEvaluation(
      postRequest({ resultId: RESULT_ID, evaluatorId: 'semantic-similarity-v1' }),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { kind: string; message: string } };
    expect(body.error.kind).toBe('BAD_REQUEST');
    expect(body.error.message).toContain('semantic-h3-v1');
  });

  it('reads a stored v4 back with its normalized texts', async () => {
    await writeRun();
    await saveVetoResult();

    const created = await postEvaluation(
      postRequest({ resultId: VETO_RESULT_ID, evaluatorId: 'semantic-h3-v1' }),
    );
    const { evaluationId } = (await created.json()) as { evaluationId: string };

    const response = await getEvaluation(
      new Request('http://localhost'),
      detailContext(evaluationId),
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      evaluation: { schema_version: number; decision: { value: string } };
      normalized: { reference: string; hypothesis: string };
    };
    expect(body.evaluation.schema_version).toBe(4);
    expect(body.evaluation.decision.value).toBe('changed');
    expect(body.normalized.reference).toBe(SOURCE_TEXT.replace('。', '.'));
    expect(body.normalized.hypothesis).toBe(WRONG_VALUE_TRANSCRIPT.replace('。', '.'));
  });
});
