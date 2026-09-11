import {
  EVALUATOR_IDS,
  listEvaluationsForRun,
  type EvaluationDeps,
  type EvaluationListEntry,
  type EvaluatorId,
  type StoredEvaluation,
} from '@/evaluation/createEvaluation';
import { CRITICAL_EVALUATION_SCHEMA_VERSION } from '@/evaluation/criticalEvaluationSchema';
import { EVALUATION_SCHEMA_VERSION } from '@/evaluation/evaluationSchema';
import { RAW_CHAR_ALGORITHM } from '@/evaluation/rawChar';
import { CRITICAL_INFO_ALGORITHM } from '@/evaluation/criticalInfo';
import { SURFACE_CHAR_ALGORITHM } from '@/evaluation/surfaceNormalize';
import { SURFACE_EVALUATION_SCHEMA_VERSION } from '@/evaluation/surfaceEvaluationSchema';
import {
  SEMANTIC_EVALUATION_SCHEMA_VERSION,
  SEMANTIC_H3_ALGORITHM,
  type SemanticCriticalStatus,
  type SemanticExecutionStatus,
} from '@/evaluation/semanticEvaluationSchema';
import {
  tallySemanticRuns,
  type SemanticDecisionSource,
  type SemanticDecisionValue,
} from '@/evaluation/semanticDecision';
import { listResultsForRun, type ResultListEntry } from '@/results/saveResult';
import { verifyRunEvidence, type VerifiedRunEvidence } from '@/results/runEvidence';
import type { IntegrityTrust } from '@/results/resultSchema';
import { STT_TOOL_IDS, type DeliveryPath, type SttToolId } from '@/results/tools';

/**
 * Run Comparison — one canonical Run, and everything observed under it.
 *
 * Derived on every request from the production read path and never stored:
 * whether an artifact verifies is a property of the current verifier, not of the
 * artifact, so a stored comparison saying `verified` would age into a false
 * claim without a byte changing (P4-A `recommended-architecture.md`).
 *
 * The one rule applied everywhere below: an artifact that failed verification
 * is never filed where its own claims would put it.
 *
 * - Tool groups hold sealed Results only, and a rejected one only when a seal
 *   backs a built-in `trustedToolId`.
 * - Evaluator groups hold verified Evaluations only. A rejected
 *   `EvaluationListEntry` carries no evaluator id at all, so there is never a
 *   trustworthy evaluator to file one under.
 * - Nothing is dropped for lacking a home. Every Result and every Evaluation the
 *   listings return appears in exactly one container.
 *
 * No score, no ranking, no winner. The four evaluators stay four readings.
 */

// ── Tool identity ───────────────────────────────────────────────────────────

/** The tools whose identity is their id. `other` is a bucket, not a tool. */
export type BuiltInToolId = Exclude<SttToolId, 'other'>;

export type ToolIdentity =
  | { kind: 'built-in'; id: BuiltInToolId }
  /** Identity is `(id, trusted_name)`. The name only ever comes from a verified seal. */
  | { kind: 'custom'; id: 'other'; trusted_name: string };

export interface ComparisonToolGroup {
  tool: ToolIdentity;
  /** Siblings, `result_id` ascending. None is promoted to latest or current. */
  results: ComparisonResult[];
}

// ── Evaluation entries and per-schema summaries ─────────────────────────────

export interface RawSummary {
  kind: typeof RAW_CHAR_ALGORITHM;
  exact_match: boolean;
  cer: number;
  edit_distance: number;
  substitutions: number;
  deletions: number;
  insertions: number;
  reference_chars: number;
  hypothesis_chars: number;
}

export interface SurfaceSummary {
  kind: typeof SURFACE_CHAR_ALGORITHM;
  exact_match: boolean;
  cer: number;
  edit_distance: number;
  substitutions: number;
  deletions: number;
  insertions: number;
  normalized: {
    reference: { sha256: string; chars: number };
    hypothesis: { sha256: string; chars: number };
  };
}

export interface CriticalSummary {
  kind: typeof CRITICAL_INFO_ALGORITHM;
  exact_entity_multiset_match: boolean;
  preservation_rate: number;
  reference_entities: number;
  hypothesis_entities: number;
  matched: number;
  missing: number;
  extra: number;
  /** Canonical keys only, in stored order — enough to audit. */
  missing_keys: string[];
  extra_keys: string[];
}

export interface SemanticSummary {
  kind: typeof SEMANTIC_H3_ALGORITHM;
  /** Exactly the production vocabulary. There is no third value. */
  decision: SemanticDecisionValue;
  decision_by: SemanticDecisionSource;
  critical_guard: { status: SemanticCriticalStatus; applicable: boolean; mismatch: boolean };
  execution: {
    status: SemanticExecutionStatus;
    /** Zero on the Critical-veto route: the model was never asked, nothing is missing. */
    runs_recorded: number;
    runs_parseable: number;
    runs_exact_format: number;
    full_run_unanimous: boolean;
    changed_votes: number;
    preserved_votes: number;
  };
  /** Null on the Critical-veto route, where no runtime was contacted. */
  model: {
    runtime_version: string;
    model_id: string;
    model_digest: string;
    prompt_id: string;
    prompt_sha256: string;
  } | null;
}

export type EvaluationSummary = RawSummary | SurfaceSummary | CriticalSummary | SemanticSummary;

/** Verified by the current verifier. Everything here came through readback. */
export interface ComparisonVerifiedEvaluation {
  status: 'verified';
  evaluation_id: string;
  evaluator_id: EvaluatorId;
  schema_version: StoredEvaluation['schema_version'];
  created_at: string;
  result_id: string;
  /** One variant per schema; never a merged score. */
  summary: EvaluationSummary;
}

/**
 * Did not verify. Carried verbatim from the verifier.
 *
 * There is no evaluator id, schema version or creation time: the rejected
 * listing entry has none, and the claims inside a failed file are not promoted
 * to attributions after the fact.
 */
export interface ComparisonRejectedEvaluation {
  status: 'rejected';
  evaluation_id: string;
  evaluator_id: null;
  schema_version: null;
  created_at: null;
  /**
   * The Result id the rejected file names, as the listing reported it, or null
   * when it names none. Used only to decide which Result it sits beside.
   */
  named_result_id: string | null;
  reason: string;
  message: string;
  detail?: string;
}

export type ComparisonEvaluationEntry = ComparisonVerifiedEvaluation | ComparisonRejectedEvaluation;

// ── Evaluator groups ────────────────────────────────────────────────────────

export type SelectionReason =
  | 'only-verified-entry-v1'
  | 'newest-verified-by-id-v1'
  | 'conflict-no-headline-v1';

export interface GroupEvidenceState {
  /** Verified entries only. `missing` is not zero, not a failure, not a pass. */
  availability: 'available' | 'missing';
  verified_count: number;
  /** A selection happened among more than one verified entry. */
  multiple_candidates: boolean;
  /** The verified entries disagree. No headline is published. */
  conflicting_evidence: boolean;
}

export interface ComparisonEvaluationGroup {
  evaluator_id: EvaluatorId;
  schema_version: StoredEvaluation['schema_version'];
  /** Verified entries only, `evaluation_id` ascending. */
  entries: ComparisonVerifiedEvaluation[];
  /** Null when nothing verified, and null on conflict. */
  headline: ComparisonVerifiedEvaluation | null;
  selection_reason: SelectionReason | null;
  state: GroupEvidenceState;
}

// ── Results ─────────────────────────────────────────────────────────────────

export interface ResultCompleteness {
  state: 'complete' | 'partial';
  /** Evaluators with at least one verified entry, in `EVALUATOR_IDS` order. */
  evaluators_present: EvaluatorId[];
  /** Evaluators with none, in `EVALUATOR_IDS` order. */
  evaluators_missing: EvaluatorId[];
  /** Rejected Evaluations naming this Result. No evaluator is inferred for them. */
  unclassified_rejected_count: number;
}

/** Sealed and verified. Everything below came through verification. */
export interface ComparisonVerifiedResult {
  kind: 'verified';
  result_id: string;
  captured_at: string;
  /** Per Result: a tool's version can change between captures under one Run. */
  tool: { id: SttToolId; name: string; version: string | null };
  capture: { method: 'manual-paste'; delivery_path: DeliveryPath };
  integrity_trust: 'sealed';
  transcript: string;
  transcript_sha256: string;
  /** One group per evaluator in `EVALUATOR_IDS` order, including empty ones. */
  evaluations: ComparisonEvaluationGroup[];
  /** Rejected Evaluations naming this Result. No evaluator is inferred. */
  unclassified_rejected_evaluations: ComparisonRejectedEvaluation[];
  completeness: ResultCompleteness;
}

/**
 * Rejected, but a seal backs its built-in tool id — so it belongs in that column.
 *
 * Exactly the fields the rejected listing entry can supply. No `captured_at`,
 * no `capture`, no `tool.version`, no transcript: a Result whose check failed
 * cannot vouch for any of them, and they are not read back from the raw file.
 */
export interface ComparisonRejectedResult {
  kind: 'rejected';
  result_id: string;
  /** Built-in ids only, by type: a rejected `other` has no trusted name. */
  trusted_tool_id: BuiltInToolId;
  integrity_trust: 'sealed';
  reason: string;
  message: string;
  detail?: string;
  /** Evaluations naming this Result. Kept, not dropped. */
  verified_evaluations: ComparisonVerifiedEvaluation[];
  unclassified_rejected_evaluations: ComparisonRejectedEvaluation[];
}

export type ComparisonResult = ComparisonVerifiedResult | ComparisonRejectedResult;

/**
 * Unsealed but intact. Shown at Run level, never inside a tool group.
 *
 * The tool fields are named `claimed_*` on purpose: they are readable, and
 * nothing proves they were not edited after the fact.
 */
export interface ComparisonVerifiedLegacyResult {
  kind: 'legacy-unsealed-verified';
  result_id: string;
  claimed_tool_id: SttToolId;
  claimed_tool_name: string;
  claimed_tool_version: string | null;
  tool_claim_is_unverified: true;
  transcript: string;
  verified_evaluations: ComparisonVerifiedEvaluation[];
  unclassified_rejected_evaluations: ComparisonRejectedEvaluation[];
}

/**
 * Unsealed and did not read back. No tool claim at all — not even a `claimed_*`
 * one: the tool section may be what failed, and no seal stands behind it.
 */
export interface ComparisonRejectedLegacyResult {
  kind: 'legacy-unsealed-rejected';
  result_id: string;
  reason: string;
  message: string;
  detail?: string;
  verified_evaluations: ComparisonVerifiedEvaluation[];
  unclassified_rejected_evaluations: ComparisonRejectedEvaluation[];
}

export type ComparisonLegacyResult = ComparisonVerifiedLegacyResult | ComparisonRejectedLegacyResult;

export type UnattributedReasonClass =
  /** Its tool id may be well-formed, but no verified seal stands behind it. */
  | 'no-seal'
  /** The tool contract itself failed: no tool id survived at all. */
  | 'tool-identity-unverified'
  /** Sealed and `other`, but the custom tool's name — its identity — is not exposed. */
  | 'custom-tool-identity-unavailable';

/** A rejected Result whose tool identity did not survive verification. */
export interface UnattributedResult {
  result_id: string;
  reason_class: UnattributedReasonClass;
  reason: string;
  message: string;
  detail?: string;
  integrity_trust: IntegrityTrust | null;
  /** Evaluations naming this Result, kept as evidence that work was done against it. */
  related_verified_evaluations: ComparisonVerifiedEvaluation[];
  related_rejected_evaluations: ComparisonRejectedEvaluation[];
}

// ── Run ─────────────────────────────────────────────────────────────────────

export interface RunCompleteness {
  /**
   * `complete` only when at least one sealed verified Result exists, every one
   * of them has verified evidence from every evaluator, and nothing sits in a
   * rejected tool slot or an unattributed container. Legacy Results do not
   * decide it: nothing is expected of them.
   */
  state: 'complete' | 'partial';
  sealed_verified_results: number;
  /**
   * Every rejected Result whose readback still vouches for its seal
   * (`integrity_trust === 'sealed'`), wherever it was placed: in a built-in
   * tool group, or in `unattributed_results` when it is a custom `other` whose
   * name is not exposed. Where a Result lands does not change what it is.
   */
  sealed_rejected_results: number;
  legacy_unsealed_results: number;
  unattributed_results: number;
  unattributed_rejected_evaluations: number;
  unattributed_verified_evaluations: number;
  /** Sealed verified Results with no verified Evaluation from any evaluator. */
  results_with_no_verified_evaluations: number;
}

export const COMPARISON_ORDERING = {
  tools: 'stt-tool-ids-declared-order-then-trusted-name-v1',
  results: 'result-id-ascending-v1',
  evaluators: 'evaluator-ids-declared-order-v1',
  evaluations: 'evaluation-id-ascending-v1',
  headline: 'newest-verified-by-id-v1',
  unattributed: 'artifact-id-ascending-v1',
} as const;

/** One canonical Run, and everything observed under it. Derived, never stored. */
export interface ComparisonRun {
  run_id: string;
  test_id: string;
  evidence: {
    manifest_schema_version: number;
    source_sha256: string;
    audio_sha256: string;
    generated_at: string;
    segment_count: number;
  };
  /** `EVALUATOR_IDS`, as declared — the row order every evaluator list follows. */
  evaluator_ids: EvaluatorId[];
  /** Trusted tool evidence only. */
  tools: ComparisonToolGroup[];
  /** Unsealed Results. Real observations, never counted as tool evidence. */
  legacy_unsealed_results: ComparisonLegacyResult[];
  /** Rejected Results whose tool identity did not survive verification. */
  unattributed_results: UnattributedResult[];
  /** Rejected Evaluations naming no Result of this Run. */
  unattributed_rejected_evaluations: ComparisonRejectedEvaluation[];
  /**
   * Verified Evaluations naming a Result this Run's listing does not contain.
   * Not expected — readback resolves the Result it measured — but kept rather
   * than dropped if the two listings ever disagree.
   */
  unattributed_verified_evaluations: ComparisonVerifiedEvaluation[];
  completeness: RunCompleteness;
  ordering: typeof COMPARISON_ORDERING;
}

// ── Building ────────────────────────────────────────────────────────────────

export type RunComparisonDeps = Pick<
  EvaluationDeps,
  'runStore' | 'resultStore' | 'sessionStore' | 'evaluationStore'
>;

/**
 * `(runId) -> ComparisonRun`, from the production read path only.
 *
 * The Run is verified first, and each listing verifies it again. Any failure
 * throws, and the comparison fails as a whole: no Result or Evaluation about a
 * Run whose own artifacts no longer match its manifest is shown partially.
 */
export async function buildRunComparison(
  deps: RunComparisonDeps,
  runId: string,
): Promise<ComparisonRun> {
  const runEvidence = await verifyRunEvidence(deps.runStore, runId);
  const results = await listResultsForRun(deps, runId);
  const evaluations = await listEvaluationsForRun(deps, runId);
  return assembleRunComparison({ runEvidence, results, evaluations });
}

export interface RunComparisonInput {
  runEvidence: VerifiedRunEvidence;
  results: readonly ResultListEntry[];
  evaluations: readonly EvaluationListEntry[];
}

/**
 * The pure half: group, select, flag and order what the listings returned.
 *
 * Reads nothing and writes nothing, and never looks inside a rejected entry for
 * a claim the entry itself does not carry.
 */
export function assembleRunComparison(input: RunComparisonInput): ComparisonRun {
  const { runEvidence } = input;

  // Every Evaluation, bucketed by the Result it names. Buckets are consumed as
  // Results claim them; whatever is left names no Result of this Run.
  const buckets = new Map<string, EvaluationBucket>();
  const bucketFor = (resultId: string): EvaluationBucket => {
    const existing = buckets.get(resultId);
    if (existing) return existing;
    const created: EvaluationBucket = { verified: [], rejected: [] };
    buckets.set(resultId, created);
    return created;
  };
  const namesNoResult: ComparisonRejectedEvaluation[] = [];
  for (const entry of input.evaluations) {
    const converted = toComparisonEvaluation(entry);
    if (converted.status === 'verified') {
      bucketFor(converted.result_id).verified.push(converted);
    } else if (converted.named_result_id === null) {
      namesNoResult.push(converted);
    } else {
      bucketFor(converted.named_result_id).rejected.push(converted);
    }
  }

  const takeBucket = (resultId: string): EvaluationBucket => {
    const bucket = buckets.get(resultId) ?? { verified: [], rejected: [] };
    buckets.delete(resultId);
    return {
      verified: sortByEvaluationId(bucket.verified),
      rejected: sortByEvaluationId(bucket.rejected),
    };
  };

  const toolGroups = new Map<string, ComparisonToolGroup>();
  const legacy: ComparisonLegacyResult[] = [];
  const unattributed: UnattributedResult[] = [];

  const placeInTool = (tool: ToolIdentity, result: ComparisonResult) => {
    const key = toolKey(tool);
    const group = toolGroups.get(key) ?? { tool, results: [] };
    group.results.push(result);
    toolGroups.set(key, group);
  };

  for (const entry of [...input.results].sort((a, b) => compareIds(a.resultId, b.resultId))) {
    const bucket = takeBucket(entry.resultId);

    // Unsealed, in either readback state. Never tool evidence.
    if (entry.integrityTrust === 'legacy-unsealed') {
      legacy.push(
        entry.status === 'verified'
          ? {
              kind: 'legacy-unsealed-verified',
              result_id: entry.resultId,
              claimed_tool_id: entry.result.tool.id,
              claimed_tool_name: entry.result.tool.name,
              claimed_tool_version: entry.result.tool.version,
              tool_claim_is_unverified: true,
              transcript: entry.transcript,
              verified_evaluations: bucket.verified,
              unclassified_rejected_evaluations: bucket.rejected,
            }
          : {
              kind: 'legacy-unsealed-rejected',
              result_id: entry.resultId,
              reason: entry.reason,
              message: entry.message,
              ...(entry.detail === undefined ? {} : { detail: entry.detail }),
              verified_evaluations: bucket.verified,
              unclassified_rejected_evaluations: bucket.rejected,
            },
      );
      continue;
    }

    if (entry.status === 'verified') {
      // A verified entry is either legacy (handled above) or sealed.
      const { tool } = entry.result;
      const identity: ToolIdentity =
        tool.id === 'other'
          ? { kind: 'custom', id: 'other', trusted_name: tool.name }
          : { kind: 'built-in', id: tool.id };
      placeInTool(identity, verifiedResult(entry, bucket));
      continue;
    }

    // Rejected. A tool column only on the strength of a seal, and only for a
    // tool whose identity is its id.
    const trustedToolId = entry.trustedToolId;
    if (
      entry.integrityTrust === 'sealed' &&
      trustedToolId !== undefined &&
      trustedToolId !== 'other'
    ) {
      placeInTool(
        { kind: 'built-in', id: trustedToolId },
        {
          kind: 'rejected',
          result_id: entry.resultId,
          trusted_tool_id: trustedToolId,
          integrity_trust: 'sealed',
          reason: entry.reason,
          message: entry.message,
          ...(entry.detail === undefined ? {} : { detail: entry.detail }),
          verified_evaluations: bucket.verified,
          unclassified_rejected_evaluations: bucket.rejected,
        },
      );
      continue;
    }

    unattributed.push({
      result_id: entry.resultId,
      reason_class: unattributedReasonOf(entry),
      reason: entry.reason,
      message: entry.message,
      ...(entry.detail === undefined ? {} : { detail: entry.detail }),
      integrity_trust: entry.integrityTrust ?? null,
      related_verified_evaluations: bucket.verified,
      related_rejected_evaluations: bucket.rejected,
    });
  }

  // Whatever is still bucketed names a Result this Run does not list. Nothing is
  // guessed about where it belongs.
  const unattributedRejected: ComparisonRejectedEvaluation[] = [...namesNoResult];
  const unattributedVerified: ComparisonVerifiedEvaluation[] = [];
  for (const bucket of buckets.values()) {
    unattributedRejected.push(...bucket.rejected);
    unattributedVerified.push(...bucket.verified);
  }

  const tools = [...toolGroups.values()].sort(compareToolGroups);
  const sortedUnattributedRejected = sortByEvaluationId(unattributedRejected);
  const sortedUnattributedVerified = sortByEvaluationId(unattributedVerified);

  return {
    run_id: runEvidence.runId,
    test_id: runEvidence.testId,
    evidence: {
      manifest_schema_version: runEvidence.manifestSchemaVersion,
      source_sha256: runEvidence.sourceSha256,
      audio_sha256: runEvidence.audioSha256,
      generated_at: runEvidence.generatedAt,
      segment_count: runEvidence.segmentation.segment_count,
    },
    evaluator_ids: [...EVALUATOR_IDS],
    tools,
    legacy_unsealed_results: legacy,
    unattributed_results: unattributed,
    unattributed_rejected_evaluations: sortedUnattributedRejected,
    unattributed_verified_evaluations: sortedUnattributedVerified,
    completeness: runCompleteness({
      tools,
      legacy,
      unattributed,
      unattributedRejected: sortedUnattributedRejected,
      unattributedVerified: sortedUnattributedVerified,
    }),
    ordering: COMPARISON_ORDERING,
  };
}

interface EvaluationBucket {
  verified: ComparisonVerifiedEvaluation[];
  rejected: ComparisonRejectedEvaluation[];
}

/**
 * Why a rejected, non-legacy Result could not be placed in a tool column.
 *
 * Mirrors the Session matrix: `trustedToolId` is attribution only when
 * `integrityTrust === 'sealed'` stands behind it (`saveResult.ts`,
 * `comparisonMatrix.ts`). Without that it is a shape check. And a sealed
 * `other` is still not an identity, because for a custom tool the name is the
 * identity and the rejected entry does not carry one.
 */
function unattributedReasonOf(
  entry: Extract<ResultListEntry, { status: 'rejected' }>,
): UnattributedReasonClass {
  if (entry.trustedToolId === undefined) return 'tool-identity-unverified';
  if (entry.integrityTrust !== 'sealed') return 'no-seal';
  return 'custom-tool-identity-unavailable';
}

function verifiedResult(
  entry: Extract<ResultListEntry, { status: 'verified' }>,
  bucket: EvaluationBucket,
): ComparisonVerifiedResult {
  const { result } = entry;
  const evaluations = EVALUATOR_IDS.map((evaluatorId) =>
    evaluatorGroup(
      evaluatorId,
      bucket.verified.filter((evaluation) => evaluation.evaluator_id === evaluatorId),
    ),
  );
  const present = evaluations
    .filter((group) => group.state.availability === 'available')
    .map((group) => group.evaluator_id);
  const missing = evaluations
    .filter((group) => group.state.availability === 'missing')
    .map((group) => group.evaluator_id);

  return {
    kind: 'verified',
    result_id: entry.resultId,
    captured_at: result.captured_at,
    tool: { id: result.tool.id, name: result.tool.name, version: result.tool.version },
    capture: { method: result.capture.method, delivery_path: result.capture.delivery_path },
    integrity_trust: 'sealed',
    transcript: entry.transcript,
    transcript_sha256: result.transcript.sha256,
    evaluations,
    unclassified_rejected_evaluations: bucket.rejected,
    completeness: {
      state: missing.length === 0 ? 'complete' : 'partial',
      evaluators_present: present,
      evaluators_missing: missing,
      unclassified_rejected_count: bucket.rejected.length,
    },
  };
}

const SCHEMA_VERSION_BY_EVALUATOR = {
  [RAW_CHAR_ALGORITHM]: EVALUATION_SCHEMA_VERSION,
  [SURFACE_CHAR_ALGORITHM]: SURFACE_EVALUATION_SCHEMA_VERSION,
  [CRITICAL_INFO_ALGORITHM]: CRITICAL_EVALUATION_SCHEMA_VERSION,
  [SEMANTIC_H3_ALGORITHM]: SEMANTIC_EVALUATION_SCHEMA_VERSION,
} as const satisfies Record<EvaluatorId, StoredEvaluation['schema_version']>;

/**
 * One evaluator's verified evidence for one Result, with the headline chosen.
 *
 * Newest verified by id when the entries agree. When they disagree there is no
 * headline at all: publishing one execution's verdict while another verified
 * execution said otherwise would be resolving the conflict by recency.
 */
function evaluatorGroup(
  evaluatorId: EvaluatorId,
  verified: ComparisonVerifiedEvaluation[],
): ComparisonEvaluationGroup {
  const entries = sortByEvaluationId(verified);
  const count = entries.length;
  const conflicting = new Set(entries.map((entry) => measurementKey(entry.summary))).size > 1;

  let headline: ComparisonVerifiedEvaluation | null = null;
  let selectionReason: SelectionReason | null = null;
  if (conflicting) {
    selectionReason = 'conflict-no-headline-v1';
  } else if (count === 1) {
    headline = entries[0] ?? null;
    selectionReason = 'only-verified-entry-v1';
  } else if (count > 1) {
    headline = entries[count - 1] ?? null;
    selectionReason = 'newest-verified-by-id-v1';
  }

  return {
    evaluator_id: evaluatorId,
    schema_version: SCHEMA_VERSION_BY_EVALUATOR[evaluatorId],
    entries,
    headline,
    selection_reason: selectionReason,
    state: {
      availability: count === 0 ? 'missing' : 'available',
      verified_count: count,
      multiple_candidates: count > 1,
      conflicting_evidence: conflicting,
    },
  };
}

/**
 * What two verified entries of one evaluator must share to be the same reading.
 *
 * v1, v2 and v3 are recomputed from the same Run and Result bytes on readback,
 * so verified entries necessarily agree; the check is there so that a
 * disagreement, if one ever reached this far, could not be hidden by a pick.
 *
 * v4 is historical model execution evidence: two verified executions can
 * legitimately disagree, and not only in their verdict. Two `review` decisions
 * by `split-vote-v1` can rest on opposite votes, and publishing either one as
 * the headline would put one execution's count forward as the reading. So the
 * key is the decision together with everything reported that bears on it —
 * the guard, the execution route and the run and vote counts. Model identity
 * is pinned by readback and is not a measurement; latency and raw responses
 * are not readings at all.
 */
function measurementKey(summary: EvaluationSummary): string {
  if (summary.kind === SEMANTIC_H3_ALGORITHM) {
    return JSON.stringify([
      summary.decision,
      summary.decision_by,
      summary.critical_guard,
      summary.execution,
    ]);
  }
  return JSON.stringify(summary);
}

function toComparisonEvaluation(entry: EvaluationListEntry): ComparisonEvaluationEntry {
  if (entry.status === 'rejected') {
    return {
      status: 'rejected',
      evaluation_id: entry.evaluationId,
      evaluator_id: null,
      schema_version: null,
      created_at: null,
      named_result_id: entry.resultId ?? null,
      reason: entry.reason,
      message: entry.message,
      ...(entry.detail === undefined ? {} : { detail: entry.detail }),
    };
  }
  const { evaluation } = entry;
  return {
    status: 'verified',
    evaluation_id: entry.evaluationId,
    evaluator_id: evaluation.evaluator.id,
    schema_version: evaluation.schema_version,
    created_at: evaluation.created_at,
    result_id: evaluation.result_id,
    summary: summaryOf(evaluation),
  };
}

/** A per-schema reading of one verified Evaluation. Read, never recomputed. */
function summaryOf(evaluation: StoredEvaluation): EvaluationSummary {
  switch (evaluation.schema_version) {
    case EVALUATION_SCHEMA_VERSION: {
      const { metrics } = evaluation;
      return {
        kind: RAW_CHAR_ALGORITHM,
        exact_match: metrics.exact_match,
        cer: metrics.cer,
        edit_distance: metrics.edit_distance,
        substitutions: metrics.substitutions,
        deletions: metrics.deletions,
        insertions: metrics.insertions,
        reference_chars: metrics.reference_chars,
        hypothesis_chars: metrics.hypothesis_chars,
      };
    }
    case SURFACE_EVALUATION_SCHEMA_VERSION: {
      const { metrics, normalized } = evaluation;
      return {
        kind: SURFACE_CHAR_ALGORITHM,
        exact_match: metrics.exact_match,
        cer: metrics.cer,
        edit_distance: metrics.edit_distance,
        substitutions: metrics.substitutions,
        deletions: metrics.deletions,
        insertions: metrics.insertions,
        normalized: {
          reference: { sha256: normalized.reference.sha256, chars: normalized.reference.chars },
          hypothesis: { sha256: normalized.hypothesis.sha256, chars: normalized.hypothesis.chars },
        },
      };
    }
    case CRITICAL_EVALUATION_SCHEMA_VERSION: {
      const { metrics } = evaluation;
      return {
        kind: CRITICAL_INFO_ALGORITHM,
        exact_entity_multiset_match: metrics.exact_entity_multiset_match,
        preservation_rate: metrics.preservation_rate,
        reference_entities: metrics.reference_entities,
        hypothesis_entities: metrics.hypothesis_entities,
        matched: metrics.matched,
        missing: metrics.missing,
        extra: metrics.extra,
        missing_keys: evaluation.missing.map((entity) => entity.canonical_key),
        extra_keys: evaluation.extra.map((entity) => entity.canonical_key),
      };
    }
    case SEMANTIC_EVALUATION_SCHEMA_VERSION: {
      const { critical, execution, decision } = evaluation;
      const tally = tallySemanticRuns(execution.runs, execution.request_contract?.repeats ?? 0);
      return {
        kind: SEMANTIC_H3_ALGORITHM,
        decision: decision.value,
        decision_by: decision.by,
        critical_guard: {
          status: critical.status,
          applicable: critical.applicable,
          mismatch: critical.mismatch,
        },
        execution: {
          status: execution.status,
          runs_recorded: execution.runs.length,
          runs_parseable: execution.runs.filter((run) => run.parseable_schema_valid === true).length,
          runs_exact_format: execution.runs.filter((run) => run.exact_output_contract_valid === true)
            .length,
          full_run_unanimous: tally.full_run_unanimous,
          changed_votes: tally.changed_votes,
          preserved_votes: tally.preserved_votes,
        },
        model:
          execution.runtime !== null && execution.model !== null && execution.prompt !== null
            ? {
                runtime_version: execution.runtime.version,
                model_id: execution.model.id,
                model_digest: execution.model.digest,
                prompt_id: execution.prompt.id,
                prompt_sha256: execution.prompt.sha256,
              }
            : null,
      };
    }
  }
}

function runCompleteness(input: {
  tools: ComparisonToolGroup[];
  legacy: ComparisonLegacyResult[];
  unattributed: UnattributedResult[];
  unattributedRejected: ComparisonRejectedEvaluation[];
  unattributedVerified: ComparisonVerifiedEvaluation[];
}): RunCompleteness {
  const grouped = input.tools.flatMap((group) => group.results);
  const verified = grouped.filter(
    (result): result is ComparisonVerifiedResult => result.kind === 'verified',
  );
  const groupedRejected = grouped.length - verified.length;
  const sealedRejected =
    groupedRejected +
    input.unattributed.filter((result) => result.integrity_trust === 'sealed').length;
  const noVerified = verified.filter(
    (result) => result.completeness.evaluators_present.length === 0,
  ).length;

  const complete =
    verified.length > 0 &&
    verified.every((result) => result.completeness.state === 'complete') &&
    groupedRejected === 0 &&
    input.unattributed.length === 0 &&
    input.unattributedRejected.length === 0 &&
    input.unattributedVerified.length === 0;

  return {
    state: complete ? 'complete' : 'partial',
    sealed_verified_results: verified.length,
    sealed_rejected_results: sealedRejected,
    legacy_unsealed_results: input.legacy.length,
    unattributed_results: input.unattributed.length,
    unattributed_rejected_evaluations: input.unattributedRejected.length,
    unattributed_verified_evaluations: input.unattributedVerified.length,
    results_with_no_verified_evaluations: noVerified,
  };
}

// ── Ordering ────────────────────────────────────────────────────────────────

/**
 * Code-unit order over timestamp ids. Their fixed-width shape makes this
 * chronological; locale collation and filesystem order never decide anything.
 */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortByEvaluationId<T extends { evaluation_id: string }>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => compareIds(a.evaluation_id, b.evaluation_id));
}

function toolKey(tool: ToolIdentity): string {
  return tool.kind === 'built-in' ? tool.id : JSON.stringify([tool.id, tool.trusted_name]);
}

/** Built-ins in `STT_TOOL_IDS` order, then custom tools by trusted name. */
function compareToolGroups(a: ComparisonToolGroup, b: ComparisonToolGroup): number {
  const byId = STT_TOOL_IDS.indexOf(a.tool.id) - STT_TOOL_IDS.indexOf(b.tool.id);
  if (byId !== 0) return byId;
  const aName = a.tool.kind === 'custom' ? a.tool.trusted_name : '';
  const bName = b.tool.kind === 'custom' ? b.tool.trusted_name : '';
  return compareIds(aName, bName);
}
