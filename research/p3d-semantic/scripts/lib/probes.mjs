import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The frozen probe corpus, and the one rule that makes it worth freezing.
 *
 * `probes-v1.json` carries a human-authored gold label for every pair. Those
 * labels are the thing every method in this spike is being scored against, so
 * a run that let one reach a model would be measuring the model's ability to
 * read the answer rather than to judge the text.
 *
 * {@link modelInputFor} is therefore the only way a probe is allowed to become
 * a request, and it returns a fresh object containing exactly the two texts. A
 * test asserts that no gold field, reason code or note survives it.
 */

export const RESEARCH_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

export const PROBES_FILE = path.join(RESEARCH_ROOT, 'probes-v1.json');
export const PROBES_SHA_FILE = path.join(RESEARCH_ROOT, 'probes-v1.sha256');

export function sha256OfFile(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export function sha256OfText(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

/** The recorded digest, read from the sidecar file. */
export function recordedProbesSha256() {
  return readFileSync(PROBES_SHA_FILE, 'utf8').trim().split(/\s+/)[0];
}

export class ProbeCorpusError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'ProbeCorpusError';
    this.kind = 'PROBE_CORPUS_UNVERIFIED';
    this.detail = detail;
  }
}

/**
 * Load the corpus, refusing to proceed if it is not the frozen one.
 *
 * Every result file in `evidence/` records this digest. A run against an edited
 * corpus would produce numbers that look comparable to earlier ones and are not,
 * which is worse than no numbers.
 */
export function loadProbes({ verify = true } = {}) {
  const actual = sha256OfFile(PROBES_FILE);
  if (verify) {
    const expected = recordedProbesSha256();
    if (actual !== expected) {
      throw new ProbeCorpusError(
        'probes-v1.json が probes-v1.sha256 と一致しません。凍結された corpus ではありません。',
        { expected, actual },
      );
    }
  }

  const corpus = JSON.parse(readFileSync(PROBES_FILE, 'utf8'));
  return { corpus, sha256: actual, probes: corpus.probes };
}

/**
 * What a model is allowed to see.
 *
 * Built by construction rather than by deletion: a new field added to a probe
 * cannot leak by being forgotten here, because nothing is copied except the two
 * texts and the id.
 */
export function modelInputFor(probe) {
  return {
    id: probe.id,
    reference: probe.reference,
    hypothesis: probe.hypothesis,
  };
}

/** Just the two texts, for a request body that should not carry the id either. */
export function textsFor(probe) {
  return { reference: probe.reference, hypothesis: probe.hypothesis };
}
