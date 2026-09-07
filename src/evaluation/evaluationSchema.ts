import { sha256OfText } from '@/lib/hash';
import type { DeliveryPath, SttToolId } from '@/results/tools';
import { RAW_CHAR_ALGORITHM, type RawCharAlgorithm, type RawCharMetrics } from './rawChar';

/**
 * Raw character Evaluation.
 *
 * One Evaluation is one comparison: a sealed Result's `transcript.txt` against
 * the canonical `source.txt` of the Run that Result cites, under raw-char-v1.
 *
 * It stores its inputs by hash, not by copy. The numbers are only meaningful
 * next to the exact bytes they came from, and re-reading those bytes on every
 * readback is what lets the metrics be re-derived instead of trusted.
 *
 * Immutable, like everything else under `data/`. There is no edit and no
 * delete: an Evaluation records what a comparison said at a moment, and
 * rewriting that would make the record worth nothing.
 *
 * Only **sealed Result v2** can be evaluated. A legacy v1 Result reads back
 * fine but carries no seal, so nothing proves its transcript is still
 * attributed to the tool it names — and a per-tool CER built on that would be a
 * number attached to the wrong tool.
 */

export const EVALUATION_SCHEMA_VERSION = 1 as const;

/** The Result schema an Evaluation is allowed to be built from. */
export const EVALUATION_SUBJECT_RESULT_SCHEMA_VERSION = 2 as const;

/** Everything an Evaluation asserts, without the integrity record. */
export interface EvaluationPayloadV1 {
  schema_version: 1;
  evaluation_id: string;
  created_at: string;
  algorithm: RawCharAlgorithm;

  /** Resolved server-side from the Result on disk, never from the request. */
  run_id: string;
  result_id: string;

  subject: {
    result_schema_version: 2;
    tool: { id: SttToolId; name: string; version: string | null };
    capture: { method: 'manual-paste'; delivery_path: DeliveryPath };
    /** The sealed Result's own semantic hash, as it stood at evaluation time. */
    result_semantic_sha256: string;
  };

  /** The canonical text the transcript is compared against. */
  reference: {
    file: 'run/source.txt';
    sha256: string;
    /** Unicode code points, which is what raw-char-v1 counts. */
    chars: number;
  };

  hypothesis: {
    file: 'result/transcript.txt';
    sha256: string;
    chars: number;
  };

  /** Verified against the Run on disk before this Evaluation was written. */
  run_evidence: {
    manifest_schema_version: number;
    test_id: string;
    source_sha256: string;
    audio_sha256: string;
  };

  metrics: RawCharMetrics;
}

/**
 * Tamper-evident seal over {@link EvaluationPayloadV1}.
 *
 * It covers the metrics and the hashes of both inputs, so an edited CER is
 * caught even when the edit is arithmetically plausible. The seal is not the
 * only defence: readback also recomputes raw-char-v1 from the actual bytes, so
 * a re-sealed Evaluation still has to survive being recalculated.
 */
export interface EvaluationIntegrityV1 {
  algorithm: 'sha256';
  semantic_sha256: string;
}

export interface EvaluationV1 extends EvaluationPayloadV1 {
  integrity: EvaluationIntegrityV1;
}

/**
 * Serialize an Evaluation's meaning in a fixed shape.
 *
 * Property order is written out explicitly rather than taken from the stored
 * object, so re-indenting `evaluation.json` or reordering its keys does not
 * change the hash — only changing what the Evaluation *says* does.
 */
export function canonicalEvaluationPayload(payload: EvaluationPayloadV1): string {
  return JSON.stringify({
    schema_version: payload.schema_version,
    evaluation_id: payload.evaluation_id,
    created_at: payload.created_at,
    algorithm: payload.algorithm,
    run_id: payload.run_id,
    result_id: payload.result_id,
    subject: {
      result_schema_version: payload.subject.result_schema_version,
      tool: {
        id: payload.subject.tool.id,
        name: payload.subject.tool.name,
        version: payload.subject.tool.version,
      },
      capture: {
        method: payload.subject.capture.method,
        delivery_path: payload.subject.capture.delivery_path,
      },
      result_semantic_sha256: payload.subject.result_semantic_sha256,
    },
    reference: {
      file: payload.reference.file,
      sha256: payload.reference.sha256,
      chars: payload.reference.chars,
    },
    hypothesis: {
      file: payload.hypothesis.file,
      sha256: payload.hypothesis.sha256,
      chars: payload.hypothesis.chars,
    },
    run_evidence: {
      manifest_schema_version: payload.run_evidence.manifest_schema_version,
      test_id: payload.run_evidence.test_id,
      source_sha256: payload.run_evidence.source_sha256,
      audio_sha256: payload.run_evidence.audio_sha256,
    },
    metrics: {
      exact_match: payload.metrics.exact_match,
      reference_chars: payload.metrics.reference_chars,
      hypothesis_chars: payload.metrics.hypothesis_chars,
      substitutions: payload.metrics.substitutions,
      deletions: payload.metrics.deletions,
      insertions: payload.metrics.insertions,
      edit_distance: payload.metrics.edit_distance,
      cer: payload.metrics.cer,
    },
  });
}

/** SHA-256 of {@link canonicalEvaluationPayload}, over its UTF-8 bytes. */
export function computeEvaluationSemanticSha256(payload: EvaluationPayloadV1): string {
  return sha256OfText(canonicalEvaluationPayload(payload));
}

/** Strip the integrity record, leaving exactly what the hash covers. */
export function evaluationPayloadOf(evaluation: EvaluationV1): EvaluationPayloadV1 {
  return {
    schema_version: evaluation.schema_version,
    evaluation_id: evaluation.evaluation_id,
    created_at: evaluation.created_at,
    algorithm: evaluation.algorithm,
    run_id: evaluation.run_id,
    result_id: evaluation.result_id,
    subject: evaluation.subject,
    reference: evaluation.reference,
    hypothesis: evaluation.hypothesis,
    run_evidence: evaluation.run_evidence,
    metrics: evaluation.metrics,
  };
}

export function isRawCharAlgorithm(value: unknown): value is RawCharAlgorithm {
  return value === RAW_CHAR_ALGORITHM;
}
