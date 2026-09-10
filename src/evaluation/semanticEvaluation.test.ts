import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalRunStore } from '@/storage/LocalRunStore';
import { LocalResultStore } from '@/storage/LocalResultStore';
import { LocalSessionStore } from '@/storage/LocalSessionStore';
import { LocalEvaluationStore } from '@/storage/LocalEvaluationStore';
import { StorageBoundaryError } from '@/storage/rootIsolation';
import { saveManualSttResult } from '@/results/saveResult';
import { BUILT_IN_TOOL_NAMES } from '@/results/tools';
import {
  createEvaluation,
  createSemanticEvaluation,
  listEvaluationsForRun,
  loadVerifiedEvaluation,
  type EvaluationDeps,
  type SemanticRunner,
} from './createEvaluation';
import { EvaluationSubjectError } from './evaluationSubject';
import { EvaluationVerificationError } from './verifyStoredEvaluation';
import {
  SEMANTIC_H3_EVALUATOR,
  computeSemanticEvaluationSemanticSha256,
  type SemanticEvaluationPayloadV4,
  type SemanticEvaluationV4,
} from './semanticEvaluationSchema';
import {
  SEMANTIC_MODEL_DIGEST,
  SEMANTIC_MODEL_ID,
  SEMANTIC_MODEL_QUANTIZATION,
  SEMANTIC_PROVIDER_PROTOCOL,
  SEMANTIC_RUNTIME_VERSION,
  SemanticProviderError,
  type SemanticRuntimeFacts,
} from './semanticProvider';
import { SEMANTIC_RUBRIC_V1_SHA256 } from './semanticPrompt';
import { surfaceNormalize } from './surfaceNormalize';
import { analyzeCriticalInfo } from './criticalInfo';

/**
 * semantic-h3-v1 against real Runs and Results on disk.
 *
 * The model is injected, so no test here reaches Ollama. What is exercised is
 * everything the artifact has to survive without it: the guard, the vote, the
 * decision, and a readback that re-derives all three from stored bytes.
 *
 * The three probe pairs below come from the P3-D-A corpus. Only their text is
 * used — the gold labels stay in the research tree, where they cannot reach a
 * prompt or a decision.
 */

const RUN_P12 = '20260909T030000000Z-aaaaaaa1';
const RUN_P14 = '20260909T030001000Z-aaaaaaa2';
const RUN_P21 = '20260909T030002000Z-aaaaaaa3';
const RUN_FULLWIDTH = '20260909T030003000Z-aaaaaaa4';
const RESULT_ID = '20260909T040000000Z-cccccccc';
const EVALUATION_ID = '20260909T050000000Z-eeeeeeee';
const NOW = new Date('2026-09-09T05:00:00.000Z');

/** p12 — a self-correction. The final intent is kept; 2600 was retracted. */
const P12_SOURCE = '天井高は二千六百ミリで、あ、すみません、二千七百ミリでした。';
const P12_TRANSCRIPT = '天井高は二千七百ミリです。';

/** p14 — a hard negative. The polarity of the instruction is reversed. */
const P14_SOURCE = '設備ルートとの干渉は梁貫通で逃がさない方針です。';
const P14_TRANSCRIPT = '設備ルートとの干渉は梁貫通で逃がす方針です。';

/** p21 — a request that became a report of completed work. */
const P21_SOURCE = '電気室の位置も、幹線ルートと合わせて一度整理しておいてください。';

/**
 * A pair that the two input profiles disagree about, which is the whole point.
 *
 * Raw, critical-info-v1 finds no measurement in the reference at all: it cannot
 * read the full-width `ｍｍ`, so the guard reports not-applicable and the pair
 * goes to the model. Surface-normalized, `2700ｍｍ` folds to `2700mm`, the
 * extractor sees 2700 against 2600, and the guard vetoes outright with zero
 * model calls.
 *
 * Same pair, opposite decisions. Every existing fixture happens to agree under
 * both compositions, so without this one the adopted contract would be pinned
 * by coincidence rather than by a test.
 */
const P21_TRANSCRIPT = '電気室の位置も、幹線ルートと合わせて一度整理しておきました。';

const FULLWIDTH_SOURCE = '天井高は2700ｍｍです。';
const FULLWIDTH_TRANSCRIPT = '天井高は2600mmです。';

const AUDIO = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45, 9, 9]);
const PROVIDER_QUERY = Buffer.from('{"schema_version":1,"segments":[]}\n', 'utf8');

function sha(bytes: Uint8Array | string): string {
  return createHash('sha256')
    .update(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes)
    .digest('hex');
}

function manifestFor(runId: string, sourceText: string): Record<string, unknown> {
  return {
    schema_version: 2,
    run_id: runId,
    test_id: 'architecture-short-001',
    generated_at: NOW.toISOString(),
    source: { file: 'source.txt', encoding: 'utf-8', line_endings: 'lf', sha256: sha(sourceText) },
    provider: {
      id: 'aivisspeech',
      engine_name: 'AivisSpeech',
      engine_version: '1.1.0-dev',
      engine_url: 'http://127.0.0.1:10101',
    },
    model: { uuid: 'model-1', name: 'まお', version: '1.2.0' },
    voice: {
      speaker_uuid: 'speaker-1',
      speaker_name: 'まお',
      style_id: 888753760,
      style_name: 'ノーマル',
    },
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

const VERDICT_CHANGED = JSON.stringify({
  meaning_preserved: false,
  severity: 'major',
  negation: true,
  direction_location: false,
  instruction_action: false,
  critical_fact: false,
  domain_term: false,
  reason_codes: ['NEGATION'],
  short_rationale: 'Polarity reversed.',
});

const VERDICT_PRESERVED = JSON.stringify({
  meaning_preserved: true,
  severity: 'none',
  negation: false,
  direction_location: false,
  instruction_action: false,
  critical_fact: false,
  domain_term: false,
  reason_codes: ['SURFACE_ONLY'],
  short_rationale: 'Same instruction.',
});

const FACTS: SemanticRuntimeFacts = {
  endpoint_class: 'loopback',
  provider_protocol: SEMANTIC_PROVIDER_PROTOCOL,
  runtime: { name: 'Ollama', version: SEMANTIC_RUNTIME_VERSION },
  model: {
    id: SEMANTIC_MODEL_ID,
    digest: SEMANTIC_MODEL_DIGEST,
    quantization: SEMANTIC_MODEL_QUANTIZATION,
  },
  prompt: { id: 'semantic-rubric-v1', sha256: SEMANTIC_RUBRIC_V1_SHA256 },
};

interface FakeRunner extends SemanticRunner {
  preflightCalls: number;
  chatCalls: string[];
}

/** A runner that replies with the given sequence, one reply per run. */
function fakeRunner(replies: Array<string | Error>): FakeRunner {
  const runner: FakeRunner = {
    preflightCalls: 0,
    chatCalls: [],
    async preflight() {
      runner.preflightCalls += 1;
      return FACTS;
    },
    async chat(requestBody: string) {
      const reply = replies[runner.chatCalls.length];
      runner.chatCalls.push(requestBody);
      if (reply instanceof Error) throw reply;
      return reply ?? '';
    },
  };
  return runner;
}

function refusingRunner(kind: SemanticProviderError['kind']): FakeRunner {
  const runner = fakeRunner([]);
  runner.preflight = async () => {
    runner.preflightCalls += 1;
    throw new SemanticProviderError(kind, 'refused in preflight');
  };
  return runner;
}

let runsRoot: string;
let resultsRoot: string;
let sessionsRoot: string;
let evaluationsRoot: string;
let runStore: LocalRunStore;
let resultStore: LocalResultStore;
let sessionStore: LocalSessionStore;
let evaluationStore: LocalEvaluationStore;

beforeEach(async () => {
  runsRoot = await mkdtemp(path.join(tmpdir(), 'vib-sem-runs-'));
  resultsRoot = await mkdtemp(path.join(tmpdir(), 'vib-sem-results-'));
  sessionsRoot = await mkdtemp(path.join(tmpdir(), 'vib-sem-sessions-'));
  evaluationsRoot = await mkdtemp(path.join(tmpdir(), 'vib-sem-evaluations-'));
  runStore = new LocalRunStore(runsRoot);
  resultStore = new LocalResultStore(resultsRoot);
  sessionStore = new LocalSessionStore(sessionsRoot);
  evaluationStore = new LocalEvaluationStore(evaluationsRoot);
});

afterEach(async () => {
  for (const root of [runsRoot, resultsRoot, sessionsRoot, evaluationsRoot]) {
    await rm(root, { recursive: true, force: true });
  }
});

function deps(overrides: Partial<EvaluationDeps> = {}): EvaluationDeps {
  return {
    runStore,
    resultStore,
    sessionStore,
    evaluationStore,
    now: () => NOW,
    evaluationId: EVALUATION_ID,
    ...overrides,
  };
}

async function writeRun(runId: string, sourceText: string): Promise<void> {
  await runStore.saveRun(runId, {
    sourceText,
    audio: AUDIO,
    providerQueryJson: PROVIDER_QUERY,
    manifestJson: Buffer.from(`${JSON.stringify(manifestFor(runId, sourceText), null, 2)}\n`, 'utf8'),
  });
}

/** Seed one Run and one sealed Result, and return the Result id. */
async function seed(runId: string, sourceText: string, transcript: string): Promise<string> {
  await writeRun(runId, sourceText);
  await saveManualSttResult(
    {
      runId,
      toolId: 'windows-standard-voice-input',
      deliveryPath: 'speaker-to-mic',
      rawTranscript: transcript,
    },
    { runStore, resultStore, now: () => NOW, resultId: RESULT_ID },
  );
  return RESULT_ID;
}

async function readStored(evaluationId = EVALUATION_ID): Promise<Record<string, unknown>> {
  const file = evaluationStore.resolveEvaluationFile(evaluationId);
  return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
}

/**
 * Edit a stored Evaluation and re-seal it.
 *
 * Resealing is the point of these tests: catching an edit that forgot to update
 * the hash is easy, and would say nothing about whether readback actually
 * recomputes anything.
 */
/**
 * Write a mutated artifact without resealing it.
 *
 * Used for shapes the canonicalizer cannot walk at all — a deleted section, a
 * null run. Those cannot be resealed by definition, and they do not need to be:
 * the shape check runs before the seal is even computed, which is the property
 * these cases exist to hold.
 */
async function tamperWithoutReseal(
  mutate: (evaluation: Record<string, unknown>) => void,
  evaluationId = EVALUATION_ID,
): Promise<void> {
  const stored = await readStored(evaluationId);
  mutate(stored);
  await writeFile(
    evaluationStore.resolveEvaluationFile(evaluationId),
    `${JSON.stringify(stored, null, 2)}
`,
    'utf8',
  );
}

async function tamperAndReseal(
  mutate: (evaluation: Record<string, unknown>) => void,
  evaluationId = EVALUATION_ID,
): Promise<void> {
  const stored = await readStored(evaluationId);
  mutate(stored);
  const { integrity: _integrity, ...payload } = stored;
  (stored as { integrity: unknown }).integrity = {
    algorithm: 'sha256',
    semantic_sha256: computeSemanticEvaluationSemanticSha256(
      payload as unknown as SemanticEvaluationPayloadV4,
    ),
  };
  await writeFile(
    evaluationStore.resolveEvaluationFile(evaluationId),
    `${JSON.stringify(stored, null, 2)}\n`,
    'utf8',
  );
}

async function verificationErrorOf(evaluationId = EVALUATION_ID): Promise<string> {
  try {
    await loadVerifiedEvaluation(deps(), evaluationId);
  } catch (caught) {
    if (caught instanceof EvaluationVerificationError) return caught.kind;
    throw caught;
  }
  throw new Error('expected verification to fail');
}

describe('the critical guard vetoes before the model is asked', () => {
  it('decides changed on a p12-style self-correction with zero model calls', async () => {
    // Known Limitation, accepted deliberately: p12 is a correct self-correction
    // — the final intent survives — but critical-info-v1 sees 2600 in the
    // reference and not in the transcript, which is a multiset mismatch. H3
    // therefore returns a deterministic CHANGED here. No p12 exception is
    // added: an exception would be a rule that only fires on the one example
    // anyone remembers, and the honest record is that the guard is coarse.
    const resultId = await seed(RUN_P12, P12_SOURCE, P12_TRANSCRIPT);
    const runner = fakeRunner([VERDICT_PRESERVED, VERDICT_PRESERVED, VERDICT_PRESERVED]);

    const outcome = await createSemanticEvaluation({ resultId }, deps({ semanticRunner: runner }));

    expect(outcome.evaluation.decision).toEqual({
      value: 'changed',
      by: 'critical-guard-veto-v1',
    });
    expect(outcome.evaluation.critical.status).toBe('applied');
    expect(outcome.evaluation.critical.mismatch).toBe(true);
    expect(outcome.evaluation.critical.missing).toHaveLength(1);

    // Nothing was contacted at all — not even preflight.
    expect(runner.preflightCalls).toBe(0);
    expect(runner.chatCalls).toHaveLength(0);
    expect(outcome.evaluation.execution.status).toBe('skipped_by_critical_veto');
    expect(outcome.evaluation.execution.runs).toHaveLength(0);
    expect(outcome.evaluation.execution.runtime).toBeNull();
    expect(outcome.evaluation.execution.model).toBeNull();
    expect(outcome.evaluation.execution.prompt).toBeNull();
    expect(outcome.evaluation.execution.request_contract).toBeNull();
  });

  it('keeps the veto auditable by storing the critical working', async () => {
    const resultId = await seed(RUN_P12, P12_SOURCE, P12_TRANSCRIPT);
    const outcome = await createSemanticEvaluation(
      { resultId },
      deps({ semanticRunner: fakeRunner([]) }),
    );

    const critical = outcome.evaluation.critical;
    expect(critical.entities?.reference).toHaveLength(2);
    expect(critical.entities?.hypothesis).toHaveLength(1);
    expect(critical.metrics?.exact_entity_multiset_match).toBe(false);
    // The span is what makes it checkable against the text it came from.
    expect(critical.missing?.[0]?.start_code_point).toBeGreaterThanOrEqual(0);

    await expect(loadVerifiedEvaluation(deps(), EVALUATION_ID)).resolves.toBeDefined();
  });

  it('runs the guard on the raw pair, not on what the model is shown', async () => {
    // The adopted composition, pinned by a pair the two profiles disagree about.
    // First, prove they really do disagree, so this test fails loudly if the
    // fixture ever stops discriminating rather than passing for the wrong reason.
    expect(() => analyzeCriticalInfo(FULLWIDTH_SOURCE, FULLWIDTH_TRANSCRIPT)).toThrow();
    const normalized = analyzeCriticalInfo(
      surfaceNormalize(FULLWIDTH_SOURCE),
      surfaceNormalize(FULLWIDTH_TRANSCRIPT),
    );
    expect(normalized.metrics.exact_entity_multiset_match).toBe(false);

    const resultId = await seed(RUN_FULLWIDTH, FULLWIDTH_SOURCE, FULLWIDTH_TRANSCRIPT);
    const runner = fakeRunner([VERDICT_CHANGED, VERDICT_CHANGED, VERDICT_CHANGED]);
    const outcome = await createSemanticEvaluation({ resultId }, deps({ semanticRunner: runner }));

    // Raw contract: the guard could not read the reference, so it did not veto.
    expect(outcome.evaluation.critical.status).toBe('not_applicable_no_reference_entity');
    expect(outcome.evaluation.critical.mismatch).toBe(false);

    // Had the guard read the model's bytes, this would have been a veto with no
    // model call at all. It is the model route instead.
    expect(runner.chatCalls).toHaveLength(3);
    expect(outcome.evaluation.decision).toEqual({
      value: 'changed',
      by: 'full-run-unanimous-changed-v1',
    });

    // The model still reads the surface-normalized pair: two profiles, recorded.
    expect(outcome.evaluation.normalized.reference.sha256).toBe(
      createHash('sha256').update(surfaceNormalize(FULLWIDTH_SOURCE), 'utf8').digest('hex'),
    );
    expect(outcome.evaluation.evaluator.llm_input_profile).toBe('surface-normalize-v1');
    expect(outcome.evaluation.evaluator.critical_input_profile).toBe('raw-v1');

    // And the artifact re-derives all of it from the raw pair on readback.
    await expect(loadVerifiedEvaluation(deps(), EVALUATION_ID)).resolves.toBeDefined();
  });

  it('reports a reference with no facts as not applicable rather than as clean', async () => {
    const resultId = await seed(RUN_P14, P14_SOURCE, P14_TRANSCRIPT);
    const outcome = await createSemanticEvaluation(
      { resultId },
      deps({ semanticRunner: fakeRunner([VERDICT_CHANGED, VERDICT_CHANGED, VERDICT_CHANGED]) }),
    );

    expect(outcome.evaluation.critical.status).toBe('not_applicable_no_reference_entity');
    expect(outcome.evaluation.critical.applicable).toBe(false);
    expect(outcome.evaluation.critical.mismatch).toBe(false);
    expect(outcome.evaluation.critical.unavailable_reason).toBe(
      'CRITICAL_INFO_NO_REFERENCE_ENTITY',
    );
  });
});

describe('the model route', () => {
  it('decides changed on a p14-style negation when all three runs agree', async () => {
    const resultId = await seed(RUN_P14, P14_SOURCE, P14_TRANSCRIPT);
    const runner = fakeRunner([VERDICT_CHANGED, VERDICT_CHANGED, VERDICT_CHANGED]);

    const outcome = await createSemanticEvaluation({ resultId }, deps({ semanticRunner: runner }));

    expect(outcome.evaluation.decision).toEqual({
      value: 'changed',
      by: 'full-run-unanimous-changed-v1',
    });
    expect(runner.preflightCalls).toBe(1);
    expect(runner.chatCalls).toHaveLength(3);
    // The same request three times: no jitter, no seed, nothing per-run.
    expect(new Set(runner.chatCalls).size).toBe(1);
  });

  it('sends the model the normalized texts and nothing about the Run', async () => {
    const resultId = await seed(RUN_P21, P21_SOURCE, P21_TRANSCRIPT);
    const runner = fakeRunner([VERDICT_CHANGED, VERDICT_CHANGED, VERDICT_CHANGED]);

    await createSemanticEvaluation({ resultId }, deps({ semanticRunner: runner }));

    // What reaches the model is the *normalized* pair, not the raw bytes:
    // surface-normalize-v1 folds the Japanese full stop to an ASCII one, so the
    // raw source string is not present and the normalized one is.
    const sent = runner.chatCalls[0] ?? '';
    expect(sent).toContain(JSON.stringify(surfaceNormalize(P21_SOURCE)).slice(1, -1));
    expect(sent).toContain(JSON.stringify(surfaceNormalize(P21_TRANSCRIPT)).slice(1, -1));
    expect(surfaceNormalize(P21_SOURCE)).not.toBe(P21_SOURCE);

    for (const leak of [RUN_P21, RESULT_ID, 'architecture-short-001', 'windows-standard']) {
      expect(sent).not.toContain(leak);
    }
  });

  it('decides review when all three runs say preserved', async () => {
    const resultId = await seed(RUN_P21, P21_SOURCE, P21_TRANSCRIPT);
    const outcome = await createSemanticEvaluation(
      { resultId },
      deps({
        semanticRunner: fakeRunner([VERDICT_PRESERVED, VERDICT_PRESERVED, VERDICT_PRESERVED]),
      }),
    );

    expect(outcome.evaluation.decision).toEqual({
      value: 'review',
      by: 'full-run-unanimous-preserved-requires-review-v1',
    });
  });

  it('records an unparseable reply as an invalid run and decides review', async () => {
    const resultId = await seed(RUN_P14, P14_SOURCE, P14_TRANSCRIPT);
    const outcome = await createSemanticEvaluation(
      { resultId },
      deps({ semanticRunner: fakeRunner([VERDICT_CHANGED, VERDICT_CHANGED, 'I think so.']) }),
    );

    const runs = outcome.evaluation.execution.runs;
    expect(runs).toHaveLength(3);
    expect(runs[2]?.parseable_schema_valid).toBe(false);
    expect(runs[2]?.raw_response).toBe('I think so.');
    expect(outcome.evaluation.decision).toEqual({
      value: 'review',
      by: 'incomplete-run-evidence-v1',
    });
  });

  it('records an HTTP failure after preflight as invalid run evidence, not an error', async () => {
    // The failure is evidence about this evaluation. Dropping it would leave
    // two answers looking like a complete set.
    const resultId = await seed(RUN_P14, P14_SOURCE, P14_TRANSCRIPT);
    const outcome = await createSemanticEvaluation(
      { resultId },
      deps({
        semanticRunner: fakeRunner([
          VERDICT_CHANGED,
          new Error('POST /api/chat -> HTTP 500'),
          VERDICT_CHANGED,
        ]),
      }),
    );

    const runs = outcome.evaluation.execution.runs;
    expect(runs).toHaveLength(3);
    expect(runs[1]?.error).toContain('HTTP 500');
    expect(runs[1]?.raw_response).toBe('');
    expect(runs[1]?.parsed_output).toBeNull();
    expect(outcome.evaluation.decision.value).toBe('review');
    await expect(loadVerifiedEvaluation(deps(), EVALUATION_ID)).resolves.toBeDefined();
  });

  it('decides review on a split vote', async () => {
    const resultId = await seed(RUN_P14, P14_SOURCE, P14_TRANSCRIPT);
    const outcome = await createSemanticEvaluation(
      { resultId },
      deps({
        semanticRunner: fakeRunner([VERDICT_CHANGED, VERDICT_PRESERVED, VERDICT_CHANGED]),
      }),
    );

    expect(outcome.evaluation.decision).toEqual({ value: 'review', by: 'split-vote-v1' });
  });

  it('stores each run whole, so readback never needs the model again', async () => {
    const resultId = await seed(RUN_P14, P14_SOURCE, P14_TRANSCRIPT);
    const fenced = '```json\n' + VERDICT_CHANGED + '\n```';
    const outcome = await createSemanticEvaluation(
      { resultId },
      deps({ semanticRunner: fakeRunner([VERDICT_CHANGED, fenced, VERDICT_CHANGED]) }),
    );

    const runs = outcome.evaluation.execution.runs;
    expect(runs.map((run) => run.run_index)).toEqual([1, 2, 3]);
    for (const run of runs) {
      expect(run.raw_response_sha256).toBe(sha(run.raw_response));
      expect(run.raw_response_chars).toBe([...run.raw_response].length);
      expect(run.request_sha256).toBe(runs[0]?.request_sha256);
      expect(run.parseable_schema_valid).toBe(true);
    }
    // A fenced reply is a usable verdict that broke the output contract.
    expect(runs[1]?.exact_output_contract_valid).toBe(false);
    expect(runs[0]?.exact_output_contract_valid).toBe(true);
    expect(outcome.evaluation.decision.value).toBe('changed');
  });

  it('writes no Evaluation at all when preflight refuses', async () => {
    const resultId = await seed(RUN_P14, P14_SOURCE, P14_TRANSCRIPT);
    const runner = refusingRunner('SEMANTIC_MODEL_DIGEST_MISMATCH');

    await expect(
      createSemanticEvaluation({ resultId }, deps({ semanticRunner: runner })),
    ).rejects.toThrow(SemanticProviderError);

    expect(runner.chatCalls).toHaveLength(0);
    expect(await readdir(evaluationsRoot)).toEqual([]);
  });
});

describe('a stored Semantic Evaluation is re-derived on read', () => {
  async function seedVerified(): Promise<void> {
    const resultId = await seed(RUN_P14, P14_SOURCE, P14_TRANSCRIPT);
    await createSemanticEvaluation(
      { resultId },
      deps({ semanticRunner: fakeRunner([VERDICT_CHANGED, VERDICT_CHANGED, VERDICT_CHANGED]) }),
    );
  }

  it('verifies an untouched artifact', async () => {
    await seedVerified();
    const verified = await loadVerifiedEvaluation(deps(), EVALUATION_ID);
    expect((verified.evaluation as SemanticEvaluationV4).schema_version).toBe(4);
    expect(verified.normalized?.reference).toBe(surfaceNormalize(P14_SOURCE));
  });

  it('catches a broken seal', async () => {
    await seedVerified();
    const stored = await readStored();
    (stored.decision as Record<string, unknown>).value = 'review';
    await writeFile(
      evaluationStore.resolveEvaluationFile(EVALUATION_ID),
      `${JSON.stringify(stored, null, 2)}\n`,
      'utf8',
    );
    expect(await verificationErrorOf()).toBe('EVALUATION_INTEGRITY_MISMATCH');
  });

  it('catches an evaluator tampered with and resealed', async () => {
    await seedVerified();
    await tamperAndReseal((evaluation) => {
      (evaluation.evaluator as Record<string, unknown>).decision_policy = 'h3-auto-preserved-v1';
    });
    expect(await verificationErrorOf()).toBe('EVALUATION_EVALUATOR_MISMATCH');
  });

  it('catches an extra evaluator field, even resealed', async () => {
    await seedVerified();
    await tamperAndReseal((evaluation) => {
      (evaluation.evaluator as Record<string, unknown>).confidence = 'high';
    });
    expect(await verificationErrorOf()).toBe('EVALUATION_EVALUATOR_MISMATCH');
  });

  it('catches tampered normalization evidence', async () => {
    await seedVerified();
    await tamperAndReseal((evaluation) => {
      const normalized = evaluation.normalized as {
        reference: Record<string, unknown>;
        hypothesis: Record<string, unknown>;
      };
      normalized.reference.chars = 1;
    });
    expect(await verificationErrorOf()).toBe('EVALUATION_NORMALIZATION_MISMATCH');
  });

  it('catches tampered critical guard evidence', async () => {
    await seedVerified();
    await tamperAndReseal((evaluation) => {
      (evaluation.critical as Record<string, unknown>).status = 'applied';
      (evaluation.critical as Record<string, unknown>).applicable = true;
    });
    expect(await verificationErrorOf()).toBe('EVALUATION_CRITICAL_GUARD_MISMATCH');
  });

  it('catches a tampered runtime version', async () => {
    await seedVerified();
    await tamperAndReseal((evaluation) => {
      const execution = evaluation.execution as {
        runtime: Record<string, unknown>;
        model: Record<string, unknown>;
        prompt: Record<string, unknown>;
        request_contract: Record<string, unknown>;
      };
      execution.runtime.version = '0.34.0';
    });
    expect(await verificationErrorOf()).toBe('EVALUATION_MODEL_CONTRACT_MISMATCH');
  });

  it('catches a tampered model digest', async () => {
    await seedVerified();
    await tamperAndReseal((evaluation) => {
      const execution = evaluation.execution as {
        runtime: Record<string, unknown>;
        model: Record<string, unknown>;
        prompt: Record<string, unknown>;
        request_contract: Record<string, unknown>;
      };
      execution.model.digest = 'a'.repeat(64);
    });
    expect(await verificationErrorOf()).toBe('EVALUATION_MODEL_CONTRACT_MISMATCH');
  });

  it('catches a tampered request contract', async () => {
    await seedVerified();
    await tamperAndReseal((evaluation) => {
      const execution = evaluation.execution as {
        runtime: Record<string, unknown>;
        model: Record<string, unknown>;
        prompt: Record<string, unknown>;
        request_contract: Record<string, unknown>;
      };
      execution.request_contract.temperature = 0.7;
    });
    expect(await verificationErrorOf()).toBe('EVALUATION_MODEL_CONTRACT_MISMATCH');
  });

  it('catches a tampered prompt hash', async () => {
    await seedVerified();
    await tamperAndReseal((evaluation) => {
      const execution = evaluation.execution as {
        runtime: Record<string, unknown>;
        model: Record<string, unknown>;
        prompt: Record<string, unknown>;
        request_contract: Record<string, unknown>;
      };
      execution.prompt.sha256 = 'b'.repeat(64);
    });
    expect(await verificationErrorOf()).toBe('EVALUATION_PROMPT_MISMATCH');
  });

  it('catches a tampered request hash', async () => {
    await seedVerified();
    await tamperAndReseal((evaluation) => {
      const runs = (evaluation.execution as Record<string, unknown>).runs as Array<
        Record<string, unknown>
      >;
      runs[0]!.request_sha256 = 'c'.repeat(64);
    });
    expect(await verificationErrorOf()).toBe('EVALUATION_RESPONSE_MISMATCH');
  });

  it('catches a tampered raw response hash', async () => {
    await seedVerified();
    await tamperAndReseal((evaluation) => {
      const runs = (evaluation.execution as Record<string, unknown>).runs as Array<
        Record<string, unknown>
      >;
      runs[1]!.raw_response_sha256 = 'd'.repeat(64);
    });
    expect(await verificationErrorOf()).toBe('EVALUATION_RESPONSE_MISMATCH');
  });

  it('catches a parsed verdict that the raw response does not support', async () => {
    // The most valuable one: the stored text is untouched, only the reading of
    // it was flipped, and the artifact was resealed afterwards.
    await seedVerified();
    await tamperAndReseal((evaluation) => {
      const runs = (evaluation.execution as Record<string, unknown>).runs as Array<
        Record<string, unknown>
      >;
      (runs[0]!.parsed_output as Record<string, unknown>).meaning_preserved = true;
    });
    expect(await verificationErrorOf()).toBe('EVALUATION_RESPONSE_MISMATCH');
  });

  it('catches a tampered decision', async () => {
    await seedVerified();
    await tamperAndReseal((evaluation) => {
      (evaluation.decision as Record<string, unknown>).value = 'review';
      (evaluation.decision as Record<string, unknown>).by = 'split-vote-v1';
    });
    expect(await verificationErrorOf()).toBe('EVALUATION_DECISION_MISMATCH');
  });

  it('refuses a stored decision of preserved outright', async () => {
    // No writer in this codebase can produce it. Readback still refuses it, so
    // a hand-edited artifact cannot introduce a verdict H3 has no path to.
    await seedVerified();
    await tamperAndReseal((evaluation) => {
      (evaluation.decision as Record<string, unknown>).value = 'preserved';
    });
    expect(await verificationErrorOf()).toBe('EVALUATION_DECISION_MISMATCH');
  });

  // --- structural validation ------------------------------------------------
  // Every case here reseals after tampering, so the seal is valid and the only
  // thing standing between a malformed artifact and a `verified` response is
  // the shape check. A raw TypeError surfacing as UNEXPECTED would be a bug:
  // "Cannot read properties of undefined" names neither the artifact nor the
  // field, and callers cannot act on it.

  it('reports a missing subject.tool as malformed, not as a crash', async () => {
    await seedVerified();
    await tamperWithoutReseal((evaluation) => {
      delete (evaluation.subject as Record<string, unknown>).tool;
    });
    expect(await verificationErrorOf()).toBe('EVALUATION_MALFORMED');
  });

  it('reports missing critical.matches as malformed', async () => {
    await seedVerified();
    await tamperWithoutReseal((evaluation) => {
      delete (evaluation.critical as Record<string, unknown>).matches;
    });
    expect(await verificationErrorOf()).toBe('EVALUATION_MALFORMED');
  });

  it('reports a null run as malformed rather than dereferencing it', async () => {
    // The canonicalizer maps over runs; a null entry used to reach it directly.
    await seedVerified();
    await tamperWithoutReseal((evaluation) => {
      (evaluation.execution as Record<string, unknown>).runs = [null];
    });
    expect(await verificationErrorOf()).toBe('EVALUATION_MALFORMED');
  });

  it('refuses an extra field on the decision, even resealed', async () => {
    // `decision.safe` is the shape of the mistake worth refusing: a field that
    // reads like a verdict, is hashed by nothing, and would otherwise survive
    // inside an artifact reported as verified.
    await seedVerified();
    await tamperAndReseal((evaluation) => {
      (evaluation.decision as Record<string, unknown>).safe = true;
    });
    expect(await verificationErrorOf()).toBe('EVALUATION_MALFORMED');
  });

  it('refuses an extra field on the execution record', async () => {
    await seedVerified();
    await tamperAndReseal((evaluation) => {
      (evaluation.execution as Record<string, unknown>).endpoint = 'http://127.0.0.1:11434';
    });
    expect(await verificationErrorOf()).toBe('EVALUATION_MALFORMED');
  });

  it('refuses an extra field on the model contract', async () => {
    await seedVerified();
    await tamperAndReseal((evaluation) => {
      const execution = evaluation.execution as Record<string, unknown>;
      (execution.model as Record<string, unknown>).extra = 'anything';
    });
    expect(await verificationErrorOf()).toBe('EVALUATION_MALFORMED');
  });

  it('refuses an extra field on a single run', async () => {
    await seedVerified();
    await tamperAndReseal((evaluation) => {
      const runs = (evaluation.execution as Record<string, unknown>).runs as Array<
        Record<string, unknown>
      >;
      runs[0]!.note = 'looked fine to me';
    });
    expect(await verificationErrorOf()).toBe('EVALUATION_MALFORMED');
  });

  it('refuses an extra field at the root', async () => {
    await seedVerified();
    await tamperAndReseal((evaluation) => {
      evaluation.reviewed_by = 'nobody';
    });
    expect(await verificationErrorOf()).toBe('EVALUATION_MALFORMED');
  });

  it('refuses an extra field on the integrity record', async () => {
    // The seal is computed over the payload, so it does not hash `integrity`
    // itself. An extra field here is free: it moves no hash, and without a
    // closed check it would sit inside an artifact reported as verified.
    //
    // Written directly rather than through `tamperAndReseal`, which rebuilds the
    // integrity record from scratch — that helper would erase the field being
    // tested, which is its own demonstration that the seal does not cover it.
    await seedVerified();
    await tamperWithoutReseal((evaluation) => {
      (evaluation.integrity as Record<string, unknown>).trusted = true;
    });
    expect(await verificationErrorOf()).toBe('EVALUATION_MALFORMED');
  });

  it('refuses an integrity field added without touching the stored hash', async () => {
    // The same case with the seal deliberately left exactly as written, which is
    // the shape an attacker would actually use: no recomputation, no mismatch,
    // just a claim like `reviewed_by` parked next to a hash that never covered it.
    await seedVerified();
    const before = (await readStored()).integrity as Record<string, unknown>;
    await tamperWithoutReseal((evaluation) => {
      (evaluation.integrity as Record<string, unknown>).reviewed_by = 'nobody';
    });

    const after = (await readStored()).integrity as Record<string, unknown>;
    expect(after.semantic_sha256).toBe(before.semantic_sha256);
    expect(await verificationErrorOf()).toBe('EVALUATION_MALFORMED');
  });

  it('reports a malformed integrity record without crashing', async () => {
    await seedVerified();
    await tamperWithoutReseal((evaluation) => {
      evaluation.integrity = 'sealed, honest';
    });
    const kind = await verificationErrorOf();
    expect(kind).toBe('EVALUATION_MALFORMED');
    expect(kind).not.toBe('UNEXPECTED');
  });

  it('still accepts an untouched integrity record', async () => {
    // The companion to the three above: closing the object must not close it on
    // the artifacts this codebase actually writes.
    await seedVerified();
    const stored = await readStored();
    expect(Object.keys(stored.integrity as Record<string, unknown>).sort()).toEqual([
      'algorithm',
      'semantic_sha256',
    ]);
    await expect(loadVerifiedEvaluation(deps(), EVALUATION_ID)).resolves.toBeDefined();
  });

  it('catches model runs added to a veto artifact', async () => {
    const resultId = await seed(RUN_P12, P12_SOURCE, P12_TRANSCRIPT);
    await createSemanticEvaluation({ resultId }, deps({ semanticRunner: fakeRunner([]) }));

    await tamperAndReseal((evaluation) => {
      const execution = evaluation.execution as Record<string, unknown>;
      execution.status = 'completed';
    });
    expect(await verificationErrorOf()).toBe('EVALUATION_EXECUTION_MISMATCH');
  });

  it('catches a run reordered inside the record', async () => {
    await seedVerified();
    await tamperAndReseal((evaluation) => {
      const execution = evaluation.execution as Record<string, unknown>;
      const runs = execution.runs as Array<Record<string, unknown>>;
      execution.runs = [runs[1], runs[0], runs[2]];
    });
    expect(await verificationErrorOf()).toBe('EVALUATION_RESPONSE_MISMATCH');
  });

  it('rejects the Evaluation when the Run source no longer matches', async () => {
    await seedVerified();
    await writeFile(runStore.resolveRunFile(RUN_P14, 'source.txt'), '別のテキスト', 'utf8');

    const [entry] = await listEvaluationsForRun(deps(), RUN_P14).catch(() => []);
    // The Run itself no longer verifies, so the listing fails closed; either
    // way nothing is reported as a verified reading of bytes that changed.
    expect(entry?.status ?? 'rejected').toBe('rejected');
  });
});

describe('the fourth evaluator sits beside the other three', () => {
  it('records the evaluator contract as eight closed fields', async () => {
    const resultId = await seed(RUN_P14, P14_SOURCE, P14_TRANSCRIPT);
    const outcome = await createSemanticEvaluation(
      { resultId },
      deps({ semanticRunner: fakeRunner([VERDICT_CHANGED, VERDICT_CHANGED, VERDICT_CHANGED]) }),
    );

    expect(outcome.evaluation.evaluator).toEqual(SEMANTIC_H3_EVALUATOR);
    expect(Object.keys(outcome.evaluation.evaluator)).toEqual([
      'id',
      'llm_input_profile',
      'critical_input_profile',
      'critical_guard',
      'decision_policy',
      'vote_policy',
      'rubric',
      'provider_contract',
    ]);
  });

  it('lists all four evaluators for one Result, each verifying', async () => {
    const resultId = await seed(RUN_P14, P14_SOURCE, P14_TRANSCRIPT);
    const runner = fakeRunner([VERDICT_CHANGED, VERDICT_CHANGED, VERDICT_CHANGED]);

    await createEvaluation(
      { resultId, evaluatorId: 'raw-char-v1' },
      deps({ evaluationId: '20260909T050001000Z-11111111' }),
    );
    await createEvaluation(
      { resultId, evaluatorId: 'surface-normalized-char-v1' },
      deps({ evaluationId: '20260909T050002000Z-22222222' }),
    );
    await createEvaluation(
      { resultId, evaluatorId: 'semantic-h3-v1' },
      deps({ evaluationId: '20260909T050003000Z-33333333', semanticRunner: runner }),
    );

    const entries = await listEvaluationsForRun(deps(), RUN_P14);
    expect(entries).toHaveLength(3);
    expect(entries.every((entry) => entry.status === 'verified')).toBe(true);
    expect(
      entries
        .map((entry) => (entry.status === 'verified' ? entry.evaluation.schema_version : 0))
        .sort(),
    ).toEqual([1, 3, 4]);
  });

  it('refuses a legacy v1 Result, like every other strict evaluator', async () => {
    await writeRun(RUN_P14, P14_SOURCE);
    const legacyId = '20260909T040009000Z-99999999';
    await resultStore.saveResult(legacyId, {
      transcriptText: P14_TRANSCRIPT,
      resultJson: Buffer.from(
        `${JSON.stringify(
          {
            schema_version: 1,
            result_id: legacyId,
            run_id: RUN_P14,
            captured_at: NOW.toISOString(),
            tool: {
              id: 'windows-standard-voice-input',
              name: BUILT_IN_TOOL_NAMES['windows-standard-voice-input'],
              version: null,
            },
            capture: { method: 'manual-paste', delivery_path: 'speaker-to-mic' },
            run_evidence: {
              manifest_schema_version: 2,
              test_id: 'architecture-short-001',
              source_sha256: sha(P14_SOURCE),
              audio_sha256: sha(AUDIO),
            },
            transcript: {
              file: 'transcript.txt',
              encoding: 'utf-8',
              line_endings: 'lf',
              sha256: sha(P14_TRANSCRIPT),
              bytes: Buffer.byteLength(P14_TRANSCRIPT, 'utf8'),
            },
          },
          null,
          2,
        )}\n`,
        'utf8',
      ),
    });

    await expect(
      createSemanticEvaluation({ resultId: legacyId }, deps({ semanticRunner: fakeRunner([]) })),
    ).rejects.toThrow(EvaluationSubjectError);
  });

  it('refuses to run with an evaluations root nested inside another tree', async () => {
    const nested = new LocalEvaluationStore(path.join(runsRoot, 'evaluations'));
    const resultId = await seed(RUN_P14, P14_SOURCE, P14_TRANSCRIPT);

    await expect(
      createSemanticEvaluation(
        { resultId },
        deps({ evaluationStore: nested, semanticRunner: fakeRunner([]) }),
      ),
    ).rejects.toThrow(StorageBoundaryError);
  });

  it('never rewrites an Evaluation: a second attempt is a new artifact', async () => {
    const resultId = await seed(RUN_P14, P14_SOURCE, P14_TRANSCRIPT);
    const runner = fakeRunner([VERDICT_CHANGED, VERDICT_CHANGED, VERDICT_CHANGED]);
    await createSemanticEvaluation({ resultId }, deps({ semanticRunner: runner }));

    const before = await readFile(evaluationStore.resolveEvaluationFile(EVALUATION_ID), 'utf8');
    await expect(
      createSemanticEvaluation(
        { resultId },
        deps({ semanticRunner: fakeRunner([VERDICT_PRESERVED, VERDICT_PRESERVED, VERDICT_PRESERVED]) }),
      ),
    ).rejects.toThrow();
    expect(await readFile(evaluationStore.resolveEvaluationFile(EVALUATION_ID), 'utf8')).toBe(
      before,
    );
  });
});
