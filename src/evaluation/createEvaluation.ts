import { sha256OfText } from '@/lib/hash';
import { createEvaluationId } from '@/lib/evaluationId';
import { computeResultSemanticSha256, resultPayloadOf } from '@/results/resultSchema';
import { verifyRunEvidence } from '@/results/runEvidence';
import type { LocalEvaluationStore } from '@/storage/LocalEvaluationStore';
import type { LocalResultStore } from '@/storage/LocalResultStore';
import type { LocalRunStore } from '@/storage/LocalRunStore';
import type { LocalSessionStore } from '@/storage/LocalSessionStore';
import { assertStorageRootsIsolated } from '@/storage/rootIsolation';
import {
  EVALUATION_SCHEMA_VERSION,
  EVALUATION_SUBJECT_RESULT_SCHEMA_VERSION,
  RAW_CHAR_EVALUATOR,
  computeEvaluationSemanticSha256,
  type EvaluationPayloadV1,
  type EvaluationV1,
} from './evaluationSchema';
import {
  resolveEvaluationSubject,
  type EvaluationSubject,
} from './evaluationSubject';
import { evaluateRawChar, toCodePoints } from './rawChar';
import {
  EvaluationVerificationError,
  verifyStoredEvaluation,
} from './verifyStoredEvaluation';
import {
  CRITICAL_EVALUATION_SCHEMA_VERSION,
  CRITICAL_INFO_EVALUATOR,
  computeCriticalEvaluationSemanticSha256,
  toStoredEntity,
  toStoredMatch,
  type CriticalEvaluationPayloadV2,
  type CriticalEvaluationV2,
} from './criticalEvaluationSchema';
import { CRITICAL_INFO_ALGORITHM, analyzeCriticalInfo } from './criticalInfo';
import { RAW_CHAR_ALGORITHM } from './rawChar';
import { verifyStoredCriticalEvaluation } from './verifyStoredCriticalEvaluation';
import {
  SURFACE_CHAR_EVALUATOR,
  SURFACE_EVALUATION_SCHEMA_VERSION,
  computeSurfaceEvaluationSemanticSha256,
  type SurfaceEvaluationPayloadV3,
  type SurfaceEvaluationV3,
} from './surfaceEvaluationSchema';
import { SURFACE_CHAR_ALGORITHM, surfaceNormalize } from './surfaceNormalize';
import { verifyStoredSurfaceEvaluation } from './verifyStoredSurfaceEvaluation';

/**
 * Creating and reading raw character Evaluations.
 *
 * P3-A measures one thing: how far a transcript is from the canonical text,
 * character by character, with nothing forgiven. There is no ranking, no
 * winner, and no judgement about which tool is better — two Evaluations of the
 * same Run are two measurements, put next to each other for a person to read.
 */

export interface EvaluationDeps {
  runStore: LocalRunStore;
  resultStore: LocalResultStore;
  sessionStore: LocalSessionStore;
  evaluationStore: LocalEvaluationStore;
  /** Injected in tests so evaluation IDs and timestamps are deterministic. */
  now?: () => Date;
  evaluationId?: string;
}

/**
 * All four artifact trees must be disjoint before anything is read or written.
 *
 * This is where the fourth root earns its check: an evaluations root nested
 * inside `data/runs/` would put derived files inside an immutable Run Bundle.
 */
function assertIsolated(deps: EvaluationDeps): void {
  assertStorageRootsIsolated({
    runs: deps.runStore.rootDir,
    results: deps.resultStore.rootDir,
    sessions: deps.sessionStore.rootDir,
    evaluations: deps.evaluationStore.rootDir,
  });
}

function buildPayload(
  evaluationId: string,
  createdAt: string,
  subject: EvaluationSubject,
): EvaluationPayloadV1 {
  const metrics = evaluateRawChar(subject.referenceText, subject.hypothesisText);

  return {
    schema_version: EVALUATION_SCHEMA_VERSION,
    evaluation_id: evaluationId,
    created_at: createdAt,
    // Server-fixed, never from the request: the artifact has to record what
    // actually did the measuring.
    evaluator: {
      id: RAW_CHAR_EVALUATOR.id,
      unit: RAW_CHAR_EVALUATOR.unit,
      normalization: RAW_CHAR_EVALUATOR.normalization,
    },
    run_id: subject.runId,
    result_id: subject.resultId,
    subject: {
      result_schema_version: EVALUATION_SUBJECT_RESULT_SCHEMA_VERSION,
      tool: {
        id: subject.result.tool.id,
        name: subject.result.tool.name,
        version: subject.result.tool.version,
      },
      capture: {
        method: subject.result.capture.method,
        delivery_path: subject.result.capture.delivery_path,
      },
      result_semantic_sha256: computeResultSemanticSha256(resultPayloadOf(subject.result)),
    },
    reference: {
      file: 'run/source.txt',
      sha256: sha256OfText(subject.referenceText),
      chars: toCodePoints(subject.referenceText).length,
    },
    hypothesis: {
      file: 'result/transcript.txt',
      sha256: sha256OfText(subject.hypothesisText),
      chars: toCodePoints(subject.hypothesisText).length,
    },
    run_evidence: {
      manifest_schema_version: subject.runEvidence.manifestSchemaVersion,
      test_id: subject.runEvidence.testId,
      source_sha256: subject.runEvidence.sourceSha256,
      audio_sha256: subject.runEvidence.audioSha256,
    },
    metrics,
  };
}

/** Either shape, as written and as read back. Told apart by `schema_version`. */
export type StoredEvaluation = EvaluationV1 | CriticalEvaluationV2 | SurfaceEvaluationV3;

/** The evaluators a caller may ask for by name. */
export const EVALUATOR_IDS = [
  RAW_CHAR_ALGORITHM,
  SURFACE_CHAR_ALGORITHM,
  CRITICAL_INFO_ALGORITHM,
] as const;
export type EvaluatorId = (typeof EVALUATOR_IDS)[number];

export function isEvaluatorId(value: unknown): value is EvaluatorId {
  return EVALUATOR_IDS.some((id) => id === value);
}

export interface CreateEvaluationOutcome {
  evaluationId: string;
  evaluationDir: string;
  evaluation: StoredEvaluation;
  referenceText: string;
  hypothesisText: string;
}

/** The same outcome, narrowed to the evaluator that produced it. */
export interface CreateRawCharEvaluationOutcome extends CreateEvaluationOutcome {
  evaluation: EvaluationV1;
}

export interface CreateCriticalEvaluationOutcome extends CreateEvaluationOutcome {
  evaluation: CriticalEvaluationV2;
}

export interface CreateSurfaceEvaluationOutcome extends CreateEvaluationOutcome {
  evaluation: SurfaceEvaluationV3;
}

/**
 * Evaluate one sealed Result against its Run's canonical text.
 *
 * The caller names a Result and nothing else. Which Run, which text, which
 * tool — all of it is resolved from disk and verified first, so the numbers
 * that get stored are about artifacts that demonstrably exist and still hash to
 * what they claim.
 *
 * The Run and the Result are only read. Nothing here writes outside
 * `data/evaluations/`.
 */
export async function createRawCharEvaluation(
  input: { resultId: string },
  deps: EvaluationDeps,
): Promise<CreateRawCharEvaluationOutcome> {
  const now = deps.now ?? (() => new Date());

  assertIsolated(deps);

  const subject = await resolveEvaluationSubject(
    { runStore: deps.runStore, resultStore: deps.resultStore },
    input.resultId,
  );

  const createdAt = now().toISOString();
  const evaluationId = deps.evaluationId ?? createEvaluationId(now());
  const payload = buildPayload(evaluationId, createdAt, subject);

  const evaluation: EvaluationV1 = {
    ...payload,
    integrity: {
      algorithm: 'sha256',
      semantic_sha256: computeEvaluationSemanticSha256(payload),
    },
  };

  const stored = await deps.evaluationStore.saveEvaluation(
    evaluationId,
    Buffer.from(`${JSON.stringify(evaluation, null, 2)}\n`, 'utf8'),
  );

  return {
    evaluationId: stored.evaluationId,
    evaluationDir: stored.evaluationDir,
    evaluation,
    referenceText: subject.referenceText,
    hypothesisText: subject.hypothesisText,
  };
}

function buildCriticalPayload(
  evaluationId: string,
  createdAt: string,
  subject: EvaluationSubject,
): CriticalEvaluationPayloadV2 {
  const analysis = analyzeCriticalInfo(subject.referenceText, subject.hypothesisText);
  const rawChar = buildPayload(evaluationId, createdAt, subject);

  return {
    schema_version: CRITICAL_EVALUATION_SCHEMA_VERSION,
    evaluation_id: evaluationId,
    created_at: createdAt,
    // Server-fixed, never from the request: the artifact has to record the
    // full semantics it was measured under, not just a name.
    evaluator: { ...CRITICAL_INFO_EVALUATOR },
    run_id: subject.runId,
    result_id: subject.resultId,
    // The subject and the input hashes are resolved identically for both
    // evaluators; only the measurement differs.
    subject: rawChar.subject,
    reference: rawChar.reference,
    hypothesis: rawChar.hypothesis,
    run_evidence: rawChar.run_evidence,
    entities: {
      reference: analysis.referenceEntities.map(toStoredEntity),
      hypothesis: analysis.hypothesisEntities.map(toStoredEntity),
    },
    matches: analysis.matches.map(toStoredMatch),
    missing: analysis.missing.map(toStoredEntity),
    extra: analysis.extra.map(toStoredEntity),
    metrics: analysis.metrics,
  };
}

/**
 * Evaluate one sealed Result for critical information preservation.
 *
 * Same evidence chain as raw-char-v1 — the Result names its Run, the Run is
 * verified from disk, the Result is checked against that verification — and a
 * different question asked of the same two texts: not how far the characters
 * drifted, but which facts came through.
 */
export async function createCriticalInfoEvaluation(
  input: { resultId: string },
  deps: EvaluationDeps,
): Promise<CreateCriticalEvaluationOutcome> {
  const now = deps.now ?? (() => new Date());

  assertIsolated(deps);

  const subject = await resolveEvaluationSubject(
    { runStore: deps.runStore, resultStore: deps.resultStore },
    input.resultId,
  );

  const createdAt = now().toISOString();
  const evaluationId = deps.evaluationId ?? createEvaluationId(now());
  const payload = buildCriticalPayload(evaluationId, createdAt, subject);

  const evaluation: CriticalEvaluationV2 = {
    ...payload,
    integrity: {
      algorithm: 'sha256',
      semantic_sha256: computeCriticalEvaluationSemanticSha256(payload),
    },
  };

  const stored = await deps.evaluationStore.saveEvaluation(
    evaluationId,
    Buffer.from(`${JSON.stringify(evaluation, null, 2)}\n`, 'utf8'),
  );

  return {
    evaluationId: stored.evaluationId,
    evaluationDir: stored.evaluationDir,
    evaluation,
    referenceText: subject.referenceText,
    hypothesisText: subject.hypothesisText,
  };
}

function buildSurfacePayload(
  evaluationId: string,
  createdAt: string,
  subject: EvaluationSubject,
): SurfaceEvaluationPayloadV3 {
  const rawChar = buildPayload(evaluationId, createdAt, subject);
  const normalizedReference = surfaceNormalize(subject.referenceText);
  const normalizedHypothesis = surfaceNormalize(subject.hypothesisText);

  return {
    schema_version: SURFACE_EVALUATION_SCHEMA_VERSION,
    evaluation_id: evaluationId,
    created_at: createdAt,
    // Server-fixed, never from the request.
    evaluator: { ...SURFACE_CHAR_EVALUATOR },
    run_id: subject.runId,
    result_id: subject.resultId,
    // The subject and the raw input hashes are resolved identically for every
    // evaluator; only the measurement differs.
    subject: rawChar.subject,
    reference: rawChar.reference,
    hypothesis: rawChar.hypothesis,
    run_evidence: rawChar.run_evidence,
    normalized: {
      reference: {
        sha256: sha256OfText(normalizedReference),
        chars: toCodePoints(normalizedReference).length,
      },
      hypothesis: {
        sha256: sha256OfText(normalizedHypothesis),
        chars: toCodePoints(normalizedHypothesis).length,
      },
    },
    metrics: evaluateRawChar(normalizedReference, normalizedHypothesis),
  };
}

/**
 * Evaluate one sealed Result after setting typography aside.
 *
 * Same evidence chain and the same Levenshtein comparison as raw-char-v1, run
 * over text that surface-normalize-v1 has folded. What comes out is a second
 * reading of the same pair, not a correction of the first: both are stored, and
 * neither replaces the other.
 */
export async function createSurfaceCharEvaluation(
  input: { resultId: string },
  deps: EvaluationDeps,
): Promise<CreateSurfaceEvaluationOutcome> {
  const now = deps.now ?? (() => new Date());

  assertIsolated(deps);

  const subject = await resolveEvaluationSubject(
    { runStore: deps.runStore, resultStore: deps.resultStore },
    input.resultId,
  );

  const createdAt = now().toISOString();
  const evaluationId = deps.evaluationId ?? createEvaluationId(now());
  const payload = buildSurfacePayload(evaluationId, createdAt, subject);

  const evaluation: SurfaceEvaluationV3 = {
    ...payload,
    integrity: {
      algorithm: 'sha256',
      semantic_sha256: computeSurfaceEvaluationSemanticSha256(payload),
    },
  };

  const stored = await deps.evaluationStore.saveEvaluation(
    evaluationId,
    Buffer.from(`${JSON.stringify(evaluation, null, 2)}\n`, 'utf8'),
  );

  return {
    evaluationId: stored.evaluationId,
    evaluationDir: stored.evaluationDir,
    evaluation,
    referenceText: subject.referenceText,
    hypothesisText: subject.hypothesisText,
  };
}

/**
 * Evaluate one sealed Result with the named evaluator.
 *
 * The name is matched against a closed list. An unknown evaluator is refused
 * rather than defaulted: silently measuring something other than what was asked
 * for would store a number under the wrong heading.
 */
export async function createEvaluation(
  input: { resultId: string; evaluatorId: EvaluatorId },
  deps: EvaluationDeps,
): Promise<CreateEvaluationOutcome> {
  if (input.evaluatorId === CRITICAL_INFO_ALGORITHM) {
    return createCriticalInfoEvaluation({ resultId: input.resultId }, deps);
  }
  if (input.evaluatorId === SURFACE_CHAR_ALGORITHM) {
    return createSurfaceCharEvaluation({ resultId: input.resultId }, deps);
  }
  return createRawCharEvaluation({ resultId: input.resultId }, deps);
}

/**
 * A stored Evaluation as the UI lists it.
 *
 * A failed one is reported rather than dropped: an Evaluation that no longer
 * reproduces is something the operator needs to see, and showing it as a
 * problem is not the same as showing it as a measurement.
 */
export type EvaluationListEntry =
  | {
      status: 'verified';
      evaluationId: string;
      evaluation: StoredEvaluation;
      /** The exact texts the metrics were re-derived from, for side-by-side reading. */
      referenceText: string;
      hypothesisText: string;
      /**
       * The same two texts after the profile ran. Present only for an evaluator
       * that normalizes, so the reader can see what was actually compared
       * rather than take the CER on trust.
       */
      normalized?: NormalizedTexts;
    }
  | {
      status: 'rejected';
      evaluationId: string;
      resultId?: string;
      reason: string;
      message: string;
      detail?: string;
    };

function rejectionOf(evaluationId: string, resultId: string | undefined, caught: unknown) {
  if (caught instanceof EvaluationVerificationError) {
    return {
      status: 'rejected' as const,
      evaluationId,
      resultId,
      reason: caught.kind,
      message: caught.message,
      detail: caught.detail,
    };
  }
  const kind =
    typeof caught === 'object' && caught !== null && 'kind' in caught
      ? String((caught as { kind: unknown }).kind)
      : 'UNEXPECTED';
  return {
    status: 'rejected' as const,
    evaluationId,
    resultId,
    reason: kind,
    message: caught instanceof Error ? caught.message : String(caught),
    detail:
      typeof caught === 'object' && caught !== null && 'detail' in caught
        ? ((caught as { detail?: string }).detail ?? undefined)
        : undefined,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Verify a stored Evaluation with the verifier its own schema calls for.
 *
 * `schema_version` decides, not anything the caller wants: v1 is a raw-char-v1
 * Evaluation and v2 a critical-info-v1 one. Reading either with the other's
 * verifier would recompute the wrong measurement and then complain that it does
 * not match.
 */
function verifyByStoredSchema(input: {
  evaluationId: string;
  stored: Record<string, unknown>;
  subject: EvaluationSubject;
}): StoredEvaluation {
  if (input.stored.schema_version === CRITICAL_EVALUATION_SCHEMA_VERSION) {
    return verifyStoredCriticalEvaluation(input);
  }
  if (input.stored.schema_version === SURFACE_EVALUATION_SCHEMA_VERSION) {
    return verifyStoredSurfaceEvaluation(input);
  }
  return verifyStoredEvaluation(input);
}

/**
 * Evaluations attached to one Run, oldest first.
 *
 * The Run is verified once before any Evaluation is considered; if it does not
 * verify, the whole listing fails rather than reporting numbers about a Run
 * whose artifacts no longer match its manifest.
 *
 * Filtering is on the stored `run_id`, so an Evaluation can never be listed
 * under a Run it does not name.
 */
export async function listEvaluationsForRun(
  deps: EvaluationDeps,
  runId: string,
): Promise<EvaluationListEntry[]> {
  assertIsolated(deps);

  // Fail Closed on the Run itself before anything derived from it is shown.
  await verifyRunEvidence(deps.runStore, runId);

  const entries: EvaluationListEntry[] = [];

  for (const evaluationId of await deps.evaluationStore.listEvaluationIds()) {
    let stored: unknown;
    try {
      stored = await deps.evaluationStore.readEvaluation(evaluationId);
    } catch {
      // Not a readable Evaluation directory. Skipped rather than breaking the
      // whole listing.
      continue;
    }

    // Only Evaluations that claim this Run are this listing's business.
    if (!isPlainObject(stored) || stored.run_id !== runId) continue;

    const resultId = typeof stored.result_id === 'string' ? stored.result_id : undefined;

    try {
      const subject = await resolveEvaluationSubject(
        { runStore: deps.runStore, resultStore: deps.resultStore },
        resultId ?? '',
      );
      const evaluation = verifyByStoredSchema({ evaluationId, stored, subject });
      entries.push({
        status: 'verified',
        evaluationId,
        evaluation,
        referenceText: subject.referenceText,
        hypothesisText: subject.hypothesisText,
        normalized: normalizedTextsFor(evaluation, subject),
      });
    } catch (caught) {
      entries.push(rejectionOf(evaluationId, resultId, caught));
    }
  }

  return entries.sort((a, b) => a.evaluationId.localeCompare(b.evaluationId));
}

export interface NormalizedTexts {
  reference: string;
  hypothesis: string;
}

/**
 * The normalized pair, for an evaluation that normalized before comparing.
 *
 * Derived at read time from the same bytes readback just verified, rather than
 * stored: the artifact keeps the hashes, and anything shown next to them has to
 * be reproducible from the source rather than carried alongside it.
 */
function normalizedTextsFor(
  evaluation: StoredEvaluation,
  subject: EvaluationSubject,
): NormalizedTexts | undefined {
  if (evaluation.schema_version !== SURFACE_EVALUATION_SCHEMA_VERSION) return undefined;
  return {
    reference: surfaceNormalize(subject.referenceText),
    hypothesis: surfaceNormalize(subject.hypothesisText),
  };
}

export interface VerifiedEvaluation {
  evaluation: StoredEvaluation;
  referenceText: string;
  hypothesisText: string;
  normalized?: NormalizedTexts;
}

/**
 * Read one Evaluation and re-derive it.
 *
 * Throws rather than returning something partial: an Evaluation that cannot be
 * reproduced is not a weaker measurement, it is not a measurement.
 */
export async function loadVerifiedEvaluation(
  deps: EvaluationDeps,
  evaluationId: string,
): Promise<VerifiedEvaluation> {
  assertIsolated(deps);

  const stored = await deps.evaluationStore.readEvaluation(evaluationId);
  if (!isPlainObject(stored) || typeof stored.result_id !== 'string') {
    throw new EvaluationVerificationError(
      'EVALUATION_MALFORMED',
      evaluationId,
      'evaluation.json が result_id を持つオブジェクトではありません。',
    );
  }

  const subject = await resolveEvaluationSubject(
    { runStore: deps.runStore, resultStore: deps.resultStore },
    stored.result_id,
  );
  const evaluation = verifyByStoredSchema({ evaluationId, stored, subject });

  return {
    evaluation,
    referenceText: subject.referenceText,
    hypothesisText: subject.hypothesisText,
    normalized: normalizedTextsFor(evaluation, subject),
  };
}
