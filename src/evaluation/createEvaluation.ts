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

export interface CreateEvaluationOutcome {
  evaluationId: string;
  evaluationDir: string;
  evaluation: EvaluationV1;
  referenceText: string;
  hypothesisText: string;
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
): Promise<CreateEvaluationOutcome> {
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
      evaluation: EvaluationV1;
      /** The exact texts the metrics were re-derived from, for side-by-side reading. */
      referenceText: string;
      hypothesisText: string;
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
      const evaluation = verifyStoredEvaluation({ evaluationId, stored, subject });
      entries.push({
        status: 'verified',
        evaluationId,
        evaluation,
        referenceText: subject.referenceText,
        hypothesisText: subject.hypothesisText,
      });
    } catch (caught) {
      entries.push(rejectionOf(evaluationId, resultId, caught));
    }
  }

  return entries.sort((a, b) => a.evaluationId.localeCompare(b.evaluationId));
}

export interface VerifiedEvaluation {
  evaluation: EvaluationV1;
  referenceText: string;
  hypothesisText: string;
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
  const evaluation = verifyStoredEvaluation({ evaluationId, stored, subject });

  return {
    evaluation,
    referenceText: subject.referenceText,
    hypothesisText: subject.hypothesisText,
  };
}
