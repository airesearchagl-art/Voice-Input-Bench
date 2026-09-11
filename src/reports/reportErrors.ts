/**
 * Why a Report could not be produced or re-checked as a whole.
 *
 * Per-artifact findings on a re-render (one Evaluation's bytes moved, one
 * Result now verifies differently) are not errors: they are the answer, and
 * come back as a structured outcome. These kinds are for the cases where no
 * honest document can be returned at all.
 */

export type ReportErrorKind =
  /** The ReportSource given for re-render is malformed, or contradicts itself. */
  | 'REPORT_SOURCE_INVALID'
  /** The re-render request body is larger than any ReportSource needs to be. */
  | 'REPORT_SOURCE_TOO_LARGE'
  /** A cited artifact changed while the package was being built. Nothing mixed is returned. */
  | 'REPORT_EVIDENCE_CHANGED_DURING_BUILD'
  /** manifest.json, source.txt or audio.wav is not the file the report was written against. */
  | 'REPORT_RUN_BASIS_CHANGED'
  /** The Run's frozen files are byte-identical, but the current verifier rejects the Run. */
  | 'REPORT_RUN_VERIFICATION_CHANGED';

/** One artifact that is not the bytes the report read. Hashes only, never contents. */
export interface EvidenceChange {
  artifact_kind: 'manifest' | 'source' | 'audio' | 'result' | 'transcript' | 'evaluation';
  /** The Run id for manifest/source/audio; the artifact's own id otherwise. */
  artifact_id: string;
  expected_sha256: string;
  /** Null when the file is gone. */
  actual_sha256: string | null;
  change: 'modified' | 'missing';
}

export class ReportError extends Error {
  readonly kind: ReportErrorKind;
  readonly detail?: string;
  readonly evidenceChanged?: EvidenceChange[];

  constructor(
    kind: ReportErrorKind,
    message: string,
    options: { detail?: string; evidenceChanged?: EvidenceChange[] } = {},
  ) {
    super(message);
    this.name = 'ReportError';
    this.kind = kind;
    this.detail = options.detail;
    this.evidenceChanged = options.evidenceChanged;
  }
}
