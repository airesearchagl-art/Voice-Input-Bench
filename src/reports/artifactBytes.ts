import { readFile } from 'node:fs/promises';
import type { ComparisonRun, RunComparisonDeps } from '@/comparisons/runComparison';
import { sha256OfBytes } from '@/lib/hash';
import { RESULT_FILE, TRANSCRIPT_FILE } from '@/storage/LocalResultStore';
import { AUDIO_FILE, MANIFEST_FILE, SOURCE_FILE } from '@/storage/LocalRunStore';
import { ReportError } from './reportErrors';
import type { CitedArtifactHashes } from './reportSource';

/**
 * The exact bytes on disk, and their SHA-256.
 *
 * Never parse-then-reserialize: a file whose JSON means the same thing but
 * whose whitespace moved is a different file, and the report says so. Every
 * path comes from a store's own resolver, which accepts only a well-formed id
 * and refuses anything that would leave its root.
 */

/** The file's bytes, or null when it is not there. Other read failures throw. */
export async function readArtifactBytes(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch (caught) {
    const code = (caught as { code?: unknown }).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw caught;
  }
}

export function sha256OrNull(bytes: Buffer | null): string | null {
  return bytes === null ? null : sha256OfBytes(bytes);
}

/** Every Evaluation id a comparison places, in every container. */
export function comparisonEvaluationIds(comparison: ComparisonRun): string[] {
  const ids: string[] = [];
  const take = (entries: ReadonlyArray<{ evaluation_id: string }>) =>
    ids.push(...entries.map((entry) => entry.evaluation_id));
  for (const group of comparison.tools) {
    for (const result of group.results) {
      if (result.kind === 'verified') {
        for (const evaluatorGroup of result.evaluations) take(evaluatorGroup.entries);
      } else {
        take(result.verified_evaluations);
      }
      take(result.unclassified_rejected_evaluations);
    }
  }
  for (const result of comparison.legacy_unsealed_results) {
    take(result.verified_evaluations);
    take(result.unclassified_rejected_evaluations);
  }
  for (const result of comparison.unattributed_results) {
    take(result.related_verified_evaluations);
    take(result.related_rejected_evaluations);
  }
  take(comparison.unattributed_rejected_evaluations);
  take(comparison.unattributed_verified_evaluations);
  return ids;
}

/**
 * Hash every artifact a comparison cites, from the bytes on disk now.
 *
 * Listed means readable a moment ago; if a cited file has gone, the evidence
 * changed under the build, and nothing is returned rather than a package that
 * describes a file nobody can read.
 */
export async function hashCitedArtifacts(
  deps: RunComparisonDeps,
  comparison: ComparisonRun,
): Promise<CitedArtifactHashes> {
  const vanished = (what: string, id: string) =>
    new ReportError(
      'REPORT_EVIDENCE_CHANGED_DURING_BUILD',
      `${what} (${id}) が build 中に読めなくなりました。`,
      { detail: `artifact=${what} id=${id}` },
    );
  const hashFile = async (file: string, what: string, id: string): Promise<string> => {
    const sha = sha256OrNull(await readArtifactBytes(file));
    if (sha === null) throw vanished(what, id);
    return sha;
  };

  const runId = comparison.run_id;
  const run = {
    manifest: await hashFile(deps.runStore.resolveRunFile(runId, MANIFEST_FILE), MANIFEST_FILE, runId),
    source: await hashFile(deps.runStore.resolveRunFile(runId, SOURCE_FILE), SOURCE_FILE, runId),
    audio: await hashFile(deps.runStore.resolveRunFile(runId, AUDIO_FILE), AUDIO_FILE, runId),
  };

  // A transcript is cited only where the Result verified: that is the only
  // case in which the report quotes it.
  const withTranscript = new Set<string>();
  const resultIds: string[] = [];
  for (const group of comparison.tools) {
    for (const result of group.results) {
      resultIds.push(result.result_id);
      if (result.kind === 'verified') withTranscript.add(result.result_id);
    }
  }
  for (const result of comparison.legacy_unsealed_results) {
    resultIds.push(result.result_id);
    if (result.kind === 'legacy-unsealed-verified') withTranscript.add(result.result_id);
  }
  for (const result of comparison.unattributed_results) resultIds.push(result.result_id);

  const results: CitedArtifactHashes['results'] = {};
  for (const resultId of [...resultIds].sort()) {
    results[resultId] = {
      result_file: await hashFile(
        deps.resultStore.resolveResultFile(resultId, RESULT_FILE),
        RESULT_FILE,
        resultId,
      ),
      ...(withTranscript.has(resultId)
        ? {
            transcript_file: await hashFile(
              deps.resultStore.resolveResultFile(resultId, TRANSCRIPT_FILE),
              TRANSCRIPT_FILE,
              resultId,
            ),
          }
        : {}),
    };
  }

  const evaluations: CitedArtifactHashes['evaluations'] = {};
  for (const evaluationId of [...comparisonEvaluationIds(comparison)].sort()) {
    evaluations[evaluationId] = await hashFile(
      deps.evaluationStore.resolveEvaluationFile(evaluationId),
      'evaluation.json',
      evaluationId,
    );
  }

  return { run, results, evaluations };
}
