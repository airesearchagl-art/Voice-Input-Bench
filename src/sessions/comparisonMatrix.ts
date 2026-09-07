import { assertStorageRootsIsolated } from '@/storage/rootIsolation';
import type { LocalResultStore } from '@/storage/LocalResultStore';
import type { LocalRunStore } from '@/storage/LocalRunStore';
import type { LocalSessionStore } from '@/storage/LocalSessionStore';
import { listResultsForRun } from '@/results/saveResult';
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

    const cells: MatrixCell[] = session.target_tools.map((tool) => {
      const verified: MatrixObservation[] = [];
      const rejected: MatrixRejection[] = [];

      for (const entry of entries) {
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

        // A rejected Result cannot be attributed to a tool with any confidence
        // — its own contents are what failed verification. It is surfaced on
        // every cell of the row so it cannot be quietly lost.
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
