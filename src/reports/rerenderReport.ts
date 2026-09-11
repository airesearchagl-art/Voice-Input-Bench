import { assembleRunComparison, type RunComparisonDeps } from '@/comparisons/runComparison';
import {
  verifyEvaluationListEntry,
  type EvaluationListEntry,
} from '@/evaluation/createEvaluation';
import { RunEvidenceError, verifyRunEvidence, type VerifiedRunEvidence } from '@/results/runEvidence';
import { verifyResultListEntry, type ResultListEntry } from '@/results/saveResult';
import { RESULT_FILE, TRANSCRIPT_FILE } from '@/storage/LocalResultStore';
import { AUDIO_FILE, MANIFEST_FILE, SOURCE_FILE } from '@/storage/LocalRunStore';
import { canonicalJson } from './canonicalJson';
import { readArtifactBytes, sha256OrNull } from './artifactBytes';
import { ReportError, type EvidenceChange } from './reportErrors';
import {
  NO_HASHES,
  evaluationPartitionOf,
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
 * Reads exactly the ids the ReportSource names — never a listing — so an
 * Evaluation created after the report cannot join it, enter a container or
 * become a new headline. The order is fixed (P4-A `report-contract.md`):
 *
 *  1. validate the ReportSource (untrusted input; fail closed)
 *  2-5. the Run's manifest.json, source.txt and audio.wav bytes against the
 *       frozen hashes — any difference and the report's basis has moved, so
 *       nothing downstream is presented as still holding
 *  6. each named result.json's bytes
 *  7. each report-time-verified Result's transcript.txt bytes
 *  8. each named evaluation.json's bytes
 *  9. only artifacts whose bytes held go to the current verifiers — the same
 *     per-artifact functions the listings use, over the bytes just hashed
 * 10. current placement and selection against the frozen ones
 * 11. the body re-rendered from what is true now
 *
 * Two different findings, never merged:
 *
 *   evidence_changed      same id, different (or missing) bytes
 *   verification_changed  same bytes, the current verifier places them differently
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

interface ReadArtifact {
  bytes: Buffer | null;
  expected: string;
  actual: string | null;
}

async function readAgainst(file: string, expected: string): Promise<ReadArtifact> {
  const bytes = await readArtifactBytes(file);
  return { bytes, expected, actual: sha256OrNull(bytes) };
}

function changeOf(
  kind: EvidenceChange['artifact_kind'],
  id: string,
  read: ReadArtifact,
): EvidenceChange | null {
  if (read.actual === read.expected) return null;
  return {
    artifact_kind: kind,
    artifact_id: id,
    expected_sha256: read.expected,
    actual_sha256: read.actual,
    change: read.actual === null ? 'missing' : 'modified',
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

function subjectOf(placement: EvaluationPlacement): string | null {
  return 'result_id' in placement ? placement.result_id : null;
}

function reportTimeTranscriptIds(source: ReportSource): Set<string> {
  const ids = new Set<string>();
  for (const result of source.results) if (result.kind === 'verified') ids.add(result.result_id);
  for (const result of source.legacy_results) {
    if (result.kind === 'legacy-unsealed-verified') ids.add(result.result_id);
  }
  return ids;
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

export async function rerenderReport(
  deps: RerenderDeps,
  input: unknown,
  options: { now?: () => Date } = {},
): Promise<RerenderOutcome> {
  // 1. Untrusted input. Nothing below runs on a ReportSource that did not parse.
  const source = validateReportSource(input);
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

  // 6-7. Results, by exactly the ids named.
  const structure: PartitionInput = source;
  const placements = resultPlacementsOf(structure);
  const withTranscript = reportTimeTranscriptIds(source);
  const evidenceChanged: EvidenceChange[] = [];
  const resultReads = new Map<string, { result: ReadArtifact; transcript: ReadArtifact | null }>();
  for (const [resultId, content] of Object.entries(source.artifact_content.results)) {
    const result = await readAgainst(deps.resultStore.resolveResultFile(resultId, RESULT_FILE), content.file_sha256);
    let transcript: ReadArtifact | null = null;
    const change = changeOf('result', resultId, result);
    if (change) evidenceChanged.push(change);
    if (withTranscript.has(resultId)) {
      const frozen = transcriptShaOf(source, resultId);
      transcript = await readAgainst(deps.resultStore.resolveResultFile(resultId, TRANSCRIPT_FILE), frozen);
      const transcriptChange = changeOf('transcript', resultId, transcript);
      if (transcriptChange) evidenceChanged.push(transcriptChange);
    }
    resultReads.set(resultId, { result, transcript });
  }
  const resultHeld = (resultId: string) => {
    const read = resultReads.get(resultId);
    return (
      read !== undefined &&
      read.result.actual === read.result.expected &&
      (read.transcript === null || read.transcript.actual === read.transcript.expected)
    );
  };

  // 8. Evaluations, by exactly the ids named.
  const partition = evaluationPartitionOf(structure);
  const evaluationReads = new Map<string, ReadArtifact>();
  for (const [evaluationId, content] of Object.entries(source.artifact_content.evaluations)) {
    const read = await readAgainst(deps.evaluationStore.resolveEvaluationFile(evaluationId), content.file_sha256);
    const change = changeOf('evaluation', evaluationId, read);
    if (change) evidenceChanged.push(change);
    evaluationReads.set(evaluationId, read);
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
    throw new ReportError(
      'REPORT_SOURCE_INVALID',
      'ReportSource の run_evidence が、自身が固定した manifest.json の内容と矛盾しています。',
      { detail: 'path=$.run_evidence' },
    );
  }

  const currentResults: ResultListEntry[] = [];
  for (const resultId of placements.keys()) {
    if (!resultHeld(resultId)) continue;
    const read = resultReads.get(resultId)!;
    const stored = parseObject(read.result.bytes);
    // As the listing does: a file that is not this Run's Result is not placed.
    if (stored === null || stored.run_id !== runId) continue;
    currentResults.push(
      await verifyResult({
        resultId,
        stored,
        runId,
        runEvidence,
        loadTranscript: async () => {
          if (read.transcript !== null) return read.transcript.bytes?.toString('utf8') ?? null;
          // Not cited at report time: a Result that did not verify then had no
          // transcript the report quoted, so there is no frozen byte identity
          // for it to be checked against.
          const bytes = await readArtifactBytes(deps.resultStore.resolveResultFile(resultId, TRANSCRIPT_FILE));
          return bytes === null ? null : bytes.toString('utf8');
        },
      }),
    );
  }

  const notRechecked: NotRechecked[] = [];
  const currentEvaluations: EvaluationListEntry[] = [];
  for (const [evaluationId, placement] of partition) {
    const read = evaluationReads.get(evaluationId)!;
    if (read.actual !== read.expected) continue;
    const subject = subjectOf(placement);
    if (subject !== null && !resultHeld(subject)) {
      notRechecked.push({
        artifact_kind: 'evaluation',
        artifact_id: evaluationId,
        because: 'subject_result_evidence_changed',
        subject_result_id: subject,
      });
      continue;
    }
    const stored = parseObject(read.bytes);
    if (stored === null || stored.run_id !== runId) continue;
    currentEvaluations.push(await verifyEvaluation(deps, evaluationId, stored));
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
    rechecked: {
      resultCandidates: new Set([...placements.keys()].filter((id) => resultHeld(id))),
      evaluationCandidates: new Set(
        [...partition.keys()].filter((id) => {
          const read = evaluationReads.get(id)!;
          const subject = subjectOf(partition.get(id)!);
          return read.actual === read.expected && (subject === null || resultHeld(subject));
        }),
      ),
    },
    currentResults,
    currentEvaluations,
  });

  // The verifiers read the subject Result, transcript and source from disk.
  // Confirm nothing cited moved while they did.
  await assertStillSame(deps, source, basis, resultReads, evaluationReads);

  notRechecked.sort((a, b) => (a.artifact_id < b.artifact_id ? -1 : a.artifact_id > b.artifact_id ? 1 : 0));
  const findings: ReportFindings = {
    evidence_changed: evidenceChanged,
    verification_changed: verificationChanged,
    not_rechecked: notRechecked,
  };
  const changed = hasFindings(findings);

  // 11. The body, from what is true now.
  const body = renderReportBody(source, current, changed ? findings : null);
  const contentSha256 = reportContentSha256(source, body);
  const generatedAt = (options.now ?? (() => new Date()))().toISOString();

  return {
    status: changed ? 'changed' : 'reproduced',
    report_source: source,
    evidence_changed: evidenceChanged,
    verification_changed: verificationChanged,
    not_rechecked: notRechecked,
    markdown: composeReportMarkdown(body, contentSha256, generatedAt),
    markdown_body: body,
    content_sha256: contentSha256,
    generated_at: generatedAt,
  };
}

function transcriptShaOf(source: ReportSource, resultId: string): string {
  for (const result of source.results) {
    if (result.result_id === resultId && result.kind === 'verified') return result.transcript_sha256;
  }
  for (const result of source.legacy_results) {
    if (result.result_id === resultId && result.kind === 'legacy-unsealed-verified') {
      return result.transcript_sha256;
    }
  }
  throw new Error(`Result ${resultId} は report 時点で transcript を引用していません。`);
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
  rechecked: {
    resultCandidates: Set<string>;
    evaluationCandidates: Set<string>;
  };
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
  for (const resultId of input.rechecked.resultCandidates) {
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
  for (const evaluationId of input.rechecked.evaluationCandidates) {
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
    if (!before.considered_evaluation_ids.every((id) => input.rechecked.evaluationCandidates.has(id))) {
      continue;
    }
    const after = currentGroups.get(key) ?? null;
    if (after !== null && same(before, after)) continue;
    changes.push({ artifact_kind: 'evaluator_group', artifact_id: key, report_time: before, current: after });
  }

  // Results, then Evaluations, then groups; each by artifact id ascending.
  const kindRank = { result: 0, evaluation: 1, evaluator_group: 2 } as const;
  return changes.sort(
    (a, b) =>
      kindRank[a.artifact_kind] - kindRank[b.artifact_kind] ||
      (a.artifact_id < b.artifact_id ? -1 : a.artifact_id > b.artifact_id ? 1 : 0),
  );
}

async function assertStillSame(
  deps: RunComparisonDeps,
  source: ReportSource,
  basis: Record<'manifest' | 'source' | 'audio', ReadArtifact>,
  resultReads: Map<string, { result: ReadArtifact; transcript: ReadArtifact | null }>,
  evaluationReads: Map<string, ReadArtifact>,
): Promise<void> {
  const again = async (file: string) => sha256OrNull(await readArtifactBytes(file));
  const moved: string[] = [];
  const runId = source.run_id;
  if ((await again(deps.runStore.resolveRunFile(runId, MANIFEST_FILE))) !== basis.manifest.actual) moved.push(MANIFEST_FILE);
  if ((await again(deps.runStore.resolveRunFile(runId, SOURCE_FILE))) !== basis.source.actual) moved.push(SOURCE_FILE);
  if ((await again(deps.runStore.resolveRunFile(runId, AUDIO_FILE))) !== basis.audio.actual) moved.push(AUDIO_FILE);
  for (const [resultId, read] of resultReads) {
    if ((await again(deps.resultStore.resolveResultFile(resultId, RESULT_FILE))) !== read.result.actual) {
      moved.push(`${resultId}/${RESULT_FILE}`);
    }
    if (
      read.transcript !== null &&
      (await again(deps.resultStore.resolveResultFile(resultId, TRANSCRIPT_FILE))) !== read.transcript.actual
    ) {
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
