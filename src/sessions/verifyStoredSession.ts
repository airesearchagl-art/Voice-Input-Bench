import { isValidRunId } from '@/lib/runId';
import { isValidSessionId } from '@/lib/sessionId';
import type { LocalRunStore } from '@/storage/LocalRunStore';
import { verifyRunEvidence, type VerifiedRunEvidence } from '@/results/runEvidence';
import {
  SESSION_SCHEMA_VERSION,
  computeSessionSemanticSha256,
  isSessionTargetTool,
  type SessionCaseV1,
  type SessionPayloadV1,
  type SessionTargetTool,
  type SessionV1,
} from './sessionSchema';

/**
 * Verification of a Session read back from disk.
 *
 * `session.json` is a plain file in a local directory; it can be hand-edited.
 * Editing a `run_id` or an `audio_sha256` would repoint the comparison at
 * different audio while the matrix kept claiming the same Cases, so a stored
 * Session is re-checked on every read rather than trusted.
 *
 * Structure is checked first, then the Session's own integrity hash, then every
 * Case against a fresh reading of the Run it pins.
 *
 * The hash step is what catches an edit from one valid value to another —
 * renaming the Session, moving `created_at`, or dropping a tool from
 * `target_tools` all leave a structurally perfect file that no longer describes
 * the experiment that was planned.
 */

export type SessionVerificationErrorKind =
  | 'SESSION_SCHEMA_UNSUPPORTED'
  | 'SESSION_MALFORMED'
  | 'SESSION_ID_MISMATCH'
  | 'SESSION_CREATED_AT_INVALID'
  | 'SESSION_NAME_INVALID'
  | 'SESSION_CASES_INVALID'
  | 'SESSION_DUPLICATE_TEST_ID'
  | 'SESSION_RUN_ID_INVALID'
  | 'SESSION_TARGET_TOOLS_INVALID'
  /** The integrity record itself is missing or malformed. */
  | 'SESSION_INTEGRITY_MISSING'
  /** The Session's contents no longer hash to what was recorded. */
  | 'SESSION_INTEGRITY_MISMATCH'
  /** A Case's recorded evidence disagrees with the Run as it stands now. */
  | 'SESSION_EVIDENCE_MISMATCH';

export class SessionVerificationError extends Error {
  readonly kind: SessionVerificationErrorKind;
  readonly sessionId: string;
  readonly detail?: string;

  constructor(
    kind: SessionVerificationErrorKind,
    sessionId: string,
    message: string,
    detail?: string,
  ) {
    super(message);
    this.name = 'SessionVerificationError';
    this.kind = kind;
    this.sessionId = sessionId;
    this.detail = detail;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Check the shape of a stored Session: schema, identity, and internal
 * consistency. Does not touch the Run tree.
 */
export function verifyStoredSessionShape(input: {
  sessionId: string;
  stored: unknown;
}): SessionV1 {
  const { sessionId, stored } = input;
  const fail = (kind: SessionVerificationErrorKind, message: string, detail?: string): never => {
    throw new SessionVerificationError(kind, sessionId, message, detail);
  };

  if (!isValidSessionId(sessionId)) {
    fail('SESSION_ID_MISMATCH', `session id の形式が不正です: ${JSON.stringify(sessionId)}`);
  }
  if (!isPlainObject(stored)) {
    fail('SESSION_MALFORMED', 'session.json がオブジェクトではありません。');
  }

  const raw = stored as Record<string, unknown>;

  if (raw.schema_version !== SESSION_SCHEMA_VERSION) {
    fail(
      'SESSION_SCHEMA_UNSUPPORTED',
      `Session schema v${String(raw.schema_version)} は対象外です（v${SESSION_SCHEMA_VERSION} のみ）。`,
      `schema_version=${String(raw.schema_version)}`,
    );
  }

  if (raw.session_id !== sessionId) {
    fail(
      'SESSION_ID_MISMATCH',
      'session.json の session_id が保存先ディレクトリと一致しません。',
      `directory=${sessionId} session_id=${String(raw.session_id)}`,
    );
  }

  if (typeof raw.created_at !== 'string' || Number.isNaN(Date.parse(raw.created_at))) {
    fail(
      'SESSION_CREATED_AT_INVALID',
      'created_at が有効な日時ではありません。',
      `created_at=${String(raw.created_at)}`,
    );
  }

  if (typeof raw.name !== 'string' || raw.name.trim().length === 0) {
    fail('SESSION_NAME_INVALID', 'name が空です。');
  }

  if (!Array.isArray(raw.cases) || raw.cases.length === 0) {
    fail('SESSION_CASES_INVALID', 'cases が空です。');
  }

  const cases: SessionCaseV1[] = [];
  const seenTestIds = new Set<string>();

  for (const entry of raw.cases as unknown[]) {
    if (!isPlainObject(entry)) {
      fail('SESSION_CASES_INVALID', 'cases の要素がオブジェクトではありません。');
      continue;
    }
    const testId = entry.test_id;
    const runId = entry.run_id;
    const sourceSha = entry.source_sha256;
    const audioSha = entry.audio_sha256;

    if (typeof testId !== 'string' || testId.length === 0) {
      fail('SESSION_CASES_INVALID', 'case の test_id が文字列ではありません。');
      continue;
    }
    if (!isValidRunId(runId)) {
      fail(
        'SESSION_RUN_ID_INVALID',
        `case "${testId}" の run_id の形式が不正です。`,
        `run_id=${String(runId)}`,
      );
      continue;
    }
    if (typeof sourceSha !== 'string' || !SHA256_PATTERN.test(sourceSha)) {
      fail('SESSION_CASES_INVALID', `case "${testId}" の source_sha256 が SHA-256 ではありません。`);
      continue;
    }
    if (typeof audioSha !== 'string' || !SHA256_PATTERN.test(audioSha)) {
      fail('SESSION_CASES_INVALID', `case "${testId}" の audio_sha256 が SHA-256 ではありません。`);
      continue;
    }
    if (seenTestIds.has(testId)) {
      fail(
        'SESSION_DUPLICATE_TEST_ID',
        `Benchmark Case "${testId}" が Session 内で重複しています。`,
      );
      continue;
    }
    seenTestIds.add(testId);

    cases.push({
      test_id: testId,
      run_id: runId,
      source_sha256: sourceSha,
      audio_sha256: audioSha,
    });
  }

  if (!Array.isArray(raw.target_tools) || raw.target_tools.length === 0) {
    fail('SESSION_TARGET_TOOLS_INVALID', 'target_tools が空です。');
  }

  const targetTools: SessionTargetTool[] = [];
  for (const candidate of raw.target_tools as unknown[]) {
    if (!isSessionTargetTool(candidate)) {
      fail(
        'SESSION_TARGET_TOOLS_INVALID',
        `target tool "${String(candidate)}" は P2-B の比較対象ではありません。`,
      );
      continue;
    }
    if (targetTools.includes(candidate)) {
      fail('SESSION_TARGET_TOOLS_INVALID', `target tool "${candidate}" が重複しています。`);
      continue;
    }
    targetTools.push(candidate);
  }

  const integrity = raw.integrity;
  if (
    !isPlainObject(integrity) ||
    integrity.algorithm !== 'sha256' ||
    typeof integrity.semantic_sha256 !== 'string' ||
    !SHA256_PATTERN.test(integrity.semantic_sha256)
  ) {
    fail('SESSION_INTEGRITY_MISSING', 'integrity が sha256 の記録として読めません。');
  }

  const payload: SessionPayloadV1 = {
    schema_version: SESSION_SCHEMA_VERSION,
    session_id: sessionId,
    created_at: raw.created_at as string,
    name: raw.name as string,
    cases,
    target_tools: targetTools,
  };

  const recorded = (integrity as Record<string, unknown>).semantic_sha256 as string;
  const actual = computeSessionSemanticSha256(payload);
  if (recorded !== actual) {
    fail(
      'SESSION_INTEGRITY_MISMATCH',
      'Session の内容が記録された semantic hash と一致しません。作成後に編集された可能性があります。',
      `recorded=${recorded} actual=${actual}`,
    );
  }

  return { ...payload, integrity: { algorithm: 'sha256', semantic_sha256: recorded } };
}

/**
 * Confirm every Case still pins the Run it recorded.
 *
 * Each Run is verified freshly, then compared against the Session's snapshot.
 * A drifted Run, a replaced Run, or an edited `session.json` all surface here.
 */
export async function verifySessionCaseEvidence(
  runStore: LocalRunStore,
  session: SessionV1,
): Promise<Map<string, VerifiedRunEvidence>> {
  const evidenceByRunId = new Map<string, VerifiedRunEvidence>();

  for (const sessionCase of session.cases) {
    const evidence = await verifyRunEvidence(runStore, sessionCase.run_id);

    const checks: Array<[string, string, string]> = [
      ['test_id', sessionCase.test_id, evidence.testId],
      ['source_sha256', sessionCase.source_sha256, evidence.sourceSha256],
      ['audio_sha256', sessionCase.audio_sha256, evidence.audioSha256],
    ];

    for (const [field, recorded, current] of checks) {
      if (recorded !== current) {
        throw new SessionVerificationError(
          'SESSION_EVIDENCE_MISMATCH',
          session.session_id,
          `case "${sessionCase.test_id}" の ${field} が現在の Run と一致しません。`,
          `run_id=${sessionCase.run_id} recorded=${recorded} current=${current}`,
        );
      }
    }

    evidenceByRunId.set(sessionCase.run_id, evidence);
  }

  return evidenceByRunId;
}
