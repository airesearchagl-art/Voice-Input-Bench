import type { DeliveryPath, SttToolId } from './tools';

/**
 * Manual STT Result, schema v1.
 *
 * One Result is one STT observation: a transcript a person produced with one
 * tool, from one Phase 1 Run's canonical audio, pasted back by hand.
 *
 * `run_evidence` is a snapshot of what the Run actually contained at capture
 * time, re-hashed server-side. It is not a copy of what the client claimed —
 * a Result that cited unverified Run metadata could not later be traced back to
 * the audio it describes.
 */

export const RESULT_SCHEMA_VERSION = 1 as const;

export interface ResultV1 {
  schema_version: 1;
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
