import { assertStorageRootsIsolated } from '@/storage/rootIsolation';
import type { LocalResultStore } from '@/storage/LocalResultStore';
import type { LocalRunStore } from '@/storage/LocalRunStore';
import type { LocalSessionStore } from '@/storage/LocalSessionStore';
import { listResultsForRun } from '@/results/saveResult';
import type { SttToolId } from '@/results/tools';
import type { SessionTargetTool, SessionV1 } from './sessionSchema';
import { verifySessionCaseEvidence, verifyStoredSessionShape } from './verifyStoredSession';

/**
 * The comparison matrix a Session produces.
 *
 * One row per Benchmark Case, one cell per target tool. A cell says whether an
 * observation exists for that Case with that tool — **coverage, not accuracy**.
 * There is no score, no ranking and no winner here; P2-B only shows what has
 * and has not been captured, plus the raw transcripts to read side by side.
 *
 * The matrix is derived at read time from the Result tree. A Session does not
 * pin Result IDs, so capturing a new Result for a pinned Run updates the matrix
 * while `session.json` stays exactly as it was written.
 */

export type CellStatus =
  /** No Result at all for this Case with this tool. */
  | 'missing'
  /** At least one verified Result. */
  | 'covered'
  /** Results exist but none of them verified. */
  | 'rejected-only';

/** A verified observation, flattened for display. */
export interface MatrixObservation {
  resultId: string;
  toolName: string;
  toolVersion: string | null;
  deliveryPath: string;
  capturedAt: string;
  transcriptSha256: string;
  transcript: string;
}

/** A Result that failed readback verification. Surfaced, never counted. */
export interface MatrixRejection {
  resultId: string;
  reason: string;
  message: string;
  detail?: string;
}

/**
 * A Result that reads back fine but carries no integrity seal — a P2-A Result,
 * written before Results were sealed.
 *
 * The observation is real. What cannot be shown is that its `tool` section says
 * the same thing it said when it was written, and that section is exactly what
 * decides which column of the comparison it belongs in. So it is shown against
 * the Case, with whatever tool it claims, rather than counted as that tool's
 * coverage.
 */
export interface MatrixLegacyEntry {
  resultId: string;
  /** What the Result claims, unverifiable. `null` when even that failed. */
  toolId: SttToolId | null;
  status: 'verified' | 'rejected';
  reason?: string;
  message?: string;
}

export interface MatrixCell {
  tool: SessionTargetTool;
  status: CellStatus;
  verifiedCount: number;
  rejectedCount: number;
  verified: MatrixObservation[];
  rejected: MatrixRejection[];
}

export interface MatrixRow {
  testId: string;
  runId: string;
  sourceSha256: string;
  audioSha256: string;
  cells: MatrixCell[];
  /**
   * Rejected Results for this Case that cannot be attributed to a target tool.
   *
   * Either the tool identity itself failed verification, or the Result belongs
   * to a tool outside this Session's comparison. Either way it is shown against
   * the Case rather than counted against a tool that may have had nothing to do
   * with it.
   */
  unattributedRejected: MatrixRejection[];
  /**
   * Results for this Case that predate Result sealing.
   *
   * Kept visible so the operator can see that observations exist, without them
   * being read as per-tool coverage they cannot support.
   */
  legacyUnsealed: MatrixLegacyEntry[];
}

export interface SessionComparison {
  session: SessionV1;
  rows: MatrixRow[];
}

/** One Session as the list view shows it, without the per-Case detail. */
export interface SessionSummary {
  sessionId: string;
  name: string;
  createdAt: string;
  caseCount: number;
  targetTools: SessionTargetTool[];
}

export interface SessionDeps {
  runStore: LocalRunStore;
  resultStore: LocalResultStore;
  sessionStore: LocalSessionStore;
}

function assertIsolated(deps: SessionDeps): void {
  assertStorageRootsIsolated({
    runs: deps.runStore.rootDir,
    results: deps.resultStore.rootDir,
    sessions: deps.sessionStore.rootDir,
  });
}

/**
 * Read one Session and verify it: shape first, then every Case against a fresh
 * reading of the Run it pins.
 */
export async function loadVerifiedSession(
  deps: SessionDeps,
  sessionId: string,
): Promise<SessionV1> {
  assertIsolated(deps);

  const stored = await deps.sessionStore.readSession(sessionId);
  const session = verifyStoredSessionShape({ sessionId, stored });
  await verifySessionCaseEvidence(deps.runStore, session);
  return session;
}

function cellStatus(verifiedCount: number, rejectedCount: number): CellStatus {
  if (verifiedCount > 0) return 'covered';
  return rejectedCount > 0 ? 'rejected-only' : 'missing';
}

/**
 * Build the coverage matrix for a verified Session.
 *
 * Results come from the P2-A listing, which re-verifies each one against the
 * Run and its own transcript. Nothing is loosened here: a Result that P2-A
 * rejects is rejected in the matrix too.
 */
export async function buildSessionComparison(
  deps: SessionDeps,
  sessionId: string,
): Promise<SessionComparison> {
  const session = await loadVerifiedSession(deps, sessionId);
  const rows: MatrixRow[] = [];

  for (const sessionCase of session.cases) {
    const entries = await listResultsForRun(
      { runStore: deps.runStore, resultStore: deps.resultStore },
      sessionCase.run_id,
    );

    const unattributedRejected: MatrixRejection[] = [];
    const legacyUnsealed: MatrixLegacyEntry[] = [];

    for (const entry of entries) {
      // Unsealed Results are shown against the Case in either state. Their tool
      // claim is readable but not provable, so it decides nothing here.
      if (entry.integrityTrust === 'legacy-unsealed') {
        legacyUnsealed.push(
          entry.status === 'verified'
            ? { resultId: entry.resultId, toolId: entry.result.tool.id, status: 'verified' }
            : {
                resultId: entry.resultId,
                toolId: entry.trustedToolId ?? null,
                status: 'rejected',
                reason: entry.reason,
                message: entry.message,
              },
        );
        continue;
      }

      if (entry.status !== 'rejected') continue;

      // Attributable to a target tool? Then it belongs in that tool's cell —
      // but only on the strength of a seal. Without one, `trustedToolId` says
      // the `tool` section is well-formed, not that it is unedited.
      if (
        entry.integrityTrust === 'sealed' &&
        session.target_tools.some((tool) => tool === entry.trustedToolId)
      ) {
        continue;
      }

      unattributedRejected.push({
        resultId: entry.resultId,
        reason: entry.reason,
        message: entry.message,
        detail: entry.detail,
      });
    }

    const cells: MatrixCell[] = session.target_tools.map((tool) => {
      const verified: MatrixObservation[] = [];
      const rejected: MatrixRejection[] = [];

      for (const entry of entries) {
        // Only sealed Results count as this tool's evidence, in either
        // direction. An unsealed Result could have been moved into — or out of
        // — this column after the fact without leaving a trace.
        if (entry.integrityTrust !== 'sealed') continue;

        if (entry.status === 'verified') {
          if (entry.result.tool.id !== tool) continue;
          verified.push({
            resultId: entry.resultId,
            toolName: entry.result.tool.name,
            toolVersion: entry.result.tool.version,
            deliveryPath: entry.result.capture.delivery_path,
            capturedAt: entry.result.captured_at,
            transcriptSha256: entry.result.transcript.sha256,
            transcript: entry.transcript,
          });
          continue;
        }

        // A rejected Result lands in a tool's cell only when its tool identity
        // survived verification. One broken Windows observation must not show
        // up as a failure of Aqua Voice.
        if (entry.trustedToolId !== tool) continue;
        rejected.push({
          resultId: entry.resultId,
          reason: entry.reason,
          message: entry.message,
          detail: entry.detail,
        });
      }

      return {
        tool,
        status: cellStatus(verified.length, rejected.length),
        verifiedCount: verified.length,
        rejectedCount: rejected.length,
        verified,
        rejected,
      };
    });

    rows.push({
      testId: sessionCase.test_id,
      runId: sessionCase.run_id,
      sourceSha256: sessionCase.source_sha256,
      audioSha256: sessionCase.audio_sha256,
      cells,
      unattributedRejected,
      legacyUnsealed,
    });
  }

  return { session, rows };
}

/**
 * Verified Sessions, newest first.
 *
 * A Session that fails verification is left out of the list rather than shown
 * as something to compare with. Opening it directly still reports why.
 */
export async function listVerifiedSessions(deps: SessionDeps): Promise<SessionSummary[]> {
  assertIsolated(deps);

  const summaries: SessionSummary[] = [];
  const sessionIds = (await deps.sessionStore.listSessionIds()).slice().reverse();

  for (const sessionId of sessionIds) {
    try {
      const session = await loadVerifiedSession(deps, sessionId);
      summaries.push({
        sessionId,
        name: session.name,
        createdAt: session.created_at,
        caseCount: session.cases.length,
        targetTools: session.target_tools,
      });
    } catch {
      continue;
    }
  }

  return summaries;
}
