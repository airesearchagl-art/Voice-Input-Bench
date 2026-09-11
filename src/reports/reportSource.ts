import {
  COMPARISON_ORDERING,
  type BuiltInToolId,
  type ComparisonRun,
  type RunComparisonReading,
  type RunCompleteness,
  type SelectionReason,
  type ToolIdentity,
  type UnattributedReasonClass,
} from '@/comparisons/runComparison';
import { EVALUATOR_IDS, type EvaluatorId } from '@/evaluation/createEvaluation';
import { TIMESTAMP_ID_PATTERN } from '@/lib/timestampId';
import { isSealedResult } from '@/results/resultSchema';
import { STT_TOOL_IDS, type SttToolId } from '@/results/tools';
import { canonicalJson } from './canonicalJson';
import { ReportError } from './reportErrors';

/**
 * ReportSource v1 — the frozen evidence selection behind one Report.
 *
 * It freezes which artifacts were considered and how they were placed, plus the
 * exact bytes each one had, and nothing else. It does not freeze verification
 * verdicts: a re-render verifies again, now, and says what changed.
 *
 * The shape follows P4-A `report-contract.md`, updated for the merged P4-B
 * production comparison — notably `unattributed_verified_evaluation_ids`,
 * which the comparison added after P4-A was written.
 *
 * It holds canonical ids only. No path of any kind is stored or accepted.
 */

export const REPORT_CONTRACT_VERSION = 1 as const;

export interface ReportRunEvidence {
  manifest_schema_version: number;
  test_id: string;
  /** Byte SHA-256 of manifest.json itself. Nothing in production seals it. */
  manifest_file_sha256: string;
  /** Byte SHA-256 of source.txt as read. */
  source_sha256: string;
  /** Byte SHA-256 of audio.wav as read. */
  audio_sha256: string;
}

export interface ReportEvaluationGroupSource {
  evaluator_id: EvaluatorId;
  /** Every verified Evaluation considered, evaluation_id ascending. Empty is `missing`. */
  considered_evaluation_ids: string[];
  headline_evaluation_id: string | null;
  selection_reason: SelectionReason | null;
  /** Present exactly on conflict, and then every considered id. */
  conflicting_evaluation_ids?: string[];
}

export interface ReportVerifiedResultSource {
  kind: 'verified';
  result_id: string;
  tool: ToolIdentity;
  /** Trusted; `null` means the Result genuinely recorded no version. */
  tool_version: string | null;
  result_file_sha256: string;
  result_semantic_sha256: string;
  /** Byte SHA-256 of transcript.txt as read. */
  transcript_sha256: string;
  evaluation_groups: ReportEvaluationGroupSource[];
  unclassified_rejected_evaluation_ids: string[];
}

/** Rejected, tool identity survived. No version, capture or transcript — by type. */
export interface ReportRejectedResultSource {
  kind: 'rejected';
  result_id: string;
  trusted_tool_id: BuiltInToolId;
  result_file_sha256: string;
  /** Historical context only; never consulted as today's truth. */
  reason_at_report_time: string;
  verified_evaluation_ids: string[];
  unclassified_rejected_evaluation_ids: string[];
}

export type ReportResultSource = ReportVerifiedResultSource | ReportRejectedResultSource;

export interface ReportVerifiedLegacyResultSource {
  kind: 'legacy-unsealed-verified';
  result_id: string;
  result_file_sha256: string;
  transcript_sha256: string;
  claimed_tool_id: SttToolId;
  tool_claim_is_unverified: true;
  verified_evaluation_ids: string[];
  unclassified_rejected_evaluation_ids: string[];
}

export interface ReportRejectedLegacyResultSource {
  kind: 'legacy-unsealed-rejected';
  result_id: string;
  result_file_sha256: string;
  reason_at_report_time: string;
  verified_evaluation_ids: string[];
  unclassified_rejected_evaluation_ids: string[];
}

export type ReportLegacyResultSource =
  | ReportVerifiedLegacyResultSource
  | ReportRejectedLegacyResultSource;

export interface ReportUnattributedResultSource {
  result_id: string;
  reason_class: UnattributedReasonClass;
  result_file_sha256: string;
  reason_at_report_time: string;
  related_verified_evaluation_ids: string[];
  related_rejected_evaluation_ids: string[];
}

export interface ReportArtifactContent {
  results: Record<string, { file_sha256: string }>;
  evaluations: Record<string, { file_sha256: string; semantic_sha256?: string }>;
}

export interface ReportSource {
  report_contract_version: typeof REPORT_CONTRACT_VERSION;
  run_id: string;
  run_evidence: ReportRunEvidence;
  /** Sealed Results placed in a tool group, in the comparison's tool and id order. */
  results: ReportResultSource[];
  legacy_results: ReportLegacyResultSource[];
  unattributed_results: ReportUnattributedResultSource[];
  /** Rejected Evaluations naming no Result of this Run. */
  unattributed_rejected_evaluation_ids: string[];
  /** Verified Evaluations naming a Result absent from the Result listing (P4-B). */
  unattributed_verified_evaluation_ids: string[];
  artifact_content: ReportArtifactContent;
  ordering: typeof COMPARISON_ORDERING;
  completeness: RunCompleteness;
}

/** The actual bytes read for everything a comparison cites. */
export interface CitedArtifactHashes {
  run: { manifest: string; source: string; audio: string };
  results: Record<string, { result_file: string; transcript_file?: string }>;
  evaluations: Record<string, string>;
}

// ── Building from a comparison ──────────────────────────────────────────────

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedRecord<T>(entries: Array<[string, T]>): Record<string, T> {
  const record: Record<string, T> = {};
  for (const [key, value] of [...entries].sort((a, b) => compareIds(a[0], b[0]))) {
    record[key] = value;
  }
  return record;
}

function ids(entries: ReadonlyArray<{ evaluation_id: string }>): string[] {
  return entries.map((entry) => entry.evaluation_id);
}

/**
 * The ReportSource for one reading of the comparison and the bytes behind it.
 *
 * Every placement, headline and selection reason is the comparison's own — the
 * report does not decide anything the comparison already decided. Throws if a
 * cited artifact has no hash, which would mean the caller hashed a different
 * generation than it read.
 */
export function reportSourceOf(
  reading: RunComparisonReading,
  hashes: CitedArtifactHashes,
): ReportSource {
  const { comparison } = reading;

  const resultSemantic = new Map<string, string>();
  for (const entry of reading.results) {
    if (entry.status === 'verified' && isSealedResult(entry.result)) {
      resultSemantic.set(entry.resultId, entry.result.integrity.semantic_sha256);
    }
  }
  const evaluationSemantic = new Map<string, string>();
  for (const entry of reading.evaluations) {
    if (entry.status === 'verified') {
      evaluationSemantic.set(entry.evaluationId, entry.evaluation.integrity.semantic_sha256);
    }
  }

  const structure = structureOf(comparison, {
    resultFile: (resultId) => {
      const hash = hashes.results[resultId]?.result_file;
      if (hash === undefined) throw missingHash('result', resultId);
      return hash;
    },
    transcriptFile: (resultId) => {
      const hash = hashes.results[resultId]?.transcript_file;
      if (hash === undefined) throw missingHash('transcript', resultId);
      return hash;
    },
    resultSeal: (resultId) => {
      const hash = resultSemantic.get(resultId);
      if (hash === undefined) throw missingHash('result seal', resultId);
      return hash;
    },
  });

  const partition = evaluationPartitionOf(structure);
  const evaluationContent: Array<[string, { file_sha256: string; semantic_sha256?: string }]> = [];
  for (const [evaluationId, placement] of partition) {
    const fileSha = hashes.evaluations[evaluationId];
    if (fileSha === undefined) throw missingHash('evaluation', evaluationId);
    if (isVerifiedPlacement(placement)) {
      const semantic = evaluationSemantic.get(evaluationId);
      if (semantic === undefined) throw missingHash('evaluation seal', evaluationId);
      evaluationContent.push([evaluationId, { file_sha256: fileSha, semantic_sha256: semantic }]);
    } else {
      evaluationContent.push([evaluationId, { file_sha256: fileSha }]);
    }
  }

  const resultIds = [
    ...structure.results.map((r) => r.result_id),
    ...structure.legacy_results.map((r) => r.result_id),
    ...structure.unattributed_results.map((r) => r.result_id),
  ];

  return {
    report_contract_version: REPORT_CONTRACT_VERSION,
    run_id: comparison.run_id,
    run_evidence: {
      manifest_schema_version: comparison.evidence.manifest_schema_version,
      test_id: comparison.test_id,
      manifest_file_sha256: hashes.run.manifest,
      source_sha256: hashes.run.source,
      audio_sha256: hashes.run.audio,
    },
    ...structure,
    artifact_content: {
      results: sortedRecord(
        resultIds.map((id): [string, { file_sha256: string }] => [
          id,
          { file_sha256: hashes.results[id]?.result_file ?? '' },
        ]),
      ),
      evaluations: sortedRecord(evaluationContent),
    },
    ordering: COMPARISON_ORDERING,
    completeness: comparison.completeness,
  };
}

/** Hash lookups for `structureOf`. Build supplies the bytes it read. */
export interface StructureHashes {
  resultFile: (resultId: string) => string;
  transcriptFile: (resultId: string) => string;
  resultSeal: (resultId: string) => string;
}

/** For comparing placements only: the structure, with every hash left blank. */
export const NO_HASHES: StructureHashes = {
  resultFile: () => '',
  transcriptFile: () => '',
  resultSeal: () => '',
};

/**
 * The id-and-placement structure of a comparison, as a ReportSource holds it.
 *
 * The one mapping from the comparison to the report's containers. Building a
 * ReportSource and re-checking an old one both go through it, so the two can
 * never disagree about where an artifact belongs.
 */
export function structureOf(comparison: ComparisonRun, hash: StructureHashes): PartitionInput {
  const results: ReportResultSource[] = comparison.tools.flatMap((group) =>
    group.results.map((result): ReportResultSource => {
      if (result.kind === 'rejected') {
        return {
          kind: 'rejected',
          result_id: result.result_id,
          trusted_tool_id: result.trusted_tool_id,
          result_file_sha256: hash.resultFile(result.result_id),
          reason_at_report_time: result.reason,
          verified_evaluation_ids: ids(result.verified_evaluations),
          unclassified_rejected_evaluation_ids: ids(result.unclassified_rejected_evaluations),
        };
      }
      return {
        kind: 'verified',
        result_id: result.result_id,
        tool: group.tool,
        tool_version: result.tool.version,
        result_file_sha256: hash.resultFile(result.result_id),
        result_semantic_sha256: hash.resultSeal(result.result_id),
        transcript_sha256: hash.transcriptFile(result.result_id),
        evaluation_groups: result.evaluations.map((evaluatorGroup) => ({
          evaluator_id: evaluatorGroup.evaluator_id,
          considered_evaluation_ids: ids(evaluatorGroup.entries),
          headline_evaluation_id: evaluatorGroup.headline?.evaluation_id ?? null,
          selection_reason: evaluatorGroup.selection_reason,
          ...(evaluatorGroup.state.conflicting_evidence
            ? { conflicting_evaluation_ids: ids(evaluatorGroup.entries) }
            : {}),
        })),
        unclassified_rejected_evaluation_ids: ids(result.unclassified_rejected_evaluations),
      };
    }),
  );

  const legacyResults: ReportLegacyResultSource[] = comparison.legacy_unsealed_results.map(
    (result) =>
      result.kind === 'legacy-unsealed-verified'
        ? {
            kind: 'legacy-unsealed-verified',
            result_id: result.result_id,
            result_file_sha256: hash.resultFile(result.result_id),
            transcript_sha256: hash.transcriptFile(result.result_id),
            claimed_tool_id: result.claimed_tool_id,
            tool_claim_is_unverified: true,
            verified_evaluation_ids: ids(result.verified_evaluations),
            unclassified_rejected_evaluation_ids: ids(result.unclassified_rejected_evaluations),
          }
        : {
            kind: 'legacy-unsealed-rejected',
            result_id: result.result_id,
            result_file_sha256: hash.resultFile(result.result_id),
            reason_at_report_time: result.reason,
            verified_evaluation_ids: ids(result.verified_evaluations),
            unclassified_rejected_evaluation_ids: ids(result.unclassified_rejected_evaluations),
          },
  );

  const unattributedResults: ReportUnattributedResultSource[] =
    comparison.unattributed_results.map((result) => ({
      result_id: result.result_id,
      reason_class: result.reason_class,
      result_file_sha256: hash.resultFile(result.result_id),
      reason_at_report_time: result.reason,
      related_verified_evaluation_ids: ids(result.related_verified_evaluations),
      related_rejected_evaluation_ids: ids(result.related_rejected_evaluations),
    }));

  return {
    results,
    legacy_results: legacyResults,
    unattributed_results: unattributedResults,
    unattributed_rejected_evaluation_ids: ids(comparison.unattributed_rejected_evaluations),
    unattributed_verified_evaluation_ids: ids(comparison.unattributed_verified_evaluations),
  };
}

function missingHash(what: string, id: string): Error {
  return new ReportError(
    'REPORT_EVIDENCE_CHANGED_DURING_BUILD',
    `${what} ${id} の byte identity がありません。読み取りと hash が別の世代を見ています。`,
  );
}

// ── The Evaluation partition ────────────────────────────────────────────────

/** Where one Evaluation sits in a ReportSource. Exactly one per id. */
export type EvaluationPlacement =
  | { container: 'evaluator_group'; result_id: string; evaluator_id: EvaluatorId }
  | { container: 'verified_on_rejected_result'; result_id: string }
  | { container: 'verified_on_legacy_result'; result_id: string }
  | { container: 'verified_on_unattributed_result'; result_id: string }
  | { container: 'unclassified_rejected'; result_id: string }
  | { container: 'rejected_on_unattributed_result'; result_id: string }
  | { container: 'unattributed_rejected' }
  | { container: 'unattributed_verified' };

export function isVerifiedPlacement(placement: EvaluationPlacement): boolean {
  switch (placement.container) {
    case 'evaluator_group':
    case 'verified_on_rejected_result':
    case 'verified_on_legacy_result':
    case 'verified_on_unattributed_result':
    case 'unattributed_verified':
      return true;
    default:
      return false;
  }
}

/** The containers of a ReportSource: ids and placements, with the hashes they carry. */
export type PartitionInput = Pick<
  ReportSource,
  | 'results'
  | 'legacy_results'
  | 'unattributed_results'
  | 'unattributed_rejected_evaluation_ids'
  | 'unattributed_verified_evaluation_ids'
>;

/**
 * Every Evaluation id, with the one container it sits in.
 *
 * Throws if an id appears twice — in one container or across two — because a
 * ReportSource in which an Evaluation is in two places is malformed.
 */
export function evaluationPartitionOf(source: PartitionInput): Map<string, EvaluationPlacement> {
  const partition = new Map<string, EvaluationPlacement>();
  const place = (evaluationIds: readonly string[], placement: EvaluationPlacement) => {
    for (const evaluationId of evaluationIds) {
      if (partition.has(evaluationId)) {
        throw invalid(`Evaluation ${evaluationId} が複数の container にあります。`);
      }
      partition.set(evaluationId, placement);
    }
  };

  for (const result of source.results) {
    if (result.kind === 'verified') {
      for (const group of result.evaluation_groups) {
        place(group.considered_evaluation_ids, {
          container: 'evaluator_group',
          result_id: result.result_id,
          evaluator_id: group.evaluator_id,
        });
      }
    } else {
      place(result.verified_evaluation_ids, {
        container: 'verified_on_rejected_result',
        result_id: result.result_id,
      });
    }
    place(result.unclassified_rejected_evaluation_ids, {
      container: 'unclassified_rejected',
      result_id: result.result_id,
    });
  }
  for (const result of source.legacy_results) {
    place(result.verified_evaluation_ids, {
      container: 'verified_on_legacy_result',
      result_id: result.result_id,
    });
    place(result.unclassified_rejected_evaluation_ids, {
      container: 'unclassified_rejected',
      result_id: result.result_id,
    });
  }
  for (const result of source.unattributed_results) {
    place(result.related_verified_evaluation_ids, {
      container: 'verified_on_unattributed_result',
      result_id: result.result_id,
    });
    place(result.related_rejected_evaluation_ids, {
      container: 'rejected_on_unattributed_result',
      result_id: result.result_id,
    });
  }
  place(source.unattributed_rejected_evaluation_ids, { container: 'unattributed_rejected' });
  place(source.unattributed_verified_evaluation_ids, { container: 'unattributed_verified' });
  return partition;
}

/** Where one Result sits in a ReportSource, with the identity it was placed on. */
export type ResultPlacement =
  | { container: 'tool_group'; kind: 'verified'; tool: ToolIdentity; tool_version: string | null }
  | { container: 'tool_group'; kind: 'rejected'; trusted_tool_id: BuiltInToolId }
  | { container: 'legacy'; kind: 'legacy-unsealed-verified'; claimed_tool_id: SttToolId }
  | { container: 'legacy'; kind: 'legacy-unsealed-rejected' }
  | { container: 'unattributed'; reason_class: UnattributedReasonClass };

export function resultPlacementsOf(source: PartitionInput): Map<string, ResultPlacement> {
  const placements = new Map<string, ResultPlacement>();
  for (const result of source.results) {
    placements.set(
      result.result_id,
      result.kind === 'verified'
        ? { container: 'tool_group', kind: 'verified', tool: result.tool, tool_version: result.tool_version }
        : { container: 'tool_group', kind: 'rejected', trusted_tool_id: result.trusted_tool_id },
    );
  }
  for (const result of source.legacy_results) {
    placements.set(
      result.result_id,
      result.kind === 'legacy-unsealed-verified'
        ? { container: 'legacy', kind: result.kind, claimed_tool_id: result.claimed_tool_id }
        : { container: 'legacy', kind: result.kind },
    );
  }
  for (const result of source.unattributed_results) {
    placements.set(result.result_id, { container: 'unattributed', reason_class: result.reason_class });
  }
  return placements;
}

// ── Completeness, derived from the structure ────────────────────────────────

/**
 * The Run completeness a ReportSource's own structure implies.
 *
 * The same reading P4-B's `RunCompleteness` gives, recomputed from ids alone:
 * a group is present when it considered anything. A sealed rejected Result is
 * a tool-grouped rejected one or an unattributed `other` (whose seal held).
 */
export function completenessOf(source: PartitionInput): RunCompleteness {
  const verified = source.results.filter(
    (result): result is ReportVerifiedResultSource => result.kind === 'verified',
  );
  const groupedRejected = source.results.length - verified.length;
  const present = (result: ReportVerifiedResultSource) =>
    result.evaluation_groups.filter((group) => group.considered_evaluation_ids.length > 0).length;
  const sealedUnattributed = source.unattributed_results.filter(
    (result) => result.reason_class === 'custom-tool-identity-unavailable',
  ).length;

  const complete =
    verified.length > 0 &&
    verified.every((result) => present(result) === EVALUATOR_IDS.length) &&
    groupedRejected === 0 &&
    source.unattributed_results.length === 0 &&
    source.unattributed_rejected_evaluation_ids.length === 0 &&
    source.unattributed_verified_evaluation_ids.length === 0;

  return {
    state: complete ? 'complete' : 'partial',
    sealed_verified_results: verified.length,
    sealed_rejected_results: groupedRejected + sealedUnattributed,
    legacy_unsealed_results: source.legacy_results.length,
    unattributed_results: source.unattributed_results.length,
    unattributed_rejected_evaluations: source.unattributed_rejected_evaluation_ids.length,
    unattributed_verified_evaluations: source.unattributed_verified_evaluation_ids.length,
    results_with_no_verified_evaluations: verified.filter((result) => present(result) === 0).length,
  };
}

/** A ReportSource built from a comparison must describe it exactly; checked, not assumed. */
export function assertSourceMatchesComparison(source: ReportSource, comparison: ComparisonRun): void {
  if (canonicalJson(completenessOf(source)) !== canonicalJson(comparison.completeness)) {
    throw new Error('ReportSource の構造から導いた completeness が comparison と一致しません。');
  }
  try {
    validateReportSource(JSON.parse(JSON.stringify(source)) as unknown);
  } catch (caught) {
    // Our own output failing our own contract is an internal fault, not a bad
    // request: reported as UNEXPECTED rather than as REPORT_SOURCE_INVALID.
    const reason = caught instanceof ReportError ? `${caught.message} ${caught.detail ?? ''}` : String(caught);
    throw new Error(`生成した ReportSource が自身の contract を満たしません: ${reason}`, { cause: caught });
  }
}

// ── Validation of an untrusted ReportSource ─────────────────────────────────

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
/** A verifier's rejection kind: an upper-snake token, as every production kind is. */
const REASON_PATTERN = /^[A-Z][A-Z0-9_]{0,99}$/;
/** Generous: production does not cap tool names or versions; the request size limit does. */
const MAX_TEXT = 100_000;
const BUILT_IN_TOOL_IDS = STT_TOOL_IDS.filter(
  (id): id is BuiltInToolId => id !== 'other',
);
const SELECTION_REASONS: readonly SelectionReason[] = [
  'only-verified-entry-v1',
  'newest-verified-by-id-v1',
  'conflict-no-headline-v1',
];
const REASON_CLASSES: readonly UnattributedReasonClass[] = [
  'no-seal',
  'tool-identity-unverified',
  'custom-tool-identity-unavailable',
];

function invalid(message: string, path?: string): ReportError {
  return new ReportError('REPORT_SOURCE_INVALID', message, path ? { detail: `path=${path}` } : {});
}

function expectObject(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid('オブジェクトである必要があります。', path);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalid('plain object である必要があります。', path);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!required.includes(key) && !optional.includes(key)) {
      throw invalid(`未知のフィールドです: ${JSON.stringify(key)}`, path);
    }
  }
  for (const key of required) {
    if (!(key in record)) throw invalid(`必須フィールドがありません: ${key}`, path);
  }
  return record;
}

function expectText(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TEXT) {
    throw invalid(`1〜${MAX_TEXT} 文字の文字列である必要があります。`, path);
  }
  return value;
}

function expectPattern(value: unknown, path: string, pattern: RegExp, what: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw invalid(`${what} の形式が不正です。`, path);
  }
  return value;
}

const expectId = (value: unknown, path: string) =>
  expectPattern(value, path, TIMESTAMP_ID_PATTERN, 'id');
const expectSha = (value: unknown, path: string) =>
  expectPattern(value, path, SHA256_PATTERN, 'SHA-256');

function expectOneOf<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw invalid(`許可されていない値です: ${JSON.stringify(value)}`, path);
  }
  return value as T;
}

/** Ids, strictly ascending: evaluation-id-ascending-v1, and no duplicate. */
function expectIdList(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw invalid('配列である必要があります。', path);
  const list = value.map((item, index) => expectId(item, `${path}[${index}]`));
  for (let i = 1; i < list.length; i += 1) {
    if (compareIds(list[i - 1]!, list[i]!) >= 0) {
      throw invalid('id は重複なく昇順である必要があります。', path);
    }
  }
  return list;
}

function expectArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw invalid('配列である必要があります。', path);
  return value;
}

function expectCount(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalid('0 以上の整数である必要があります。', path);
  }
  return value;
}

function expectToolIdentity(value: unknown, path: string): ToolIdentity {
  const kind = expectObject(value, path, ['kind', 'id'], ['trusted_name']).kind;
  const record = value as Record<string, unknown>;
  if (kind === 'built-in') {
    expectObject(value, path, ['kind', 'id']);
    return { kind: 'built-in', id: expectOneOf(record.id, `${path}.id`, BUILT_IN_TOOL_IDS) };
  }
  if (kind === 'custom') {
    expectObject(value, path, ['kind', 'id', 'trusted_name']);
    expectOneOf(record.id, `${path}.id`, ['other'] as const);
    return {
      kind: 'custom',
      id: 'other',
      trusted_name: expectText(record.trusted_name, `${path}.trusted_name`),
    };
  }
  throw invalid(`許可されていない tool kind です: ${JSON.stringify(kind)}`, `${path}.kind`);
}

function expectGroups(value: unknown, path: string): ReportEvaluationGroupSource[] {
  const groups = expectArray(value, path);
  if (groups.length !== EVALUATOR_IDS.length) {
    throw invalid(`evaluator group は ${EVALUATOR_IDS.length} 件である必要があります。`, path);
  }
  return groups.map((raw, index) => {
    const at = `${path}[${index}]`;
    const record = expectObject(
      raw,
      at,
      ['evaluator_id', 'considered_evaluation_ids', 'headline_evaluation_id', 'selection_reason'],
      ['conflicting_evaluation_ids'],
    );
    if (record.evaluator_id !== EVALUATOR_IDS[index]) {
      throw invalid('evaluator group は EVALUATOR_IDS の順である必要があります。', `${at}.evaluator_id`);
    }
    const evaluatorId = EVALUATOR_IDS[index]!;
    const considered = expectIdList(record.considered_evaluation_ids, `${at}.considered_evaluation_ids`);
    const headline =
      record.headline_evaluation_id === null
        ? null
        : expectId(record.headline_evaluation_id, `${at}.headline_evaluation_id`);
    const reason =
      record.selection_reason === null
        ? null
        : expectOneOf(record.selection_reason, `${at}.selection_reason`, SELECTION_REASONS);
    const conflicting =
      'conflicting_evaluation_ids' in record
        ? expectIdList(record.conflicting_evaluation_ids, `${at}.conflicting_evaluation_ids`)
        : undefined;

    // Selection must be the one the frozen rules give for this candidate set.
    const n = considered.length;
    const ok =
      (n === 0 && headline === null && reason === null && conflicting === undefined) ||
      (n === 1 &&
        reason === 'only-verified-entry-v1' &&
        headline === considered[0] &&
        conflicting === undefined) ||
      (n > 1 &&
        reason === 'newest-verified-by-id-v1' &&
        headline === considered[n - 1] &&
        conflicting === undefined) ||
      (n > 1 &&
        reason === 'conflict-no-headline-v1' &&
        headline === null &&
        conflicting !== undefined &&
        canonicalJson(conflicting) === canonicalJson(considered));
    if (!ok) {
      throw invalid(
        'headline / selection_reason / conflicting_evaluation_ids が considered の件数と整合しません。',
        at,
      );
    }
    return {
      evaluator_id: evaluatorId,
      considered_evaluation_ids: considered,
      headline_evaluation_id: headline,
      selection_reason: reason,
      ...(conflicting === undefined ? {} : { conflicting_evaluation_ids: conflicting }),
    };
  });
}

function expectResult(value: unknown, path: string): ReportResultSource {
  const kind = expectObject(value, path, ['kind'], [
    'result_id',
    'tool',
    'tool_version',
    'result_file_sha256',
    'result_semantic_sha256',
    'transcript_sha256',
    'evaluation_groups',
    'unclassified_rejected_evaluation_ids',
    'trusted_tool_id',
    'reason_at_report_time',
    'verified_evaluation_ids',
  ]).kind;
  if (kind === 'verified') {
    const record = expectObject(value, path, [
      'kind',
      'result_id',
      'tool',
      'tool_version',
      'result_file_sha256',
      'result_semantic_sha256',
      'transcript_sha256',
      'evaluation_groups',
      'unclassified_rejected_evaluation_ids',
    ]);
    return {
      kind: 'verified',
      result_id: expectId(record.result_id, `${path}.result_id`),
      tool: expectToolIdentity(record.tool, `${path}.tool`),
      tool_version:
        record.tool_version === null ? null : expectText(record.tool_version, `${path}.tool_version`),
      result_file_sha256: expectSha(record.result_file_sha256, `${path}.result_file_sha256`),
      result_semantic_sha256: expectSha(record.result_semantic_sha256, `${path}.result_semantic_sha256`),
      transcript_sha256: expectSha(record.transcript_sha256, `${path}.transcript_sha256`),
      evaluation_groups: expectGroups(record.evaluation_groups, `${path}.evaluation_groups`),
      unclassified_rejected_evaluation_ids: expectIdList(
        record.unclassified_rejected_evaluation_ids,
        `${path}.unclassified_rejected_evaluation_ids`,
      ),
    };
  }
  if (kind === 'rejected') {
    const record = expectObject(value, path, [
      'kind',
      'result_id',
      'trusted_tool_id',
      'result_file_sha256',
      'reason_at_report_time',
      'verified_evaluation_ids',
      'unclassified_rejected_evaluation_ids',
    ]);
    return {
      kind: 'rejected',
      result_id: expectId(record.result_id, `${path}.result_id`),
      trusted_tool_id: expectOneOf(record.trusted_tool_id, `${path}.trusted_tool_id`, BUILT_IN_TOOL_IDS),
      result_file_sha256: expectSha(record.result_file_sha256, `${path}.result_file_sha256`),
      reason_at_report_time: expectPattern(
        record.reason_at_report_time,
        `${path}.reason_at_report_time`,
        REASON_PATTERN,
        'reason',
      ),
      verified_evaluation_ids: expectIdList(record.verified_evaluation_ids, `${path}.verified_evaluation_ids`),
      unclassified_rejected_evaluation_ids: expectIdList(
        record.unclassified_rejected_evaluation_ids,
        `${path}.unclassified_rejected_evaluation_ids`,
      ),
    };
  }
  throw invalid(`許可されていない Result kind です: ${JSON.stringify(kind)}`, `${path}.kind`);
}

function expectLegacyResult(value: unknown, path: string): ReportLegacyResultSource {
  const kind = expectObject(value, path, ['kind'], [
    'result_id',
    'result_file_sha256',
    'transcript_sha256',
    'claimed_tool_id',
    'tool_claim_is_unverified',
    'reason_at_report_time',
    'verified_evaluation_ids',
    'unclassified_rejected_evaluation_ids',
  ]).kind;
  if (kind === 'legacy-unsealed-verified') {
    const record = expectObject(value, path, [
      'kind',
      'result_id',
      'result_file_sha256',
      'transcript_sha256',
      'claimed_tool_id',
      'tool_claim_is_unverified',
      'verified_evaluation_ids',
      'unclassified_rejected_evaluation_ids',
    ]);
    if (record.tool_claim_is_unverified !== true) {
      throw invalid('tool_claim_is_unverified は true である必要があります。', `${path}.tool_claim_is_unverified`);
    }
    return {
      kind: 'legacy-unsealed-verified',
      result_id: expectId(record.result_id, `${path}.result_id`),
      result_file_sha256: expectSha(record.result_file_sha256, `${path}.result_file_sha256`),
      transcript_sha256: expectSha(record.transcript_sha256, `${path}.transcript_sha256`),
      claimed_tool_id: expectOneOf(record.claimed_tool_id, `${path}.claimed_tool_id`, STT_TOOL_IDS),
      tool_claim_is_unverified: true,
      verified_evaluation_ids: expectIdList(record.verified_evaluation_ids, `${path}.verified_evaluation_ids`),
      unclassified_rejected_evaluation_ids: expectIdList(
        record.unclassified_rejected_evaluation_ids,
        `${path}.unclassified_rejected_evaluation_ids`,
      ),
    };
  }
  if (kind === 'legacy-unsealed-rejected') {
    const record = expectObject(value, path, [
      'kind',
      'result_id',
      'result_file_sha256',
      'reason_at_report_time',
      'verified_evaluation_ids',
      'unclassified_rejected_evaluation_ids',
    ]);
    return {
      kind: 'legacy-unsealed-rejected',
      result_id: expectId(record.result_id, `${path}.result_id`),
      result_file_sha256: expectSha(record.result_file_sha256, `${path}.result_file_sha256`),
      reason_at_report_time: expectPattern(
        record.reason_at_report_time,
        `${path}.reason_at_report_time`,
        REASON_PATTERN,
        'reason',
      ),
      verified_evaluation_ids: expectIdList(record.verified_evaluation_ids, `${path}.verified_evaluation_ids`),
      unclassified_rejected_evaluation_ids: expectIdList(
        record.unclassified_rejected_evaluation_ids,
        `${path}.unclassified_rejected_evaluation_ids`,
      ),
    };
  }
  throw invalid(`許可されていない legacy kind です: ${JSON.stringify(kind)}`, `${path}.kind`);
}

function expectUnattributedResult(value: unknown, path: string): ReportUnattributedResultSource {
  const record = expectObject(value, path, [
    'result_id',
    'reason_class',
    'result_file_sha256',
    'reason_at_report_time',
    'related_verified_evaluation_ids',
    'related_rejected_evaluation_ids',
  ]);
  return {
    result_id: expectId(record.result_id, `${path}.result_id`),
    reason_class: expectOneOf(record.reason_class, `${path}.reason_class`, REASON_CLASSES),
    result_file_sha256: expectSha(record.result_file_sha256, `${path}.result_file_sha256`),
    reason_at_report_time: expectPattern(
      record.reason_at_report_time,
      `${path}.reason_at_report_time`,
      REASON_PATTERN,
      'reason',
    ),
    related_verified_evaluation_ids: expectIdList(
      record.related_verified_evaluation_ids,
      `${path}.related_verified_evaluation_ids`,
    ),
    related_rejected_evaluation_ids: expectIdList(
      record.related_rejected_evaluation_ids,
      `${path}.related_rejected_evaluation_ids`,
    ),
  };
}

function expectContentRecord<T>(
  value: unknown,
  path: string,
  entry: (raw: unknown, at: string) => T,
): Record<string, T> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid('オブジェクトである必要があります。', path);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalid('plain object である必要があります。', path);
  }
  const raw = value as Record<string, unknown>;
  const entries: Array<[string, T]> = [];
  // Keys are ids, checked as ids before anything else is done with them.
  for (const key of Object.keys(raw)) {
    expectId(key, `${path}[${JSON.stringify(key)}]`);
    entries.push([key, entry(raw[key], `${path}.${key}`)]);
  }
  return sortedRecord(entries);
}

/** Tool-grouped Results in the comparison's order: STT_TOOL_IDS, then trusted name, then id. */
function compareToolGrouped(a: ReportResultSource, b: ReportResultSource): number {
  const key = (result: ReportResultSource): [number, string] =>
    result.kind === 'verified'
      ? [
          STT_TOOL_IDS.indexOf(result.tool.id),
          result.tool.kind === 'custom' ? result.tool.trusted_name : '',
        ]
      : [STT_TOOL_IDS.indexOf(result.trusted_tool_id), ''];
  const [aRank, aName] = key(a);
  const [bRank, bName] = key(b);
  if (aRank !== bRank) return aRank - bRank;
  const byName = compareIds(aName, bName);
  if (byName !== 0) return byName;
  return compareIds(a.result_id, b.result_id);
}

function expectAscending<T>(items: readonly T[], path: string, compare: (a: T, b: T) => number) {
  for (let i = 1; i < items.length; i += 1) {
    if (compare(items[i - 1]!, items[i]!) >= 0) {
      throw invalid('並び順が ordering 規則と一致しないか、重複があります。', path);
    }
  }
}

/**
 * Parse an untrusted ReportSource, failing closed on anything unexpected.
 *
 * Checks shape and vocabulary (closed everywhere), id and hash formats, the
 * ordering rules, the headline rules, that every Result and every Evaluation
 * sits in exactly one container, that every one of them has — and only they
 * have — an artifact_content entry, and that the completeness it states is the
 * one its own structure implies. It never touches the disk: ids are validated
 * as ids before anything could turn them into a path.
 */
export function validateReportSource(input: unknown): ReportSource {
  const root = expectObject(input, '$', [
    'report_contract_version',
    'run_id',
    'run_evidence',
    'results',
    'legacy_results',
    'unattributed_results',
    'unattributed_rejected_evaluation_ids',
    'unattributed_verified_evaluation_ids',
    'artifact_content',
    'ordering',
    'completeness',
  ]);

  if (root.report_contract_version !== REPORT_CONTRACT_VERSION) {
    throw invalid(
      `report_contract_version は ${REPORT_CONTRACT_VERSION} である必要があります。`,
      '$.report_contract_version',
    );
  }
  const runId = expectId(root.run_id, '$.run_id');

  const evidence = expectObject(root.run_evidence, '$.run_evidence', [
    'manifest_schema_version',
    'test_id',
    'manifest_file_sha256',
    'source_sha256',
    'audio_sha256',
  ]);
  const runEvidence: ReportRunEvidence = {
    manifest_schema_version: expectCount(
      evidence.manifest_schema_version,
      '$.run_evidence.manifest_schema_version',
    ),
    test_id: expectText(evidence.test_id, '$.run_evidence.test_id'),
    manifest_file_sha256: expectSha(evidence.manifest_file_sha256, '$.run_evidence.manifest_file_sha256'),
    source_sha256: expectSha(evidence.source_sha256, '$.run_evidence.source_sha256'),
    audio_sha256: expectSha(evidence.audio_sha256, '$.run_evidence.audio_sha256'),
  };

  const results = expectArray(root.results, '$.results').map((raw, index) =>
    expectResult(raw, `$.results[${index}]`),
  );
  expectAscending(results, '$.results', compareToolGrouped);
  const legacyResults = expectArray(root.legacy_results, '$.legacy_results').map((raw, index) =>
    expectLegacyResult(raw, `$.legacy_results[${index}]`),
  );
  expectAscending(legacyResults, '$.legacy_results', (a, b) => compareIds(a.result_id, b.result_id));
  const unattributedResults = expectArray(root.unattributed_results, '$.unattributed_results').map(
    (raw, index) => expectUnattributedResult(raw, `$.unattributed_results[${index}]`),
  );
  expectAscending(unattributedResults, '$.unattributed_results', (a, b) =>
    compareIds(a.result_id, b.result_id),
  );

  const unattributedRejected = expectIdList(
    root.unattributed_rejected_evaluation_ids,
    '$.unattributed_rejected_evaluation_ids',
  );
  const unattributedVerified = expectIdList(
    root.unattributed_verified_evaluation_ids,
    '$.unattributed_verified_evaluation_ids',
  );

  const contentRoot = expectObject(root.artifact_content, '$.artifact_content', ['results', 'evaluations']);
  const resultContent = expectContentRecord(contentRoot.results, '$.artifact_content.results', (raw, at) => {
    const record = expectObject(raw, at, ['file_sha256']);
    return { file_sha256: expectSha(record.file_sha256, `${at}.file_sha256`) };
  });
  const evaluationContent = expectContentRecord(
    contentRoot.evaluations,
    '$.artifact_content.evaluations',
    (raw, at) => {
      const record = expectObject(raw, at, ['file_sha256'], ['semantic_sha256']);
      return {
        file_sha256: expectSha(record.file_sha256, `${at}.file_sha256`),
        ...('semantic_sha256' in record
          ? { semantic_sha256: expectSha(record.semantic_sha256, `${at}.semantic_sha256`) }
          : {}),
      };
    },
  );

  const ordering = expectObject(root.ordering, '$.ordering', Object.keys(COMPARISON_ORDERING));
  for (const [key, value] of Object.entries(COMPARISON_ORDERING)) {
    if (ordering[key] !== value) {
      throw invalid(`ordering.${key} は ${value} である必要があります。`, `$.ordering.${key}`);
    }
  }

  const structure: PartitionInput = {
    results,
    legacy_results: legacyResults,
    unattributed_results: unattributedResults,
    unattributed_rejected_evaluation_ids: unattributedRejected,
    unattributed_verified_evaluation_ids: unattributedVerified,
  };

  // Results: each in exactly one container, each with exactly one content entry
  // whose hash agrees with the one on the Result.
  const allResults = [...results, ...legacyResults, ...unattributedResults];
  const resultIds = new Set<string>();
  for (const result of allResults) {
    if (resultIds.has(result.result_id)) {
      throw invalid(`Result ${result.result_id} が複数の container にあります。`, '$');
    }
    resultIds.add(result.result_id);
    const content = resultContent[result.result_id];
    if (!content) {
      throw invalid(`Result ${result.result_id} に artifact_content がありません。`, '$.artifact_content.results');
    }
    if (content.file_sha256 !== result.result_file_sha256) {
      throw invalid(
        `Result ${result.result_id} の result_file_sha256 が artifact_content と一致しません。`,
        '$.artifact_content.results',
      );
    }
  }
  for (const resultId of Object.keys(resultContent)) {
    if (!resultIds.has(resultId)) {
      throw invalid(`artifact_content の Result ${resultId} がどの container にもありません。`, '$.artifact_content.results');
    }
  }

  // Evaluations: the partition, and the content map, name the same ids; the
  // seal hash is present exactly for the verified containers.
  const partition = evaluationPartitionOf(structure);
  for (const [evaluationId, placement] of partition) {
    const content = evaluationContent[evaluationId];
    if (!content) {
      throw invalid(`Evaluation ${evaluationId} に artifact_content がありません。`, '$.artifact_content.evaluations');
    }
    if (isVerifiedPlacement(placement) !== (content.semantic_sha256 !== undefined)) {
      throw invalid(
        `Evaluation ${evaluationId} の semantic_sha256 は verified の container にある場合だけ必要です。`,
        '$.artifact_content.evaluations',
      );
    }
  }
  for (const evaluationId of Object.keys(evaluationContent)) {
    if (!partition.has(evaluationId)) {
      throw invalid(
        `artifact_content の Evaluation ${evaluationId} がどの container にもありません。`,
        '$.artifact_content.evaluations',
      );
    }
  }
  // A headline is one of its own group's candidates; the group rules above
  // already bind it to `considered`, so no id can head a group it is not in.

  const completenessRecord = expectObject(root.completeness, '$.completeness', [
    'state',
    'sealed_verified_results',
    'sealed_rejected_results',
    'legacy_unsealed_results',
    'unattributed_results',
    'unattributed_rejected_evaluations',
    'unattributed_verified_evaluations',
    'results_with_no_verified_evaluations',
  ]);
  const completeness: RunCompleteness = {
    state: expectOneOf(completenessRecord.state, '$.completeness.state', ['complete', 'partial'] as const),
    sealed_verified_results: expectCount(completenessRecord.sealed_verified_results, '$.completeness.sealed_verified_results'),
    sealed_rejected_results: expectCount(completenessRecord.sealed_rejected_results, '$.completeness.sealed_rejected_results'),
    legacy_unsealed_results: expectCount(completenessRecord.legacy_unsealed_results, '$.completeness.legacy_unsealed_results'),
    unattributed_results: expectCount(completenessRecord.unattributed_results, '$.completeness.unattributed_results'),
    unattributed_rejected_evaluations: expectCount(
      completenessRecord.unattributed_rejected_evaluations,
      '$.completeness.unattributed_rejected_evaluations',
    ),
    unattributed_verified_evaluations: expectCount(
      completenessRecord.unattributed_verified_evaluations,
      '$.completeness.unattributed_verified_evaluations',
    ),
    results_with_no_verified_evaluations: expectCount(
      completenessRecord.results_with_no_verified_evaluations,
      '$.completeness.results_with_no_verified_evaluations',
    ),
  };
  if (canonicalJson(completeness) !== canonicalJson(completenessOf(structure))) {
    throw invalid('completeness が ReportSource 自身の構造と一致しません。', '$.completeness');
  }

  return {
    report_contract_version: REPORT_CONTRACT_VERSION,
    run_id: runId,
    run_evidence: runEvidence,
    results,
    legacy_results: legacyResults,
    unattributed_results: unattributedResults,
    unattributed_rejected_evaluation_ids: unattributedRejected,
    unattributed_verified_evaluation_ids: unattributedVerified,
    artifact_content: { results: resultContent, evaluations: evaluationContent },
    ordering: COMPARISON_ORDERING,
    completeness,
  };
}
