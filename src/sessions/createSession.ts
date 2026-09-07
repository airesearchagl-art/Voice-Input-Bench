import { createSessionId } from '@/lib/sessionId';
import { assertStorageRootsIsolated } from '@/storage/rootIsolation';
import type { LocalResultStore } from '@/storage/LocalResultStore';
import type { LocalRunStore } from '@/storage/LocalRunStore';
import type { LocalSessionStore } from '@/storage/LocalSessionStore';
import { verifyRunEvidence } from '@/results/runEvidence';
import {
  SESSION_SCHEMA_VERSION,
  SESSION_TARGET_TOOLS,
  computeSessionSemanticSha256,
  isSessionTargetTool,
  type SessionCaseV1,
  type SessionPayloadV1,
  type SessionTargetTool,
  type SessionV1,
} from './sessionSchema';

/**
 * Create one Benchmark Session.
 *
 * The client sends a name, a list of Run IDs, and which tools to compare. That
 * is all it gets to send: `test_id`, `source_sha256` and `audio_sha256` are
 * resolved server-side from a fresh verification of each Run. A Session whose
 * case evidence came from the request body would pin nothing.
 *
 * Two Runs of the same Benchmark Case cannot both be in one Session — the
 * matrix has one row per `test_id`, and two rows claiming the same Case would
 * make "did Windows cover this Case?" ambiguous.
 */

export type SessionCreationErrorKind =
  /** No name, or only whitespace. */
  | 'SESSION_NAME_REQUIRED'
  /** No Runs selected. */
  | 'SESSION_RUNS_REQUIRED'
  /** A run ID appears more than once, or two Runs share a `test_id`. */
  | 'SESSION_DUPLICATE_TEST_ID'
  /** No target tools selected. */
  | 'SESSION_TARGET_TOOLS_REQUIRED'
  /** A target tool is not one this milestone compares. */
  | 'SESSION_UNKNOWN_TARGET_TOOL'
  /** The same target tool was listed twice. */
  | 'SESSION_DUPLICATE_TARGET_TOOL';

export class SessionCreationError extends Error {
  readonly kind: SessionCreationErrorKind;
  readonly detail?: string;

  constructor(kind: SessionCreationErrorKind, message: string, detail?: string) {
    super(message);
    this.name = 'SessionCreationError';
    this.kind = kind;
    this.detail = detail;
  }
}

export interface CreateSessionInput {
  name: string;
  runIds: unknown;
  targetTools: unknown;
}

export interface CreateSessionDeps {
  runStore: LocalRunStore;
  resultStore: LocalResultStore;
  sessionStore: LocalSessionStore;
  /** Injected in tests so session IDs and timestamps are deterministic. */
  now?: () => Date;
  sessionId?: string;
}

export interface CreateSessionOutcome {
  sessionId: string;
  sessionDir: string;
  session: SessionV1;
}

/** Validate the requested tool list without trusting its order or contents. */
export function resolveTargetTools(value: unknown): SessionTargetTool[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new SessionCreationError(
      'SESSION_TARGET_TOOLS_REQUIRED',
      '比較対象の STT tool を 1 つ以上選択してください。',
    );
  }

  const tools: SessionTargetTool[] = [];
  for (const candidate of value) {
    if (!isSessionTargetTool(candidate)) {
      throw new SessionCreationError(
        'SESSION_UNKNOWN_TARGET_TOOL',
        `target tool "${String(candidate)}" は P2-B の比較対象ではありません（${SESSION_TARGET_TOOLS.join(' / ')}）。`,
      );
    }
    if (tools.includes(candidate)) {
      throw new SessionCreationError(
        'SESSION_DUPLICATE_TARGET_TOOL',
        `target tool "${candidate}" が重複しています。`,
      );
    }
    tools.push(candidate);
  }

  return tools;
}

function resolveRunIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new SessionCreationError(
      'SESSION_RUNS_REQUIRED',
      'Session に含める Run を 1 つ以上選択してください。',
    );
  }
  return value.map((entry) => (typeof entry === 'string' ? entry : String(entry)));
}

export async function createBenchmarkSession(
  input: CreateSessionInput,
  deps: CreateSessionDeps,
): Promise<CreateSessionOutcome> {
  const now = deps.now ?? (() => new Date());

  // 0. Refuse a storage layout where a Session could land inside the Run or
  //    Result tree. Checked before anything is read or written.
  assertStorageRootsIsolated({
    runs: deps.runStore.rootDir,
    results: deps.resultStore.rootDir,
    sessions: deps.sessionStore.rootDir,
  });

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name.length === 0) {
    throw new SessionCreationError('SESSION_NAME_REQUIRED', 'Session 名を入力してください。');
  }

  const targetTools = resolveTargetTools(input.targetTools);
  const runIds = resolveRunIds(input.runIds);

  // Each Run is verified fresh. The snapshot below is what that verification
  // produced, never what the caller claimed about the Run.
  const cases: SessionCaseV1[] = [];
  const seenTestIds = new Map<string, string>();

  for (const runId of runIds) {
    const evidence = await verifyRunEvidence(deps.runStore, runId);

    const existingRunId = seenTestIds.get(evidence.testId);
    if (existingRunId !== undefined) {
      throw new SessionCreationError(
        'SESSION_DUPLICATE_TEST_ID',
        `Benchmark Case "${evidence.testId}" の Run が複数選択されています。1 Case につき 1 Run を固定してください。`,
        `test_id=${evidence.testId} runs=${existingRunId}, ${runId}`,
      );
    }
    seenTestIds.set(evidence.testId, runId);

    cases.push({
      test_id: evidence.testId,
      run_id: evidence.runId,
      source_sha256: evidence.sourceSha256,
      audio_sha256: evidence.audioSha256,
    });
  }

  const sessionId = deps.sessionId ?? createSessionId(now());
  const payload: SessionPayloadV1 = {
    schema_version: SESSION_SCHEMA_VERSION,
    session_id: sessionId,
    created_at: now().toISOString(),
    name,
    cases,
    target_tools: targetTools,
  };

  // Recorded now so a later hand edit of any of the above is detectable.
  const session: SessionV1 = {
    ...payload,
    integrity: { algorithm: 'sha256', semantic_sha256: computeSessionSemanticSha256(payload) },
  };

  const stored = await deps.sessionStore.saveSession(
    sessionId,
    Buffer.from(`${JSON.stringify(session, null, 2)}\n`, 'utf8'),
  );

  return { sessionId: stored.sessionId, sessionDir: stored.sessionDir, session };
}
