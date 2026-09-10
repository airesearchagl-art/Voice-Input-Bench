/**
 * semantic-rubric-v1 — the production prompt the Human Gate approved.
 *
 * Byte-for-byte the text of research/p3d-semantic/prompts/semantic-rubric-v1.md,
 * copied here once at authoring time. Production must not read anything under
 * `research/` at runtime: a research tree is a place where files get re-run and
 * re-saved, and a graded verdict that depends on one cannot say what it was
 * graded under. This module is the production original.
 *
 * SHA-256: 9677764f367cfbf44048ec60ac76f111e0c2487356598405cca91b27790f3558
 *
 * Do not edit the text. Editing it changes the hash, and preflight then refuses
 * the whole evaluation with SEMANTIC_PROMPT_MISMATCH rather than grading under
 * a prompt no gate ever saw.
 */

export const SEMANTIC_RUBRIC_V1_ID = 'semantic-rubric-v1';

export const SEMANTIC_RUBRIC_V1_SHA256 =
  '9677764f367cfbf44048ec60ac76f111e0c2487356598405cca91b27790f3558';

export const SEMANTIC_RUBRIC_V1_REFERENCE_PLACEHOLDER = '<<<REFERENCE>>>';

export const SEMANTIC_RUBRIC_V1_HYPOTHESIS_PLACEHOLDER = '<<<HYPOTHESIS>>>';

/**
 * The approved template, one source line per entry.
 *
 * Stored as lines rather than one template literal so that a backtick or a
 * `${` inside the rubric can never change how this file parses. Joined with
 * '\n' it is exactly the approved text and nothing else.
 */
const SEMANTIC_RUBRIC_V1_LINES: readonly string[] = [
  "You are grading whether a speech-to-text transcript preserved the meaning of a",
  "canonical source sentence from an architectural design conversation.",
  "",
  "You are given exactly two texts: REFERENCE (what was said) and HYPOTHESIS (what",
  "the transcript recorded). You are not given the correct answer, and you must not",
  "assume one exists in the input.",
  "",
  "## The only question",
  "",
  "Would a reader acting on the HYPOTHESIS do the same thing as a reader acting on",
  "the REFERENCE?",
  "",
  "- `preserved` — yes.",
  "- `changed` — no.",
  "",
  "Judge meaning only. Never judge spelling, punctuation, politeness, fluency or",
  "formatting.",
  "",
  "## Rules",
  "",
  "These are general rules. They are not worked examples, and no pair you are asked",
  "to grade is answered here.",
  "",
  "1. **Writing is not meaning.** Character width, letter case, script, punctuation",
  "   shape and spacing may all differ freely without changing the answer.",
  "2. **The same quantity written differently is the same quantity.** A number",
  "   spelled in digits and the same number spelled in words are one fact, and so",
  "   are two spellings of the same unit.",
  "3. **The same term written differently is the same term.** A domain term",
  "   transliterated into another script, or written in a common colloquial form,",
  "   is not a domain term change.",
  "4. **A different value or unit is `changed`**, however small the edit that",
  "   produced it.",
  "5. **A reversed polarity is `changed`.** A negation added or removed reverses",
  "   the instruction.",
  "6. **A reversed direction, side, level or placement is `changed`.**",
  "7. **A change of instruction state is `changed`** — a request that became a",
  "   report of completed work, or work still to be done that became work already",
  "   done, is not the same instruction.",
  "8. **A required fact that is missing is `changed`, and a fact nobody stated that",
  "   has appeared is `changed`.**",
  "9. **A self-correction is judged by its final intent.** Keeping the corrected",
  "   value and dropping the retracted one is `preserved`; keeping the retracted",
  "   value instead is `changed`.",
  "10. **A change of who must act is `changed`**, and so is a change to the order",
  "    in which things must happen.",
  "",
  "## Output",
  "",
  "Reply with one JSON object and nothing else. No prose before it, no prose after",
  "it, no code fence.",
  "",
  "```",
  "{",
  "  \"meaning_preserved\": true | false,",
  "  \"severity\": \"none\" | \"minor\" | \"major\" | \"critical\",",
  "  \"negation\": true | false,",
  "  \"direction_location\": true | false,",
  "  \"instruction_action\": true | false,",
  "  \"critical_fact\": true | false,",
  "  \"domain_term\": true | false,",
  "  \"reason_codes\": [\"...\"],",
  "  \"short_rationale\": \"...\"",
  "}",
  "```",
  "",
  "Field meanings:",
  "",
  "- `meaning_preserved` — the answer to the only question above.",
  "- `severity` — `none` when preserved. Otherwise how much damage acting on the",
  "  hypothesis would do: `minor` for a difference a reader would catch, `major`",
  "  for one they would act on, `critical` for one that would be built.",
  "- `negation` — true when polarity was reversed or a negation was added or lost.",
  "- `direction_location` — true when a direction, side, level or placement differs.",
  "- `instruction_action` — true when who must do what, or whether it is still to",
  "  be done, differs.",
  "- `critical_fact` — true when a number, unit or clock time differs in value, or",
  "  a required fact is missing or invented.",
  "- `domain_term` — true when a domain term differs in a way that changes what is",
  "  meant.",
  "- `reason_codes` — zero or more of: `SURFACE_ONLY`, `NUMERAL_OR_UNIT_FORM`,",
  "  `DOMAIN_TERM_FORM`, `PARAPHRASE`, `SELF_CORRECTION`, `VALUE`, `UNIT`,",
  "  `DIRECTION_LOCATION`, `NEGATION`, `INSTRUCTION_ACTION`, `OMISSION`,",
  "  `ADDITION`, `ACTOR`, `ORDERING`.",
  "- `short_rationale` — one sentence, at most 200 characters, naming the specific",
  "  difference or stating that there is none.",
  "",
  "When the two texts differ only in how they are written, answer `preserved` with",
  "`severity: \"none\"`.",
  "",
  "When you are unsure, answer `changed`. A missed change costs more than a false",
  "alarm.",
  "",
  "## Input",
  "",
  "REFERENCE:",
  "<<<REFERENCE>>>",
  "",
  "HYPOTHESIS:",
  "<<<HYPOTHESIS>>>",
  "",
];

/** The approved template, placeholders not yet substituted. */
export const SEMANTIC_RUBRIC_V1_TEMPLATE = SEMANTIC_RUBRIC_V1_LINES.join('\n');
