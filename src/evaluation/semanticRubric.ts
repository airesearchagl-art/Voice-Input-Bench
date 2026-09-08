import {
  SEMANTIC_RUBRIC_V1_HYPOTHESIS_PLACEHOLDER,
  SEMANTIC_RUBRIC_V1_REFERENCE_PLACEHOLDER,
  SEMANTIC_RUBRIC_V1_TEMPLATE,
} from './semanticPrompt';
import {
  SEMANTIC_MODEL_ID,
  SEMANTIC_REQUEST_NUM_PREDICT,
  SEMANTIC_REQUEST_TEMPERATURE,
} from './semanticProvider';
import { sha256OfText } from '@/lib/hash';

/**
 * Rendering the approved rubric, and reading what the model sent back.
 *
 * Two things live here because they are the two halves of one contract: what
 * exactly was asked, and what exactly counts as an answer. Both have to be
 * reproducible from stored bytes, since readback re-derives the verdict without
 * ever calling the model again.
 */

/** The severities the rubric defines. Anything else is not a severity. */
export const SEMANTIC_SEVERITIES: readonly string[] = ['none', 'minor', 'major', 'critical'];

/** Every field the rubric requires, in the order it is validated. */
export const SEMANTIC_REQUIRED_FIELDS = [
  'meaning_preserved',
  'severity',
  'negation',
  'direction_location',
  'instruction_action',
  'critical_fact',
  'domain_term',
  'reason_codes',
  'short_rationale',
] as const;

const SEMANTIC_BOOLEAN_FIELDS = [
  'meaning_preserved',
  'negation',
  'direction_location',
  'instruction_action',
  'critical_fact',
  'domain_term',
] as const;

export interface SemanticVerdict {
  meaning_preserved: boolean;
  severity: string;
  negation: boolean;
  direction_location: boolean;
  instruction_action: boolean;
  critical_fact: boolean;
  domain_term: boolean;
  reason_codes: string[];
  short_rationale: string;
}

/**
 * Put the two texts into the approved rubric.
 *
 * Only the normalized reference and hypothesis are ever substituted. Nothing
 * about a gold label, a reason code, a probe category or a review status exists
 * on this path to be leaked — the function takes two strings and has nothing
 * else to send.
 *
 * The replacements are passed as functions rather than strings on purpose.
 * `String.replace` expands `$&`, `` $` ``, `$'` and `$$` inside a string
 * replacement, so a transcript that happened to contain `$&` would silently
 * change the prompt. A replacer function is inserted literally.
 */
export function renderSemanticPrompt(reference: string, hypothesis: string): string {
  return SEMANTIC_RUBRIC_V1_TEMPLATE.replace(
    SEMANTIC_RUBRIC_V1_REFERENCE_PLACEHOLDER,
    () => reference,
  ).replace(SEMANTIC_RUBRIC_V1_HYPOTHESIS_PLACEHOLDER, () => hypothesis);
}

/**
 * The exact bytes sent to `/api/chat`.
 *
 * Written as one explicit literal so the serialization is fixed: the stored
 * `request_sha256` is only meaningful if this shape cannot drift with an object
 * spread or a reordered key. `top_p` and `seed` are absent because the approved
 * contract does not send them.
 */
export function buildSemanticRequestBody(prompt: string): string {
  return JSON.stringify({
    model: SEMANTIC_MODEL_ID,
    messages: [{ role: 'user', content: prompt }],
    options: {
      temperature: SEMANTIC_REQUEST_TEMPERATURE,
      num_predict: SEMANTIC_REQUEST_NUM_PREDICT,
    },
    stream: false,
  });
}

/**
 * Rebuild the request from stored evidence and hash it.
 *
 * This is what makes `request_sha256` checkable at readback: the fixed prompt
 * plus the stored normalized texts plus the fixed model and request contract
 * are enough to reconstruct the exact bytes, with no model call.
 */
export function semanticRequestSha256(reference: string, hypothesis: string): string {
  return sha256OfText(buildSemanticRequestBody(renderSemanticPrompt(reference, hypothesis)));
}

export interface SemanticParseResult {
  /** The reply carried a schema-valid verdict object. */
  parseable_schema_valid: boolean;
  /**
   * The reply *was* the object: no fence, no preamble, no trailing remark.
   *
   * Tracked separately from validity on purpose. A fenced or prefaced reply is
   * still a usable verdict, so folding the two together would throw away
   * evidence; but "the model obeyed the output contract" is a different claim
   * from "the model answered", and the UI reports both.
   */
  exact_output_contract_valid: boolean;
  parsed_output: SemanticVerdict | null;
  error: string | null;
}

const FENCE_PATTERN = /```(?:json)?\s*([\s\S]*?)```/i;

/**
 * An unusable reply.
 *
 * `exact_output_contract_valid` is false here whatever the reply looked like:
 * obeying the formatting while failing the schema is not partial compliance,
 * and a run that cannot vote must not look half-good in the evidence.
 */
function invalid(error: string): SemanticParseResult {
  return {
    parseable_schema_valid: false,
    exact_output_contract_valid: false,
    parsed_output: null,
    error,
  };
}

/**
 * Read one reply, strictly.
 *
 * No coercion anywhere: the string `"true"` is not `true`, and a missing field
 * is not `false`. A model that did not answer in the required shape has not
 * answered, and pretending otherwise would let a malformed reply cast a vote.
 */
export function parseSemanticVerdict(text: unknown): SemanticParseResult {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return invalid('empty response');
  }

  const trimmed = text.trim();
  const fenced = FENCE_PATTERN.exec(trimmed);
  const candidate = fenced?.[1] ?? trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return invalid('no JSON object in response');
  }

  const exact = fenced === null && start === 0 && end === candidate.length - 1;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    return invalid(`JSON parse failed: ${message}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return invalid('response is not a JSON object');
  }
  const verdict = parsed as Record<string, unknown>;

  for (const field of SEMANTIC_REQUIRED_FIELDS) {
    if (!(field in verdict)) return invalid(`missing field: ${field}`);
  }
  for (const field of SEMANTIC_BOOLEAN_FIELDS) {
    if (typeof verdict[field] !== 'boolean') return invalid(`${field} is not a boolean`);
  }
  if (typeof verdict.severity !== 'string' || !SEMANTIC_SEVERITIES.includes(verdict.severity)) {
    return invalid(`severity ${String(verdict.severity)} is not a severity`);
  }
  if (
    !Array.isArray(verdict.reason_codes) ||
    !verdict.reason_codes.every((code) => typeof code === 'string')
  ) {
    return invalid('reason_codes is not a string array');
  }
  if (typeof verdict.short_rationale !== 'string') {
    return invalid('short_rationale is not a string');
  }

  return {
    parseable_schema_valid: true,
    exact_output_contract_valid: exact,
    parsed_output: {
      meaning_preserved: verdict.meaning_preserved as boolean,
      severity: verdict.severity,
      negation: verdict.negation as boolean,
      direction_location: verdict.direction_location as boolean,
      instruction_action: verdict.instruction_action as boolean,
      critical_fact: verdict.critical_fact as boolean,
      domain_term: verdict.domain_term as boolean,
      reason_codes: [...(verdict.reason_codes as string[])],
      short_rationale: verdict.short_rationale,
    },
    error: null,
  };
}
