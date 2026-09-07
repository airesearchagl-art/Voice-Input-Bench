import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_HOSTS,
  NotLoopbackError,
  assertLoopbackEndpoint,
  isLoopbackHost,
} from './localGuard.mjs';
import {
  PROBES_FILE,
  RESEARCH_ROOT,
  loadProbes,
  modelInputFor,
  recordedProbesSha256,
  sha256OfFile,
  textsFor,
} from './probes.mjs';
import { parseVerdict } from '../run-llm-rubric.mjs';

/**
 * The four guards the P3-D-A spike rests on.
 *
 * A research number is only as trustworthy as the conditions it was produced
 * under, and three of these guards are about exactly that: the corpus was the
 * frozen one, no request left this machine, and no model was shown the answer.
 * The fourth keeps a malformed reply from becoming a data point.
 */

describe('probe SHA verification', () => {
  it('the recorded digest matches the corpus on disk', () => {
    expect(sha256OfFile(PROBES_FILE)).toBe(recordedProbesSha256());
  });

  it('loads the corpus when the digest matches', () => {
    const { probes, sha256 } = loadProbes();
    expect(sha256).toBe(recordedProbesSha256());
    expect(probes.length).toBeGreaterThanOrEqual(24);
  });

  it('refuses a corpus that does not match its digest', () => {
    const original = readFileSync(PROBES_FILE);
    try {
      const edited = JSON.parse(original.toString('utf8'));
      edited.probes[0].hypothesis = 'edited after freezing';
      writeFileSync(PROBES_FILE, `${JSON.stringify(edited, null, 2)}\n`);

      // Numbers produced from an edited corpus would look comparable to earlier
      // runs and would not be. The load fails rather than the comparison
      // quietly becoming meaningless.
      expect(() => loadProbes()).toThrow(/凍結された corpus ではありません/);
    } finally {
      writeFileSync(PROBES_FILE, original);
    }
    expect(sha256OfFile(PROBES_FILE)).toBe(recordedProbesSha256());
  });

  it('the frozen prompt matches its recorded digest', () => {
    const promptFile = path.join(RESEARCH_ROOT, 'prompts', 'semantic-rubric-v1.md');
    const shaFile = path.join(RESEARCH_ROOT, 'prompts', 'semantic-rubric-v1.sha256');
    const recorded = readFileSync(shaFile, 'utf8').trim().split(/\s+/)[0];
    expect(sha256OfFile(promptFile)).toBe(recorded);
  });
});

describe('loopback-only guard', () => {
  it('accepts exactly the three loopback forms', () => {
    expect(ALLOWED_HOSTS).toEqual(['127.0.0.1', 'localhost', '::1', '[::1]']);
    for (const endpoint of [
      'http://127.0.0.1:11434',
      'http://localhost:1234/v1/models',
      'http://LOCALHOST:1234',
      'http://[::1]:8080',
    ]) {
      expect(() => assertLoopbackEndpoint(endpoint)).not.toThrow();
    }
  });

  it('refuses a remote host', () => {
    for (const endpoint of [
      'https://api.openai.com/v1/embeddings',
      'http://192.168.1.10:11434',
      'http://10.0.0.5:1234',
      'https://example.com',
    ]) {
      expect(() => assertLoopbackEndpoint(endpoint)).toThrow(NotLoopbackError);
    }
  });

  it('refuses a host that merely looks local', () => {
    // Each of these contains an allowed host as a substring and is remote. A
    // `startsWith` or `includes` check would have sent transcript text to all
    // four of them.
    for (const hostname of [
      'localhost.example.com',
      '127.0.0.1.attacker.test',
      'notlocalhost',
      'my-localhost',
    ]) {
      expect(isLoopbackHost(hostname)).toBe(false);
      expect(() => assertLoopbackEndpoint(`http://${hostname}:1234`)).toThrow(NotLoopbackError);
    }
  });

  it('refuses a non-http protocol and an unparseable endpoint', () => {
    expect(() => assertLoopbackEndpoint('file:///etc/passwd')).toThrow(NotLoopbackError);
    expect(() => assertLoopbackEndpoint('ws://127.0.0.1:1234')).toThrow(NotLoopbackError);
    expect(() => assertLoopbackEndpoint('not a url')).toThrow(NotLoopbackError);
    expect(() => assertLoopbackEndpoint(undefined)).toThrow(NotLoopbackError);
  });

  it('names the host it refused', () => {
    const error = (() => {
      try {
        assertLoopbackEndpoint('https://api.example.com/v1/embeddings');
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(NotLoopbackError);
    expect(error.kind).toBe('ENDPOINT_NOT_LOOPBACK');
    expect(error.detail.hostname).toBe('api.example.com');
  });
});

describe('gold provenance is stated honestly', () => {
  const { corpus } = loadProbes();

  it('does not claim a human wrote or reviewed the labels', () => {
    // The spike proposed these labels. Calling them human-authored before a
    // person has confirmed them would make every accuracy figure look like a
    // measurement against ground truth.
    expect(corpus.gold_provenance.authoring).toBe('research-agent');
    expect(corpus.gold_provenance.authoring).not.toMatch(/human/);
    // The field that used to make the claim is gone, not merely contradicted.
    expect(corpus.authored_by).toBeUndefined();
  });

  it('records the review as pending until a human says otherwise', () => {
    expect(corpus.gold_provenance.human_review_status).toBe('pending');
    expect(corpus.gold_provenance.human_review_artifact).toBe('HUMAN_GOLD_REVIEW.md');
  });

  it('the review artifact has a row per probe and no approvals', () => {
    const review = readFileSync(path.join(RESEARCH_ROOT, 'HUMAN_GOLD_REVIEW.md'), 'utf8');
    for (const probe of corpus.probes) {
      expect(review).toContain(`| ${probe.id} |`);
    }
    // Count table rows only; the header sentence mentions the marker too.
    const pendingRows = review.split('\n').filter((line) => /^\| p\d+ \|/.test(line));
    expect(pendingRows).toHaveLength(corpus.probes.length);
    expect(pendingRows.every((line) => line.includes('☐ pending'))).toBe(true);
    // An agent must not approve its own labels, so no row may be ticked. The
    // instructions above the table name the marker; a row using it is the thing
    // being guarded against.
    expect(pendingRows.some((line) => line.includes('☑'))).toBe(false);
    expect(pendingRows.some((line) => /approved/i.test(line))).toBe(false);
  });
});

describe('gold labels never reach a model', () => {
  const { probes } = loadProbes();

  it('every probe carries a proposed label to be withheld', () => {
    for (const probe of probes) {
      expect(probe.gold.label).toMatch(/^(preserved|changed)$/);
    }
  });

  it('model input carries only the two texts and the id', () => {
    for (const probe of probes) {
      expect(Object.keys(modelInputFor(probe)).sort()).toEqual(['hypothesis', 'id', 'reference']);
      expect(Object.keys(textsFor(probe)).sort()).toEqual(['hypothesis', 'reference']);
    }
  });

  it('serialized model input contains no gold field, reason code or note', () => {
    for (const probe of probes) {
      const serialized = JSON.stringify(modelInputFor(probe));
      expect(serialized).not.toContain('gold');
      expect(serialized).not.toContain(probe.gold.reason_code);
      expect(serialized).not.toContain(probe.gold.note);
      expect(serialized).not.toContain('hard_negative');
    }
  });

  it('the rendered rubric prompt leaks neither the label nor the note', () => {
    const template = readFileSync(
      path.join(RESEARCH_ROOT, 'prompts', 'semantic-rubric-v1.md'),
      'utf8',
    );
    for (const probe of probes) {
      const texts = textsFor(probe);
      const prompt = template
        .replace('<<<REFERENCE>>>', texts.reference)
        .replace('<<<HYPOTHESIS>>>', texts.hypothesis);

      expect(prompt).toContain(probe.reference);
      expect(prompt).toContain(probe.hypothesis);
      expect(prompt).not.toContain(probe.gold.note);
      // The prompt legitimately lists every reason code as an output option, so
      // the leak to look for is the answer *for this probe* — the gold label
      // presented as a fact about this pair.
      expect(prompt).not.toContain(`"label": "${probe.gold.label}"`);
      expect(prompt).not.toContain(`gold`);
      expect(prompt).not.toContain(probe.id);
    }
  });

  it('the static template contains no holdout probe text', () => {
    // The first round's rubric spelled out two of the corpus pairs as worked
    // examples. That is a few-shot answer to a question the model is about to be
    // asked, and the measured effect of removing it was large.
    const template = readFileSync(
      path.join(RESEARCH_ROOT, 'prompts', 'semantic-rubric-v1.md'),
      'utf8',
    );
    for (const probe of probes) {
      expect(template).not.toContain(probe.reference);
      expect(template).not.toContain(probe.hypothesis);
    }
  });

  it('the prompt template carries exactly two substitution points', () => {
    const template = readFileSync(
      path.join(RESEARCH_ROOT, 'prompts', 'semantic-rubric-v1.md'),
      'utf8',
    );
    const placeholders = template.match(/<<<[A-Z_]+>>>/g) ?? [];
    expect(placeholders.sort()).toEqual(['<<<HYPOTHESIS>>>', '<<<REFERENCE>>>']);
  });
});

describe('malformed model responses fail closed', () => {
  const VALID = {
    meaning_preserved: true,
    severity: 'none',
    negation: false,
    direction_location: false,
    instruction_action: false,
    critical_fact: false,
    domain_term: false,
    reason_codes: ['SURFACE_ONLY'],
    short_rationale: 'Only spelling differs.',
  };

  it('accepts a well-formed verdict', () => {
    const parsed = parseVerdict(JSON.stringify(VALID));
    expect(parsed.ok).toBe(true);
    expect(parsed.verdict.meaning_preserved).toBe(true);
  });

  it('accepts a verdict wrapped in a code fence or prose', () => {
    expect(parseVerdict(`Here you go:\n\`\`\`json\n${JSON.stringify(VALID)}\n\`\`\``).ok).toBe(true);
    expect(parseVerdict(`Sure. ${JSON.stringify(VALID)}`).ok).toBe(true);
  });

  it('rejects a reply with no JSON at all', () => {
    for (const reply of ['', '   ', 'I think the meaning is preserved.', '[1,2,3]']) {
      expect(parseVerdict(reply).ok).toBe(false);
    }
  });

  it('rejects a truncated or unparseable object', () => {
    expect(parseVerdict('{"meaning_preserved": true, "severity":').ok).toBe(false);
    expect(parseVerdict('{meaning_preserved: true}').ok).toBe(false);
  });

  it('rejects a verdict missing any required field', () => {
    for (const field of Object.keys(VALID)) {
      const partial = { ...VALID };
      delete partial[field];
      const parsed = parseVerdict(JSON.stringify(partial));
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain(field);
    }
  });

  it('rejects a wrong type rather than coercing it', () => {
    // "true" is not true. Coercing it would turn a model that could not follow
    // the format into a model that said the transcript was fine.
    expect(parseVerdict(JSON.stringify({ ...VALID, meaning_preserved: 'true' })).ok).toBe(false);
    expect(parseVerdict(JSON.stringify({ ...VALID, severity: 'catastrophic' })).ok).toBe(false);
    expect(parseVerdict(JSON.stringify({ ...VALID, reason_codes: 'SURFACE_ONLY' })).ok).toBe(false);
    expect(parseVerdict(JSON.stringify({ ...VALID, reason_codes: [1, 2] })).ok).toBe(false);
    expect(parseVerdict(JSON.stringify({ ...VALID, short_rationale: null })).ok).toBe(false);
  });

  it('never returns a default verdict on failure', () => {
    const parsed = parseVerdict('nonsense');
    expect(parsed.ok).toBe(false);
    expect(parsed.verdict).toBeUndefined();
  });
});
