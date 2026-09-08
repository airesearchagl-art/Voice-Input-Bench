import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVIDENCE_DIR } from './evidence.mjs';
import { loadProbes, recordedProbesSha256 } from './probes.mjs';
import { goldStatus } from './goldStatus.mjs';

/**
 * The Human Gold promotion moved the corpus, and therefore its digest.
 *
 * The risk this file guards is not that a number is wrong; it is that a number
 * from *before* the review survives beside one from after it and reads as
 * current. Every evidence file records the corpus digest it ran against, so
 * "which corpus produced this?" is answerable — but only if something checks
 * that the answer is the same everywhere.
 */

const PREVIOUS_CORPUS_SHA =
  '5a14302d80732959b5ae249de1daaf731f8e9596fd86042d526b7fafc4475b0a';

function evidenceFiles() {
  return readdirSync(EVIDENCE_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => ({ name, body: JSON.parse(readFileSync(path.join(EVIDENCE_DIR, name), 'utf8')) }));
}

describe('the corpus digest is the promoted one, everywhere', () => {
  const { sha256, corpus } = loadProbes();

  it('the corpus on disk matches its recorded digest', () => {
    expect(sha256).toBe(recordedProbesSha256());
  });

  it('the promoted corpus is not the pre-review one', () => {
    expect(sha256).not.toBe(PREVIOUS_CORPUS_SHA);
    expect(corpus.gold_provenance.historical.previous_corpus_sha256).toBe(PREVIOUS_CORPUS_SHA);
  });

  it('every evidence file that names a corpus names this one', () => {
    const files = evidenceFiles().filter((file) => 'probes_sha256' in file.body);
    // The runs that produce scored results all record it; if one ever stops,
    // this catches that too.
    expect(files.map((f) => f.name).sort()).toEqual([
      'analysis-summary.json',
      'embedding-results.json',
      'llm-rubric-results.raw.json',
      'llm-rubric-results.surface.json',
    ]);

    for (const file of files) {
      expect(file.body.probes_sha256, file.name).toBe(sha256);
    }
  });

  it('no evidence file still runs against the pre-review corpus', () => {
    // The pre-review digest may appear as recorded history inside the corpus
    // provenance, and nowhere else. An evidence file carrying it would be a
    // result from before the review sitting where a current one belongs.
    for (const file of evidenceFiles()) {
      expect(file.body.probes_sha256 ?? sha256, file.name).not.toBe(PREVIOUS_CORPUS_SHA);
      expect(
        file.body.gold_provenance?.historical?.previous_corpus_sha256 ?? PREVIOUS_CORPUS_SHA,
        file.name,
      ).toBe(PREVIOUS_CORPUS_SHA);
    }
  });
});

describe('how accuracy may be described is derived from the corpus', () => {
  const { corpus } = loadProbes();

  it('reads the wording off gold_provenance rather than being told it', () => {
    const status = goldStatus(corpus.gold_provenance);
    expect(status.human_reviewed).toBe(true);
    expect(status.accuracy_label).toBe('accuracy against human-reviewed labels');
    expect(status.accuracy_label).not.toMatch(/provisional/);
  });

  it('falls back to provisional wording whenever the review is not approved', () => {
    // The property that matters: nothing can describe a figure as
    // human-reviewed unless the corpus says the review happened.
    for (const human_review_status of ['pending', 'rejected', 'unknown', undefined]) {
      const status = goldStatus({ authoring: 'research-agent', human_review_status });
      expect(status.human_reviewed).toBe(false);
      expect(status.accuracy_label).toBe('provisional accuracy against proposed labels');
    }
  });

  it('every scored evidence file carries the reviewed status', () => {
    for (const file of evidenceFiles()) {
      if (!file.body.gold_status) continue;
      expect(file.body.gold_status.human_review_status, file.name).toBe('approved');
      expect(file.body.scoring_caveat, file.name).not.toMatch(/provisional/);
      expect(file.body.scoring_caveat, file.name).toMatch(/human-reviewed labels/);
    }
  });

  it('no current artifact carries a provisional field name', () => {
    // The corpus is reviewed, so nothing produced from it may be *called*
    // provisional. `gold_provenance.historical` is the one place the word still
    // belongs: it records what R0, R1 and R1.1 were measured against, and
    // deleting that would make those rounds unreadable rather than accurate.
    for (const file of evidenceFiles()) {
      const withoutHistory = { ...file.body };
      if (withoutHistory.gold_provenance) {
        withoutHistory.gold_provenance = { ...withoutHistory.gold_provenance };
        delete withoutHistory.gold_provenance.historical;
      }
      const serialized = JSON.stringify(withoutHistory);

      expect(serialized, file.name).not.toContain('provisional_accuracy');
      expect(serialized, file.name).not.toContain('provisional accuracy');
      // And the history that is kept says it is history.
      if (file.body.gold_provenance?.historical) {
        expect(file.body.gold_provenance.historical.previous_human_review_status, file.name).toBe(
          'pending',
        );
      }
    }
  });

  it('accuracy is reported under a name that survives a review', () => {
    const summary = JSON.parse(
      readFileSync(path.join(EVIDENCE_DIR, 'analysis-summary.json'), 'utf8'),
    );
    for (const variant of Object.values(summary.llm_rubric)) {
      if (variant.status !== 'OK') continue;
      expect(variant.accuracy).toMatch(/^\d+\.\d%$/);
      expect(variant).not.toHaveProperty('provisional_accuracy');
    }
    for (const [name, data] of Object.entries(summary.hybrid.variants)) {
      expect(data.accuracy, name).toMatch(/^\d+\.\d%$/);
      expect(data, name).not.toHaveProperty('provisional_accuracy');
    }
  });

  it('the summary still names who wrote the labels', () => {
    const summary = JSON.parse(
      readFileSync(path.join(EVIDENCE_DIR, 'analysis-summary.json'), 'utf8'),
    );
    expect(summary.gold_provenance.authoring).toBe('research-agent');
    expect(summary.gold_provenance.human_review_status).toBe('approved');
    expect(summary.gold_provenance.human_label_change_count).toBe(0);
  });
});

describe('the runtime that produced the final evidence is recorded', () => {
  it('the rubric evidence pins the Ollama build and model artifact', () => {
    for (const name of ['llm-rubric-results.raw.json', 'llm-rubric-results.surface.json']) {
      const body = JSON.parse(readFileSync(path.join(EVIDENCE_DIR, name), 'utf8'));
      expect(body.runtime.name, name).toBe('Ollama');
      expect(body.runtime.version_status, name).toBe('reported');
      expect(body.model.digest_status, name).toBe('reported');
      expect(body.model.digest, name).toMatch(/^[0-9a-f]{64}$/);
      expect(body.endpoint_class, name).toBe('loopback');
    }
  });

  it('the embedding evidence says what it cannot pin, rather than omitting it', () => {
    const body = JSON.parse(
      readFileSync(path.join(EVIDENCE_DIR, 'embedding-results.json'), 'utf8'),
    );
    expect(body.endpoint_class).toBe('loopback');
    // No digest exists for this runtime. The absence is recorded with a reason,
    // never filled with a placeholder that would survive a comparison it never
    // made.
    expect(body.model.digest).toBeNull();
    expect(body.model.digest_status).toMatch(/^unavailable_from_runtime:/);
  });
});
