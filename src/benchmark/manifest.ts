/**
 * Run Manifest, schema v2.
 *
 * Records what was said, by which voice, from which model, with which settings,
 * how the text was split, and what bytes came out — enough to check later that
 * the stored artifacts are the ones the Run claims. Deliberately narrow: no
 * field is added here for a feature that does not exist yet.
 *
 * v2 widens two things over the P1-B schema: `test_id` may now name a built-in
 * Benchmark Case, and `segmentation` carries the splitter target. Existing v1
 * Runs are left exactly as they were written — nothing is migrated or rewritten.
 */

export const MANIFEST_SCHEMA_VERSION = 2;

export interface RunManifest {
  schema_version: number;
  run_id: string;
  /** `manual`, or the ID of the built-in Benchmark Case that supplied the text. */
  test_id: string;
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

  /**
   * How the canonical text was divided before synthesis. `none` means the text
   * went to the engine in one piece; `sentence-v1` means it was split by the
   * deterministic splitter.
   */
  segmentation: {
    strategy: string;
    /** Upper bound in Unicode code points the splitter aimed for. */
    target_max_chars: number;
    segment_count: number;
  };

  provider_query: {
    file: 'provider-query.json';
    /** SHA-256 of the bytes actually written to provider-query.json. */
    sha256: string;
  };

  audio: {
    file: 'audio.wav';
    content_type: string;
    /**
     * SHA-256 of the exact bytes of `audio.wav` — for a multi-segment Run that
     * is the assembled file, not any individual segment.
     */
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

/** @deprecated Kept as an alias while callers migrate to {@link RunManifest}. */
export type RunManifestV1 = RunManifest;
