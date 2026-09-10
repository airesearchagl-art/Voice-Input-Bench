import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  SEMANTIC_RUBRIC_V1_SHA256,
  SEMANTIC_RUBRIC_V1_TEMPLATE,
} from './semanticPrompt';
import {
  buildSemanticRequestBody,
  parseSemanticVerdict,
  renderSemanticPrompt,
  semanticRequestSha256,
} from './semanticRubric';
import {
  SEMANTIC_MODEL_ID,
  SEMANTIC_REQUEST_NUM_PREDICT,
  SEMANTIC_REQUEST_TEMPERATURE,
} from './semanticProvider';

/**
 * The prompt that is sent, and the reply that counts as an answer.
 *
 * The prompt is pinned by hash because it is the measurement instrument: two
 * rubrics that read alike can grade differently, and a stored verdict is only
 * interpretable next to the exact text that produced it.
 */

const REFERENCE = '天井高は二千七百ミリを確保してください。';
const HYPOTHESIS = '天井高は2700ミリを確保してください。';

function sha256(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

const VALID_VERDICT = {
  meaning_preserved: false,
  severity: 'major',
  negation: false,
  direction_location: false,
  instruction_action: false,
  critical_fact: true,
  domain_term: false,
  reason_codes: ['VALUE'],
  short_rationale: 'The value differs.',
};

describe('the production prompt is the approved one', () => {
  it('hashes to the SHA the Human Gate approved', () => {
    // The gate approved a specific text. If this fails, production is grading
    // under a rubric nobody signed off on.
    expect(sha256(SEMANTIC_RUBRIC_V1_TEMPLATE)).toBe(SEMANTIC_RUBRIC_V1_SHA256);
    expect(SEMANTIC_RUBRIC_V1_SHA256).toBe(
      '9677764f367cfbf44048ec60ac76f111e0c2487356598405cca91b27790f3558',
    );
  });

  it('reads nothing from disk at runtime', async () => {
    // research/ is where files get re-run and re-saved, so a verdict that
    // depended on one could not say what it was graded under. The module names
    // that file in a comment as its provenance; what matters is that it never
    // opens it, or anything else.
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./semanticPrompt.ts', import.meta.url), 'utf8'),
    );
    for (const forbidden of ['node:fs', 'readFile', 'require(', 'import(', 'process.cwd']) {
      expect(source).not.toContain(forbidden);
    }
    // Exports constants only: nothing to call, so nothing to call at the wrong
    // moment.
    expect(source).not.toContain('export function');
  });

  it('carries both placeholders exactly once', () => {
    expect(SEMANTIC_RUBRIC_V1_TEMPLATE.split('<<<REFERENCE>>>')).toHaveLength(2);
    expect(SEMANTIC_RUBRIC_V1_TEMPLATE.split('<<<HYPOTHESIS>>>')).toHaveLength(2);
  });
});

describe('only the two texts enter the prompt', () => {
  it('substitutes both placeholders and changes nothing else', () => {
    const rendered = renderSemanticPrompt(REFERENCE, HYPOTHESIS);

    expect(rendered).toContain(REFERENCE);
    expect(rendered).toContain(HYPOTHESIS);
    expect(rendered).not.toContain('<<<REFERENCE>>>');
    expect(rendered).not.toContain('<<<HYPOTHESIS>>>');
    // Same length arithmetic as the template: nothing else moved.
    expect(rendered.length).toBe(
      SEMANTIC_RUBRIC_V1_TEMPLATE.length -
        '<<<REFERENCE>>>'.length -
        '<<<HYPOTHESIS>>>'.length +
        REFERENCE.length +
        HYPOTHESIS.length,
    );
  });

  it('leaks no gold label, category or review status about the pair', () => {
    // The research corpus carries all of these next to each pair. None is
    // reachable from this function, which takes two strings and nothing else.
    //
    // Each token is asserted absent from the approved template first, so the
    // test cannot quietly start passing because the rubric happens to use the
    // word. (SELF_CORRECTION, for instance, *is* rubric vocabulary — it is one
    // of the reason codes the model may choose, not a hint about this pair.)
    const rendered = renderSemanticPrompt(REFERENCE, HYPOTHESIS);
    const forbidden = [
      'gold',
      'hard_negative',
      'human_verified',
      'review_status',
      'expected_label',
      'probes-v1',
      'p12',
      'p14',
      'p21',
    ];
    for (const token of forbidden) {
      expect(SEMANTIC_RUBRIC_V1_TEMPLATE.toLowerCase()).not.toContain(token.toLowerCase());
      expect(rendered.toLowerCase()).not.toContain(token.toLowerCase());
    }
  });

  it('renders back to the approved template when the two texts are removed', () => {
    // The strongest form of "nothing else was substituted": undo the two
    // insertions and the original text has to come back exactly.
    const rendered = renderSemanticPrompt(REFERENCE, HYPOTHESIS);
    const undone = rendered
      .replace(REFERENCE, () => '<<<REFERENCE>>>')
      .replace(HYPOTHESIS, () => '<<<HYPOTHESIS>>>');
    expect(undone).toBe(SEMANTIC_RUBRIC_V1_TEMPLATE);
  });

  it('inserts text containing $& literally', () => {
    // String.replace expands `$&` in a string replacement. A transcript that
    // happened to contain it would silently rewrite the prompt.
    const rendered = renderSemanticPrompt('価格は $& です', HYPOTHESIS);
    expect(rendered).toContain('価格は $& です');
  });
});

describe('the request contract is fixed', () => {
  it('sends one user message, temperature 0, num_predict 600, stream false', () => {
    const body = JSON.parse(buildSemanticRequestBody('PROMPT')) as Record<string, unknown>;

    expect(body).toEqual({
      model: SEMANTIC_MODEL_ID,
      messages: [{ role: 'user', content: 'PROMPT' }],
      options: {
        temperature: SEMANTIC_REQUEST_TEMPERATURE,
        num_predict: SEMANTIC_REQUEST_NUM_PREDICT,
      },
      stream: false,
    });
    expect(SEMANTIC_REQUEST_TEMPERATURE).toBe(0);
    expect(SEMANTIC_REQUEST_NUM_PREDICT).toBe(600);
  });

  it('sends no top_p and no seed', () => {
    // The spike measured this exact request. Adding a sampling parameter would
    // make the production runs a different experiment.
    const body = buildSemanticRequestBody('PROMPT');
    expect(body).not.toContain('top_p');
    expect(body).not.toContain('seed');
  });

  it('rebuilds the request hash from the fixed prompt and the two texts', () => {
    // This is what makes request_sha256 checkable at readback with no model.
    expect(semanticRequestSha256(REFERENCE, HYPOTHESIS)).toBe(
      sha256(buildSemanticRequestBody(renderSemanticPrompt(REFERENCE, HYPOTHESIS))),
    );
    expect(semanticRequestSha256(REFERENCE, HYPOTHESIS)).not.toBe(
      semanticRequestSha256(REFERENCE, `${HYPOTHESIS} `),
    );
  });
});

describe('a reply only counts if it is the required shape', () => {
  it('accepts a bare JSON object as both parseable and exact', () => {
    const parsed = parseSemanticVerdict(JSON.stringify(VALID_VERDICT));
    expect(parsed.parseable_schema_valid).toBe(true);
    expect(parsed.exact_output_contract_valid).toBe(true);
    expect(parsed.parsed_output).toEqual(VALID_VERDICT);
    expect(parsed.error).toBeNull();
  });

  it('accepts a fenced reply as parseable but not exact', () => {
    // Usable evidence, but the model did not obey the output contract. Folding
    // the two together would throw away one of the two facts.
    const parsed = parseSemanticVerdict(
      '```json\n' + JSON.stringify(VALID_VERDICT) + '\n```',
    );
    expect(parsed.parseable_schema_valid).toBe(true);
    expect(parsed.exact_output_contract_valid).toBe(false);
    expect(parsed.parsed_output).toEqual(VALID_VERDICT);
  });

  it('accepts a prefaced reply as parseable but not exact', () => {
    const parsed = parseSemanticVerdict(`Here is my answer: ${JSON.stringify(VALID_VERDICT)}`);
    expect(parsed.parseable_schema_valid).toBe(true);
    expect(parsed.exact_output_contract_valid).toBe(false);
  });

  it('never coerces a string into a boolean', () => {
    // "true" is a string. Treating it as agreement would let a sloppy reply
    // cast a vote it did not earn.
    const parsed = parseSemanticVerdict(
      JSON.stringify({ ...VALID_VERDICT, meaning_preserved: 'true' }),
    );
    expect(parsed.parseable_schema_valid).toBe(false);
    expect(parsed.parsed_output).toBeNull();
    expect(parsed.error).toContain('meaning_preserved');
  });

  it('never coerces 0 or 1 into a boolean', () => {
    const parsed = parseSemanticVerdict(JSON.stringify({ ...VALID_VERDICT, negation: 0 }));
    expect(parsed.parseable_schema_valid).toBe(false);
  });

  it('rejects a missing field rather than defaulting it', () => {
    for (const field of Object.keys(VALID_VERDICT)) {
      const partial: Record<string, unknown> = { ...VALID_VERDICT };
      delete partial[field];
      const parsed = parseSemanticVerdict(JSON.stringify(partial));
      expect(parsed.parseable_schema_valid).toBe(false);
      expect(parsed.error).toContain(field);
    }
  });

  it('rejects an explicit null, which is present but not a boolean', () => {
    const parsed = parseSemanticVerdict(
      JSON.stringify({ ...VALID_VERDICT, critical_fact: null }),
    );
    expect(parsed.parseable_schema_valid).toBe(false);
  });

  it('rejects a severity outside the rubric', () => {
    const parsed = parseSemanticVerdict(
      JSON.stringify({ ...VALID_VERDICT, severity: 'catastrophic' }),
    );
    expect(parsed.parseable_schema_valid).toBe(false);
    expect(parsed.error).toContain('severity');
  });

  it('rejects reason_codes that is not an array of strings', () => {
    expect(
      parseSemanticVerdict(JSON.stringify({ ...VALID_VERDICT, reason_codes: 'VALUE' }))
        .parseable_schema_valid,
    ).toBe(false);
    expect(
      parseSemanticVerdict(JSON.stringify({ ...VALID_VERDICT, reason_codes: [1] }))
        .parseable_schema_valid,
    ).toBe(false);
  });

  it('rejects an empty reply, a non-string, prose, and a JSON array', () => {
    for (const reply of ['', '   ', 'I think it changed.', '[1,2,3]', null, undefined, 42]) {
      expect(parseSemanticVerdict(reply).parseable_schema_valid).toBe(false);
    }
  });

  it('rejects a truncated object rather than guessing the rest', () => {
    const parsed = parseSemanticVerdict('{"meaning_preserved": false, "severity": "maj');
    expect(parsed.parseable_schema_valid).toBe(false);
  });

  it('reports every invalid reply as non-exact as well', () => {
    // Obeying the formatting while failing the schema is not partial credit.
    const parsed = parseSemanticVerdict('{}');
    expect(parsed.parseable_schema_valid).toBe(false);
    expect(parsed.exact_output_contract_valid).toBe(false);
  });
});
