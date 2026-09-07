/**
 * raw-char-v1 — the baseline character comparison.
 *
 * Compares a canonical source text against an STT transcript, exactly as both
 * were written. Nothing is normalized, trimmed, case-folded, width-converted,
 * or stripped of whitespace and punctuation. A tool that returns 「2700ミリ」
 * where the source says 「二千七百ミリ」 differs here, and that difference is
 * reported rather than smoothed away.
 *
 * That makes this the harshest possible reading, which is the point of a
 * baseline: every later, more forgiving profile has to explain what it chose to
 * ignore relative to this one. It is not a quality score, and it does not rank
 * anything.
 *
 * The unit is the **Unicode code point**, not the UTF-16 code unit. An emoji or
 * any other astral character counts once, not twice.
 */

export const RAW_CHAR_ALGORITHM = 'raw-char-v1' as const;
export type RawCharAlgorithm = typeof RAW_CHAR_ALGORITHM;

export type RawCharErrorKind =
  /** The reference is empty, so CER has no denominator. */
  | 'RAW_CHAR_EMPTY_REFERENCE'
  /** `edit_distance` and `S + D + I` disagree — the alignment is unusable. */
  | 'RAW_CHAR_INVARIANT_VIOLATED';

export class RawCharError extends Error {
  readonly kind: RawCharErrorKind;
  readonly detail?: string;

  constructor(kind: RawCharErrorKind, message: string, detail?: string) {
    super(message);
    this.name = 'RawCharError';
    this.kind = kind;
    this.detail = detail;
  }
}

export interface RawCharMetrics {
  exact_match: boolean;
  reference_chars: number;
  hypothesis_chars: number;
  substitutions: number;
  deletions: number;
  insertions: number;
  edit_distance: number;
  /** `edit_distance / reference_chars`. Not clamped: it can exceed 1.0. */
  cer: number;
}

/** Split into Unicode code points. `Array.from` iterates code points, not units. */
export function toCodePoints(text: string): string[] {
  return Array.from(text);
}

/**
 * Levenshtein distance with the three operation counts.
 *
 * Costs are match 0, substitution 1, deletion 1, insertion 1, so the distance
 * is the number of edits and `edit_distance === substitutions + deletions +
 * insertions` for any minimal path.
 *
 * Which minimal path is taken still matters, because different paths of the
 * same total cost split that total between S, D and I differently. The tie is
 * broken by a fixed precedence — **substitution/match, then deletion, then
 * insertion** — so the same pair of texts always yields the same three numbers,
 * on any machine and in any order of evaluation.
 *
 * Two rolling rows rather than a full table: a long Benchmark Case against a
 * long transcript would otherwise allocate a million-cell matrix for a result
 * that only needs the last row.
 */
export function evaluateRawChar(reference: string, hypothesis: string): RawCharMetrics {
  const ref = toCodePoints(reference);
  const hyp = toCodePoints(hypothesis);
  const n = ref.length;
  const m = hyp.length;

  if (n === 0) {
    // CER would divide by zero. There is no honest number to report, and
    // reporting 0 or 1 would both be inventions.
    throw new RawCharError(
      'RAW_CHAR_EMPTY_REFERENCE',
      'reference が空のため CER を計算できません。',
      `reference_chars=0 hypothesis_chars=${m}`,
    );
  }

  // Row j = hypothesis consumed up to j. Row 0: nothing of the reference has
  // been consumed, so every hypothesis character so far is an insertion.
  let prevDist = new Int32Array(m + 1);
  let prevSub = new Int32Array(m + 1);
  let prevDel = new Int32Array(m + 1);
  let prevIns = new Int32Array(m + 1);
  for (let j = 0; j <= m; j += 1) {
    prevDist[j] = j;
    prevIns[j] = j;
  }

  let curDist = new Int32Array(m + 1);
  let curSub = new Int32Array(m + 1);
  let curDel = new Int32Array(m + 1);
  let curIns = new Int32Array(m + 1);

  for (let i = 1; i <= n; i += 1) {
    // Column 0: no hypothesis consumed, so every reference character so far is
    // a deletion.
    curDist[0] = i;
    curSub[0] = 0;
    curDel[0] = i;
    curIns[0] = 0;

    const refChar = ref[i - 1];

    for (let j = 1; j <= m; j += 1) {
      const same = refChar === hyp[j - 1];
      const diagonal = prevDist[j - 1]! + (same ? 0 : 1);
      const deletion = prevDist[j]! + 1;
      const insertion = curDist[j - 1]! + 1;

      const best = Math.min(diagonal, deletion, insertion);

      // Fixed precedence on a tie: diagonal, then deletion, then insertion.
      if (best === diagonal) {
        curDist[j] = diagonal;
        curSub[j] = prevSub[j - 1]! + (same ? 0 : 1);
        curDel[j] = prevDel[j - 1]!;
        curIns[j] = prevIns[j - 1]!;
      } else if (best === deletion) {
        curDist[j] = deletion;
        curSub[j] = prevSub[j]!;
        curDel[j] = prevDel[j]! + 1;
        curIns[j] = prevIns[j]!;
      } else {
        curDist[j] = insertion;
        curSub[j] = curSub[j - 1]!;
        curDel[j] = curDel[j - 1]!;
        curIns[j] = curIns[j - 1]! + 1;
      }
    }

    // Swap the rows rather than reallocating them.
    [prevDist, curDist] = [curDist, prevDist];
    [prevSub, curSub] = [curSub, prevSub];
    [prevDel, curDel] = [curDel, prevDel];
    [prevIns, curIns] = [curIns, prevIns];
  }

  const substitutions = prevSub[m]!;
  const deletions = prevDel[m]!;
  const insertions = prevIns[m]!;
  const editDistance = prevDist[m]!;

  // The counts and the distance are two readings of the same path. If they ever
  // disagree the alignment bookkeeping is wrong, and a wrong CER is worse than
  // no CER.
  if (substitutions + deletions + insertions !== editDistance) {
    throw new RawCharError(
      'RAW_CHAR_INVARIANT_VIOLATED',
      'edit distance と S/D/I の合計が一致しません。',
      `S=${substitutions} D=${deletions} I=${insertions} distance=${editDistance}`,
    );
  }

  return {
    exact_match: editDistance === 0,
    reference_chars: n,
    hypothesis_chars: m,
    substitutions,
    deletions,
    insertions,
    edit_distance: editDistance,
    cer: editDistance / n,
  };
}
