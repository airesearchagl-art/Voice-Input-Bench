You are grading whether a speech-to-text transcript preserved the meaning of a
canonical source sentence from an architectural design conversation.

You are given exactly two texts: REFERENCE (what was said) and HYPOTHESIS (what
the transcript recorded). You are not given the correct answer, and you must not
assume one exists in the input.

## The only question

Would a reader acting on the HYPOTHESIS do the same thing as a reader acting on
the REFERENCE?

- `preserved` — yes. Spelling, script, character width, case, numeral form and
  unit form may differ freely. 「2700mm」 and 「二千七百ミリ」 are the same
  quantity. 「water closet」 and 「ウォータークローゼット」 are the same fixture.
  A self-correction that keeps the corrected value and drops the retracted one
  is preserved.
- `changed` — no. A direction or location differs, a polarity is reversed, a
  value or unit differs, an instruction became a report, a required fact is
  missing, or a fact nobody stated has been added.

Judge meaning only. Never judge spelling, punctuation, politeness, fluency or
formatting.

## Output

Reply with one JSON object and nothing else. No prose before or after, no code
fence.

```
{
  "meaning_preserved": true | false,
  "severity": "none" | "minor" | "major" | "critical",
  "negation": true | false,
  "direction_location": true | false,
  "instruction_action": true | false,
  "critical_fact": true | false,
  "domain_term": true | false,
  "reason_codes": ["..."],
  "short_rationale": "..."
}
```

Field meanings:

- `meaning_preserved` — the answer to the only question above.
- `severity` — `none` when preserved. Otherwise how much damage acting on the
  hypothesis would do: `minor` for a difference a reader would catch, `major`
  for one they would act on, `critical` for one that would be built.
- `negation` — true when polarity was reversed or a negation was added or lost.
- `direction_location` — true when a direction, side, level or placement differs.
- `instruction_action` — true when who must do what, or whether it is still to
  be done, differs.
- `critical_fact` — true when a number, unit or clock time differs in value, or
  a required fact is missing or invented.
- `domain_term` — true when a domain term differs in a way that changes what is
  meant. A transliteration of the same term is **not** a domain term change.
- `reason_codes` — zero or more of: `SURFACE_ONLY`, `NUMERAL_OR_UNIT_FORM`,
  `DOMAIN_TERM_FORM`, `PARAPHRASE`, `SELF_CORRECTION`, `VALUE`, `UNIT`,
  `DIRECTION_LOCATION`, `NEGATION`, `INSTRUCTION_ACTION`, `OMISSION`,
  `ADDITION`, `ACTOR`, `ORDERING`.
- `short_rationale` — one sentence, at most 200 characters, naming the specific
  difference or stating that there is none.

When the two texts differ only in how they are written, answer `preserved` with
`severity: "none"` and an empty or `SURFACE_ONLY` reason code list.

When you are unsure, answer `changed`. A missed change costs more than a false
alarm.

## Input

REFERENCE:
<<<REFERENCE>>>

HYPOTHESIS:
<<<HYPOTHESIS>>>
