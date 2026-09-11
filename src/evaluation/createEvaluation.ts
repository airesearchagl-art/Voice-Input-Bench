import { sha256OfText } from '@/lib/hash';
import { createEvaluationId } from '@/lib/evaluationId';
import { getSemanticEndpoint, getSemanticTimeoutMs } from '@/lib/engineConfig';
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
import {
  SEMANTIC_EVALUATION_SCHEMA_VERSION,
  SEMANTIC_H3_ALGORITHM,
  SEMANTIC_H3_EVALUATOR,
  SEMANTIC_REQUEST_CONTRACT,
  computeSemanticEvaluationSemanticSha256,
  type SemanticEvaluationPayloadV4,
  type SemanticEvaluationV4,
  type SemanticExecutionV4,
  type SemanticRunV4,
} from './semanticEvaluationSchema';
import {
  SEMANTIC_REQUEST_REPEATS,
  preflightSemanticProvider,
  semanticChat,
  type SemanticRuntimeFacts,
} from './semanticProvider';
import { normalizeSemanticInput, runSemanticCriticalGuard } from './semanticGuard';
import {
  buildSemanticRequestBody,
  parseSemanticVerdict,
  renderSemanticPrompt,
} from './semanticRubric';
import { deriveSemanticDecision, tallySemanticRuns } from './semanticDecision';
import { verifyStoredSemanticEvaluation } from './verifyStoredSemanticEvaluation';

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
  /**
   * The local model, injected so tests never reach a socket.
   *
   * Only semantic-h3-v1 uses it. Left out, it is the pinned Ollama provider
   * reading its endpoint from the environment — the client never gets to name
   * a runtime, a model or a prompt, here or anywhere else.
   */
  semanticRunner?: SemanticRunner;
}

/** The two calls semantic-h3-v1 makes, in the order it makes them. */
export interface SemanticRunner {
  preflight(): Promise<SemanticRuntimeFacts>;
  chat(requestBody: string): Promise<string>;
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
export type StoredEvaluation =
  | EvaluationV1
  | CriticalEvaluationV2
  | SurfaceEvaluationV3
  | SemanticEvaluationV4;

/** The evaluators a caller may ask for by name. */
export const EVALUATOR_IDS = [
  RAW_CHAR_ALGORITHM,
  SURFACE_CHAR_ALGORITHM,
  CRITICAL_INFO_ALGORITHM,
  SEMANTIC_H3_ALGORITHM,
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

export interface CreateSemanticEvaluationOutcome extends CreateEvaluationOutcome {
  evaluation: SemanticEvaluationV4;
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

/** The pinned Ollama provider, used whenever no runner was injected. */
const DEFAULT_SEMANTIC_RUNNER: SemanticRunner = {
  preflight: () =>
    preflightSemanticProvider({
      endpoint: getSemanticEndpoint(),
      timeoutMs: getSemanticTimeoutMs(),
    }),
  chat: (requestBody) =>
    semanticChat(requestBody, {
      endpoint: getSemanticEndpoint(),
      timeoutMs: getSemanticTimeoutMs(),
    }),
};

/** An empty execution record. Nothing was contacted, and it says so. */
const SKIPPED_BY_CRITICAL_VETO: SemanticExecutionV4 = {
  status: 'skipped_by_critical_veto',
  endpoint_class: null,
  provider_protocol: null,
  runtime: null,
  model: null,
  prompt: null,
  request_contract: null,
  runs: [],
};

/**
 * Ask the model the same question three times, recording each answer whole.
 *
 * A call that fails after preflight becomes an invalid run rather than an
 * exception: the failure is evidence about this evaluation, and dropping it
 * would leave two answers looking like a complete set. Three runs are always
 * attempted, because a run that was never made and a run that came back
 * unreadable have to be told apart by the record, not by its length.
 */
async function runSemanticModel(
  runner: SemanticRunner,
  facts: SemanticRuntimeFacts,
  normalizedReference: string,
  normalizedHypothesis: string,
): Promise<SemanticExecutionV4> {
  const requestBody = buildSemanticRequestBody(
    renderSemanticPrompt(normalizedReference, normalizedHypothesis),
  );
  const requestSha = sha256OfText(requestBody);
  const runs: SemanticRunV4[] = [];

  for (let runIndex = 1; runIndex <= SEMANTIC_REQUEST_REPEATS; runIndex += 1) {
    const startedAt = performance.now();
    let rawResponse = '';
    let transportError: string | null = null;
    try {
      rawResponse = await runner.chat(requestBody);
    } catch (caught) {
      transportError = caught instanceof Error ? caught.message : String(caught);
    }
    const latencyMs = Math.round(performance.now() - startedAt);

    const parsed = parseSemanticVerdict(rawResponse);
    runs.push({
      run_index: runIndex,
      latency_ms: latencyMs,
      request_sha256: requestSha,
      raw_response: rawResponse,
      raw_response_sha256: sha256OfText(rawResponse),
      raw_response_chars: toCodePoints(rawResponse).length,
      parseable_schema_valid: parsed.parseable_schema_valid,
      exact_output_contract_valid: parsed.exact_output_contract_valid,
      parsed_output: parsed.parsed_output,
      error: transportError ?? parsed.error,
    });
  }

  return {
    status: 'completed',
    endpoint_class: facts.endpoint_class,
    provider_protocol: facts.provider_protocol,
    runtime: facts.runtime,
    model: facts.model,
    prompt: facts.prompt,
    request_contract: SEMANTIC_REQUEST_CONTRACT,
    runs,
  };
}

/**
 * Evaluate whether a transcript still means what the source said.
 *
 * The order is the policy. The model reads the surface-normalized pair and the
 * guard reads the raw one, which is the composition P3-D-A adopted and not an
 * accident of plumbing. critical-info-v1 then runs as a hard
 * veto: a supported numeric mismatch is a change no rubric gets to argue with,
 * and it ends the evaluation before a single token is generated. Only if the
 * guard has nothing to say is the model asked, three times, and only three
 * parseable answers that all say the meaning changed produce `changed`.
 *
 * Everything else produces `review`. There is no path to `preserved`: the
 * decision type does not have one. A local 8B model agreeing with itself is not
 * evidence that meaning survived, and a bench that quietly said "fine" on that
 * basis would be worse than no bench at all.
 *
 * Preflight runs before anything is written, so a runtime or model that does
 * not match the approved contract produces an error and no artifact.
 */
export async function createSemanticEvaluation(
  input: { resultId: string },
  deps: EvaluationDeps,
): Promise<CreateSemanticEvaluationOutcome> {
  const now = deps.now ?? (() => new Date());

  assertIsolated(deps);

  const subject = await resolveEvaluationSubject(
    { runStore: deps.runStore, resultStore: deps.resultStore },
    input.resultId,
  );

  // Two input profiles, deliberately. The model reads the surface-normalized
  // pair; the guard reads the raw pair, which is the composition P3-D-A
  // adopted. They are not interchangeable: a full-width unit the extractor
  // cannot read raw becomes readable once folded, so running the guard on the
  // model's bytes would veto pairs the adopted evaluator sends to the model.
  const normalizedReference = normalizeSemanticInput(subject.referenceText);
  const normalizedHypothesis = normalizeSemanticInput(subject.hypothesisText);
  const critical = runSemanticCriticalGuard(subject.referenceText, subject.hypothesisText);

  let execution = SKIPPED_BY_CRITICAL_VETO;
  if (!critical.mismatch) {
    const runner = deps.semanticRunner ?? DEFAULT_SEMANTIC_RUNNER;
    // Fail Closed: a contract mismatch throws out of here, and no Evaluation
    // is written at all.
    const facts = await runner.preflight();
    execution = await runSemanticModel(
      runner,
      facts,
      normalizedReference.text,
      normalizedHypothesis.text,
    );
  }

  const decision = deriveSemanticDecision(
    critical.mismatch,
    critical.mismatch ? null : tallySemanticRuns(execution.runs, SEMANTIC_REQUEST_REPEATS),
  );

  const createdAt = now().toISOString();
  const evaluationId = deps.evaluationId ?? createEvaluationId(now());
  const rawChar = buildPayload(evaluationId, createdAt, subject);

  const payload: SemanticEvaluationPayloadV4 = {
    schema_version: SEMANTIC_EVALUATION_SCHEMA_VERSION,
    evaluation_id: evaluationId,
    created_at: createdAt,
    // Server-fixed, never from the request.
    evaluator: { ...SEMANTIC_H3_EVALUATOR },
    run_id: subject.runId,
    result_id: subject.resultId,
    // The subject and the raw input hashes are resolved identically for every
    // evaluator; only the reading differs.
    subject: rawChar.subject,
    reference: rawChar.reference,
    hypothesis: rawChar.hypothesis,
    run_evidence: rawChar.run_evidence,
    normalized: {
      reference: normalizedReference.side,
      hypothesis: normalizedHypothesis.side,
    },
    critical,
    execution,
    decision,
  };

  const evaluation: SemanticEvaluationV4 = {
    ...payload,
    integrity: {
      algorithm: 'sha256',
      semantic_sha256: computeSemanticEvaluationSemanticSha256(payload),
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
  if (input.evaluatorId === SEMANTIC_H3_ALGORITHM) {
    return createSemanticEvaluation({ resultId: input.resultId }, deps);
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
  if (input.stored.schema_version === SEMANTIC_EVALUATION_SCHEMA_VERSION) {
    return verifyStoredSemanticEvaluation(input);
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

    entries.push(await verifyEvaluationListEntry(deps, evaluationId, stored));
  }

  return entries.sort((a, b) => a.evaluationId.localeCompare(b.evaluationId));
}

/**
 * Verify one stored Evaluation, as the listing does.
 *
 * The listing's verdict for a single Evaluation, and the only place it is made:
 * `listEvaluationsForRun` uses it for every Evaluation it finds, and a Report
 * re-render uses it for exactly the Evaluation ids a ReportSource names, over
 * the exact bytes it just hashed. Never throws: anything that goes wrong is a
 * rejected entry. Readback only — no model is contacted here.
 */
export async function verifyEvaluationListEntry(
  deps: Pick<EvaluationDeps, 'runStore' | 'resultStore'>,
  evaluationId: string,
  stored: Record<string, unknown>,
): Promise<EvaluationListEntry> {
  const resultId = typeof stored.result_id === 'string' ? stored.result_id : undefined;

  try {
    const subject = await resolveEvaluationSubject(
      { runStore: deps.runStore, resultStore: deps.resultStore },
      resultId ?? '',
    );
    const evaluation = verifyByStoredSchema({ evaluationId, stored, subject });
    return {
      status: 'verified',
      evaluationId,
      evaluation,
      referenceText: subject.referenceText,
      hypothesisText: subject.hypothesisText,
      normalized: normalizedTextsFor(evaluation, subject),
    };
  } catch (caught) {
    return rejectionOf(evaluationId, resultId, caught);
  }
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
  // v3 measures the normalized pair and v4 shows the model the same pair, so
  // both need it on screen. v1 and v2 read the raw text and have none.
  if (
    evaluation.schema_version !== SURFACE_EVALUATION_SCHEMA_VERSION &&
    evaluation.schema_version !== SEMANTIC_EVALUATION_SCHEMA_VERSION
  ) {
    return undefined;
  }
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
