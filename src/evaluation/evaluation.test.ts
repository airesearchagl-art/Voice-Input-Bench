import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalRunStore } from '@/storage/LocalRunStore';
import { LocalResultStore } from '@/storage/LocalResultStore';
import { LocalSessionStore } from '@/storage/LocalSessionStore';
import { LocalEvaluationStore, EvaluationStoreError } from '@/storage/LocalEvaluationStore';
import { StorageBoundaryError } from '@/storage/rootIsolation';
import { saveManualSttResult } from '@/results/saveResult';
import { BUILT_IN_TOOL_NAMES } from '@/results/tools';
import {
  createCriticalInfoEvaluation,
  createEvaluation,
  createRawCharEvaluation,
  createSurfaceCharEvaluation,
  isEvaluatorId,
  listEvaluationsForRun,
  loadVerifiedEvaluation,
  type EvaluationDeps,
} from './createEvaluation';
import {
  computeCriticalEvaluationSemanticSha256,
  type CriticalEvaluationPayloadV2,
} from './criticalEvaluationSchema';
import { CriticalInfoError, analyzeCriticalInfo } from './criticalInfo';
import {
  computeSurfaceEvaluationSemanticSha256,
  type SurfaceEvaluationPayloadV3,
} from './surfaceEvaluationSchema';
import { surfaceNormalize } from './surfaceNormalize';
import { computeEvaluationSemanticSha256, type EvaluationPayloadV1 } from './evaluationSchema';
import { EvaluationSubjectError } from './evaluationSubject';
import { evaluateRawChar } from './rawChar';

/**
 * Raw character Evaluation against real Runs and Results on disk.
 *
 * The Run tree and the Result tree are written with the same stores Phase 1 and
 * P2-A use, then read and cited — never modified.
 */

const RUN_ID = '20260907T030000000Z-aaaaaaaa';
const OTHER_RUN_ID = '20260907T030001000Z-bbbbbbbb';
const RESULT_ID = '20260907T040000000Z-cccccccc';
const RESULT_ID_2 = '20260907T040001000Z-dddddddd';
const EVALUATION_ID = '20260907T050000000Z-eeeeeeee';
const EVALUATION_ID_2 = '20260907T050001000Z-ffffffff';
const NOW = new Date('2026-09-07T05:00:00.000Z');

const SOURCE_TEXT = '基準階の会議室は north side に寄せて、天井高は二千七百ミリを確保してください。';
const WINDOWS_TRANSCRIPT =
  '基準階の会議室はノースサイドに寄せて、天井高は2700ミリを確保してください。';
const AQUA_TRANSCRIPT =
  '基準階の会議室は north side に寄せて、天井高は二千七百ミリを確保してください。';

const WRONG_VALUE_TRANSCRIPT =
  '基準階の会議室はノースサイドに寄せて、天井高は2600ミリを確保してください。';
const NO_ENTITY_SOURCE = '基準階の会議室は north side に寄せてください。';

/** Differs from the source only in width, case and spacing. */
const SURFACE_ONLY_TRANSCRIPT =
  '基準階の会議室は　ＮＯＲＴＨ  ＳＩＤＥ に寄せて、天井高は二千七百ミリを確保してください。';

const AUDIO = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45, 9, 9]);
const PROVIDER_QUERY = Buffer.from('{"schema_version":1,"segments":[]}\n', 'utf8');

function sha(bytes: Uint8Array | string): string {
  return createHash('sha256')
    .update(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes)
    .digest('hex');
}

function manifestFor(
  runId: string,
  testId = 'architecture-short-001',
  sourceText = SOURCE_TEXT,
): Record<string, unknown> {
  return {
    schema_version: 2,
    run_id: runId,
    test_id: testId,
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

let runsRoot: string;
let resultsRoot: string;
let sessionsRoot: string;
let evaluationsRoot: string;
let runStore: LocalRunStore;
let resultStore: LocalResultStore;
let sessionStore: LocalSessionStore;
let evaluationStore: LocalEvaluationStore;

function deps(overrides: Partial<EvaluationDeps> = {}): EvaluationDeps {
  return {
    runStore,
    resultStore,
    sessionStore,
    evaluationStore,
    now: () => NOW,
    ...overrides,
  };
}

async function writeRun(
  runId = RUN_ID,
  testId?: string,
  sourceText = SOURCE_TEXT,
): Promise<void> {
  await runStore.saveRun(runId, {
    sourceText,
    audio: AUDIO,
    providerQueryJson: PROVIDER_QUERY,
    manifestJson: Buffer.from(
      `${JSON.stringify(manifestFor(runId, testId, sourceText), null, 2)}\n`,
      'utf8',
    ),
  });
}

async function saveSealedResult(
  resultId = RESULT_ID,
  toolId = 'windows-standard-voice-input',
  rawTranscript = WINDOWS_TRANSCRIPT,
  runId = RUN_ID,
) {
  return saveManualSttResult(
    { runId, toolId, deliveryPath: 'speaker-to-mic', rawTranscript },
    { runStore, resultStore, now: () => NOW, resultId },
  );
}

/** A P2-A Result, written the way P2-A wrote them: no integrity record. */
async function saveLegacyV1Result(resultId: string, transcript = WINDOWS_TRANSCRIPT) {
  const legacy = {
    schema_version: 1,
    result_id: resultId,
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
      test_id: 'architecture-short-001',
      source_sha256: sha(SOURCE_TEXT),
      audio_sha256: sha(AUDIO),
    },
    transcript: {
      file: 'transcript.txt',
      encoding: 'utf-8',
      line_endings: 'lf',
      sha256: sha(transcript),
      bytes: Buffer.byteLength(transcript, 'utf8'),
    },
  };
  return resultStore.saveResult(resultId, {
    transcriptText: transcript,
    resultJson: Buffer.from(`${JSON.stringify(legacy, null, 2)}\n`, 'utf8'),
  });
}

/** Every file under a root with its current hash, for before/after comparison. */
async function treeFingerprint(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string, base: string): Promise<void> => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = path.join(dir, entry.name);
      const key = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(full, key);
      else out[key] = sha(new Uint8Array(await readFile(full)));
    }
  };
  await walk(root, '').catch(() => {});
  return out;
}

async function tempResidue(root: string): Promise<string[]> {
  const entries = await readdir(root).catch(() => [] as string[]);
  return entries.filter((entry) => entry.startsWith('.tmp-'));
}

async function patchEvaluation(
  evaluationId: string,
  mutate: (evaluation: Record<string, unknown>) => void,
  reseal = false,
) {
  const file = evaluationStore.resolveEvaluationFile(evaluationId);
  const evaluation = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  mutate(evaluation);
  if (reseal) {
    delete evaluation.integrity;
    evaluation.integrity = {
      algorithm: 'sha256',
      semantic_sha256: computeEvaluationSemanticSha256(
        evaluation as unknown as EvaluationPayloadV1,
      ),
    };
  }
  await writeFile(file, `${JSON.stringify(evaluation, null, 2)}\n`);
}

beforeEach(async () => {
  runsRoot = await mkdtemp(path.join(tmpdir(), 'vib-e-runs-'));
  resultsRoot = await mkdtemp(path.join(tmpdir(), 'vib-e-results-'));
  sessionsRoot = await mkdtemp(path.join(tmpdir(), 'vib-e-sessions-'));
  evaluationsRoot = await mkdtemp(path.join(tmpdir(), 'vib-e-evaluations-'));
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

describe('creating a raw character Evaluation', () => {
  it('measures a sealed Result against its Run’s canonical text', async () => {
    await writeRun();
    await saveSealedResult();

    const outcome = await createRawCharEvaluation(
      { resultId: RESULT_ID },
      deps({ evaluationId: EVALUATION_ID }),
    );

    const expected = evaluateRawChar(SOURCE_TEXT, WINDOWS_TRANSCRIPT);
    expect(outcome.evaluation).toMatchObject({
      schema_version: 1,
      evaluation_id: EVALUATION_ID,
      evaluator: { id: 'raw-char-v1', unit: 'unicode-code-point', normalization: 'none' },
      run_id: RUN_ID,
      result_id: RESULT_ID,
      metrics: expected,
    });
    expect(outcome.evaluation.integrity.algorithm).toBe('sha256');
    expect(outcome.evaluation.integrity.semantic_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(outcome.referenceText).toBe(SOURCE_TEXT);
    expect(outcome.hypothesisText).toBe(WINDOWS_TRANSCRIPT);
  });

  it('resolves the Run and the tool from the Result, not from the caller', async () => {
    await writeRun();
    await saveSealedResult(RESULT_ID, 'aqua-voice', AQUA_TRANSCRIPT);

    const outcome = await createRawCharEvaluation(
      { resultId: RESULT_ID },
      deps({ evaluationId: EVALUATION_ID }),
    );

    expect(outcome.evaluation.run_id).toBe(RUN_ID);
    expect(outcome.evaluation.subject.tool.id).toBe('aqua-voice');
    expect(outcome.evaluation.subject.tool.name).toBe(BUILT_IN_TOOL_NAMES['aqua-voice']);
    expect(outcome.evaluation.subject.capture.delivery_path).toBe('speaker-to-mic');
    expect(outcome.evaluation.run_evidence).toEqual({
      manifest_schema_version: 2,
      test_id: 'architecture-short-001',
      source_sha256: sha(SOURCE_TEXT),
      audio_sha256: sha(AUDIO),
    });
  });

  it('reports an exact transcript as an exact match', async () => {
    await writeRun();
    await saveSealedResult(RESULT_ID, 'aqua-voice', SOURCE_TEXT);

    const outcome = await createRawCharEvaluation(
      { resultId: RESULT_ID },
      deps({ evaluationId: EVALUATION_ID }),
    );

    expect(outcome.evaluation.metrics).toMatchObject({
      exact_match: true,
      edit_distance: 0,
      cer: 0,
    });
  });

  it('writes the file as one immutable directory with no temp residue', async () => {
    await writeRun();
    await saveSealedResult();
    await createRawCharEvaluation({ resultId: RESULT_ID }, deps({ evaluationId: EVALUATION_ID }));

    expect(await evaluationStore.listEvaluationIds()).toEqual([EVALUATION_ID]);
    expect(await readdir(evaluationStore.resolveEvaluationDir(EVALUATION_ID))).toEqual([
      'evaluation.json',
    ]);
    expect(await tempResidue(evaluationsRoot)).toEqual([]);
  });

  it('never overwrites an Evaluation', async () => {
    await writeRun();
    await saveSealedResult();
    await createRawCharEvaluation({ resultId: RESULT_ID }, deps({ evaluationId: EVALUATION_ID }));

    const error = await createRawCharEvaluation(
      { resultId: RESULT_ID },
      deps({ evaluationId: EVALUATION_ID }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EvaluationStoreError);
    expect((error as EvaluationStoreError).kind).toBe('EVALUATION_ALREADY_EXISTS');
  });

  it('leaves the Run, Result and Session trees exactly as they were', async () => {
    await writeRun();
    await saveSealedResult();

    const before = {
      runs: await treeFingerprint(runsRoot),
      results: await treeFingerprint(resultsRoot),
      sessions: await treeFingerprint(sessionsRoot),
    };

    await createRawCharEvaluation({ resultId: RESULT_ID }, deps({ evaluationId: EVALUATION_ID }));
    await listEvaluationsForRun(deps(), RUN_ID);
    await loadVerifiedEvaluation(deps(), EVALUATION_ID);

    expect(await treeFingerprint(runsRoot)).toEqual(before.runs);
    expect(await treeFingerprint(resultsRoot)).toEqual(before.results);
    expect(await treeFingerprint(sessionsRoot)).toEqual(before.sessions);
  });
});

describe('only sealed Result v2 is evaluated', () => {
  it('refuses a legacy v1 Result and writes nothing', async () => {
    await writeRun();
    await saveLegacyV1Result(RESULT_ID);

    const error = await createRawCharEvaluation(
      { resultId: RESULT_ID },
      deps({ evaluationId: EVALUATION_ID }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EvaluationSubjectError);
    expect((error as EvaluationSubjectError).kind).toBe('EVALUATION_RESULT_NOT_SEALED');
    expect(await evaluationStore.listEvaluationIds()).toEqual([]);
    expect(await tempResidue(evaluationsRoot)).toEqual([]);
  });

  it('leaves a legacy v1 Result exactly as it was written', async () => {
    await writeRun();
    await saveLegacyV1Result(RESULT_ID);
    const before = await treeFingerprint(resultsRoot);

    await createRawCharEvaluation(
      { resultId: RESULT_ID },
      deps({ evaluationId: EVALUATION_ID }),
    ).catch(() => undefined);

    expect(await treeFingerprint(resultsRoot)).toEqual(before);
    const stored = JSON.parse(
      await readFile(resultStore.resolveResultFile(RESULT_ID, 'result.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(stored.schema_version).toBe(1);
    expect(stored.integrity).toBeUndefined();
  });

  it('refuses a Result that does not exist', async () => {
    await writeRun();
    const error = await createRawCharEvaluation(
      { resultId: RESULT_ID },
      deps({ evaluationId: EVALUATION_ID }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EvaluationSubjectError);
    expect((error as EvaluationSubjectError).kind).toBe('EVALUATION_RESULT_UNREADABLE');
  });

  it('refuses a malformed result id before it touches a path', async () => {
    await writeRun();
    const error = await createRawCharEvaluation(
      { resultId: '../../etc/passwd' },
      deps({ evaluationId: EVALUATION_ID }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EvaluationSubjectError);
    expect((error as EvaluationSubjectError).kind).toBe('EVALUATION_RESULT_UNREADABLE');
  });
});

describe('stored Evaluations are re-derived on read', () => {
  async function seed() {
    await writeRun();
    await saveSealedResult();
    return createRawCharEvaluation({ resultId: RESULT_ID }, deps({ evaluationId: EVALUATION_ID }));
  }

  async function listOne() {
    const entries = await listEvaluationsForRun(deps(), RUN_ID);
    expect(entries).toHaveLength(1);
    return entries[0]!;
  }

  it('returns a verified entry for an untouched Evaluation', async () => {
    await seed();
    const entry = await listOne();
    expect(entry.status).toBe('verified');
    if (entry.status === 'verified') {
      expect(entry.evaluation.evaluation_id).toBe(EVALUATION_ID);
      expect(entry.referenceText).toBe(SOURCE_TEXT);
      expect(entry.hypothesisText).toBe(WINDOWS_TRANSCRIPT);
    }
  });

  it('accepts a reformatted evaluation.json with reordered keys', async () => {
    await seed();
    const file = evaluationStore.resolveEvaluationFile(EVALUATION_ID);
    const original = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;

    const reverseKeys = (value: Record<string, unknown>): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value).reverse()) out[key] = value[key];
      return out;
    };

    const reordered = reverseKeys(original);
    // Nested objects too — the canonical payload builds its own order, so none
    // of this can move the hash.
    reordered.evaluator = reverseKeys(original.evaluator as Record<string, unknown>);
    reordered.metrics = reverseKeys(original.metrics as Record<string, unknown>);
    await writeFile(file, JSON.stringify(reordered, null, 4));

    expect((await listOne()).status).toBe('verified');
  });

  it('rejects an edited CER', async () => {
    await seed();
    await patchEvaluation(EVALUATION_ID, (evaluation) => {
      (evaluation.metrics as Record<string, unknown>).cer = 0;
    });

    const entry = await listOne();
    expect(entry.status).toBe('rejected');
    if (entry.status === 'rejected') expect(entry.reason).toBe('EVALUATION_INTEGRITY_MISMATCH');
  });

  it('rejects an edited CER even when the Evaluation is re-sealed', async () => {
    await seed();
    // Someone who knows the hashing scheme can re-seal. The recomputation is
    // what stops them: the numbers still have to come out of the actual bytes.
    await patchEvaluation(
      EVALUATION_ID,
      (evaluation) => {
        const metrics = evaluation.metrics as Record<string, unknown>;
        metrics.cer = 0;
        metrics.edit_distance = 0;
        metrics.substitutions = 0;
        metrics.deletions = 0;
        metrics.insertions = 0;
        metrics.exact_match = true;
      },
      true,
    );

    const entry = await listOne();
    expect(entry.status).toBe('rejected');
    if (entry.status === 'rejected') expect(entry.reason).toBe('EVALUATION_METRICS_MISMATCH');
  });

  it('rejects a re-sealed Evaluation pointed at a different Result', async () => {
    await seed();
    await saveSealedResult(RESULT_ID_2, 'aqua-voice', AQUA_TRANSCRIPT);
    await patchEvaluation(
      EVALUATION_ID,
      (evaluation) => {
        evaluation.result_id = RESULT_ID_2;
      },
      true,
    );

    const entry = await listOne();
    expect(entry.status).toBe('rejected');
    if (entry.status === 'rejected') expect(entry.reason).toBe('EVALUATION_SUBJECT_MISMATCH');
  });

  it('rejects an Evaluation with no readable integrity record', async () => {
    await seed();
    await patchEvaluation(EVALUATION_ID, (evaluation) => {
      delete evaluation.integrity;
    });

    const entry = await listOne();
    expect(entry.status).toBe('rejected');
    if (entry.status === 'rejected') expect(entry.reason).toBe('EVALUATION_INTEGRITY_MISSING');
  });

  it('rejects an unsupported schema version', async () => {
    await seed();
    // A version no verifier claims. P3-D made 4 a real schema, so the probe
    // moved up rather than testing something the app now reads.
    await patchEvaluation(EVALUATION_ID, (evaluation) => {
      evaluation.schema_version = 5;
    });

    const entry = await listOne();
    expect(entry.status).toBe('rejected');
    if (entry.status === 'rejected') expect(entry.reason).toBe('EVALUATION_SCHEMA_UNSUPPORTED');
  });

  it('rejects a raw-char Evaluation relabelled as the surface schema', async () => {
    await seed();
    // `schema_version` picks the verifier, so this asks the surface reader to
    // make sense of a raw-char artifact. It cannot, and says so.
    await patchEvaluation(EVALUATION_ID, (evaluation) => {
      evaluation.schema_version = 3;
    });

    const entry = await listOne();
    expect(entry.status).toBe('rejected');
    if (entry.status === 'rejected') expect(entry.reason).toBe('EVALUATION_MALFORMED');
  });

  it('rejects a raw-char Evaluation relabelled as the semantic schema', async () => {
    await seed();
    // Same trick against the fourth reader: semantic-h3-v1 needs a normalized
    // block, a critical guard and an execution record, and a raw-char artifact
    // has none of them.
    await patchEvaluation(EVALUATION_ID, (evaluation) => {
      evaluation.schema_version = 4;
    });

    const entry = await listOne();
    expect(entry.status).toBe('rejected');
    if (entry.status === 'rejected') expect(entry.reason).toBe('EVALUATION_MALFORMED');
  });

  it('rejects a raw-char Evaluation relabelled as the critical schema', async () => {
    await seed();
    // `schema_version` picks the verifier, so this asks the critical-info
    // reader to make sense of a raw-char artifact. It cannot, and says so.
    await patchEvaluation(EVALUATION_ID, (evaluation) => {
      evaluation.schema_version = 2;
    });

    const entry = await listOne();
    expect(entry.status).toBe('rejected');
    if (entry.status === 'rejected') expect(entry.reason).toBe('EVALUATION_MALFORMED');
  });

  it('records the evaluator semantics under the seal', async () => {
    const outcome = await seed();
    expect(outcome.evaluation.evaluator).toEqual({
      id: 'raw-char-v1',
      unit: 'unicode-code-point',
      normalization: 'none',
    });

    // The stored file carries it too, and nothing else names the algorithm.
    const stored = JSON.parse(
      await readFile(evaluationStore.resolveEvaluationFile(EVALUATION_ID), 'utf8'),
    ) as Record<string, unknown>;
    expect(stored.evaluator).toEqual({
      id: 'raw-char-v1',
      unit: 'unicode-code-point',
      normalization: 'none',
    });
    expect(stored.algorithm).toBeUndefined();
  });

  it('verifies an untouched evaluator record', async () => {
    await seed();
    const entry = await listOne();
    expect(entry.status).toBe('verified');
    if (entry.status === 'verified') {
      expect(entry.evaluation.evaluator).toEqual({
        id: 'raw-char-v1',
        unit: 'unicode-code-point',
        normalization: 'none',
      });
    }
  });

  const EVALUATOR_EDITS: Array<[string, (evaluator: Record<string, unknown>) => void]> = [
    ['id', (evaluator) => (evaluator.id = 'normalized-char-v1')],
    ['unit', (evaluator) => (evaluator.unit = 'utf-16-code-unit')],
    ['normalization', (evaluator) => (evaluator.normalization = 'nfkc')],
  ];

  for (const [field, edit] of EVALUATOR_EDITS) {
    it(`rejects an edited evaluator.${field}`, async () => {
      await seed();
      await patchEvaluation(EVALUATION_ID, (evaluation) => {
        edit(evaluation.evaluator as Record<string, unknown>);
      });

      const entry = await listOne();
      expect(entry.status).toBe('rejected');
      // Caught by the seal first, since the evaluator is inside it.
      if (entry.status === 'rejected') expect(entry.reason).toBe('EVALUATION_INTEGRITY_MISMATCH');
    });

    it(`rejects an edited evaluator.${field} even when re-sealed`, async () => {
      await seed();
      await patchEvaluation(
        EVALUATION_ID,
        (evaluation) => {
          edit(evaluation.evaluator as Record<string, unknown>);
        },
        true,
      );

      const entry = await listOne();
      expect(entry.status).toBe('rejected');
      if (entry.status === 'rejected') {
        expect(entry.reason).toBe('EVALUATION_EVALUATOR_MISMATCH');
      }
    });
  }

  it('rejects an Evaluation with no evaluator record at all', async () => {
    await seed();
    // Not re-sealed, because the seal cannot even be computed without an
    // evaluator — which is why this one structural check runs before it.
    await patchEvaluation(EVALUATION_ID, (evaluation) => {
      delete evaluation.evaluator;
    });

    const entry = await listOne();
    expect(entry.status).toBe('rejected');
    if (entry.status === 'rejected') expect(entry.reason).toBe('EVALUATION_EVALUATOR_MISMATCH');
  });

  it('rejects a plausible-looking evaluator that is a different measurement', async () => {
    await seed();
    // Every field is a well-formed string, and the id is even right. It still
    // describes something this code does not compute.
    await patchEvaluation(
      EVALUATION_ID,
      (evaluation) => {
        evaluation.evaluator = {
          id: 'raw-char-v1',
          unit: 'grapheme-cluster',
          normalization: 'nfc',
        };
      },
      true,
    );

    const entry = await listOne();
    expect(entry.status).toBe('rejected');
    if (entry.status === 'rejected') expect(entry.reason).toBe('EVALUATION_EVALUATOR_MISMATCH');
  });

  it('rejects an evaluation_id that does not match its directory', async () => {
    await seed();
    await patchEvaluation(
      EVALUATION_ID,
      (evaluation) => {
        evaluation.evaluation_id = EVALUATION_ID_2;
      },
      true,
    );

    const entry = await listOne();
    expect(entry.status).toBe('rejected');
    if (entry.status === 'rejected') expect(entry.reason).toBe('EVALUATION_ID_MISMATCH');
  });

  it('rejects an Evaluation whose transcript changed underneath it', async () => {
    await seed();
    await writeFile(
      resultStore.resolveResultFile(RESULT_ID, 'transcript.txt'),
      '書き換えられた書き起こし',
    );

    const entry = await listOne();
    expect(entry.status).toBe('rejected');
    if (entry.status === 'rejected') {
      expect(entry.reason).toBe('RESULT_TRANSCRIPT_HASH_MISMATCH');
    }
  });

  it('rejects an Evaluation whose Result metadata was edited valid-to-valid', async () => {
    await seed();
    const file = resultStore.resolveResultFile(RESULT_ID, 'result.json');
    const stored = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    const tool = stored.tool as Record<string, unknown>;
    tool.id = 'aqua-voice';
    tool.name = BUILT_IN_TOOL_NAMES['aqua-voice'];
    await writeFile(file, `${JSON.stringify(stored, null, 2)}\n`);

    const entry = await listOne();
    expect(entry.status).toBe('rejected');
    if (entry.status === 'rejected') expect(entry.reason).toBe('RESULT_INTEGRITY_MISMATCH');
  });

  it('loadVerifiedEvaluation throws rather than returning something partial', async () => {
    await seed();
    await patchEvaluation(EVALUATION_ID, (evaluation) => {
      (evaluation.metrics as Record<string, unknown>).cer = 0;
    });

    await expect(loadVerifiedEvaluation(deps(), EVALUATION_ID)).rejects.toThrow(
      /semantic hash と一致しません/,
    );
  });

  it('loadVerifiedEvaluation returns both texts for side-by-side reading', async () => {
    await seed();
    const verified = await loadVerifiedEvaluation(deps(), EVALUATION_ID);
    expect(verified.referenceText).toBe(SOURCE_TEXT);
    expect(verified.hypothesisText).toBe(WINDOWS_TRANSCRIPT);
    expect(verified.evaluation.evaluation_id).toBe(EVALUATION_ID);
  });
});

describe('listing is scoped to one Run', () => {
  it('lists only Evaluations that name the requested Run', async () => {
    await writeRun();
    await writeRun(OTHER_RUN_ID, 'numbers-units-001');
    await saveSealedResult();
    await saveSealedResult(RESULT_ID_2, 'aqua-voice', AQUA_TRANSCRIPT, OTHER_RUN_ID);

    await createRawCharEvaluation({ resultId: RESULT_ID }, deps({ evaluationId: EVALUATION_ID }));
    await createRawCharEvaluation(
      { resultId: RESULT_ID_2 },
      deps({ evaluationId: EVALUATION_ID_2 }),
    );

    const forRun = await listEvaluationsForRun(deps(), RUN_ID);
    expect(forRun.map((entry) => entry.evaluationId)).toEqual([EVALUATION_ID]);

    const forOther = await listEvaluationsForRun(deps(), OTHER_RUN_ID);
    expect(forOther.map((entry) => entry.evaluationId)).toEqual([EVALUATION_ID_2]);
  });

  it('fails closed when the Run itself no longer verifies', async () => {
    await writeRun();
    await saveSealedResult();
    await createRawCharEvaluation({ resultId: RESULT_ID }, deps({ evaluationId: EVALUATION_ID }));

    await writeFile(runStore.resolveRunFile(RUN_ID, 'source.txt'), '書き換えられた原文');

    await expect(listEvaluationsForRun(deps(), RUN_ID)).rejects.toThrow();
  });

  it('returns an empty list for a Run with no Evaluations', async () => {
    await writeRun();
    expect(await listEvaluationsForRun(deps(), RUN_ID)).toEqual([]);
  });
});

describe('four-root isolation', () => {
  async function expectViolation(promise: Promise<unknown>) {
    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StorageBoundaryError);
    expect((error as StorageBoundaryError).kind).toBe('ROOT_ISOLATION_VIOLATED');
  }

  const NESTED_CASES: Array<[string, () => EvaluationDeps]> = [
    [
      'evaluations inside runs',
      () => deps({ evaluationStore: new LocalEvaluationStore(path.join(runsRoot, 'nested')) }),
    ],
    [
      'evaluations inside results',
      () => deps({ evaluationStore: new LocalEvaluationStore(path.join(resultsRoot, 'nested')) }),
    ],
    [
      'evaluations inside sessions',
      () => deps({ evaluationStore: new LocalEvaluationStore(path.join(sessionsRoot, 'nested')) }),
    ],
    [
      'evaluations equal to runs',
      () => deps({ evaluationStore: new LocalEvaluationStore(runsRoot) }),
    ],
    [
      'runs inside evaluations',
      () => deps({ runStore: new LocalRunStore(path.join(evaluationsRoot, 'nested')) }),
    ],
    [
      'results inside evaluations',
      () => deps({ resultStore: new LocalResultStore(path.join(evaluationsRoot, 'nested')) }),
    ],
    [
      'sessions inside evaluations',
      () => deps({ sessionStore: new LocalSessionStore(path.join(evaluationsRoot, 'nested')) }),
    ],
  ];

  for (const [label, build] of NESTED_CASES) {
    it(`refuses ${label} on the write path`, async () => {
      await writeRun();
      await saveSealedResult();
      await expectViolation(
        createRawCharEvaluation({ resultId: RESULT_ID }, { ...build(), evaluationId: EVALUATION_ID }),
      );
    });
  }

  /**
   * A directory literally named `..evaluations` is a child, not an escape.
   * These are the layouts a `startsWith('..')` containment check waved through:
   * genuinely inside another root, but looking like a path that leaves it.
   */
  const DOTTED_CASES: Array<[string, () => EvaluationDeps]> = [
    [
      'evaluations at <runs>/..evaluations',
      () =>
        deps({ evaluationStore: new LocalEvaluationStore(path.join(runsRoot, '..evaluations')) }),
    ],
    [
      'evaluations at <results>/..evaluations',
      () =>
        deps({
          evaluationStore: new LocalEvaluationStore(path.join(resultsRoot, '..evaluations')),
        }),
    ],
    [
      'evaluations at <sessions>/..evaluations',
      () =>
        deps({
          evaluationStore: new LocalEvaluationStore(path.join(sessionsRoot, '..evaluations')),
        }),
    ],
    [
      'runs at <evaluations>/..runs',
      () => deps({ runStore: new LocalRunStore(path.join(evaluationsRoot, '..runs')) }),
    ],
  ];

  for (const [label, build] of DOTTED_CASES) {
    it(`refuses ${label} before writing anything`, async () => {
      await writeRun();
      await saveSealedResult();
      const evaluationsBefore = await treeFingerprint(evaluationsRoot);

      await expectViolation(
        createRawCharEvaluation(
          { resultId: RESULT_ID },
          { ...build(), evaluationId: EVALUATION_ID },
        ),
      );

      // The check runs before the Run and Result are even read, so nothing
      // lands anywhere.
      expect(await treeFingerprint(evaluationsRoot)).toEqual(evaluationsBefore);
      expect(await tempResidue(evaluationsRoot)).toEqual([]);
    });
  }

  it('does not mistake a dotted sibling root for a nested one', async () => {
    await writeRun();
    await saveSealedResult();
    // `<tmp>/..evaluations` alongside the other roots is a sibling.
    const sibling = path.join(path.dirname(evaluationsRoot), '..evaluations-sibling');
    const outcome = await createRawCharEvaluation(
      { resultId: RESULT_ID },
      deps({ evaluationStore: new LocalEvaluationStore(sibling), evaluationId: EVALUATION_ID }),
    );
    expect(outcome.evaluationId).toBe(EVALUATION_ID);
    await rm(sibling, { recursive: true, force: true });
  });

  it('does not mistake a -archive suffix for a nested root', async () => {
    await writeRun();
    await saveSealedResult();
    const archive = `${runsRoot}-archive`;
    const outcome = await createRawCharEvaluation(
      { resultId: RESULT_ID },
      deps({ evaluationStore: new LocalEvaluationStore(archive), evaluationId: EVALUATION_ID }),
    );
    expect(outcome.evaluationId).toBe(EVALUATION_ID);
    await rm(archive, { recursive: true, force: true });
  });

  it('refuses the same violation on the read path', async () => {
    await writeRun();
    await expectViolation(
      listEvaluationsForRun(
        deps({ evaluationStore: new LocalEvaluationStore(path.join(runsRoot, 'nested')) }),
        RUN_ID,
      ),
    );
  });

  it('refuses a dotted violation on the read path', async () => {
    await writeRun();
    await expectViolation(
      listEvaluationsForRun(
        deps({ evaluationStore: new LocalEvaluationStore(path.join(runsRoot, '..evaluations')) }),
        RUN_ID,
      ),
    );
  });

  it('accepts four sibling roots', async () => {
    await writeRun();
    await saveSealedResult();
    const outcome = await createRawCharEvaluation(
      { resultId: RESULT_ID },
      deps({ evaluationId: EVALUATION_ID }),
    );
    expect(outcome.evaluationId).toBe(EVALUATION_ID);
  });
});

/**
 * P3-B — critical information Evaluations, in the same root as P3-A's.
 *
 * The two evaluators answer different questions about the same pair of texts,
 * and both artifacts live in `data/evaluations/`. What has to hold is that
 * neither disturbs the other: a v1 Evaluation is never rewritten or migrated to
 * make room for v2, and each is read back by the verifier its own schema calls
 * for.
 */
describe('creating a critical information Evaluation', () => {
  it('measures which facts survived, at schema v2', async () => {
    await writeRun();
    await saveSealedResult();

    const outcome = await createCriticalInfoEvaluation(
      { resultId: RESULT_ID },
      deps({ evaluationId: EVALUATION_ID }),
    );

    const expected = analyzeCriticalInfo(SOURCE_TEXT, WINDOWS_TRANSCRIPT);
    expect(outcome.evaluation).toMatchObject({
      schema_version: 2,
      evaluation_id: EVALUATION_ID,
      evaluator: {
        id: 'critical-info-v1',
        scope: 'numeric-unit-time',
        number_grammar: 'number-grammar-v1',
        unit_aliases: 'unit-alias-v1',
        matching: 'canonical-multiset-v1',
        separator_policy: 'space-fullwidth-space-v1',
      },
      run_id: RUN_ID,
      result_id: RESULT_ID,
      metrics: expected.metrics,
    });
    expect(outcome.evaluation.integrity.semantic_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('preserves 二千七百ミリ as 2700ミリ', async () => {
    await writeRun();
    await saveSealedResult();

    const outcome = await createCriticalInfoEvaluation(
      { resultId: RESULT_ID },
      deps({ evaluationId: EVALUATION_ID }),
    );

    expect(outcome.evaluation.metrics).toMatchObject({
      reference_entities: 1,
      hypothesis_entities: 1,
      matched: 1,
      missing: 0,
      extra: 0,
      preservation_rate: 1,
      exact_entity_multiset_match: true,
    });
    expect(outcome.evaluation.matches).toEqual([
      {
        canonical_key: 'measurement:2700:millimetre',
        reference: {
          kind: 'measurement',
          raw: '二千七百ミリ',
          start_code_point: expect.any(Number),
          end_code_point: expect.any(Number),
          canonical_key: 'measurement:2700:millimetre',
        },
        hypothesis: {
          kind: 'measurement',
          raw: '2700ミリ',
          start_code_point: expect.any(Number),
          end_code_point: expect.any(Number),
          canonical_key: 'measurement:2700:millimetre',
        },
      },
    ]);

    // Both spans point back into the texts they were read from.
    const match = outcome.evaluation.matches[0]!;
    expect(
      Array.from(SOURCE_TEXT)
        .slice(match.reference.start_code_point, match.reference.end_code_point)
        .join(''),
    ).toBe('二千七百ミリ');
    expect(
      Array.from(WINDOWS_TRANSCRIPT)
        .slice(match.hypothesis.start_code_point, match.hypothesis.end_code_point)
        .join(''),
    ).toBe('2700ミリ');
  });

  it('stores the working, not just the rate', async () => {
    await writeRun();
    await saveSealedResult(RESULT_ID, 'windows-standard-voice-input', WRONG_VALUE_TRANSCRIPT);

    const outcome = await createCriticalInfoEvaluation(
      { resultId: RESULT_ID },
      deps({ evaluationId: EVALUATION_ID }),
    );

    expect(outcome.evaluation.entities.reference.map((entity) => entity.canonical_key)).toEqual([
      'measurement:2700:millimetre',
    ]);
    expect(outcome.evaluation.entities.hypothesis.map((entity) => entity.canonical_key)).toEqual([
      'measurement:2600:millimetre',
    ]);
    expect(outcome.evaluation.missing.map((entity) => entity.raw)).toEqual(['二千七百ミリ']);
    expect(outcome.evaluation.extra.map((entity) => entity.raw)).toEqual(['2600ミリ']);

    // Every stored span points back into the text it was read from.
    const referenceChars = Array.from(SOURCE_TEXT);
    for (const entity of outcome.evaluation.entities.reference) {
      expect(
        referenceChars.slice(entity.start_code_point, entity.end_code_point).join(''),
      ).toBe(entity.raw);
    }
    expect(outcome.evaluation.metrics).toMatchObject({
      matched: 0,
      missing: 1,
      extra: 1,
      preservation_rate: 0,
      exact_entity_multiset_match: false,
    });
  });

  it('refuses a legacy v1 Result and writes nothing', async () => {
    await writeRun();
    await saveLegacyV1Result(RESULT_ID);

    const error = await createCriticalInfoEvaluation(
      { resultId: RESULT_ID },
      deps({ evaluationId: EVALUATION_ID }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EvaluationSubjectError);
    expect((error as EvaluationSubjectError).kind).toBe('EVALUATION_RESULT_NOT_SEALED');
    expect(await evaluationStore.listEvaluationIds()).toEqual([]);
  });

  it('fails closed when the canonical text carries no critical information', async () => {
    // Nothing to preserve means no honest rate to report — 100% least of all.
    await writeRun(RUN_ID, 'architecture-short-001', NO_ENTITY_SOURCE);
    await saveSealedResult(RESULT_ID, 'windows-standard-voice-input', '会議室はノースサイドです。');

    const error = await createCriticalInfoEvaluation(
      { resultId: RESULT_ID },
      deps({ evaluationId: EVALUATION_ID }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CriticalInfoError);
    expect((error as CriticalInfoError).kind).toBe('CRITICAL_INFO_NO_REFERENCE_ENTITY');
    expect(await evaluationStore.listEvaluationIds()).toEqual([]);
    expect(await tempResidue(evaluationsRoot)).toEqual([]);
  });

  it('leaves the Run, Result and Session trees exactly as they were', async () => {
    await writeRun();
    await saveSealedResult();

    const before = {
      runs: await treeFingerprint(runsRoot),
      results: await treeFingerprint(resultsRoot),
      sessions: await treeFingerprint(sessionsRoot),
    };

    await createCriticalInfoEvaluation({ resultId: RESULT_ID }, deps({ evaluationId: EVALUATION_ID }));
    await listEvaluationsForRun(deps(), RUN_ID);
    await loadVerifiedEvaluation(deps(), EVALUATION_ID);

    expect(await treeFingerprint(runsRoot)).toEqual(before.runs);
    expect(await treeFingerprint(resultsRoot)).toEqual(before.results);
    expect(await treeFingerprint(sessionsRoot)).toEqual(before.sessions);
  });
});

describe('choosing an evaluator by name', () => {
  it('runs raw-char-v1 when asked for it', async () => {
    await writeRun();
    await saveSealedResult();
    const outcome = await createEvaluation(
      { resultId: RESULT_ID, evaluatorId: 'raw-char-v1' },
      deps({ evaluationId: EVALUATION_ID }),
    );
    expect(outcome.evaluation.schema_version).toBe(1);
    expect(outcome.evaluation.evaluator.id).toBe('raw-char-v1');
  });

  it('runs critical-info-v1 when asked for it', async () => {
    await writeRun();
    await saveSealedResult();
    const outcome = await createEvaluation(
      { resultId: RESULT_ID, evaluatorId: 'critical-info-v1' },
      deps({ evaluationId: EVALUATION_ID }),
    );
    expect(outcome.evaluation.schema_version).toBe(2);
    expect(outcome.evaluation.evaluator.id).toBe('critical-info-v1');
  });

  it('only accepts evaluators it implements', () => {
    expect(isEvaluatorId('raw-char-v1')).toBe(true);
    expect(isEvaluatorId('critical-info-v1')).toBe(true);
    expect(isEvaluatorId('normalized-char-v1')).toBe(false);
    expect(isEvaluatorId('')).toBe(false);
    expect(isEvaluatorId(undefined)).toBe(false);
  });
});

describe('stored critical Evaluations are re-derived on read', () => {
  async function seedCritical() {
    await writeRun();
    await saveSealedResult(RESULT_ID, 'windows-standard-voice-input', WRONG_VALUE_TRANSCRIPT);
    return createCriticalInfoEvaluation(
      { resultId: RESULT_ID },
      deps({ evaluationId: EVALUATION_ID }),
    );
  }

  async function listOne() {
    const entries = await listEvaluationsForRun(deps(), RUN_ID);
    expect(entries).toHaveLength(1);
    return entries[0]!;
  }

  /** Edit a v2 Evaluation, optionally re-sealing it the way its author would. */
  async function patchCritical(
    mutate: (evaluation: Record<string, unknown>) => void,
    reseal = false,
  ) {
    const file = evaluationStore.resolveEvaluationFile(EVALUATION_ID);
    const evaluation = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    mutate(evaluation);
    if (reseal) {
      delete evaluation.integrity;
      evaluation.integrity = {
        algorithm: 'sha256',
        semantic_sha256: computeCriticalEvaluationSemanticSha256(
          evaluation as unknown as CriticalEvaluationPayloadV2,
        ),
      };
    }
    await writeFile(file, `${JSON.stringify(evaluation, null, 2)}\n`);
  }

  it('returns a verified entry for an untouched Evaluation', async () => {
    await seedCritical();
    const entry = await listOne();
    expect(entry.status).toBe('verified');
    if (entry.status === 'verified') {
      expect(entry.evaluation.schema_version).toBe(2);
      expect(entry.referenceText).toBe(SOURCE_TEXT);
      expect(entry.hypothesisText).toBe(WRONG_VALUE_TRANSCRIPT);
    }
  });

  it('accepts a reformatted evaluation.json with reordered keys', async () => {
    await seedCritical();
    const file = evaluationStore.resolveEvaluationFile(EVALUATION_ID);
    const original = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;

    const reverseKeys = (value: Record<string, unknown>): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value).reverse()) out[key] = value[key];
      return out;
    };

    const reordered = reverseKeys(original);
    reordered.evaluator = reverseKeys(original.evaluator as Record<string, unknown>);
    reordered.metrics = reverseKeys(original.metrics as Record<string, unknown>);
    await writeFile(file, JSON.stringify(reordered, null, 4));

    expect((await listOne()).status).toBe('verified');
  });

  it('rejects an edited preservation rate', async () => {
    await seedCritical();
    await patchCritical((evaluation) => {
      (evaluation.metrics as Record<string, unknown>).preservation_rate = 1;
    });

    const entry = await listOne();
    expect(entry.status).toBe('rejected');
    if (entry.status === 'rejected') expect(entry.reason).toBe('EVALUATION_INTEGRITY_MISMATCH');
  });

  it('rejects an edited preservation rate even when re-sealed', async () => {
    await seedCritical();
    // Consistent on its face: the rate, the counts and the flag all agree.
    // Only recomputing from the texts catches it.
    await patchCritical((evaluation) => {
      const metrics = evaluation.metrics as Record<string, unknown>;
      metrics.matched = 1;
      metrics.missing = 0;
      metrics.extra = 0;
      metrics.preservation_rate = 1;
      metrics.exact_entity_multiset_match = true;
    }, true);

    const entry = await listOne();
    expect(entry.status).toBe('rejected');
    if (entry.status === 'rejected') expect(entry.reason).toBe('EVALUATION_METRICS_MISMATCH');
  });

  it('rejects a rewritten entity list even when re-sealed', async () => {
    await seedCritical();
    await patchCritical((evaluation) => {
      const entities = evaluation.entities as Record<string, unknown>;
      entities.hypothesis = [
        { kind: 'number', surface: '二千七百ミリ', key: 'number:2700:mm', offset: 0 },
      ];
    }, true);

    const entry = await listOne();
    expect(entry.status).toBe('rejected');
    if (entry.status === 'rejected') expect(entry.reason).toBe('EVALUATION_ENTITIES_MISMATCH');
  });

  it('rejects a rewritten missing list even when re-sealed', async () => {
    await seedCritical();
    await patchCritical((evaluation) => {
      evaluation.missing = [];
    }, true);

    const entry = await listOne();
    expect(entry.status).toBe('rejected');
    if (entry.status === 'rejected') expect(entry.reason).toBe('EVALUATION_ENTITIES_MISMATCH');
  });

  // --- structural validation before the seal ---------------------------------
  // A stored v2 artifact whose nested shape the canonicalizer cannot walk used
  // to throw a TypeError out of `computeCriticalEvaluationSemanticSha256` and
  // arrive as UNEXPECTED. Every case below asserts a structured rejection, and
  // all of them read through `listEvaluationsForRun`, which is the path the API
  // and the screen actually use.

  it('reports a match without a reference object as malformed', async () => {
    // The shape the five historical artifacts on disk actually have: a match
    // carrying `reference_surface` and `reference_offset` rather than a
    // `reference` object, so `canonicalEntity(match.reference)` got undefined.
    await seedCritical();
    await patchCritical((evaluation) => {
      evaluation.matches = [
        {
          key: 'number:2700:mm',
          reference_surface: '2700mm',
          reference_offset: 5,
          hypothesis_surface: '2600mm',
          hypothesis_offset: 4,
        },
      ];
    });

    const entry = await listOne();
    expect(entry.status).toBe('rejected');
    if (entry.status === 'rejected') {
      expect(entry.reason).toBe('EVALUATION_MALFORMED');
      expect(entry.reason).not.toBe('UNEXPECTED');
      // The rejection has to say which field, or it is no better than a crash.
      expect(entry.detail).toContain('matches[0].reference');
    }
  });

  it('reports a null entity in the reference list as malformed', async () => {
    await seedCritical();
    await patchCritical((evaluation) => {
      (evaluation.entities as Record<string, unknown>).reference = [null];
    });

    const entry = await listOne();
    expect(entry.status).toBe('rejected');
    if (entry.status === 'rejected') {
      expect(entry.reason).toBe('EVALUATION_MALFORMED');
      expect(entry.detail).toContain('entities.reference[0]');
    }
  });

  it('reports a null match as malformed', async () => {
    await seedCritical();
    await patchCritical((evaluation) => {
      evaluation.matches = [null];
    });

    const entry = await listOne();
    expect(entry.status).toBe('rejected');
    if (entry.status === 'rejected') {
      expect(entry.reason).toBe('EVALUATION_MALFORMED');
      expect(entry.detail).toContain('matches[0]');
    }
  });

  it('reports metrics that are not an object as malformed', async () => {
    await seedCritical();
    await patchCritical((evaluation) => {
      evaluation.metrics = 'all good';
    });

    const entry = await listOne();
    expect(entry.status).toBe('rejected');
    if (entry.status === 'rejected') {
      expect(entry.reason).toBe('EVALUATION_MALFORMED');
      expect(entry.detail).toContain('metrics');
    }
  });

  it('reports a missing subject.tool as malformed rather than crashing', async () => {
    // `payload.subject.tool.id` is dereferenced by name in the canonicalizer.
    await seedCritical();
    await patchCritical((evaluation) => {
      delete (evaluation.subject as Record<string, unknown>).tool;
    });

    const entry = await listOne();
    expect(entry.status).toBe('rejected');
    if (entry.status === 'rejected') {
      expect(entry.reason).toBe('EVALUATION_MALFORMED');
      expect(entry.detail).toContain('subject.tool');
    }
  });

  it('keeps a malformed integrity record with its existing owner', async () => {
    // Structured, and deliberately still EVALUATION_INTEGRITY_MISSING: that
    // check never crashed, so hardening the shape must not relabel it.
    await seedCritical();
    await patchCritical((evaluation) => {
      evaluation.integrity = 'sealed, honest';
    });

    const entry = await listOne();
    expect(entry.status).toBe('rejected');
    if (entry.status === 'rejected') {
      expect(entry.reason).toBe('EVALUATION_INTEGRITY_MISSING');
      expect(entry.reason).not.toBe('UNEXPECTED');
    }
  });

  it('keeps an entity with the wrong fields as an entities mismatch', async () => {
    // The distinction the shape check must not blur. An entity object with the
    // old vocabulary is still an object, so the canonicalizer can walk it; what
    // is wrong is what it says, and recomputation is what knows that. Reporting
    // this as malformed would lose the more precise answer.
    await seedCritical();
    await patchCritical((evaluation) => {
      const entities = evaluation.entities as Record<string, unknown>;
      entities.hypothesis = [{ kind: 'number', surface: '二千七百ミリ', key: 'number:2700:mm' }];
    }, true);

    const entry = await listOne();
    expect(entry.status).toBe('rejected');
    if (entry.status === 'rejected') {
      expect(entry.reason).toBe('EVALUATION_ENTITIES_MISMATCH');
      expect(entry.reason).not.toBe('UNEXPECTED');
    }
  });

  it('never reports UNEXPECTED for any malformed nested v2 shape', async () => {
    // A sweep rather than one case: the guarantee is about the class, not about
    // the particular field someone happened to break.
    const breakages: Array<[string, (evaluation: Record<string, unknown>) => void]> = [
      ['matches not an array', (e) => { e.matches = {}; }],
      ['missing not an array', (e) => { e.missing = 'none'; }],
      ['extra containing null', (e) => { e.extra = [null]; }],
      ['entities not an object', (e) => { e.entities = []; }],
      ['entities.hypothesis null entry', (e) => {
        (e.entities as Record<string, unknown>).hypothesis = [null];
      }],
      ['match hypothesis not an object', (e) => {
        e.matches = [{ canonical_key: 'k', reference: {}, hypothesis: 'x' }];
      }],
      ['subject.capture missing', (e) => {
        delete (e.subject as Record<string, unknown>).capture;
      }],
      ['run_evidence not an object', (e) => { e.run_evidence = 7; }],
      ['reference not an object', (e) => { e.reference = null; }],
    ];

    // Seeded once — the Run bundle is immutable and will not be written twice —
    // then each case is applied to a pristine copy of the same artifact.
    await seedCritical();
    const file = evaluationStore.resolveEvaluationFile(EVALUATION_ID);
    const pristine = await readFile(file, 'utf8');

    for (const [label, mutate] of breakages) {
      const evaluation = JSON.parse(pristine) as Record<string, unknown>;
      mutate(evaluation);
      await writeFile(file, `${JSON.stringify(evaluation, null, 2)}
`);

      const entry = await listOne();
      expect(entry.status, label).toBe('rejected');
      if (entry.status === 'rejected') {
        expect(entry.reason, label).toBe('EVALUATION_MALFORMED');
      }
    }

    // And the pristine artifact still verifies once it is put back.
    await writeFile(file, pristine);
    expect((await listOne()).status).toBe('verified');
  });

  const EVALUATOR_FIELD_EDITS: Array<[string, string]> = [
    ['id', 'normalized-info-v1'],
    ['scope', 'numeric-only'],
    ['number_grammar', 'number-grammar-v2'],
    ['unit_aliases', 'unit-alias-v2'],
    ['matching', 'greedy-overlap-v1'],
    ['separator_policy', 'any-whitespace-v1'],
  ];

  for (const [field, value] of EVALUATOR_FIELD_EDITS) {
    it(`rejects an edited evaluator.${field} even when re-sealed`, async () => {
      await seedCritical();
      await patchCritical((evaluation) => {
        (evaluation.evaluator as Record<string, unknown>)[field] = value;
      }, true);

      const entry = await listOne();
      expect(entry.status).toBe('rejected');
      if (entry.status === 'rejected') expect(entry.reason).toBe('EVALUATION_EVALUATOR_MISMATCH');
    });
  }

  it('rejects an evaluator carrying a field this build has never heard of', async () => {
    await seedCritical();
    await patchCritical((evaluation) => {
      (evaluation.evaluator as Record<string, unknown>).rounding_policy = 'nearest-v1';
    }, true);

    const entry = await listOne();
    expect(entry.status).toBe('rejected');
    if (entry.status === 'rejected') expect(entry.reason).toBe('EVALUATION_EVALUATOR_MISMATCH');
  });

  it('rejects an edited entity span', async () => {
    await seedCritical();
    await patchCritical((evaluation) => {
      const entities = evaluation.entities as { reference: Array<Record<string, unknown>> };
      entities.reference[0]!.start_code_point = 0;
    });

    const entry = await listOne();
    expect(entry.status).toBe('rejected');
    if (entry.status === 'rejected') expect(entry.reason).toBe('EVALUATION_INTEGRITY_MISMATCH');
  });

  it('rejects an edited entity span even when re-sealed', async () => {
    await seedCritical();
    // The span no longer points at the text the raw came from. Only recomputing
    // from the bytes catches it.
    await patchCritical((evaluation) => {
      const entities = evaluation.entities as { reference: Array<Record<string, unknown>> };
      entities.reference[0]!.start_code_point = 0;
      entities.reference[0]!.end_code_point = 6;
    }, true);

    const entry = await listOne();
    expect(entry.status).toBe('rejected');
    if (entry.status === 'rejected') expect(entry.reason).toBe('EVALUATION_ENTITIES_MISMATCH');
  });

  it('rejects an edited span inside a match even when re-sealed', async () => {
    await seedCritical();
    await patchCritical((evaluation) => {
      const missing = evaluation.missing as Array<Record<string, unknown>>;
      missing[0]!.end_code_point = (missing[0]!.end_code_point as number) + 1;
    }, true);

    const entry = await listOne();
    expect(entry.status).toBe('rejected');
    if (entry.status === 'rejected') expect(entry.reason).toBe('EVALUATION_ENTITIES_MISMATCH');
  });

  it('stores spans that point back into the texts they were read from', async () => {
    const outcome = await seedCritical();
    const referenceChars = Array.from(SOURCE_TEXT);
    const hypothesisChars = Array.from(WRONG_VALUE_TRANSCRIPT);

    for (const entity of outcome.evaluation.entities.reference) {
      expect(
        referenceChars.slice(entity.start_code_point, entity.end_code_point).join(''),
      ).toBe(entity.raw);
    }
    for (const entity of outcome.evaluation.entities.hypothesis) {
      expect(
        hypothesisChars.slice(entity.start_code_point, entity.end_code_point).join(''),
      ).toBe(entity.raw);
    }
  });

  it('rejects an Evaluation whose transcript changed underneath it', async () => {
    await seedCritical();
    await writeFile(
      resultStore.resolveResultFile(RESULT_ID, 'transcript.txt'),
      '書き換えられた書き起こし',
    );

    const entry = await listOne();
    expect(entry.status).toBe('rejected');
    if (entry.status === 'rejected') expect(entry.reason).toBe('RESULT_TRANSCRIPT_HASH_MISMATCH');
  });

  it('loadVerifiedEvaluation returns both texts for side-by-side reading', async () => {
    await seedCritical();
    const verified = await loadVerifiedEvaluation(deps(), EVALUATION_ID);
    expect(verified.referenceText).toBe(SOURCE_TEXT);
    expect(verified.hypothesisText).toBe(WRONG_VALUE_TRANSCRIPT);
    expect(verified.evaluation.schema_version).toBe(2);
  });
});

describe('P3-A and P3-B Evaluations share a root without disturbing each other', () => {
  it('lists a raw-char v1 and a critical v2 Evaluation side by side', async () => {
    await writeRun();
    await saveSealedResult();
    await createRawCharEvaluation({ resultId: RESULT_ID }, deps({ evaluationId: EVALUATION_ID }));
    await createCriticalInfoEvaluation(
      { resultId: RESULT_ID },
      deps({ evaluationId: EVALUATION_ID_2 }),
    );

    const entries = await listEvaluationsForRun(deps(), RUN_ID);
    expect(entries.map((entry) => entry.status)).toEqual(['verified', 'verified']);
    expect(
      entries.map((entry) =>
        entry.status === 'verified' ? entry.evaluation.evaluator.id : null,
      ),
    ).toEqual(['raw-char-v1', 'critical-info-v1']);
  });

  it('never rewrites an existing P3-A Evaluation', async () => {
    await writeRun();
    await saveSealedResult();
    await createRawCharEvaluation({ resultId: RESULT_ID }, deps({ evaluationId: EVALUATION_ID }));

    const file = evaluationStore.resolveEvaluationFile(EVALUATION_ID);
    const before = sha(new Uint8Array(await readFile(file)));

    await createCriticalInfoEvaluation(
      { resultId: RESULT_ID },
      deps({ evaluationId: EVALUATION_ID_2 }),
    );
    await listEvaluationsForRun(deps(), RUN_ID);
    await loadVerifiedEvaluation(deps(), EVALUATION_ID);

    expect(sha(new Uint8Array(await readFile(file)))).toBe(before);
    const stored = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    expect(stored.schema_version).toBe(1);
    expect(stored.entities).toBeUndefined();
  });

  it('reads each Evaluation back with the verifier its own schema calls for', async () => {
    await writeRun();
    await saveSealedResult();
    await createRawCharEvaluation({ resultId: RESULT_ID }, deps({ evaluationId: EVALUATION_ID }));
    await createCriticalInfoEvaluation(
      { resultId: RESULT_ID },
      deps({ evaluationId: EVALUATION_ID_2 }),
    );

    const rawChar = await loadVerifiedEvaluation(deps(), EVALUATION_ID);
    const critical = await loadVerifiedEvaluation(deps(), EVALUATION_ID_2);
    expect(rawChar.evaluation.schema_version).toBe(1);
    expect(critical.evaluation.schema_version).toBe(2);
  });
});

/**
 * P3-C — surface-normalized Evaluations, in the same root as P3-A's and P3-B's.
 *
 * Three evaluators now answer three questions about the same pair of texts, and
 * all three artifacts live in `data/evaluations/`. What has to hold is that none
 * disturbs the others: neither v1 nor v2 is rewritten or migrated to make room
 * for v3, and each is read back by the verifier its own schema calls for.
 */
describe('creating a surface-normalized Evaluation', () => {
  it('measures the normalized pair, at schema v3', async () => {
    await writeRun();
    await saveSealedResult();

    const outcome = await createSurfaceCharEvaluation(
      { resultId: RESULT_ID },
      deps({ evaluationId: EVALUATION_ID }),
    );

    const expected = evaluateRawChar(
      surfaceNormalize(SOURCE_TEXT),
      surfaceNormalize(WINDOWS_TRANSCRIPT),
    );
    expect(outcome.evaluation).toMatchObject({
      schema_version: 3,
      evaluation_id: EVALUATION_ID,
      evaluator: {
        id: 'surface-normalized-char-v1',
        unit: 'unicode-code-point',
        normalization_profile: 'surface-normalize-v1',
        width_mapping: 'fullwidth-ascii-range-v1',
        case_fold: 'ascii-lower-v1',
        punctuation_aliases: 'punctuation-alias-v1',
        space_policy: 'ascii-space-trim-collapse-v1',
        line_break_policy: 'preserve-lf-v1',
        distance: 'levenshtein-code-point-sdi-v1',
      },
      run_id: RUN_ID,
      result_id: RESULT_ID,
      metrics: expected,
    });
    expect(outcome.evaluation.integrity.semantic_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('records what the two texts became, not just what they were', async () => {
    await writeRun();
    await saveSealedResult();

    const outcome = await createSurfaceCharEvaluation(
      { resultId: RESULT_ID },
      deps({ evaluationId: EVALUATION_ID }),
    );

    const normalizedReference = surfaceNormalize(SOURCE_TEXT);
    const normalizedHypothesis = surfaceNormalize(WINDOWS_TRANSCRIPT);

    expect(outcome.evaluation.normalized).toEqual({
      reference: {
        sha256: sha(normalizedReference),
        chars: Array.from(normalizedReference).length,
      },
      hypothesis: {
        sha256: sha(normalizedHypothesis),
        chars: Array.from(normalizedHypothesis).length,
      },
    });

    // The raw hashes are kept alongside, so the artifact says which bytes were
    // read as well as what they became.
    expect(outcome.evaluation.reference.sha256).toBe(sha(SOURCE_TEXT));
    expect(outcome.evaluation.hypothesis.sha256).toBe(sha(WINDOWS_TRANSCRIPT));
  });

  it('forgives a formatting-only difference the raw evaluator counts', async () => {
    await writeRun();
    await saveSealedResult(RESULT_ID, 'aqua-voice', SURFACE_ONLY_TRANSCRIPT);

    const rawChar = await createRawCharEvaluation(
      { resultId: RESULT_ID },
      deps({ evaluationId: EVALUATION_ID }),
    );
    const surface = await createSurfaceCharEvaluation(
      { resultId: RESULT_ID },
      deps({ evaluationId: EVALUATION_ID_2 }),
    );

    expect(rawChar.evaluation.metrics.exact_match).toBe(false);
    expect(rawChar.evaluation.metrics.edit_distance).toBeGreaterThan(0);

    expect(surface.evaluation.metrics.exact_match).toBe(true);
    expect(surface.evaluation.metrics.edit_distance).toBe(0);
    expect(surface.evaluation.metrics.cer).toBe(0);
  });

  it('keeps a numeral difference that critical-info-v1 would call preserved', async () => {
    // 二千七百ミリ against 2700ミリ: one fact under critical-info-v1, two
    // different texts here. Both readings are right about different questions.
    await writeRun();
    await saveSealedResult();

    const surface = await createSurfaceCharEvaluation(
      { resultId: RESULT_ID },
      deps({ evaluationId: EVALUATION_ID }),
    );
    const critical = await createCriticalInfoEvaluation(
      { resultId: RESULT_ID },
      deps({ evaluationId: EVALUATION_ID_2 }),
    );

    expect(surface.evaluation.metrics.edit_distance).toBeGreaterThan(0);
    expect(critical.evaluation.metrics).toMatchObject({ matched: 1, missing: 0, extra: 0 });
  });

  it('refuses a legacy v1 Result and writes nothing', async () => {
    await writeRun();
    await saveLegacyV1Result(RESULT_ID);

    const error = await createSurfaceCharEvaluation(
      { resultId: RESULT_ID },
      deps({ evaluationId: EVALUATION_ID }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EvaluationSubjectError);
    expect((error as EvaluationSubjectError).kind).toBe('EVALUATION_RESULT_NOT_SEALED');
    expect(await evaluationStore.listEvaluationIds()).toEqual([]);
    expect(await tempResidue(evaluationsRoot)).toEqual([]);
  });

  it('leaves the Run, Result and Session trees exactly as they were', async () => {
    await writeRun();
    await saveSealedResult();

    const before = {
      runs: await treeFingerprint(runsRoot),
      results: await treeFingerprint(resultsRoot),
      sessions: await treeFingerprint(sessionsRoot),
    };

    await createSurfaceCharEvaluation({ resultId: RESULT_ID }, deps({ evaluationId: EVALUATION_ID }));
    await listEvaluationsForRun(deps(), RUN_ID);
    await loadVerifiedEvaluation(deps(), EVALUATION_ID);

    expect(await treeFingerprint(runsRoot)).toEqual(before.runs);
    expect(await treeFingerprint(resultsRoot)).toEqual(before.results);
    expect(await treeFingerprint(sessionsRoot)).toEqual(before.sessions);
  });
});

describe('stored surface Evaluations are re-derived on read', () => {
  async function seedSurface() {
    await writeRun();
    await saveSealedResult();
    return createSurfaceCharEvaluation(
      { resultId: RESULT_ID },
      deps({ evaluationId: EVALUATION_ID }),
    );
  }

  async function listOne() {
    const entries = await listEvaluationsForRun(deps(), RUN_ID);
    expect(entries).toHaveLength(1);
    return entries[0]!;
  }

  /** Edit a v3 Evaluation, optionally re-sealing it the way its author would. */
  async function patchSurface(
    mutate: (evaluation: Record<string, unknown>) => void,
    reseal = false,
  ) {
    const file = evaluationStore.resolveEvaluationFile(EVALUATION_ID);
    const evaluation = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    mutate(evaluation);
    if (reseal) {
      delete evaluation.integrity;
      evaluation.integrity = {
        algorithm: 'sha256',
        semantic_sha256: computeSurfaceEvaluationSemanticSha256(
          evaluation as unknown as SurfaceEvaluationPayloadV3,
        ),
      };
    }
    await writeFile(file, `${JSON.stringify(evaluation, null, 2)}\n`);
  }

  it('returns a verified entry with both normalized texts', async () => {
    await seedSurface();
    const entry = await listOne();
    expect(entry.status).toBe('verified');
    if (entry.status === 'verified') {
      expect(entry.evaluation.schema_version).toBe(3);
      expect(entry.referenceText).toBe(SOURCE_TEXT);
      expect(entry.hypothesisText).toBe(WINDOWS_TRANSCRIPT);
      expect(entry.normalized).toEqual({
        reference: surfaceNormalize(SOURCE_TEXT),
        hypothesis: surfaceNormalize(WINDOWS_TRANSCRIPT),
      });
    }
  });

  it('accepts a reformatted evaluation.json with reordered keys', async () => {
    await seedSurface();
    const file = evaluationStore.resolveEvaluationFile(EVALUATION_ID);
    const original = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;

    const reverseKeys = (value: Record<string, unknown>): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value).reverse()) out[key] = value[key];
      return out;
    };

    const reordered = reverseKeys(original);
    reordered.evaluator = reverseKeys(original.evaluator as Record<string, unknown>);
    reordered.normalized = reverseKeys(original.normalized as Record<string, unknown>);
    reordered.metrics = reverseKeys(original.metrics as Record<string, unknown>);
    await writeFile(file, JSON.stringify(reordered, null, 4));

    expect((await listOne()).status).toBe('verified');
  });

  it('rejects an edited surface CER', async () => {
    await seedSurface();
    await patchSurface((evaluation) => {
      (evaluation.metrics as Record<string, unknown>).cer = 0;
    });

    const entry = await listOne();
    expect(entry.status).toBe('rejected');
    if (entry.status === 'rejected') expect(entry.reason).toBe('EVALUATION_INTEGRITY_MISMATCH');
  });

  it('rejects an edited surface CER even when re-sealed', async () => {
    await seedSurface();
    await patchSurface((evaluation) => {
      const metrics = evaluation.metrics as Record<string, unknown>;
      metrics.cer = 0;
      metrics.edit_distance = 0;
      metrics.substitutions = 0;
      metrics.deletions = 0;
      metrics.insertions = 0;
      metrics.exact_match = true;
    }, true);

    const entry = await listOne();
    expect(entry.status).toBe('rejected');
    if (entry.status === 'rejected') expect(entry.reason).toBe('EVALUATION_METRICS_MISMATCH');
  });

  it('rejects an edited normalized hash even when re-sealed', async () => {
    await seedSurface();
    // The hash no longer describes what the profile produces from these bytes.
    await patchSurface((evaluation) => {
      const normalized = evaluation.normalized as {
        reference: Record<string, unknown>;
      };
      normalized.reference.sha256 = 'f'.repeat(64);
    }, true);

    const entry = await listOne();
    expect(entry.status).toBe('rejected');
    if (entry.status === 'rejected') {
      expect(entry.reason).toBe('EVALUATION_NORMALIZATION_MISMATCH');
    }
  });

  it('rejects an edited normalized length even when re-sealed', async () => {
    await seedSurface();
    await patchSurface((evaluation) => {
      const normalized = evaluation.normalized as {
        hypothesis: Record<string, unknown>;
      };
      normalized.hypothesis.chars = 1;
    }, true);

    const entry = await listOne();
    expect(entry.status).toBe('rejected');
    if (entry.status === 'rejected') {
      expect(entry.reason).toBe('EVALUATION_NORMALIZATION_MISMATCH');
    }
  });

  it('keeps the profile in one place only', async () => {
    const outcome = await seedSurface();
    // `evaluator.normalization_profile` is the single record of which
    // profile ran. `normalized` carries hashes and lengths, nothing that
    // could disagree with it.
    expect(outcome.evaluation.evaluator.normalization_profile).toBe('surface-normalize-v1');
    expect(Object.keys(outcome.evaluation.normalized).sort()).toEqual([
      'hypothesis',
      'reference',
    ]);

    const stored = JSON.parse(
      await readFile(evaluationStore.resolveEvaluationFile(EVALUATION_ID), 'utf8'),
    ) as { normalized: Record<string, unknown> };
    expect(stored.normalized.profile).toBeUndefined();
  });

  const SURFACE_EVALUATOR_EDITS: Array<[string, string]> = [
    ['id', 'normalized-char-v1'],
    ['unit', 'utf-16-code-unit'],
    ['normalization_profile', 'surface-normalize-v2'],
    ['width_mapping', 'nfkc-width-v1'],
    ['case_fold', 'unicode-lower-v1'],
    ['punctuation_aliases', 'punctuation-alias-v2'],
    ['space_policy', 'any-whitespace-collapse-v1'],
    ['line_break_policy', 'collapse-lf-v1'],
    ['distance', 'damerau-levenshtein-v1'],
  ];

  for (const [field, value] of SURFACE_EVALUATOR_EDITS) {
    it(`rejects an edited evaluator.${field} even when re-sealed`, async () => {
      await seedSurface();
      await patchSurface((evaluation) => {
        (evaluation.evaluator as Record<string, unknown>)[field] = value;
      }, true);

      const entry = await listOne();
      expect(entry.status).toBe('rejected');
      if (entry.status === 'rejected') expect(entry.reason).toBe('EVALUATION_EVALUATOR_MISMATCH');
    });
  }

  it('rejects an evaluator carrying a field this build has never heard of', async () => {
    await seedSurface();
    await patchSurface((evaluation) => {
      (evaluation.evaluator as Record<string, unknown>).case_policy = 'ascii-only-v1';
    }, true);

    const entry = await listOne();
    expect(entry.status).toBe('rejected');
    if (entry.status === 'rejected') expect(entry.reason).toBe('EVALUATION_EVALUATOR_MISMATCH');
  });

  it('rejects an Evaluation whose transcript changed underneath it', async () => {
    await seedSurface();
    await writeFile(
      resultStore.resolveResultFile(RESULT_ID, 'transcript.txt'),
      '書き換えられた書き起こし',
    );

    const entry = await listOne();
    expect(entry.status).toBe('rejected');
    if (entry.status === 'rejected') expect(entry.reason).toBe('RESULT_TRANSCRIPT_HASH_MISMATCH');
  });

  it('loadVerifiedEvaluation returns the normalized pair', async () => {
    await seedSurface();
    const verified = await loadVerifiedEvaluation(deps(), EVALUATION_ID);
    expect(verified.evaluation.schema_version).toBe(3);
    expect(verified.normalized).toEqual({
      reference: surfaceNormalize(SOURCE_TEXT),
      hypothesis: surfaceNormalize(WINDOWS_TRANSCRIPT),
    });
  });
});

describe('three evaluators share a root without disturbing each other', () => {
  const EVALUATION_ID_3 = '20260907T050002000Z-99998888';

  async function seedAllThree() {
    await writeRun();
    await saveSealedResult();
    await createRawCharEvaluation({ resultId: RESULT_ID }, deps({ evaluationId: EVALUATION_ID }));
    await createSurfaceCharEvaluation(
      { resultId: RESULT_ID },
      deps({ evaluationId: EVALUATION_ID_2 }),
    );
    await createCriticalInfoEvaluation(
      { resultId: RESULT_ID },
      deps({ evaluationId: EVALUATION_ID_3 }),
    );
  }

  it('lists one of each, all verified', async () => {
    await seedAllThree();

    const entries = await listEvaluationsForRun(deps(), RUN_ID);
    expect(entries.map((entry) => entry.status)).toEqual(['verified', 'verified', 'verified']);
    expect(
      entries.map((entry) => (entry.status === 'verified' ? entry.evaluation.evaluator.id : null)),
    ).toEqual(['raw-char-v1', 'surface-normalized-char-v1', 'critical-info-v1']);
  });

  it('reads each back with the verifier its own schema calls for', async () => {
    await seedAllThree();

    expect((await loadVerifiedEvaluation(deps(), EVALUATION_ID)).evaluation.schema_version).toBe(1);
    expect((await loadVerifiedEvaluation(deps(), EVALUATION_ID_2)).evaluation.schema_version).toBe(
      3,
    );
    expect((await loadVerifiedEvaluation(deps(), EVALUATION_ID_3)).evaluation.schema_version).toBe(
      2,
    );
  });

  it('never rewrites an existing P3-A or P3-B Evaluation', async () => {
    await writeRun();
    await saveSealedResult();
    await createRawCharEvaluation({ resultId: RESULT_ID }, deps({ evaluationId: EVALUATION_ID }));
    await createCriticalInfoEvaluation(
      { resultId: RESULT_ID },
      deps({ evaluationId: EVALUATION_ID_2 }),
    );

    const v1File = evaluationStore.resolveEvaluationFile(EVALUATION_ID);
    const v2File = evaluationStore.resolveEvaluationFile(EVALUATION_ID_2);
    const before = {
      v1: sha(new Uint8Array(await readFile(v1File))),
      v2: sha(new Uint8Array(await readFile(v2File))),
    };

    await createSurfaceCharEvaluation(
      { resultId: RESULT_ID },
      deps({ evaluationId: EVALUATION_ID_3 }),
    );
    await listEvaluationsForRun(deps(), RUN_ID);

    expect(sha(new Uint8Array(await readFile(v1File)))).toBe(before.v1);
    expect(sha(new Uint8Array(await readFile(v2File)))).toBe(before.v2);

    const storedV1 = JSON.parse(await readFile(v1File, 'utf8')) as Record<string, unknown>;
    const storedV2 = JSON.parse(await readFile(v2File, 'utf8')) as Record<string, unknown>;
    expect(storedV1.schema_version).toBe(1);
    expect(storedV1.normalized).toBeUndefined();
    expect(storedV2.schema_version).toBe(2);
    expect(storedV2.normalized).toBeUndefined();
  });

  it('does not fold the three artifacts into one envelope', async () => {
    // P3-C keeps three schemas rather than a generic wrapper. Merging them is a
    // question for the semantic architecture spike, not something to slip in.
    await seedAllThree();
    const shapes = await Promise.all(
      [EVALUATION_ID, EVALUATION_ID_2, EVALUATION_ID_3].map(async (id) =>
        JSON.parse(
          await readFile(evaluationStore.resolveEvaluationFile(id), 'utf8'),
        ) as Record<string, unknown>,
      ),
    );
    expect(shapes.map((shape) => shape.schema_version)).toEqual([1, 3, 2]);
    for (const shape of shapes) {
      expect(shape.envelope).toBeUndefined();
      expect(shape.payload).toBeUndefined();
    }
  });
});

describe('choosing the surface evaluator by name', () => {
  it('runs surface-normalized-char-v1 when asked for it', async () => {
    await writeRun();
    await saveSealedResult();
    const outcome = await createEvaluation(
      { resultId: RESULT_ID, evaluatorId: 'surface-normalized-char-v1' },
      deps({ evaluationId: EVALUATION_ID }),
    );
    expect(outcome.evaluation.schema_version).toBe(3);
    expect(outcome.evaluation.evaluator.id).toBe('surface-normalized-char-v1');
  });

  it('accepts exactly the three evaluators this build implements', () => {
    expect(isEvaluatorId('raw-char-v1')).toBe(true);
    expect(isEvaluatorId('surface-normalized-char-v1')).toBe(true);
    expect(isEvaluatorId('critical-info-v1')).toBe(true);
    expect(isEvaluatorId('normalized-char-v1')).toBe(false);
    expect(isEvaluatorId('surface-normalize-v1')).toBe(false);
  });
});
