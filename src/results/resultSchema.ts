import { sha256OfText } from '@/lib/hash';
import type { DeliveryPath, SttToolId } from './tools';

/**
 * Manual STT Result.
 *
 * One Result is one STT observation: a transcript a person produced with one
 * tool, from one Phase 1 Run's canonical audio, pasted back by hand.
 *
 * `run_evidence` is a snapshot of what the Run actually contained at capture
 * time, re-hashed server-side. It is not a copy of what the client claimed —
 * a Result that cited unverified Run metadata could not later be traced back to
 * the audio it describes.
 *
 * ## v1 → v2
 *
 * v1 records the observation. v2 adds an integrity hash over the observation's
 * own metadata.
 *
 * Field-by-field validation catches contradictions — an unknown tool id, a name
 * that does not match its id — but not an edit that swaps one valid pair for
 * another. Rewriting `tool.id` **and** `tool.name` together from Windows to
 * Aqua Voice leaves a perfectly contract-valid Result that has silently moved
 * to the other column of a comparison. The hash closes that.
 *
 * v1 Results already on disk are left exactly as they were written: no
 * migration, no rewrite. They still read back as observations, but without a
 * seal they cannot be counted as strict per-tool coverage.
 */

/** The version new Results are written at. */
export const RESULT_SCHEMA_VERSION = 2 as const;

/** Written by P2-A. Readable, never rewritten. */
export const LEGACY_RESULT_SCHEMA_VERSION = 1 as const;

/** Everything a Result asserts, without the integrity record itself. */
export interface ResultPayloadV2 {
  schema_version: 2;
  result_id: string;
  run_id: string;
  captured_at: string;

  tool: {
    id: SttToolId;
    /** Server-owned for built-in tools; operator-supplied only for `other`. */
    name: string;
    version: string | null;
  };

  capture: {
    /** P2-A only records what a human pasted back. No tool is driven. */
    method: 'manual-paste';
    /** How the Run audio reached the STT tool. */
    delivery_path: DeliveryPath;
  };

  /** Verified against the Run on disk before this Result was written. */
  run_evidence: {
    manifest_schema_version: number;
    test_id: string;
    source_sha256: string;
    audio_sha256: string;
  };

  transcript: {
    file: 'transcript.txt';
    encoding: 'utf-8';
    /** Only CRLF and bare CR are normalized; nothing else is touched. */
    line_endings: 'lf';
    sha256: string;
    bytes: number;
  };
}

/**
 * Tamper-evident seal over {@link ResultPayloadV2}.
 *
 * The transcript bytes themselves are not covered here — they are checked
 * separately against `transcript.sha256` and `transcript.bytes`, which this
 * hash does cover. So an edit to either the file or the record about it is
 * caught, and an edit to both is caught by the seal.
 */
export interface ResultIntegrityV2 {
  algorithm: 'sha256';
  semantic_sha256: string;
}

export interface ResultV2 extends ResultPayloadV2 {
  integrity: ResultIntegrityV2;
}

/** The P2-A shape. Kept for reading Results written before v2. */
export interface ResultV1 extends Omit<ResultPayloadV2, 'schema_version'> {
  schema_version: 1;
}

/** Either shape, as read back from disk. */
export type StoredResult = ResultV1 | ResultV2;

/**
 * Whether a stored Result carries a verified seal.
 *
 * `legacy-unsealed` is not a failure — the observation is real and readable —
 * but its metadata cannot be shown to be unedited, so it is not counted as
 * strict per-tool coverage.
 */
export type IntegrityTrust = 'sealed' | 'legacy-unsealed';

export function isSealedResult(result: StoredResult): result is ResultV2 {
  return result.schema_version === RESULT_SCHEMA_VERSION;
}

/**
 * Serialize a Result's meaning in a fixed shape.
 *
 * Property order is written out explicitly rather than taken from the stored
 * object, so re-indenting `result.json` or reordering its keys does not change
 * the hash — only changing what the Result *says* does.
 */
export function canonicalResultPayload(payload: ResultPayloadV2): string {
  return JSON.stringify({
    schema_version: payload.schema_version,
    result_id: payload.result_id,
    run_id: payload.run_id,
    captured_at: payload.captured_at,
    tool: {
      id: payload.tool.id,
      name: payload.tool.name,
      version: payload.tool.version,
    },
    capture: {
      method: payload.capture.method,
      delivery_path: payload.capture.delivery_path,
    },
    run_evidence: {
      manifest_schema_version: payload.run_evidence.manifest_schema_version,
      test_id: payload.run_evidence.test_id,
      source_sha256: payload.run_evidence.source_sha256,
      audio_sha256: payload.run_evidence.audio_sha256,
    },
    transcript: {
      file: payload.transcript.file,
      encoding: payload.transcript.encoding,
      line_endings: payload.transcript.line_endings,
      sha256: payload.transcript.sha256,
      bytes: payload.transcript.bytes,
    },
  });
}

/** SHA-256 of {@link canonicalResultPayload}, over its UTF-8 bytes. */
export function computeResultSemanticSha256(payload: ResultPayloadV2): string {
  return sha256OfText(canonicalResultPayload(payload));
}

/** Strip the integrity record, leaving exactly what the hash covers. */
export function resultPayloadOf(result: ResultV2): ResultPayloadV2 {
  return {
    schema_version: result.schema_version,
    result_id: result.result_id,
    run_id: result.run_id,
    captured_at: result.captured_at,
    tool: result.tool,
    capture: result.capture,
    run_evidence: result.run_evidence,
    transcript: result.transcript,
  };
}
