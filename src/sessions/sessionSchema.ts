/**
 * Benchmark Session, schema v1.
 *
 * One Session is one experiment plan: a fixed set of Benchmark Cases, each
 * pinned to one exact Run, to be compared across a fixed set of STT tools.
 *
 * The pinning is the whole point. Regenerating the same Case produces a new Run
 * with the same `test_id` but a different `run_id` and a different
 * `audio_sha256`. Comparing Windows against Aqua Voice by `test_id` alone could
 * therefore compare two transcripts of two different WAVs. A Session fixes
 *
 *   test_id → exact run_id → exact audio_sha256
 *
 * so every tool in the comparison was fed the same canonical audio.
 *
 * A Session references artifacts; it never copies them. Runs and Results stay
 * where they are, and no Result is embedded here — the coverage matrix is
 * derived from the Result tree as it stands at read time.
 */

import { sha256OfText } from '@/lib/hash';

export const SESSION_SCHEMA_VERSION = 1 as const;

/**
 * Tools a P2-B Session can compare.
 *
 * Built-in only. `other` exists as a P2-A Result tool, but the P2-B comparison
 * matrix is fixed to Windows vs Aqua Voice for this milestone.
 */
export const SESSION_TARGET_TOOLS = ['windows-standard-voice-input', 'aqua-voice'] as const;

export type SessionTargetTool = (typeof SESSION_TARGET_TOOLS)[number];

export function isSessionTargetTool(value: unknown): value is SessionTargetTool {
  return typeof value === 'string' && (SESSION_TARGET_TOOLS as readonly string[]).includes(value);
}

/** One Benchmark Case pinned to one exact Run. */
export interface SessionCaseV1 {
  test_id: string;
  run_id: string;
  /** Snapshot taken from a fresh verification at Session creation time. */
  source_sha256: string;
  audio_sha256: string;
}

/**
 * Everything a Session means, without the integrity record itself.
 *
 * This is what gets hashed. Anything in here is part of the plan; editing any
 * of it changes what the experiment claims to be.
 */
export interface SessionPayloadV1 {
  schema_version: 1;
  session_id: string;
  created_at: string;
  name: string;
  /** At most one entry per `test_id`. */
  cases: SessionCaseV1[];
  target_tools: SessionTargetTool[];
}

/**
 * Self-check for the Session's own contents.
 *
 * Field-by-field validation catches nonsense — a malformed `run_id`, an unknown
 * tool — but not a hand edit that swaps one valid value for another. Dropping
 * `aqua-voice` from `target_tools` leaves a perfectly valid Session that
 * silently describes a different experiment than the one that was run.
 *
 * The hash closes that: a Session is only accepted if its contents still hash
 * to what was recorded when it was created.
 */
export interface SessionIntegrityV1 {
  algorithm: 'sha256';
  semantic_sha256: string;
}

export interface SessionV1 extends SessionPayloadV1 {
  integrity: SessionIntegrityV1;
}

/**
 * Serialize a Session's meaning in a fixed shape.
 *
 * Property order is written out explicitly rather than taken from the stored
 * object, so re-indenting `session.json`, reordering its keys, or adding a
 * field outside the schema does not change the hash — only changing what the
 * Session *says* does.
 */
export function canonicalSessionPayload(payload: SessionPayloadV1): string {
  return JSON.stringify({
    schema_version: payload.schema_version,
    session_id: payload.session_id,
    created_at: payload.created_at,
    name: payload.name,
    cases: payload.cases.map((sessionCase) => ({
      test_id: sessionCase.test_id,
      run_id: sessionCase.run_id,
      source_sha256: sessionCase.source_sha256,
      audio_sha256: sessionCase.audio_sha256,
    })),
    target_tools: [...payload.target_tools],
  });
}

/** SHA-256 of {@link canonicalSessionPayload}, over its UTF-8 bytes. */
export function computeSessionSemanticSha256(payload: SessionPayloadV1): string {
  return sha256OfText(canonicalSessionPayload(payload));
}

/** Strip the integrity record, leaving exactly what the hash covers. */
export function sessionPayloadOf(session: SessionV1): SessionPayloadV1 {
  return {
    schema_version: session.schema_version,
    session_id: session.session_id,
    created_at: session.created_at,
    name: session.name,
    cases: session.cases,
    target_tools: session.target_tools,
  };
}
