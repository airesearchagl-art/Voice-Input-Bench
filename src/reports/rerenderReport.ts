import {
  assembleRunComparison,
  type ComparisonRun,
  type RunComparisonDeps,
} from '@/comparisons/runComparison';
import {
  verifyEvaluationListEntry,
  type EvaluationListEntry,
} from '@/evaluation/createEvaluation';
import type { EvaluationSubjectReader } from '@/evaluation/evaluationSubject';
import { RunEvidenceError, verifyRunEvidence, type VerifiedRunEvidence } from '@/results/runEvidence';
import { verifyResultListEntry, type ResultListEntry } from '@/results/saveResult';
import { RESULT_FILE, ResultStoreError, TRANSCRIPT_FILE } from '@/storage/LocalResultStore';
import { AUDIO_FILE, MANIFEST_FILE, SOURCE_FILE } from '@/storage/LocalRunStore';
import { canonicalJson } from './canonicalJson';
import { readArtifactBytes, sha256OrNull } from './artifactBytes';
import { ReportError, type EvidenceChange } from './reportErrors';
import {
  NO_HASHES,
  evaluationPartitionOf,
  isVerifiedPlacement,
  resultPlacementsOf,
  structureOf,
  validateReportSource,
  type EvaluationPlacement,
  type PartitionInput,
  type ReportSource,
} from './reportSource';
import {
  composeReportMarkdown,
  hasFindings,
  renderReportBody,
  reportContentSha256,
  type GroupSelection,
  type NotRechecked,
  type ReportFindings,
  type VerificationChange,
} from './renderReport';

/**
 * Re-check an old ReportSource against the evidence and verifier of today.
 *
 * Reads exactly the artifacts the ReportSource names — never a listing — and
 * hands the verifiers only bytes it has just matched against the frozen
 * hashes. An Evaluation created after the report cannot join it, and no
 * verifier can read a Result, transcript or source the report did not pin:
 * Evaluation readback here goes through a subject reader over those frozen
 * bytes, not through the disk. The order is fixed (P4-A `report-contract.md`):
 *
 *  1. validate the ReportSource (untrusted input; fail closed)
 *  2-5. the Run's manifest.json, source.txt and audio.wav bytes against the
 *       frozen hashes — any difference and the report's basis has moved, so
 *       nothing downstream is presented as still holding
 *  6. each named result.json's bytes, and every named Result's transcript.txt
 *     (present or recorded absent); supporting subject Results likewise
 *  7. each named evaluation.json's bytes
 *  8. the seal hashes the ReportSource claims, against the bytes that held
 *  9. only artifacts whose bytes — and whose subject's bytes — held go to the
 *     current verifiers: the same per-artifact functions the listings use
 * 10. current placement and selection against the frozen ones
 * 11. the body re-rendered from what is true now
 *
 * Findings, never merged:
 *
 *   evidence_changed      same id, different (or missing) bytes
 *   verification_changed  same bytes, the current verifier places them differently
 *   not_rechecked         bytes held, but the Result they depend on did not
 *
 * No model is called. Nothing is written.
 */

export interface RerenderDeps extends RunComparisonDeps {
  /**
   * The per-artifact verifiers. Production by default; a test double may stand
   * in to reproduce a verifier whose outcome differs on unchanged bytes.
   */
  verifiers?: {
    result?: typeof verifyResultListEntry;
    evaluation?: typeof verifyEvaluationListEntry;
  };
}

export interface RerenderOutcome {
  /** `reproduced` only when no evidence and no verification outcome changed. */
  status: 'reproduced' | 'changed';
  report_source: ReportSource;
  evidence_changed: EvidenceChange[];
  verification_changed: VerificationChange[];
  not_rechecked: NotRechecked[];
  markdown: string;
  markdown_body: string;
  /** Equal to the original package's when `status` is `reproduced`. */
  content_sha256: string;
  generated_at: string;
}

/** What re-checking a ReportSource found, and the comparison it read. */
export interface FrozenRecheck {
  findings: ReportFindings;
  /** The comparison of exactly the frozen artifacts, as read now. */
  current: ComparisonRun;
}

export async function rerenderReport(
  deps: RerenderDeps,
  input: unknown,
  options: { now?: () => Date } = {},
): Promise<RerenderOutcome> {
  // 1. Untrusted input. Nothing below runs on a ReportSource that did not parse.
  const source = validateReportSource(input);
  const { findings, current } = await recheckFrozenSource(deps, source);
  const changed = hasFindings(findings);

  // 11. The body, from what is true now.
  const body = renderReportBody(source, current, changed ? findings : null);
  const contentSha256 = reportContentSha256(source, body);
  const generatedAt = (options.now ?? (() => new Date()))().toISOString();

  return {
    status: changed ? 'changed' : 'reproduced',
    report_source: source,
    evidence_changed: findings.evidence_changed,
    verification_changed: findings.verification_changed,
    not_rechecked: findings.not_rechecked,
    markdown: composeReportMarkdown(body, contentSha256, generatedAt),
    markdown_body: body,
    content_sha256: contentSha256,
    generated_at: generatedAt,
  };
}

// ── Reading against frozen hashes ───────────────────────────────────────────

interface ReadArtifact {
  bytes: Buffer | null;
  /** Null when the ReportSource recorded the file as absent. */
  expected: string | null;
  actual: string | null;
}

async function readAgainst(file: string, expected: string | null): Promise<ReadArtifact> {
  const bytes = await readArtifactBytes(file);
  return { bytes, expected, actual: sha256OrNull(bytes) };
}

const held = (read: ReadArtifact) => read.actual === read.expected;

function changeOf(
  kind: EvidenceChange['artifact_kind'],
  id: string,
  read: ReadArtifact,
): EvidenceChange | null {
  if (held(read)) return null;
  return {
    artifact_kind: kind,
    artifact_id: id,
    expected_sha256: read.expected,
    actual_sha256: read.actual,
    change: read.actual === null ? 'missing' : read.expected === null ? 'appeared' : 'modified',
  };
}

function parseObject(bytes: Buffer | null): Record<string, unknown> | null {
  if (bytes === null) return null;
  try {
    const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function sealOf(bytes: Buffer | null): unknown {
  const parsed = parseObject(bytes);
  const integrity = parsed?.integrity;
  return typeof integrity === 'object' && integrity !== null
    ? (integrity as Record<string, unknown>).semantic_sha256
    : undefined;
}

interface HeldResult {
  result: ReadArtifact;
  transcript: ReadArtifact;
}

/** A read the frozen evidence cannot answer. Readback reports it; it never reaches the disk. */
class FrozenEvidenceBoundaryError extends Error {
  readonly kind = 'REPORT_SUBJECT_NOT_FROZEN';
  constructor(message: string) {
    super(message);
    this.name = 'FrozenEvidenceBoundaryError';
  }
}

/**
 * Evaluation subjects served from frozen bytes only.
 *
 * The same answers the disk reader would give for these exact bytes — the
 * same parse, the same "transcript missing" — and a boundary error for
 * anything the ReportSource did not pin.
 */
function frozenSubjectReader(input: {
  runId: string;
  runEvidence: VerifiedRunEvidence;
  sourceText: string;
  results: Map<string, HeldResult>;
}): EvaluationSubjectReader {
  const pinned = (resultId: string) => {
    const entry = input.results.get(resultId);
    if (!entry) {
      throw new FrozenEvidenceBoundaryError(
        `Result ${resultId} は ReportSource が固定した evidence にないため読みません。`,
      );
    }
    return entry;
  };
  return {
    async readResult(resultId) {
      const entry = pinned(resultId);
      try {
        return JSON.parse((entry.result.bytes ?? Buffer.alloc(0)).toString('utf8')) as unknown;
      } catch (cause) {
        throw new ResultStoreError(
          'RESULT_UNREADABLE',
          `Result ${resultId} の result.json が JSON として解釈できません。`,
          { cause },
        );
      }
    },
    async readTranscript(resultId) {
      const entry = pinned(resultId);
      if (entry.transcript.bytes === null) {
        throw new ResultStoreError('RESULT_NOT_FOUND', `Result ${resultId} の transcript が見つかりません。`);
      }
      return entry.transcript.bytes.toString('utf8');
    },
    async readSource(runId) {
      if (runId !== input.runId) {
        throw new FrozenEvidenceBoundaryError(`Run ${runId} の source.txt は固定されていないため読みません。`);
      }
      return input.sourceText;
    },
    async verifyRun(runId) {
      if (runId !== input.runId) {
        throw new FrozenEvidenceBoundaryError(`Run ${runId} は ReportSource の Run ではないため読みません。`);
      }
      return input.runEvidence;
    },
  };
}

function groupSelectionsOf(structure: PartitionInput): Map<string, GroupSelection> {
  const selections = new Map<string, GroupSelection>();
  for (const result of structure.results) {
    if (result.kind !== 'verified') continue;
    for (const group of result.evaluation_groups) {
      selections.set(`${result.result_id}/${group.evaluator_id}`, {
        considered_evaluation_ids: group.considered_evaluation_ids,
        headline_evaluation_id: group.headline_evaluation_id,
        selection_reason: group.selection_reason,
      });
    }
  }
  return selections;
}

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function sourceContradiction(message: string, path: string): ReportError {
  return new ReportError('REPORT_SOURCE_INVALID', message, { detail: `path=${path}` });
}

/**
 * Steps 2-10 over an already-validated ReportSource.
 *
 * Also what a new package is checked against before it is returned, so a
 * fresh build and a later re-render derive their body the same way.
 */
export async function recheckFrozenSource(
  deps: RerenderDeps,
  source: ReportSource,
): Promise<FrozenRecheck> {
  const runId = source.run_id;
  const verifyResult = deps.verifiers?.result ?? verifyResultListEntry;
  const verifyEvaluation = deps.verifiers?.evaluation ?? verifyEvaluationListEntry;

  // 2-5. The Run's basis, first. Every id below is an id about this Run.
  const basis = {
    manifest: await readAgainst(
      deps.runStore.resolveRunFile(runId, MANIFEST_FILE),
      source.run_evidence.manifest_file_sha256,
    ),
    source: await readAgainst(deps.runStore.resolveRunFile(runId, SOURCE_FILE), source.run_evidence.source_sha256),
    audio: await readAgainst(deps.runStore.resolveRunFile(runId, AUDIO_FILE), source.run_evidence.audio_sha256),
  };
  const basisChanges = [
    changeOf('manifest', runId, basis.manifest),
    changeOf('source', runId, basis.source),
    changeOf('audio', runId, basis.audio),
  ].filter((change): change is EvidenceChange => change !== null);
  if (basisChanges.length > 0) {
    throw new ReportError(
      'REPORT_RUN_BASIS_CHANGED',
      'この Report が書かれた Run の manifest.json / source.txt / audio.wav が、現在のファイルと一致しません。Report 全体の前提が変わっています。',
      { evidenceChanged: basisChanges },
    );
  }

  // 6. Results by exactly the ids named: result.json and transcript.txt both.
  const evidenceChanged: EvidenceChange[] = [];
  const resultReads = new Map<string, HeldResult>();
  for (const [resultId, content] of Object.entries(source.artifact_content.results)) {
    const read: HeldResult = {
      result: await readAgainst(deps.resultStore.resolveResultFile(resultId, RESULT_FILE), content.file_sha256),
      transcript: await readAgainst(
        deps.resultStore.resolveResultFile(resultId, TRANSCRIPT_FILE),
        content.transcript_file_sha256,
      ),
    };
    for (const change of [changeOf('result', resultId, read.result), changeOf('transcript', resultId, read.transcript)]) {
      if (change) evidenceChanged.push(change);
    }
    resultReads.set(resultId, read);
  }
  // Supporting subjects: frozen only because a verified Evaluation reads them.
  const supportingReads = new Map<string, HeldResult>();
  for (const [resultId, content] of Object.entries(source.supporting_results)) {
    const read: HeldResult = {
      result: await readAgainst(deps.resultStore.resolveResultFile(resultId, RESULT_FILE), content.result_file_sha256),
      transcript: await readAgainst(
        deps.resultStore.resolveResultFile(resultId, TRANSCRIPT_FILE),
        content.transcript_file_sha256,
      ),
    };
    for (const change of [
      changeOf('supporting_result', resultId, read.result),
      changeOf('supporting_transcript', resultId, read.transcript),
    ]) {
      if (change) evidenceChanged.push(change);
    }
    supportingReads.set(resultId, read);
  }
  const bothHeld = (read: HeldResult | undefined) =>
    read !== undefined && held(read.result) && held(read.transcript);

  // 7. Evaluations by exactly the ids named.
  const structure: PartitionInput = source;
  const partition = evaluationPartitionOf(structure);
  const evaluationReads = new Map<string, ReadArtifact>();
  for (const [evaluationId, content] of Object.entries(source.artifact_content.evaluations)) {
    const read = await readAgainst(deps.evaluationStore.resolveEvaluationFile(evaluationId), content.file_sha256);
    const change = changeOf('evaluation', evaluationId, read);
    if (change) evidenceChanged.push(change);
    evaluationReads.set(evaluationId, read);
  }

  // 8. The seals the ReportSource claims must be the seals in the bytes that
  // held. A mismatch is the source contradicting its own evidence — neither
  // moved evidence nor a verifier change — and nothing is reproduced from it.
  for (const result of source.results) {
    if (result.kind !== 'verified') continue;
    const read = resultReads.get(result.result_id)!;
    if (held(read.result) && sealOf(read.result.bytes) !== result.result_semantic_sha256) {
      throw sourceContradiction(
        `Result ${result.result_id} の result_semantic_sha256 が、固定された result.json の seal と一致しません。`,
        `$.results[${result.result_id}].result_semantic_sha256`,
      );
    }
  }
  for (const [evaluationId, content] of Object.entries(source.artifact_content.evaluations)) {
    if (content.semantic_sha256 === undefined) continue;
    const read = evaluationReads.get(evaluationId)!;
    if (held(read) && sealOf(read.bytes) !== content.semantic_sha256) {
      throw sourceContradiction(
        `Evaluation ${evaluationId} の semantic_sha256 が、固定された evaluation.json の seal と一致しません。`,
        `$.artifact_content.evaluations.${evaluationId}.semantic_sha256`,
      );
    }
  }

  // 9. Only now, the current verifiers — and only over bytes that held.
  let runEvidence: VerifiedRunEvidence;
  try {
    runEvidence = await verifyRunEvidence(deps.runStore, runId);
  } catch (caught) {
    if (caught instanceof RunEvidenceError) {
      throw new ReportError(
        'REPORT_RUN_VERIFICATION_CHANGED',
        'Run の manifest.json / source.txt / audio.wav は Report 時点と同じ bytes ですが、現在の verifier は Run を受け付けません。',
        { detail: `current=${caught.kind}${caught.detail ? ` ${caught.detail}` : ''}` },
      );
    }
    throw caught;
  }
  if (
    runEvidence.testId !== source.run_evidence.test_id ||
    runEvidence.manifestSchemaVersion !== source.run_evidence.manifest_schema_version
  ) {
    throw sourceContradiction(
      'ReportSource の run_evidence が、自身が固定した manifest.json の内容と矛盾しています。',
      '$.run_evidence',
    );
  }

  const heldSubjects = new Map<string, HeldResult>();
  for (const [resultId, read] of [...resultReads, ...supportingReads]) {
    if (bothHeld(read)) heldSubjects.set(resultId, read);
  }
  const reader = frozenSubjectReader({
    runId,
    runEvidence,
    sourceText: basis.source.bytes!.toString('utf8'),
    results: heldSubjects,
  });

  const placements = resultPlacementsOf(structure);
  const currentResults: ResultListEntry[] = [];
  const resultCandidates = new Set<string>();
  for (const resultId of placements.keys()) {
    const read = resultReads.get(resultId);
    if (!bothHeld(read)) continue;
    resultCandidates.add(resultId);
    const stored = parseObject(read!.result.bytes);
    // As the listing does: a file that is not this Run's Result is not placed.
    if (stored === null || stored.run_id !== runId) continue;
    currentResults.push(
      await verifyResult({
        resultId,
        stored,
        runId,
        runEvidence,
        loadTranscript: async () => read!.transcript.bytes?.toString('utf8') ?? null,
      }),
    );
  }

  const notRechecked: NotRechecked[] = [];
  const currentEvaluations: EvaluationListEntry[] = [];
  const evaluationCandidates = new Set<string>();
  for (const [evaluationId, placement] of partition) {
    const read = evaluationReads.get(evaluationId)!;
    if (!held(read)) continue;
    const subject = subjectOf(source, evaluationId, placement);
    if (subject !== null && !heldSubjects.has(subject)) {
      notRechecked.push({
        artifact_kind: 'evaluation',
        artifact_id: evaluationId,
        because: 'subject_result_evidence_changed',
        subject_result_id: subject,
      });
      continue;
    }
    evaluationCandidates.add(evaluationId);
    const stored = parseObject(read.bytes);
    if (stored === null || stored.run_id !== runId) continue;
    currentEvaluations.push(await verifyEvaluation(deps, evaluationId, stored, reader));
  }

  // 10. What the current reading places where, against what was frozen.
  const current = assembleRunComparison({
    runEvidence,
    results: currentResults,
    evaluations: currentEvaluations,
  });
  const verificationChanged = compareStructures({
    frozen: structure,
    current: structureOf(current, NO_HASHES),
    resultCandidates,
    evaluationCandidates,
    currentResults,
    currentEvaluations,
  });

  // The Run verifier read the Run's files from disk. Confirm nothing cited
  // moved while the checks ran.
  await assertStillSame(deps, source, basis, resultReads, supportingReads, evaluationReads);

  notRechecked.sort((a, b) => byId(a.artifact_id, b.artifact_id));
  return {
    findings: {
      evidence_changed: evidenceChanged,
      verification_changed: verificationChanged,
      not_rechecked: notRechecked,
    },
    current,
  };
}

/**
 * The Result whose bytes an Evaluation's readback reads, as the ReportSource
 * froze it — or null when it names none the report pinned.
 */
function subjectOf(source: ReportSource, evaluationId: string, placement: EvaluationPlacement): string | null {
  if (isVerifiedPlacement(placement)) {
    return source.verified_evaluation_subjects[evaluationId]?.subject_result_id ?? null;
  }
  return 'result_id' in placement ? placement.result_id : null;
}

/**
 * Same bytes, different current reading — per Result, per Evaluation, per group.
 *
 * Only artifacts that were re-checked are compared: an artifact whose bytes
 * moved is an evidence change, and one standing on moved evidence was not
 * re-checked, so neither is ever reported as a verifier change.
 */
function compareStructures(input: {
  frozen: PartitionInput;
  current: PartitionInput;
  resultCandidates: Set<string>;
  evaluationCandidates: Set<string>;
  currentResults: ResultListEntry[];
  currentEvaluations: EvaluationListEntry[];
}): VerificationChange[] {
  const changes: VerificationChange[] = [];

  const resultReason = new Map<string, string>();
  for (const entry of input.currentResults) {
    if (entry.status === 'rejected') resultReason.set(entry.resultId, entry.reason);
  }
  const evaluationReason = new Map<string, string>();
  for (const entry of input.currentEvaluations) {
    if (entry.status === 'rejected') evaluationReason.set(entry.evaluationId, entry.reason);
  }

  const frozenResults = resultPlacementsOf(input.frozen);
  const currentResults = resultPlacementsOf(input.current);
  const unchangedResults = new Set<string>();
  for (const resultId of input.resultCandidates) {
    const before = frozenResults.get(resultId)!;
    const after = currentResults.get(resultId) ?? null;
    if (after !== null && same(before, after)) {
      unchangedResults.add(resultId);
      continue;
    }
    changes.push({
      artifact_kind: 'result',
      artifact_id: resultId,
      report_time: before,
      current: after,
      ...(resultReason.has(resultId) ? { current_reason: resultReason.get(resultId)! } : {}),
    });
  }

  const frozenPartition = evaluationPartitionOf(input.frozen);
  const currentPartition = evaluationPartitionOf(input.current);
  for (const evaluationId of input.evaluationCandidates) {
    const before = frozenPartition.get(evaluationId)!;
    const after = currentPartition.get(evaluationId) ?? null;
    if (after !== null && same(before, after)) continue;
    changes.push({
      artifact_kind: 'evaluation',
      artifact_id: evaluationId,
      report_time: before,
      current: after,
      ...(evaluationReason.has(evaluationId) ? { current_reason: evaluationReason.get(evaluationId)! } : {}),
    });
  }

  // A group is compared only when its Result held its place and every one of
  // its frozen candidates was re-checked; otherwise its difference is already
  // explained by a change reported above or by moved evidence.
  const frozenGroups = groupSelectionsOf(input.frozen);
  const currentGroups = groupSelectionsOf(input.current);
  for (const [key, before] of frozenGroups) {
    const resultId = key.slice(0, key.indexOf('/'));
    if (!unchangedResults.has(resultId)) continue;
    if (!before.considered_evaluation_ids.every((id) => input.evaluationCandidates.has(id))) continue;
    const after = currentGroups.get(key) ?? null;
    if (after !== null && same(before, after)) continue;
    changes.push({ artifact_kind: 'evaluator_group', artifact_id: key, report_time: before, current: after });
  }

  // Results, then Evaluations, then groups; each by artifact id ascending.
  const kindRank = { result: 0, evaluation: 1, evaluator_group: 2 } as const;
  return changes.sort(
    (a, b) => kindRank[a.artifact_kind] - kindRank[b.artifact_kind] || byId(a.artifact_id, b.artifact_id),
  );
}

async function assertStillSame(
  deps: RunComparisonDeps,
  source: ReportSource,
  basis: Record<'manifest' | 'source' | 'audio', ReadArtifact>,
  resultReads: Map<string, HeldResult>,
  supportingReads: Map<string, HeldResult>,
  evaluationReads: Map<string, ReadArtifact>,
): Promise<void> {
  const again = async (file: string) => sha256OrNull(await readArtifactBytes(file));
  const moved: string[] = [];
  const runId = source.run_id;
  if ((await again(deps.runStore.resolveRunFile(runId, MANIFEST_FILE))) !== basis.manifest.actual) moved.push(MANIFEST_FILE);
  if ((await again(deps.runStore.resolveRunFile(runId, SOURCE_FILE))) !== basis.source.actual) moved.push(SOURCE_FILE);
  if ((await again(deps.runStore.resolveRunFile(runId, AUDIO_FILE))) !== basis.audio.actual) moved.push(AUDIO_FILE);
  for (const [resultId, read] of [...resultReads, ...supportingReads]) {
    if ((await again(deps.resultStore.resolveResultFile(resultId, RESULT_FILE))) !== read.result.actual) {
      moved.push(`${resultId}/${RESULT_FILE}`);
    }
    if ((await again(deps.resultStore.resolveResultFile(resultId, TRANSCRIPT_FILE))) !== read.transcript.actual) {
      moved.push(`${resultId}/${TRANSCRIPT_FILE}`);
    }
  }
  for (const [evaluationId, read] of evaluationReads) {
    if ((await again(deps.evaluationStore.resolveEvaluationFile(evaluationId))) !== read.actual) {
      moved.push(`${evaluationId}/evaluation.json`);
    }
  }
  if (moved.length > 0) {
    throw new ReportError(
      'REPORT_EVIDENCE_CHANGED_DURING_BUILD',
      '再確認の途中で引用 artifact の bytes が変わりました。混在した結果は返しません。',
      { detail: `moved=${moved.join(',')}` },
    );
  }
}
