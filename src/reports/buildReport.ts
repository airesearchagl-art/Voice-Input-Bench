import {
  readRunComparison,
  type RunComparisonDeps,
  type RunComparisonReading,
} from '@/comparisons/runComparison';
import { canonicalJson, canonicalJsonPretty } from './canonicalJson';
import { hashCitedArtifacts } from './artifactBytes';
import { ReportError } from './reportErrors';
import { assertSourceMatchesComparison, reportSourceOf, type ReportSource } from './reportSource';
import { composeReportMarkdown, renderReportBody, reportContentSha256 } from './renderReport';

/**
 * The Report package for one Run — built from current evidence, stored nowhere.
 *
 * P4-C v1 decision: a Report is an operator-exported package. This function
 * reads; it never writes. There is no report storage root and no Report
 * entity: the two files it returns become the package when the operator saves
 * them.
 *
 * One generation only. The comparison is read, the cited bytes hashed, then the
 * comparison is read again and the bytes hashed again. Only if both readings
 * agree exactly, and both hash passes agree exactly, is anything returned — so
 * a file edited mid-build can never leave a package that pairs one version's
 * verdicts with another version's hashes.
 *
 * No model is called. Semantic values are stored v4 evidence, read back by the
 * current verifier.
 */

export interface ReportPackage {
  report_source: ReportSource;
  /** The exact `*.source.json` file text: canonical key order, 2-space indent, LF. */
  report_source_json: string;
  /** The exact `report.md` file text: deterministic body, then the presentation footer. */
  markdown: string;
  /** The deterministic body alone — what `content_sha256` covers. */
  markdown_body: string;
  content_sha256: string;
  /** Presentation only; not part of content identity. */
  generated_at: string;
  filenames: { source: string; markdown: string };
}

export interface BuildReportOptions {
  now?: () => Date;
}

/** Names derived from a validated Run id and a hex hash only: nothing a caller can steer. */
export function reportFilenames(runId: string, contentSha256: string) {
  const stem = `vib-report-${runId}-${contentSha256.slice(0, 12)}`;
  return { source: `${stem}.source.json`, markdown: `${stem}.md` };
}

export async function buildReportPackage(
  deps: RunComparisonDeps,
  runId: string,
  options: BuildReportOptions = {},
): Promise<ReportPackage> {
  const first = await readRunComparison(deps, runId);
  const firstHashes = await hashCitedArtifacts(deps, first.comparison);
  const second = await readRunComparison(deps, runId);
  const secondHashes = await hashCitedArtifacts(deps, second.comparison);

  if (canonicalJson(first.comparison) !== canonicalJson(second.comparison)) {
    throw changedDuringBuild('comparison の読み取りが build 中に変わりました。');
  }
  if (canonicalJson(firstHashes) !== canonicalJson(secondHashes)) {
    throw changedDuringBuild('引用する artifact の bytes が build 中に変わりました。');
  }

  return packageOf(second, secondHashes, options);
}

function changedDuringBuild(message: string): ReportError {
  return new ReportError('REPORT_EVIDENCE_CHANGED_DURING_BUILD', message, {
    detail: '古い bytes と新しい bytes を混ぜた package は返しません。再生成してください。',
  });
}

function packageOf(
  reading: RunComparisonReading,
  hashes: Awaited<ReturnType<typeof hashCitedArtifacts>>,
  options: BuildReportOptions,
): ReportPackage {
  const source = reportSourceOf(reading, hashes);
  // The source is checked against its own contract before it leaves: the same
  // validation an untrusted copy gets on re-render.
  assertSourceMatchesComparison(source, reading.comparison);

  const body = renderReportBody(source, reading.comparison);
  const contentSha256 = reportContentSha256(source, body);
  const generatedAt = (options.now ?? (() => new Date()))().toISOString();

  return {
    report_source: source,
    report_source_json: canonicalJsonPretty(source),
    markdown: composeReportMarkdown(body, contentSha256, generatedAt),
    markdown_body: body,
    content_sha256: contentSha256,
    generated_at: generatedAt,
    filenames: reportFilenames(source.run_id, contentSha256),
  };
}
