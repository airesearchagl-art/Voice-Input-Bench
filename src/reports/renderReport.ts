import type {
  ComparisonEvaluationGroup,
  ComparisonRejectedEvaluation,
  ComparisonRun,
  ComparisonVerifiedEvaluation,
  ComparisonVerifiedResult,
  EvaluationSummary,
  SemanticSummary,
  ToolIdentity,
} from '@/comparisons/runComparison';
import type { EvaluatorId } from '@/evaluation/createEvaluation';
import type { SemanticDecisionSource } from '@/evaluation/semanticDecision';
import { sha256OfText } from '@/lib/hash';
import { CANONICAL_JSON_ID, canonicalJson } from './canonicalJson';
import type { EvidenceChange } from './reportErrors';
import type { EvaluationPlacement, ReportSource, ResultPlacement } from './reportSource';

/**
 * report-markdown-v1 — the deterministic body of a Report.
 *
 * The body is a pure function of the ReportSource, the comparison as the
 * current verifier reads those exact artifacts, and (on a re-render) what
 * changed. No clock, no locale, no environment: the same inputs produce the
 * same bytes — UTF-8, LF only, one trailing LF.
 *
 * Every piece of text that came from an artifact or a verifier — transcripts,
 * tool names, messages — is written inside a code span or a fenced block, so
 * nothing stored can turn itself into Markdown structure.
 *
 * No score, no ranking, no winner. Raw, Surface, Critical and Semantic are
 * written as four separate sections, and nothing combines them.
 */

export const REPORT_RENDERER_ID = 'report-markdown-v1';

/**
 * Where the presentation footer begins in `report.md`.
 *
 * Everything before this line is the deterministic body; the footer after it
 * carries `content_sha256` and `generated_at`, which are presentation only.
 */
export const PRESENTATION_FOOTER_MARKER = '<!-- vib-report:presentation-footer -->';

// ── Re-render findings (rendered when a re-render found anything) ──────────

/** Same bytes, and the current verifier places or selects differently. */
export interface VerificationChange {
  artifact_kind: 'result' | 'evaluation' | 'evaluator_group';
  /** Result id, Evaluation id, or `<result-id>/<evaluator-id>` for a group. */
  artifact_id: string;
  report_time: ResultPlacement | EvaluationPlacement | GroupSelection;
  /** Null when the artifact is no longer placed anywhere by the current reading. */
  current: ResultPlacement | EvaluationPlacement | GroupSelection | null;
  /** The current verifier's rejection kind, when it now rejects. */
  current_reason?: string;
}

export interface GroupSelection {
  considered_evaluation_ids: string[];
  headline_evaluation_id: string | null;
  selection_reason: string | null;
}

/** An artifact whose own bytes held, but which stands on evidence that did not. */
export interface NotRechecked {
  artifact_kind: 'evaluation';
  artifact_id: string;
  because: 'subject_result_evidence_changed';
  subject_result_id: string;
}

export interface ReportFindings {
  evidence_changed: EvidenceChange[];
  verification_changed: VerificationChange[];
  not_rechecked: NotRechecked[];
}

export function hasFindings(findings: ReportFindings | null): findings is ReportFindings {
  return (
    findings !== null &&
    (findings.evidence_changed.length > 0 ||
      findings.verification_changed.length > 0 ||
      findings.not_rechecked.length > 0)
  );
}

// ── Identity ────────────────────────────────────────────────────────────────

/**
 * The Report's content identity: `sha256(canonical-json-v1({report_source,
 * markdown_body}))`, over UTF-8. `generated_at` is not in it, and neither is
 * the presentation footer.
 */
export function reportContentSha256(source: ReportSource, markdownBody: string): string {
  return sha256OfText(canonicalJson({ markdown_body: markdownBody, report_source: source }));
}

export function renderPresentationFooter(contentSha256: string, generatedAt: string): string {
  return [
    PRESENTATION_FOOTER_MARKER,
    '',
    '---',
    '',
    `- content_sha256: \`${contentSha256}\``,
    `- generated_at: \`${generatedAt}\` (presentation only; not part of content identity)`,
    '',
  ].join('\n');
}

/** `report.md`: the deterministic body, then the presentation footer. */
export function composeReportMarkdown(body: string, contentSha256: string, generatedAt: string): string {
  return `${body}\n${renderPresentationFooter(contentSha256, generatedAt)}`;
}

/**
 * Recover the deterministic body from a `report.md`, or null if the footer
 * marker is missing. The inverse of `composeReportMarkdown`.
 */
export function splitReportMarkdown(markdown: string): { body: string; footer: string } | null {
  const at = markdown.lastIndexOf(`\n${PRESENTATION_FOOTER_MARKER}\n`);
  if (at < 0) return null;
  return { body: markdown.slice(0, at), footer: markdown.slice(at + 1) };
}

// ── Text helpers ────────────────────────────────────────────────────────────

function longestRun(text: string, char: string): number {
  let longest = 0;
  let current = 0;
  for (const c of text) {
    current = c === char ? current + 1 : 0;
    if (current > longest) longest = current;
  }
  return longest;
}

/** One-line inline code, fenced long enough that the text cannot close it. */
function code(text: string): string {
  const single = text.replace(/\r\n|\r|\n/g, ' ');
  if (single.length === 0) return '` `';
  const fence = '`'.repeat(longestRun(single, '`') + 1);
  const pad = single.startsWith('`') || single.endsWith('`') || single.startsWith(' ') ? ' ' : '';
  return `${fence}${pad}${single}${pad}${fence}`;
}

/** A fenced block holding text exactly (line breaks as LF). */
function fenced(text: string): string {
  const body = text.replace(/\r\n|\r/g, '\n');
  const fence = '`'.repeat(Math.max(3, longestRun(body, '`') + 1));
  return `${fence}text\n${body}${body.endsWith('\n') ? '' : '\n'}${fence}`;
}

function ids(list: readonly string[]): string {
  return list.length === 0 ? '(none)' : list.map(code).join(', ');
}

const EVALUATOR_LABELS: Record<EvaluatorId, string> = {
  'raw-char-v1': 'Raw',
  'surface-normalized-char-v1': 'Surface',
  'critical-info-v1': 'Critical',
  'semantic-h3-v1': 'Semantic',
};

function toolLabel(tool: ToolIdentity): string {
  return tool.kind === 'built-in' ? code(tool.id) : `${code('other')} ${code(tool.trusted_name)}`;
}

// ── Semantic wording ────────────────────────────────────────────────────────

/** The only two words semantic-h3-v1 may say. Never PASS, SAFE, PRESERVED or OK. */
export function semanticVerdict(summary: SemanticSummary): 'CHANGED' | 'REVIEW REQUIRED' {
  return summary.decision === 'changed' ? 'CHANGED' : 'REVIEW REQUIRED';
}

const DECISION_SOURCE_NOTES: Record<SemanticDecisionSource, string> = {
  'critical-guard-veto-v1':
    'Critical guard が supported mismatch を検出したため CHANGED。モデルは実行されていません。',
  'full-run-unanimous-changed-v1': '3 回すべて parseable で、全会一致で changed と回答したため CHANGED。',
  'full-run-unanimous-preserved-requires-review-v1':
    '3 回とも意味保持と回答しましたが、H3 は自動で保持判定を出さないため REVIEW REQUIRED。',
  'no-valid-run-evidence-v1': '使える実行結果が 1 件もないため REVIEW REQUIRED。',
  'incomplete-run-evidence-v1': '使える実行結果が 3 件に満たないため REVIEW REQUIRED。',
  'split-vote-v1': '3 回の回答が割れたため REVIEW REQUIRED。',
};

export const CRITICAL_VETO_ROUTE_NOTE =
  'Critical guard が決定しました。モデルは実行されていません。0 runs は欠損ではありません。';

/** The p12-style limitation, carried wherever a Critical veto decided. */
export const SELF_CORRECTION_LIMITATION_NOTE =
  'Known Limitation（自己訂正）: 「二千六百、あ、すみません、二千七百」のような自己訂正は、' +
  '最終的な意図としては保持されていても、critical-info-v1 からは数値の multiset 不一致に見えます。' +
  'そのため p12 型の事例は決定的に CHANGED になります。これは既知の限界であり、例外規則は入れていません。';

export const MISSING_NOTE = 'verified evidence なし（0 点でも失敗でも合格でもありません）';

const SELECTION_NOTES: Record<string, string> = {
  'only-verified-entry-v1': 'verified は 1 件のみ',
  'newest-verified-by-id-v1':
    '一致する複数の verified のうち evaluation_id が最大のもの（選択であり優劣ではありません）',
  'conflict-no-headline-v1': 'verified 同士が食い違うため headline なし（多数決・新しさでは解決しません）',
};

// ── Summaries ───────────────────────────────────────────────────────────────

function summaryLines(summary: EvaluationSummary, indent: string): string[] {
  switch (summary.kind) {
    case 'raw-char-v1':
      return [
        `${indent}- exact_match: ${summary.exact_match} · CER: ${summary.cer} · edit distance: ${summary.edit_distance}` +
          ` (S ${summary.substitutions} / D ${summary.deletions} / I ${summary.insertions})`,
        `${indent}- chars: reference ${summary.reference_chars} / hypothesis ${summary.hypothesis_chars}`,
      ];
    case 'surface-normalized-char-v1':
      return [
        `${indent}- exact_match: ${summary.exact_match} · CER: ${summary.cer} · edit distance: ${summary.edit_distance}` +
          ` (S ${summary.substitutions} / D ${summary.deletions} / I ${summary.insertions})`,
        `${indent}- normalized reference: ${summary.normalized.reference.chars} chars ${code(summary.normalized.reference.sha256)}`,
        `${indent}- normalized hypothesis: ${summary.normalized.hypothesis.chars} chars ${code(summary.normalized.hypothesis.sha256)}`,
      ];
    case 'critical-info-v1':
      return [
        `${indent}- exact_entity_multiset_match: ${summary.exact_entity_multiset_match} · preservation_rate: ${summary.preservation_rate}`,
        `${indent}- entities: reference ${summary.reference_entities} / hypothesis ${summary.hypothesis_entities}` +
          ` · matched ${summary.matched} · missing ${summary.missing} · extra ${summary.extra}`,
        `${indent}- missing keys: ${ids(summary.missing_keys)}`,
        `${indent}- extra keys: ${ids(summary.extra_keys)}`,
      ];
    case 'semantic-h3-v1':
      return semanticLines(summary, indent);
  }
}

function semanticLines(summary: SemanticSummary, indent: string): string[] {
  const { execution, critical_guard: guard } = summary;
  const lines = [
    `${indent}- Decision: **${semanticVerdict(summary)}** (${code(summary.decision)})`,
    `${indent}- decision_by: ${code(summary.decision_by)} — ${DECISION_SOURCE_NOTES[summary.decision_by]}`,
    `${indent}- Critical guard: ${code(guard.status)} · applicable ${guard.applicable} · mismatch ${guard.mismatch}`,
  ];
  if (execution.status === 'skipped_by_critical_veto') {
    lines.push(
      `${indent}- Execution: ${code(execution.status)} · runs recorded ${execution.runs_recorded} — ${CRITICAL_VETO_ROUTE_NOTE}`,
    );
  } else {
    lines.push(
      `${indent}- Execution: ${code(execution.status)} · runs recorded ${execution.runs_recorded}` +
        ` · parseable ${execution.runs_parseable} · exact format ${execution.runs_exact_format}` +
        ` · full-run unanimous ${execution.full_run_unanimous ? 'yes' : 'no'}` +
        ` · votes changed ${execution.changed_votes} / preserved ${execution.preserved_votes}`,
    );
  }
  if (summary.model) {
    lines.push(
      `${indent}- Model: ${code(summary.model.model_id)} digest ${code(summary.model.model_digest)}` +
        ` · runtime ${code(summary.model.runtime_version)}` +
        ` · prompt ${code(summary.model.prompt_id)} ${code(summary.model.prompt_sha256)}`,
    );
  }
  if (summary.decision_by === 'critical-guard-veto-v1') {
    lines.push(`${indent}- ${SELF_CORRECTION_LIMITATION_NOTE}`);
  }
  return lines;
}

function entryLine(entry: ComparisonVerifiedEvaluation): string[] {
  return [`  - ${code(entry.evaluation_id)}`, ...summaryLines(entry.summary, '    ')];
}

function rejectedLine(entry: ComparisonRejectedEvaluation): string {
  const detail = entry.detail === undefined ? '' : ` · detail ${code(entry.detail)}`;
  return `${code(entry.evaluation_id)} — ${code(entry.reason)} ${code(entry.message)}${detail} (evaluator は特定しません)`;
}

// ── Sections ────────────────────────────────────────────────────────────────

function groupLines(group: ComparisonEvaluationGroup, unclassifiedRejected: number): string[] {
  const { state } = group;
  if (state.availability === 'missing') {
    const lines = [`- Status: **MISSING** — ${MISSING_NOTE}`];
    if (unclassifiedRejected > 0) {
      lines.push(
        `- この Result には evaluator を特定できない rejected Evaluation が ${unclassifiedRejected} 件あります（Evidence gaps 参照）。`,
      );
    }
    return lines;
  }

  const flags = [`verified ${state.verified_count}`];
  if (state.multiple_candidates) flags.push('multiple candidates');
  if (state.conflicting_evidence) flags.push('**CONFLICTING EVIDENCE**');
  const lines = [
    `- Status: available · ${flags.join(' · ')}`,
    `- Considered: ${ids(group.entries.map((entry) => entry.evaluation_id))}`,
  ];
  const reason = group.selection_reason ?? '';
  if (group.headline) {
    lines.push(
      `- Headline: ${code(group.headline.evaluation_id)} — selection ${code(reason)}（${SELECTION_NOTES[reason] ?? ''}）`,
      ...summaryLines(group.headline.summary, ''),
    );
    if (state.multiple_candidates) {
      lines.push('- All considered entries:');
      for (const entry of group.entries) lines.push(...entryLine(entry));
    }
  } else {
    lines.push(
      `- Headline: none — selection ${code(reason)}（${SELECTION_NOTES[reason] ?? ''}）`,
      `- Conflicting: ${ids(group.entries.map((entry) => entry.evaluation_id))}`,
    );
    for (const entry of group.entries) lines.push(...entryLine(entry));
  }
  if (unclassifiedRejected > 0) {
    lines.push(
      `- この Result には evaluator を特定できない rejected Evaluation が ${unclassifiedRejected} 件あります（Evidence gaps 参照）。`,
    );
  }
  return lines;
}

function groupedResults(view: ComparisonRun) {
  return view.tools.flatMap((group) => group.results.map((result) => ({ group, result })));
}

function fileSha(source: ReportSource, resultId: string): string {
  return source.artifact_content.results[resultId]?.file_sha256 ?? '(not frozen)';
}

function frozenTranscriptSha(source: ReportSource, resultId: string): string | null {
  return source.artifact_content.results[resultId]?.transcript_file_sha256 ?? null;
}

function trustedResultsSection(source: ReportSource, view: ComparisonRun): string[] {
  const lines = ['## Trusted Results', ''];
  if (view.tools.length === 0) {
    lines.push('tool 比較に使える sealed Result はありません。', '');
    return lines;
  }
  for (const group of view.tools) {
    lines.push(`### Tool ${toolLabel(group.tool)}`, '');
    for (const result of group.results) {
      if (result.kind === 'verified') {
        lines.push(
          `#### Result ${code(result.result_id)}`,
          '',
          `- Tool: ${code(result.tool.name)} (${code(result.tool.id)})`,
          `- Version: ${result.tool.version === null ? '(none recorded)' : code(result.tool.version)}`,
          `- Delivery path: ${code(result.capture.delivery_path)}`,
          `- Captured at: ${code(result.captured_at)}`,
          `- result.json SHA-256: ${code(fileSha(source, result.result_id))}`,
          `- transcript.txt SHA-256: ${code(frozenTranscriptSha(source, result.result_id) ?? result.transcript_sha256)}`,
          '',
          fenced(result.transcript),
          '',
        );
      } else {
        lines.push(
          `#### Result ${code(result.result_id)} — REJECTED`,
          '',
          `- Trusted tool id: ${code(result.trusted_tool_id)} (sealed)`,
          `- Reason: ${code(result.reason)} ${code(result.message)}${result.detail === undefined ? '' : ` · detail ${code(result.detail)}`}`,
          `- result.json SHA-256: ${code(fileSha(source, result.result_id))}`,
          '- captured_at / capture / version / transcript: 表示しません。検証に失敗した Result はそれらを保証できません。',
          '',
        );
      }
    }
  }
  return lines;
}

function evaluatorSection(view: ComparisonRun, evaluatorId: EvaluatorId): string[] {
  const lines = [`## ${EVALUATOR_LABELS[evaluatorId]} — ${code(evaluatorId)}`, ''];
  const columns = groupedResults(view);
  if (columns.length === 0) {
    lines.push('対象となる tool-grouped Result はありません。', '');
    return lines;
  }
  for (const { group, result } of columns) {
    lines.push(`### Result ${code(result.result_id)} — ${toolLabel(group.tool)}`, '');
    if (result.kind === 'rejected') {
      lines.push('- 対象外: Result が rejected のため evaluator group を作りません（Evidence gaps 参照）。', '');
      continue;
    }
    const evaluatorGroup = result.evaluations.find((candidate) => candidate.evaluator_id === evaluatorId);
    if (evaluatorGroup) {
      lines.push(...groupLines(evaluatorGroup, result.completeness.unclassified_rejected_count), '');
    }
  }
  return lines;
}

function verifiedEntryBullets(
  entries: readonly ComparisonVerifiedEvaluation[],
  indent = '  ',
): string[] {
  return entries.flatMap((entry) => [
    `${indent}- verified ${code(entry.evaluation_id)} (${code(entry.evaluator_id)})`,
    ...summaryLines(entry.summary, `${indent}  `),
  ]);
}

function gapsSection(source: ReportSource, view: ComparisonRun): string[] {
  const lines = ['## Evidence gaps', ''];
  const verifiedResults = groupedResults(view)
    .map(({ result }) => result)
    .filter((result): result is ComparisonVerifiedResult => result.kind === 'verified');

  lines.push('### Missing evaluators', '');
  const missing = verifiedResults.filter((result) => result.completeness.evaluators_missing.length > 0);
  if (missing.length === 0) lines.push('None.');
  for (const result of missing) {
    lines.push(
      `- Result ${code(result.result_id)}: ${result.completeness.evaluators_missing
        .map((id) => `${EVALUATOR_LABELS[id]} (${code(id)})`)
        .join(', ')} — ${MISSING_NOTE}`,
    );
  }
  lines.push('');

  lines.push('### Rejected Result evidence', '');
  const rejectedResults = groupedResults(view).filter(({ result }) => result.kind === 'rejected');
  if (rejectedResults.length === 0) lines.push('None.');
  for (const { result } of rejectedResults) {
    if (result.kind !== 'rejected') continue;
    lines.push(
      `- Result ${code(result.result_id)} (${code(result.trusted_tool_id)}): ${code(result.reason)} ${code(result.message)}`,
    );
    lines.push(...verifiedEntryBullets(result.verified_evaluations));
    for (const entry of result.unclassified_rejected_evaluations) {
      lines.push(`  - rejected ${rejectedLine(entry)}`);
    }
  }
  lines.push('');

  lines.push('### Rejected / unclassified Evaluations (Result known)', '');
  const withRejected = verifiedResults.filter((result) => result.unclassified_rejected_evaluations.length > 0);
  if (withRejected.length === 0) lines.push('None.');
  for (const result of withRejected) {
    lines.push(`- Result ${code(result.result_id)}:`);
    for (const entry of result.unclassified_rejected_evaluations) lines.push(`  - ${rejectedLine(entry)}`);
  }
  lines.push('');

  lines.push('### Legacy unsealed Results', '');
  lines.push(
    '未署名 (legacy) の Result です。tool の記録は改変されていない保証がないため、tool 比較には含めません。',
    '',
  );
  if (view.legacy_unsealed_results.length === 0) lines.push('None.', '');
  for (const result of view.legacy_unsealed_results) {
    if (result.kind === 'legacy-unsealed-verified') {
      lines.push(
        `#### Legacy Result ${code(result.result_id)}`,
        '',
        `- Tool claim (unverified): ${code(result.claimed_tool_name)} (${code(result.claimed_tool_id)})` +
          `${result.claimed_tool_version === null ? '' : ` version ${code(result.claimed_tool_version)}`}`,
        `- result.json SHA-256: ${code(fileSha(source, result.result_id))}`,
        `- transcript.txt SHA-256: ${code(frozenTranscriptSha(source, result.result_id) ?? '(not frozen)')}`,
        '',
        fenced(result.transcript),
        '',
      );
    } else {
      lines.push(
        `#### Legacy Result ${code(result.result_id)} — REJECTED`,
        '',
        `- Reason: ${code(result.reason)} ${code(result.message)}`,
        '- Tool claim: 表示しません（読み戻しに失敗した未署名 Result の tool 記録は信頼できません）。',
        `- result.json SHA-256: ${code(fileSha(source, result.result_id))}`,
        '',
      );
    }
    if (result.verified_evaluations.length > 0 || result.unclassified_rejected_evaluations.length > 0) {
      lines.push(...verifiedEntryBullets(result.verified_evaluations, ''));
      for (const entry of result.unclassified_rejected_evaluations) lines.push(`- rejected ${rejectedLine(entry)}`);
      lines.push('');
    }
  }

  lines.push('### Unattributed Results', '');
  if (view.unattributed_results.length === 0) lines.push('None.');
  for (const result of view.unattributed_results) {
    lines.push(
      `- Result ${code(result.result_id)}: reason_class ${code(result.reason_class)} · ${code(result.reason)} ${code(result.message)}` +
        ` · result.json SHA-256 ${code(fileSha(source, result.result_id))}`,
    );
    lines.push(...verifiedEntryBullets(result.related_verified_evaluations));
    for (const entry of result.related_rejected_evaluations) lines.push(`  - rejected ${rejectedLine(entry)}`);
  }
  lines.push('');

  lines.push('### Run-level unattributed rejected Evaluations', '');
  if (view.unattributed_rejected_evaluations.length === 0) lines.push('None.');
  for (const entry of view.unattributed_rejected_evaluations) {
    const named = entry.named_result_id === null ? 'names no Result' : `names ${code(entry.named_result_id)} (not in this Run's listing)`;
    lines.push(`- ${rejectedLine(entry)} · ${named}`);
  }
  lines.push('');

  lines.push('### Run-level unattributed verified Evaluations', '');
  if (view.unattributed_verified_evaluations.length === 0) lines.push('None.');
  for (const entry of view.unattributed_verified_evaluations) {
    lines.push(`- ${code(entry.evaluation_id)} (${code(entry.evaluator_id)}) names ${code(entry.result_id)}, absent from the Result listing`);
    lines.push(...summaryLines(entry.summary, '  '));
  }
  lines.push('');
  return lines;
}

function findingsSection(findings: ReportFindings): string[] {
  const lines = ['## Re-render findings', ''];
  lines.push('### Evidence changed (same id, different bytes)', '');
  if (findings.evidence_changed.length === 0) lines.push('None.');
  for (const change of findings.evidence_changed) {
    lines.push(
      `- ${code(change.artifact_kind)} ${code(change.artifact_id)}: expected ${change.expected_sha256 === null ? 'absent' : code(change.expected_sha256)}` +
        ` · actual ${change.actual_sha256 === null ? 'missing' : code(change.actual_sha256)} — cited evidence として扱いません。`,
    );
  }
  lines.push('', '### Verification changed (same bytes, different current outcome)', '');
  if (findings.verification_changed.length === 0) lines.push('None.');
  for (const change of findings.verification_changed) {
    lines.push(
      `- ${code(change.artifact_kind)} ${code(change.artifact_id)}: report time ${code(canonicalJson(change.report_time))}` +
        ` → current ${change.current === null ? 'not placed' : code(canonicalJson(change.current))}` +
        `${change.current_reason === undefined ? '' : ` · current reason ${code(change.current_reason)}`}`,
    );
  }
  lines.push('', '### Not re-checked', '');
  if (findings.not_rechecked.length === 0) lines.push('None.');
  for (const entry of findings.not_rechecked) {
    lines.push(
      `- ${code(entry.artifact_kind)} ${code(entry.artifact_id)}: 依拠する Result ${code(entry.subject_result_id)} の evidence が変わったため再検証しません。`,
    );
  }
  lines.push('');
  return lines;
}

function identitySection(source: ReportSource): string[] {
  const seal = new Map<string, string>();
  for (const result of source.results) {
    if (result.kind === 'verified') seal.set(result.result_id, result.result_semantic_sha256);
  }
  const transcript = (sha: string | null) => (sha === null ? 'absent' : code(sha));
  const lines = [
    '## Artifact content identity',
    '',
    'Report 生成時に読んだ実ファイル bytes の SHA-256（parse し直した値ではありません）。',
    '',
    '| kind | id | file SHA-256 | transcript.txt SHA-256 | seal semantic SHA-256 | subject Result |',
    '|---|---|---|---|---|---|',
  ];
  for (const [resultId, content] of Object.entries(source.artifact_content.results)) {
    lines.push(
      `| result | ${code(resultId)} | ${code(content.file_sha256)} | ${transcript(content.transcript_file_sha256)}` +
        ` | ${seal.has(resultId) ? code(seal.get(resultId)!) : '—'} | — |`,
    );
  }
  for (const [resultId, content] of Object.entries(source.supporting_results)) {
    lines.push(
      `| supporting result | ${code(resultId)} | ${code(content.result_file_sha256)} | ${code(content.transcript_file_sha256)} | — | — |`,
    );
  }
  for (const [evaluationId, content] of Object.entries(source.artifact_content.evaluations)) {
    const subject = source.verified_evaluation_subjects[evaluationId]?.subject_result_id;
    lines.push(
      `| evaluation | ${code(evaluationId)} | ${code(content.file_sha256)} | — | ${content.semantic_sha256 === undefined ? '—' : code(content.semantic_sha256)}` +
        ` | ${subject === undefined ? '—' : code(subject)} |`,
    );
  }
  lines.push(
    '',
    'supporting result は、verified Evaluation の読み戻しが依拠する Result として bytes だけを固定したものです。tool 比較・legacy・unattributed のいずれとしても扱いません。',
    '',
  );
  return lines;
}

/**
 * The deterministic Markdown body.
 *
 * `view` is the comparison of exactly the artifacts the ReportSource names, as
 * the current verifier reads them — on first render, the comparison the source
 * was taken from. `findings` is null on first render and on a re-render that
 * found nothing, so an unchanged re-render produces the same bytes.
 */
export function renderReportBody(
  source: ReportSource,
  view: ComparisonRun,
  findings: ReportFindings | null = null,
): string {
  const { run_evidence: evidence, completeness } = source;
  const ordering = Object.entries(source.ordering)
    .map(([key, value]) => `${key}=${code(value)}`)
    .join(' · ');

  const lines: string[] = [
    '# Voice Input Bench Report',
    '',
    'この本文は、下記 ReportSource が名指す artifact と、それを render 時点の verifier が読み戻した結果から決定的に生成されています。' +
      'アプリが保存した artifact ではなく、operator が export した package の一部です。',
    '',
    '## Run',
    '',
    `- Run ID: ${code(source.run_id)}`,
    `- Test ID: ${code(evidence.test_id)}`,
    `- Manifest schema: ${evidence.manifest_schema_version}`,
    `- manifest.json SHA-256: ${code(evidence.manifest_file_sha256)}`,
    `- source.txt SHA-256: ${code(evidence.source_sha256)}`,
    `- audio.wav SHA-256: ${code(evidence.audio_sha256)}`,
    '',
    '## Completeness',
    '',
    `- Verified evaluator coverage: **${completeness.state}**`,
    '  （verified な Result ごとに 4 evaluator の verified evidence が揃っているかだけを示します。rejected・unclassified・legacy の evidence が無いことは意味しません。それらは下記に別途表示します。）',
    `- Sealed verified Results: ${completeness.sealed_verified_results}`,
    `- Sealed rejected Results: ${completeness.sealed_rejected_results}`,
    `- Legacy unsealed Results: ${completeness.legacy_unsealed_results}`,
    `- Unattributed Results: ${completeness.unattributed_results}`,
    `- Run-level unattributed rejected Evaluations: ${completeness.unattributed_rejected_evaluations}`,
    `- Run-level unattributed verified Evaluations: ${completeness.unattributed_verified_evaluations}`,
    `- Sealed verified Results with no verified Evaluation: ${completeness.results_with_no_verified_evaluations}`,
    '',
    '## Contract',
    '',
    `- report_contract_version: ${source.report_contract_version}`,
    `- renderer: ${code(REPORT_RENDERER_ID)} · canonicalization: ${code(CANONICAL_JSON_ID)}`,
    `- ordering: ${ordering}`,
    '- 総合スコア・加重スコア・ランキング・勝者判定はありません。Raw / Surface / Critical / Semantic は最後まで別々の測定です。',
    '',
    ...trustedResultsSection(source, view),
    ...view.evaluator_ids.flatMap((evaluatorId) => evaluatorSection(view, evaluatorId)),
    ...gapsSection(source, view),
    ...(hasFindings(findings) ? findingsSection(findings) : []),
    ...identitySection(source),
  ];

  // LF only, exactly one trailing LF, whatever any fragment carried.
  return `${lines.join('\n').replace(/\r\n|\r/g, '\n').replace(/\n+$/, '')}\n`;
}
