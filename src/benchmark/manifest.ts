/**
 * Run Manifest, schema v1.
 *
 * Records what was said, by which voice, from which model, with which settings,
 * and what bytes came out — enough to check later that the stored artifacts are
 * the ones the Run claims. Deliberately narrow: no field is added here for a
 * feature that does not exist yet.
 */

export const MANIFEST_SCHEMA_VERSION = 1;

export interface RunManifestV1 {
  schema_version: number;
  run_id: string;
  /** P1-B has no Benchmark Case selector yet; every Run is a manual one. */
  test_id: 'manual';
  generated_at: string;

  source: {
    file: 'source.txt';
    encoding: 'utf-8';
    /** Canonicalization normalizes CRLF and bare CR to LF, and nothing else. */
    line_endings: 'lf';
    /** SHA-256 of the canonical text's UTF-8 bytes. */
    sha256: string;
  };

  provider: {
    id: string;
    engine_name: string;
    engine_version: string;
    engine_url: string;
  };

  /** Resolved server-side from engine evidence, never from the client. */
  model: {
    uuid: string;
    name: string;
    version: string;
  };

  /** Resolved server-side from a fresh `/speakers` read, never from the client. */
  voice: {
    speaker_uuid: string;
    speaker_name: string;
    style_id: number;
    style_name: string;
  };

  settings: {
    speed_scale: number;
    volume_scale: number;
    sample_rate: 44100;
    stereo: false;
  };

  /** P1-B never splits text; long-text handling is P1-C. */
  segmentation: {
    strategy: 'none';
    segment_count: 1;
  };

  provider_query: {
    file: 'provider-query.json';
    /** SHA-256 of the bytes actually written to provider-query.json. */
    sha256: string;
  };

  audio: {
    file: 'audio.wav';
    content_type: string;
    /** SHA-256 of the exact WAV bytes the provider returned. */
    sha256: string;
    bytes: number;
  };

  reproducibility: {
    /** The stored WAV is the artifact of record, not a regenerable intermediate. */
    canonical_artifact: true;
    /** Engine and model updates change output; identical bytes are not promised. */
    bit_exact_regeneration_expected: false;
  };
}
