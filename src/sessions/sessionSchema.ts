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

export interface SessionV1 {
  schema_version: 1;
  session_id: string;
  created_at: string;
  name: string;
  /** At most one entry per `test_id`. */
  cases: SessionCaseV1[];
  target_tools: SessionTargetTool[];
}
