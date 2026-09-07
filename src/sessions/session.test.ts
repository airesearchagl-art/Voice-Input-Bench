import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalRunStore } from '@/storage/LocalRunStore';
import { LocalResultStore } from '@/storage/LocalResultStore';
import { LocalSessionStore } from '@/storage/LocalSessionStore';
import { StorageBoundaryError } from '@/storage/rootIsolation';
import { RunEvidenceError, verifyRunEvidence } from '@/results/runEvidence';
import { BUILT_IN_TOOL_NAMES } from '@/results/tools';
import { saveManualSttResult } from '@/results/saveResult';
import { SessionCreationError, createBenchmarkSession } from './createSession';
import { SessionVerificationError } from './verifyStoredSession';
import { computeSessionSemanticSha256, sessionPayloadOf } from './sessionSchema';
import {
  buildSessionComparison,
  listVerifiedSessions,
  loadVerifiedSession,
} from './comparisonMatrix';

/**
 * Session creation, verification and the coverage matrix, against real Run and
 * Result bundles on disk. Runs and Results are written with the same stores
 * Phase 1 and P2-A use, then referenced — never modified.
 */

const SHORT_RUN = '20260907T010000000Z-aaaaaaaa';
const NUMBERS_RUN = '20260907T010001000Z-bbbbbbbb';
const CODING_RUN = '20260907T010002000Z-cccccccc';
const SHORT_RUN_REGENERATED = '20260907T010003000Z-dddddddd';

const SESSION_ID = '20260907T020000000Z-11111111';
const SESSION_ID_2 = '20260907T020001000Z-22222222';
const NOW = new Date('2026-09-07T02:00:00.000Z');

function sha(bytes: Uint8Array | string): string {
  return createHash('sha256')
    .update(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes)
    .digest('hex');
}

interface RunSpec {
  runId: string;
  testId: string;
  /** Different bytes per Run so `audio_sha256` genuinely differs. */
  seed: number;
  schemaVersion?: unknown;
}

const RUNS: Record<string, RunSpec> = {
  [SHORT_RUN]: { runId: SHORT_RUN, testId: 'architecture-short-001', seed: 1 },
  [NUMBERS_RUN]: { runId: NUMBERS_RUN, testId: 'numbers-units-001', seed: 2 },
  [CODING_RUN]: { runId: CODING_RUN, testId: 'coding-001', seed: 3 },
  // Same Benchmark Case as SHORT_RUN, regenerated: same test_id, different audio.
  [SHORT_RUN_REGENERATED]: {
    runId: SHORT_RUN_REGENERATED,
    testId: 'architecture-short-001',
    seed: 4,
  },
};

function sourceFor(spec: RunSpec): string {
  return `${spec.testId} の本文です（seed ${spec.seed}）。`;
}

function audioFor(spec: RunSpec): Uint8Array {
  const bytes = new Uint8Array(16);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x41, 0x56, 0x45], 8);
  bytes[12] = spec.seed;
  return bytes;
}

const PROVIDER_QUERY = Buffer.from('{"schema_version":1,"segments":[]}\n', 'utf8');

function manifestFor(spec: RunSpec): Record<string, unknown> {
  return {
    schema_version: spec.schemaVersion ?? 2,
    run_id: spec.runId,
    test_id: spec.testId,
    generated_at: NOW.toISOString(),
    source: {
      file: 'source.txt',
      encoding: 'utf-8',
      line_endings: 'lf',
      sha256: sha(sourceFor(spec)),
    },
    provider: {
      id: 'aivisspeech',
      engine_name: 'AivisSpeech',
      engine_version: '1.1.0-dev',
      engine_url: 'http://127.0.0.1:10101',
    },
    model: { uuid: 'm', name: 'まお', version: '1.2.0' },
    voice: { speaker_uuid: 's', speaker_name: 'まお', style_id: 1, style_name: 'ノーマル' },
    settings: { speed_scale: 1, volume_scale: 1, sample_rate: 44100, stereo: false },
    segmentation: { strategy: 'none', target_max_chars: 450, segment_count: 1 },
    provider_query: { file: 'provider-query.json', sha256: sha(PROVIDER_QUERY) },
    audio: {
      file: 'audio.wav',
      content_type: 'audio/wav',
      sha256: sha(audioFor(spec)),
      bytes: audioFor(spec).byteLength,
    },
    reproducibility: { canonical_artifact: true, bit_exact_regeneration_expected: false },
  };
}

let runsRoot: string;
let resultsRoot: string;
let sessionsRoot: string;
let runStore: LocalRunStore;
let resultStore: LocalResultStore;
let sessionStore: LocalSessionStore;

function deps() {
  return { runStore, resultStore, sessionStore };
}

async function writeRun(runId: string, overrides: Partial<RunSpec> = {}): Promise<void> {
  const spec = { ...RUNS[runId]!, ...overrides };
  await runStore.saveRun(spec.runId, {
    sourceText: sourceFor(spec),
    audio: audioFor(spec),
    providerQueryJson: PROVIDER_QUERY,
    manifestJson: Buffer.from(`${JSON.stringify(manifestFor(spec), null, 2)}\n`, 'utf8'),
  });
}

/** Every file of a tree with its hash, for before/after comparison. */
async function treeFingerprint(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string, prefix: string) => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = path.join(dir, entry.name);
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(full, key);
      else out[key] = sha(new Uint8Array(await readFile(full)));
    }
  };
  await walk(root, '').catch(() => {});
  return out;
}

async function saveResult(runId: string, toolId: string, transcript: string, resultId: string) {
  return saveManualSttResult(
    { runId, toolId, deliveryPath: 'speaker-to-mic', rawTranscript: transcript },
    { runStore, resultStore, now: () => NOW, resultId },
  );
}

beforeEach(async () => {
  runsRoot = await mkdtemp(path.join(tmpdir(), 'vib-s-runs-'));
  resultsRoot = await mkdtemp(path.join(tmpdir(), 'vib-s-results-'));
  sessionsRoot = await mkdtemp(path.join(tmpdir(), 'vib-s-sessions-'));
  runStore = new LocalRunStore(runsRoot);
  resultStore = new LocalResultStore(resultsRoot);
  sessionStore = new LocalSessionStore(sessionsRoot);
});

afterEach(async () => {
  for (const root of [runsRoot, resultsRoot, sessionsRoot]) {
    await rm(root, { recursive: true, force: true });
  }
});

const BOTH_TOOLS = ['windows-standard-voice-input', 'aqua-voice'];

function createInput(runIds: string[], overrides: Record<string, unknown> = {}) {
  return { name: '2026-09 建築ドメイン比較', runIds, targetTools: BOTH_TOOLS, ...overrides };
}

describe('session creation resolves evidence server-side', () => {
  it('snapshots test_id and hashes from a fresh verification', async () => {
    await writeRun(SHORT_RUN);
    await writeRun(NUMBERS_RUN);

    const outcome = await createBenchmarkSession(createInput([SHORT_RUN, NUMBERS_RUN]), {
      ...deps(),
      now: () => NOW,
      sessionId: SESSION_ID,
    });

    expect(outcome.session).toEqual({
      schema_version: 1,
      session_id: SESSION_ID,
      created_at: NOW.toISOString(),
      name: '2026-09 建築ドメイン比較',
      cases: [
        {
          test_id: 'architecture-short-001',
          run_id: SHORT_RUN,
          source_sha256: sha(sourceFor(RUNS[SHORT_RUN]!)),
          audio_sha256: sha(audioFor(RUNS[SHORT_RUN]!)),
        },
        {
          test_id: 'numbers-units-001',
          run_id: NUMBERS_RUN,
          source_sha256: sha(sourceFor(RUNS[NUMBERS_RUN]!)),
          audio_sha256: sha(audioFor(RUNS[NUMBERS_RUN]!)),
        },
      ],
      target_tools: BOTH_TOOLS,
      integrity: {
        algorithm: 'sha256',
        semantic_sha256: computeSessionSemanticSha256(sessionPayloadOf(outcome.session)),
      },
    });
  });

  it('records an integrity hash over the Session payload', async () => {
    await writeRun(SHORT_RUN);
    const outcome = await createBenchmarkSession(createInput([SHORT_RUN]), {
      ...deps(),
      now: () => NOW,
      sessionId: SESSION_ID,
    });

    expect(outcome.session.integrity.algorithm).toBe('sha256');
    expect(outcome.session.integrity.semantic_sha256).toMatch(/^[0-9a-f]{64}$/);
    // The hash covers the payload, not itself.
    expect(outcome.session.integrity.semantic_sha256).toBe(
      computeSessionSemanticSha256({
        schema_version: 1,
        session_id: SESSION_ID,
        created_at: NOW.toISOString(),
        name: '2026-09 建築ドメイン比較',
        cases: outcome.session.cases,
        target_tools: outcome.session.target_tools,
      }),
    );
  });

  it('ignores case metadata the client tries to supply', async () => {
    await writeRun(SHORT_RUN);

    const outcome = await createBenchmarkSession(
      {
        ...createInput([SHORT_RUN]),
        // None of these are part of the input contract; they must not appear.
        cases: [{ test_id: 'spoofed', run_id: SHORT_RUN, audio_sha256: 'f'.repeat(64) }],
        test_id: 'spoofed',
        audio_sha256: 'f'.repeat(64),
      } as never,
      { ...deps(), now: () => NOW, sessionId: SESSION_ID },
    );

    expect(outcome.session.cases[0]!.test_id).toBe('architecture-short-001');
    expect(outcome.session.cases[0]!.audio_sha256).toBe(sha(audioFor(RUNS[SHORT_RUN]!)));
    expect(JSON.stringify(outcome.session)).not.toContain('spoofed');
  });

  it('writes session.json whose parsed content equals the returned Session', async () => {
    await writeRun(SHORT_RUN);
    const outcome = await createBenchmarkSession(createInput([SHORT_RUN]), {
      ...deps(),
      now: () => NOW,
      sessionId: SESSION_ID,
    });

    const onDisk = JSON.parse(await readFile(path.join(outcome.sessionDir, 'session.json'), 'utf8'));
    expect(onDisk).toEqual(outcome.session);
  });

  it('generates its own session id when none is injected', async () => {
    await writeRun(SHORT_RUN);
    const outcome = await createBenchmarkSession(createInput([SHORT_RUN]), {
      ...deps(),
      now: () => NOW,
    });
    expect(outcome.sessionId).toMatch(/^20260907T020000000Z-[0-9a-f]{8}$/);
  });
});

describe('session creation fails closed', () => {
  async function expectNoSession(promise: Promise<unknown>) {
    const error = await promise.catch((caught: unknown) => caught);
    expect(await readdir(sessionsRoot)).toEqual([]);
    return error;
  }

  it('refuses an unknown Run', async () => {
    const error = await expectNoSession(
      createBenchmarkSession(createInput([SHORT_RUN]), {
        ...deps(),
        now: () => NOW,
        sessionId: SESSION_ID,
      }),
    );
    expect(error).toBeInstanceOf(RunEvidenceError);
    expect((error as RunEvidenceError).kind).toBe('RUN_NOT_FOUND');
  });

  it('refuses a manifest schema v1 Run', async () => {
    await writeRun(SHORT_RUN, { schemaVersion: 1 });
    const error = await expectNoSession(
      createBenchmarkSession(createInput([SHORT_RUN]), {
        ...deps(),
        now: () => NOW,
        sessionId: SESSION_ID,
      }),
    );
    expect((error as RunEvidenceError).kind).toBe('RUN_MANIFEST_SCHEMA_UNSUPPORTED');
  });

  it('refuses a Run whose artifacts no longer match its manifest', async () => {
    await writeRun(SHORT_RUN);
    await writeFile(path.join(runStore.resolveRunDir(SHORT_RUN), 'audio.wav'), '差し替え');

    const error = await expectNoSession(
      createBenchmarkSession(createInput([SHORT_RUN]), {
        ...deps(),
        now: () => NOW,
        sessionId: SESSION_ID,
      }),
    );
    expect((error as RunEvidenceError).kind).toBe('RUN_HASH_MISMATCH');
  });

  it('refuses two Runs of the same Benchmark Case', async () => {
    // The regenerated Run has the same test_id but different audio: exactly the
    // ambiguity a Session exists to remove.
    await writeRun(SHORT_RUN);
    await writeRun(SHORT_RUN_REGENERATED);

    const error = await expectNoSession(
      createBenchmarkSession(createInput([SHORT_RUN, SHORT_RUN_REGENERATED]), {
        ...deps(),
        now: () => NOW,
        sessionId: SESSION_ID,
      }),
    );
    expect(error).toBeInstanceOf(SessionCreationError);
    expect((error as SessionCreationError).kind).toBe('SESSION_DUPLICATE_TEST_ID');
    expect((error as SessionCreationError).detail).toContain('architecture-short-001');
  });

  it('refuses the same Run listed twice', async () => {
    await writeRun(SHORT_RUN);
    const error = await expectNoSession(
      createBenchmarkSession(createInput([SHORT_RUN, SHORT_RUN]), {
        ...deps(),
        now: () => NOW,
        sessionId: SESSION_ID,
      }),
    );
    expect((error as SessionCreationError).kind).toBe('SESSION_DUPLICATE_TEST_ID');
  });

  const BAD_INPUTS: Array<[string, Record<string, unknown>, string]> = [
    ['an empty name', { name: '   ' }, 'SESSION_NAME_REQUIRED'],
    ['no Runs', { runIds: [] }, 'SESSION_RUNS_REQUIRED'],
    ['no target tools', { targetTools: [] }, 'SESSION_TARGET_TOOLS_REQUIRED'],
    ['an unknown target tool', { targetTools: ['whisper'] }, 'SESSION_UNKNOWN_TARGET_TOOL'],
    [
      'the `other` tool, which P2-B does not compare',
      { targetTools: ['other'] },
      'SESSION_UNKNOWN_TARGET_TOOL',
    ],
    [
      'a duplicate target tool',
      { targetTools: ['aqua-voice', 'aqua-voice'] },
      'SESSION_DUPLICATE_TARGET_TOOL',
    ],
  ];

  for (const [label, overrides, kind] of BAD_INPUTS) {
    it(`refuses ${label}`, async () => {
      await writeRun(SHORT_RUN);
      const error = await expectNoSession(
        createBenchmarkSession(createInput([SHORT_RUN], overrides), {
          ...deps(),
          now: () => NOW,
          sessionId: SESSION_ID,
        }),
      );
      expect(error).toBeInstanceOf(SessionCreationError);
      expect((error as SessionCreationError).kind).toBe(kind);
    });
  }

  it('refuses a storage layout where sessions sit inside the runs tree', async () => {
    await writeRun(SHORT_RUN);
    const before = await treeFingerprint(runsRoot);

    const error = await createBenchmarkSession(createInput([SHORT_RUN]), {
      runStore,
      resultStore,
      sessionStore: new LocalSessionStore(path.join(runsRoot, 'sessions')),
      now: () => NOW,
      sessionId: SESSION_ID,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StorageBoundaryError);
    expect(await treeFingerprint(runsRoot)).toEqual(before);
  });
});

describe('session readback verification', () => {
  async function seed(runIds: string[] = [SHORT_RUN, NUMBERS_RUN]) {
    for (const runId of runIds) await writeRun(runId);
    return createBenchmarkSession(createInput(runIds), {
      ...deps(),
      now: () => NOW,
      sessionId: SESSION_ID,
    });
  }

  async function patchSession(mutate: (session: Record<string, unknown>) => void) {
    const file = sessionStore.resolveSessionFile(SESSION_ID);
    const session = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    mutate(session);
    await writeFile(file, `${JSON.stringify(session, null, 2)}\n`);
  }

  async function expectRejected(kind: string) {
    const error = await loadVerifiedSession(deps(), SESSION_ID).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SessionVerificationError);
    expect((error as SessionVerificationError).kind).toBe(kind);
  }

  it('accepts an untouched Session', async () => {
    await seed();
    const session = await loadVerifiedSession(deps(), SESSION_ID);
    expect(session.cases).toHaveLength(2);
  });

  it('rejects an unsupported schema', async () => {
    await seed();
    await patchSession((session) => {
      session.schema_version = 2;
    });
    await expectRejected('SESSION_SCHEMA_UNSUPPORTED');
  });

  it('rejects a session_id that does not match its directory', async () => {
    await seed();
    await patchSession((session) => {
      session.session_id = SESSION_ID_2;
    });
    await expectRejected('SESSION_ID_MISMATCH');
  });

  it('rejects an invalid created_at', async () => {
    await seed();
    await patchSession((session) => {
      session.created_at = 'not a date';
    });
    await expectRejected('SESSION_CREATED_AT_INVALID');
  });

  it('rejects an empty name', async () => {
    await seed();
    await patchSession((session) => {
      session.name = '   ';
    });
    await expectRejected('SESSION_NAME_INVALID');
  });

  it('rejects a hand-added duplicate Case', async () => {
    await seed();
    await patchSession((session) => {
      const cases = session.cases as unknown[];
      cases.push(cases[0]);
    });
    await expectRejected('SESSION_DUPLICATE_TEST_ID');
  });

  it('rejects a malformed run_id', async () => {
    await seed();
    await patchSession((session) => {
      (session.cases as Array<Record<string, unknown>>)[0]!.run_id = '../escape';
    });
    await expectRejected('SESSION_RUN_ID_INVALID');
  });

  it('rejects an unknown target tool', async () => {
    await seed();
    await patchSession((session) => {
      session.target_tools = ['whisper'];
    });
    await expectRejected('SESSION_TARGET_TOOLS_INVALID');
  });

  it('rejects duplicate target tools', async () => {
    await seed();
    await patchSession((session) => {
      session.target_tools = ['aqua-voice', 'aqua-voice'];
    });
    await expectRejected('SESSION_TARGET_TOOLS_INVALID');
  });

  it('rejects a Session whose Run has gone missing', async () => {
    await seed();
    await rm(runStore.resolveRunDir(NUMBERS_RUN), { recursive: true });

    const error = await loadVerifiedSession(deps(), SESSION_ID).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RunEvidenceError);
    expect((error as RunEvidenceError).kind).toBe('RUN_NOT_FOUND');
  });

  it('rejects a Session whose Run drifted from its manifest', async () => {
    await seed();
    await writeFile(path.join(runStore.resolveRunDir(SHORT_RUN), 'audio.wav'), '差し替え');

    const error = await loadVerifiedSession(deps(), SESSION_ID).catch((caught: unknown) => caught);
    expect((error as RunEvidenceError).kind).toBe('RUN_HASH_MISMATCH');
  });

  const EVIDENCE_FIELDS: Array<[string, string]> = [
    ['test_id', 'spoofed-case'],
    ['source_sha256', 'a'.repeat(64)],
    ['audio_sha256', 'b'.repeat(64)],
  ];

  for (const [field, value] of EVIDENCE_FIELDS) {
    it(`rejects a hand-edited ${field}`, async () => {
      await seed();
      await patchSession((session) => {
        (session.cases as Array<Record<string, unknown>>)[0]![field] = value;
      });
      // The integrity hash catches this before the Run is even read.
      await expectRejected('SESSION_INTEGRITY_MISMATCH');
    });
  }

  it('rejects a Case repointed at another Run', async () => {
    // The clearest form of the failure a Session exists to prevent: same
    // test_id, different WAV.
    await writeRun(SHORT_RUN_REGENERATED);
    await seed();
    await patchSession((session) => {
      (session.cases as Array<Record<string, unknown>>)[0]!.run_id = SHORT_RUN_REGENERATED;
    });
    await expectRejected('SESSION_INTEGRITY_MISMATCH');
  });

  it('still reports an evidence mismatch when the Run itself was replaced', async () => {
    // session.json is untouched, so the integrity hash passes. The Run at that
    // id was deleted and rebuilt with different content — internally consistent,
    // but no longer the Run this Session pinned.
    await seed([SHORT_RUN]);
    await rm(runStore.resolveRunDir(SHORT_RUN), { recursive: true });
    await writeRun(SHORT_RUN, { testId: 'coding-001', seed: 9 });

    await expectRejected('SESSION_EVIDENCE_MISMATCH');
  });

  it('keeps a broken Session out of the verified listing', async () => {
    await seed();
    await patchSession((session) => {
      session.name = '   ';
    });
    expect(await listVerifiedSessions(deps())).toEqual([]);
  });

  it('lists verified Sessions newest first', async () => {
    await seed();
    await createBenchmarkSession(createInput([CODING_RUN], { name: 'second' }), {
      ...deps(),
      now: () => NOW,
      sessionId: SESSION_ID_2,
    }).catch(() => {});
    await writeRun(CODING_RUN);
    await createBenchmarkSession(createInput([CODING_RUN], { name: 'second' }), {
      ...deps(),
      now: () => NOW,
      sessionId: SESSION_ID_2,
    });

    const summaries = await listVerifiedSessions(deps());
    expect(summaries.map((entry) => entry.sessionId)).toEqual([SESSION_ID_2, SESSION_ID]);
    expect(summaries[0]).toMatchObject({ name: 'second', caseCount: 1, targetTools: BOTH_TOOLS });
  });
});

describe('RF-1: semantic integrity of the stored Session', () => {
  async function seed() {
    await writeRun(SHORT_RUN);
    await writeRun(NUMBERS_RUN);
    return createBenchmarkSession(createInput([SHORT_RUN, NUMBERS_RUN]), {
      ...deps(),
      now: () => NOW,
      sessionId: SESSION_ID,
    });
  }

  async function patchSession(mutate: (session: Record<string, unknown>) => void) {
    const file = sessionStore.resolveSessionFile(SESSION_ID);
    const session = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    mutate(session);
    await writeFile(file, `${JSON.stringify(session, null, 2)}\n`);
  }

  async function expectIntegrityRejection() {
    const error = await loadVerifiedSession(deps(), SESSION_ID).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SessionVerificationError);
    expect((error as SessionVerificationError).kind).toBe('SESSION_INTEGRITY_MISMATCH');
  }

  it('accepts an untouched Session', async () => {
    await seed();
    const session = await loadVerifiedSession(deps(), SESSION_ID);
    expect(session.integrity.algorithm).toBe('sha256');
  });

  it('rejects an edit to a different but perfectly valid name', async () => {
    await seed();
    await patchSession((session) => {
      session.name = '別の実験名';
    });
    await expectIntegrityRejection();
  });

  it('rejects an edit to a different but perfectly valid created_at', async () => {
    await seed();
    await patchSession((session) => {
      session.created_at = '2026-01-01T00:00:00.000Z';
    });
    await expectIntegrityRejection();
  });

  it('rejects narrowing target_tools to a valid subset', async () => {
    // The exact edit that structural validation cannot see: still a valid
    // Session, but a different experiment.
    await seed();
    await patchSession((session) => {
      session.target_tools = ['windows-standard-voice-input'];
    });
    await expectIntegrityRejection();
  });

  it('rejects reordering target_tools', async () => {
    await seed();
    await patchSession((session) => {
      session.target_tools = ['aqua-voice', 'windows-standard-voice-input'];
    });
    await expectIntegrityRejection();
  });

  it('rejects reordering cases', async () => {
    await seed();
    await patchSession((session) => {
      session.cases = (session.cases as unknown[]).slice().reverse();
    });
    await expectIntegrityRejection();
  });

  it('rejects dropping a case', async () => {
    await seed();
    await patchSession((session) => {
      session.cases = (session.cases as unknown[]).slice(0, 1);
    });
    await expectIntegrityRejection();
  });

  it('rejects a tampered integrity hash', async () => {
    await seed();
    await patchSession((session) => {
      (session.integrity as Record<string, unknown>).semantic_sha256 = 'f'.repeat(64);
    });
    await expectIntegrityRejection();
  });

  it('rejects a missing or malformed integrity record', async () => {
    await seed();
    const file = sessionStore.resolveSessionFile(SESSION_ID);
    const pristine = await readFile(file, 'utf8');

    for (const mutate of [
      (session: Record<string, unknown>) => delete session.integrity,
      (session: Record<string, unknown>) => {
        session.integrity = { algorithm: 'md5', semantic_sha256: 'f'.repeat(64) };
      },
      (session: Record<string, unknown>) => {
        session.integrity = { algorithm: 'sha256', semantic_sha256: 'not-a-hash' };
      },
      (session: Record<string, unknown>) => {
        session.integrity = 'sha256';
      },
    ]) {
      await writeFile(file, pristine);
      await patchSession(mutate);

      const error = await loadVerifiedSession(deps(), SESSION_ID).catch((caught: unknown) => caught);
      expect((error as SessionVerificationError).kind).toBe('SESSION_INTEGRITY_MISSING');
    }
  });

  it('accepts a file that was only reformatted', async () => {
    // Whitespace and key order are not part of what a Session means.
    await seed();
    const file = sessionStore.resolveSessionFile(SESSION_ID);
    const session = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    const reordered = {
      integrity: session.integrity,
      target_tools: session.target_tools,
      cases: session.cases,
      name: session.name,
      created_at: session.created_at,
      session_id: session.session_id,
      schema_version: session.schema_version,
    };
    await writeFile(file, JSON.stringify(reordered));

    const verified = await loadVerifiedSession(deps(), SESSION_ID);
    expect(verified.name).toBe('2026-09 建築ドメイン比較');
  });

  it('keeps an integrity-broken Session out of the verified listing', async () => {
    await seed();
    await patchSession((session) => {
      session.name = 'tampered';
    });
    expect(await listVerifiedSessions(deps())).toEqual([]);
  });
});

describe('comparison matrix', () => {
  async function seedSession() {
    await writeRun(SHORT_RUN);
    await writeRun(NUMBERS_RUN);
    await writeRun(CODING_RUN);
    return createBenchmarkSession(createInput([SHORT_RUN, NUMBERS_RUN, CODING_RUN]), {
      ...deps(),
      now: () => NOW,
      sessionId: SESSION_ID,
    });
  }

  function cell(
    comparison: Awaited<ReturnType<typeof buildSessionComparison>>,
    testId: string,
    tool: string,
  ) {
    const row = comparison.rows.find((candidate) => candidate.testId === testId)!;
    return row.cells.find((candidate) => candidate.tool === tool)!;
  }

  it('reports every Case as missing before any Result exists', async () => {
    await seedSession();
    const comparison = await buildSessionComparison(deps(), SESSION_ID);

    expect(comparison.rows.map((row) => row.testId)).toEqual([
      'architecture-short-001',
      'numbers-units-001',
      'coding-001',
    ]);
    for (const row of comparison.rows) {
      for (const matrixCell of row.cells) {
        expect(matrixCell.status).toBe('missing');
        expect(matrixCell.verifiedCount).toBe(0);
      }
    }
  });

  it('shows both tools verified, one missing, and reports transcripts', async () => {
    await seedSession();
    await saveResult(
      SHORT_RUN,
      'windows-standard-voice-input',
      'Windows の書き起こし',
      '20260907T030000000Z-aaaa0001',
    );
    await saveResult(SHORT_RUN, 'aqua-voice', 'Aqua の書き起こし', '20260907T030001000Z-aaaa0002');
    await saveResult(
      NUMBERS_RUN,
      'windows-standard-voice-input',
      '2700ミリ',
      '20260907T030002000Z-aaaa0003',
    );

    const comparison = await buildSessionComparison(deps(), SESSION_ID);

    expect(cell(comparison, 'architecture-short-001', 'windows-standard-voice-input')).toMatchObject(
      { status: 'covered', verifiedCount: 1 },
    );
    expect(cell(comparison, 'architecture-short-001', 'aqua-voice')).toMatchObject({
      status: 'covered',
      verifiedCount: 1,
    });
    expect(cell(comparison, 'numbers-units-001', 'windows-standard-voice-input').status).toBe(
      'covered',
    );
    expect(cell(comparison, 'numbers-units-001', 'aqua-voice').status).toBe('missing');
    expect(cell(comparison, 'coding-001', 'windows-standard-voice-input').status).toBe('missing');

    // Transcripts are attached so the two tools can be read side by side.
    expect(
      cell(comparison, 'architecture-short-001', 'windows-standard-voice-input').verified[0]!
        .transcript,
    ).toBe('Windows の書き起こし');
    expect(cell(comparison, 'architecture-short-001', 'aqua-voice').verified[0]!.transcript).toBe(
      'Aqua の書き起こし',
    );
  });

  it('does not attribute a Result to a Case it was not captured for', async () => {
    await seedSession();
    await saveResult(
      NUMBERS_RUN,
      'aqua-voice',
      '別 Case の観測',
      '20260907T030003000Z-aaaa0004',
    );

    const comparison = await buildSessionComparison(deps(), SESSION_ID);
    expect(cell(comparison, 'numbers-units-001', 'aqua-voice').status).toBe('covered');
    expect(cell(comparison, 'architecture-short-001', 'aqua-voice').status).toBe('missing');
  });

  it('counts several observations of the same tool', async () => {
    await seedSession();
    await saveResult(SHORT_RUN, 'aqua-voice', '一回目', '20260907T030004000Z-aaaa0005');
    await saveResult(SHORT_RUN, 'aqua-voice', '二回目', '20260907T030005000Z-aaaa0006');

    const matrixCell = cell(
      await buildSessionComparison(deps(), SESSION_ID),
      'architecture-short-001',
      'aqua-voice',
    );
    expect(matrixCell.verifiedCount).toBe(2);
    expect(matrixCell.verified.map((entry) => entry.transcript)).toEqual(['一回目', '二回目']);
  });

  it('surfaces a rejected Result without counting it as coverage', async () => {
    await seedSession();
    const stored = await saveResult(
      SHORT_RUN,
      'windows-standard-voice-input',
      '改竄される観測',
      '20260907T030006000Z-aaaa0007',
    );
    await writeFile(path.join(stored.resultDir, 'transcript.txt'), '書き換えられた');

    const matrixCell = cell(
      await buildSessionComparison(deps(), SESSION_ID),
      'architecture-short-001',
      'windows-standard-voice-input',
    );
    expect(matrixCell.status).toBe('rejected-only');
    expect(matrixCell.verifiedCount).toBe(0);
    expect(matrixCell.rejectedCount).toBe(1);
    expect(matrixCell.rejected[0]!.resultId).toBe('20260907T030006000Z-aaaa0007');
  });

  it('keeps a broken Windows observation out of the Aqua column', async () => {
    await seedSession();
    await saveResult(SHORT_RUN, 'aqua-voice', '正常な観測', '20260907T030007000Z-aaaa0008');
    const broken = await saveResult(
      SHORT_RUN,
      'windows-standard-voice-input',
      '壊れる観測',
      '20260907T030008000Z-aaaa0009',
    );
    await writeFile(path.join(broken.resultDir, 'transcript.txt'), '書き換えられた');

    const comparison = await buildSessionComparison(deps(), SESSION_ID);
    const aqua = cell(comparison, 'architecture-short-001', 'aqua-voice');
    const windows = cell(comparison, 'architecture-short-001', 'windows-standard-voice-input');

    expect(aqua).toMatchObject({ verifiedCount: 1, rejectedCount: 0, status: 'covered' });
    expect(windows).toMatchObject({ verifiedCount: 0, rejectedCount: 1, status: 'rejected-only' });
  });

  it('reflects a Result added after the Session was created', async () => {
    const outcome = await seedSession();
    const before = await readFile(path.join(outcome.sessionDir, 'session.json'), 'utf8');

    expect(
      cell(await buildSessionComparison(deps(), SESSION_ID), 'coding-001', 'aqua-voice').status,
    ).toBe('missing');

    await saveResult(CODING_RUN, 'aqua-voice', 'npm run build', '20260907T030009000Z-aaaa000a');

    expect(
      cell(await buildSessionComparison(deps(), SESSION_ID), 'coding-001', 'aqua-voice').status,
    ).toBe('covered');

    // The plan itself did not change.
    expect(await readFile(path.join(outcome.sessionDir, 'session.json'), 'utf8')).toBe(before);
  });

  it('reports no score, ranking or winner', async () => {
    await seedSession();
    await saveResult(SHORT_RUN, 'aqua-voice', 'テキスト', '20260907T030010000Z-aaaa000b');

    const comparison = await buildSessionComparison(deps(), SESSION_ID);
    const serialized = JSON.stringify(comparison);
    for (const forbidden of ['score', 'cer', 'wer', 'rank', 'winner', 'accuracy']) {
      expect(serialized.toLowerCase()).not.toContain(forbidden);
    }
  });
});

describe('immutability across the whole flow', () => {
  it('leaves the Run and Result trees untouched by Session creation and reads', async () => {
    await writeRun(SHORT_RUN);
    await writeRun(NUMBERS_RUN);
    await saveResult(
      SHORT_RUN,
      'windows-standard-voice-input',
      '観測',
      '20260907T040000000Z-bbbb0001',
    );

    const runsBefore = await treeFingerprint(runsRoot);
    const resultsBefore = await treeFingerprint(resultsRoot);

    const outcome = await createBenchmarkSession(createInput([SHORT_RUN, NUMBERS_RUN]), {
      ...deps(),
      now: () => NOW,
      sessionId: SESSION_ID,
    });
    await buildSessionComparison(deps(), SESSION_ID);
    await listVerifiedSessions(deps());

    expect(await treeFingerprint(runsRoot)).toEqual(runsBefore);
    expect(await treeFingerprint(resultsRoot)).toEqual(resultsBefore);
    expect(Object.keys(await treeFingerprint(sessionsRoot))).toEqual([
      `${outcome.sessionId}/session.json`,
    ]);
  });

  it('leaves session.json unchanged when a Result is added', async () => {
    await writeRun(SHORT_RUN);
    const outcome = await createBenchmarkSession(createInput([SHORT_RUN]), {
      ...deps(),
      now: () => NOW,
      sessionId: SESSION_ID,
    });
    const before = await treeFingerprint(sessionsRoot);

    await saveResult(SHORT_RUN, 'aqua-voice', '後から追加', '20260907T040001000Z-bbbb0002');
    await buildSessionComparison(deps(), outcome.sessionId);

    expect(await treeFingerprint(sessionsRoot)).toEqual(before);
  });

  it('refuses to create a second Session with the same id', async () => {
    await writeRun(SHORT_RUN);
    await createBenchmarkSession(createInput([SHORT_RUN]), {
      ...deps(),
      now: () => NOW,
      sessionId: SESSION_ID,
    });

    await expect(
      createBenchmarkSession(createInput([SHORT_RUN], { name: 'another' }), {
        ...deps(),
        now: () => NOW,
        sessionId: SESSION_ID,
      }),
    ).rejects.toMatchObject({ kind: 'SESSION_ALREADY_EXISTS' });

    const session = await loadVerifiedSession(deps(), SESSION_ID);
    expect(session.name).toBe('2026-09 建築ドメイン比較');
  });
});

describe('RF-3: rejected Results are attributed to the tool they belong to', () => {
  async function seedSession() {
    await writeRun(SHORT_RUN);
    return createBenchmarkSession(createInput([SHORT_RUN]), {
      ...deps(),
      now: () => NOW,
      sessionId: SESSION_ID,
    });
  }

  function cellOf(
    comparison: Awaited<ReturnType<typeof buildSessionComparison>>,
    tool: string,
  ) {
    return comparison.rows[0]!.cells.find((candidate) => candidate.tool === tool)!;
  }

  async function patchResultJson(
    resultId: string,
    mutate: (result: Record<string, unknown>) => void,
  ) {
    const file = resultStore.resolveResultFile(resultId, 'result.json');
    const result = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    mutate(result);
    await writeFile(file, `${JSON.stringify(result, null, 2)}\n`);
  }

  it('counts a broken Windows Result against Windows only', async () => {
    await seedSession();
    const stored = await saveResult(
      SHORT_RUN,
      'windows-standard-voice-input',
      '壊れる観測',
      '20260907T050000000Z-cccc0001',
    );
    await writeFile(path.join(stored.resultDir, 'transcript.txt'), '書き換え');

    const comparison = await buildSessionComparison(deps(), SESSION_ID);
    expect(cellOf(comparison, 'windows-standard-voice-input')).toMatchObject({
      status: 'rejected-only',
      verifiedCount: 0,
      rejectedCount: 1,
    });
    expect(cellOf(comparison, 'aqua-voice')).toMatchObject({
      status: 'missing',
      rejectedCount: 0,
    });
    expect(comparison.rows[0]!.unattributedRejected).toEqual([]);
  });

  it('counts a broken Aqua Result against Aqua only', async () => {
    await seedSession();
    const stored = await saveResult(
      SHORT_RUN,
      'aqua-voice',
      '壊れる観測',
      '20260907T050001000Z-cccc0002',
    );
    await writeFile(path.join(stored.resultDir, 'transcript.txt'), '書き換え');

    const comparison = await buildSessionComparison(deps(), SESSION_ID);
    expect(cellOf(comparison, 'aqua-voice')).toMatchObject({
      status: 'rejected-only',
      rejectedCount: 1,
    });
    expect(cellOf(comparison, 'windows-standard-voice-input')).toMatchObject({
      status: 'missing',
      rejectedCount: 0,
    });
  });

  it('attributes nothing when the tool identity itself is invalid', async () => {
    await seedSession();
    const resultId = '20260907T050002000Z-cccc0003';
    await saveResult(SHORT_RUN, 'windows-standard-voice-input', '観測', resultId);
    await patchResultJson(resultId, (result) => {
      (result.tool as Record<string, unknown>).id = 'whisper';
    });

    const comparison = await buildSessionComparison(deps(), SESSION_ID);
    for (const tool of ['windows-standard-voice-input', 'aqua-voice']) {
      expect(cellOf(comparison, tool)).toMatchObject({ status: 'missing', rejectedCount: 0 });
    }
    expect(comparison.rows[0]!.unattributedRejected).toHaveLength(1);
    expect(comparison.rows[0]!.unattributedRejected[0]!.resultId).toBe(resultId);
  });

  it('attributes nothing when the tool name contradicts the tool id', async () => {
    await seedSession();
    const resultId = '20260907T050003000Z-cccc0004';
    await saveResult(SHORT_RUN, 'windows-standard-voice-input', '観測', resultId);
    await patchResultJson(resultId, (result) => {
      (result.tool as Record<string, unknown>).name = 'Aqua Voice';
    });

    const comparison = await buildSessionComparison(deps(), SESSION_ID);
    expect(cellOf(comparison, 'windows-standard-voice-input').rejectedCount).toBe(0);
    expect(cellOf(comparison, 'aqua-voice').rejectedCount).toBe(0);
    expect(comparison.rows[0]!.unattributedRejected).toHaveLength(1);
  });

  it('shows a verified and a rejected observation of the same tool together', async () => {
    await seedSession();
    await saveResult(
      SHORT_RUN,
      'windows-standard-voice-input',
      '正常な観測',
      '20260907T050004000Z-cccc0005',
    );
    const broken = await saveResult(
      SHORT_RUN,
      'windows-standard-voice-input',
      '壊れる観測',
      '20260907T050005000Z-cccc0006',
    );
    await writeFile(path.join(broken.resultDir, 'transcript.txt'), '書き換え');

    const comparison = await buildSessionComparison(deps(), SESSION_ID);
    expect(cellOf(comparison, 'windows-standard-voice-input')).toMatchObject({
      status: 'covered',
      verifiedCount: 1,
      rejectedCount: 1,
    });
    expect(cellOf(comparison, 'aqua-voice').status).toBe('missing');
  });

  it('leaves both tools covered when both Results are valid', async () => {
    await seedSession();
    await saveResult(
      SHORT_RUN,
      'windows-standard-voice-input',
      'Windows',
      '20260907T050006000Z-cccc0007',
    );
    await saveResult(SHORT_RUN, 'aqua-voice', 'Aqua', '20260907T050007000Z-cccc0008');

    const comparison = await buildSessionComparison(deps(), SESSION_ID);
    expect(cellOf(comparison, 'windows-standard-voice-input').status).toBe('covered');
    expect(cellOf(comparison, 'aqua-voice').status).toBe('covered');
    expect(comparison.rows[0]!.unattributedRejected).toEqual([]);
  });

  it('keeps an `other` tool Result out of the Windows and Aqua columns', async () => {
    await seedSession();
    await saveManualSttResult(
      {
        runId: SHORT_RUN,
        toolId: 'other',
        customToolName: '社内ツール',
        deliveryPath: 'speaker-to-mic',
        rawTranscript: '対象外ツールの観測',
      },
      { runStore, resultStore, now: () => NOW, resultId: '20260907T050008000Z-cccc0009' },
    );

    const comparison = await buildSessionComparison(deps(), SESSION_ID);
    for (const tool of ['windows-standard-voice-input', 'aqua-voice']) {
      expect(cellOf(comparison, tool)).toMatchObject({
        status: 'missing',
        verifiedCount: 0,
        rejectedCount: 0,
      });
    }
    expect(comparison.rows[0]!.unattributedRejected).toEqual([]);
  });

  it('surfaces a broken `other` Result as unattributed rather than as coverage', async () => {
    await seedSession();
    const resultId = '20260907T050009000Z-cccc000a';
    const stored = await saveManualSttResult(
      {
        runId: SHORT_RUN,
        toolId: 'other',
        customToolName: '社内ツール',
        deliveryPath: 'speaker-to-mic',
        rawTranscript: '対象外ツールの観測',
      },
      { runStore, resultStore, now: () => NOW, resultId },
    );
    await writeFile(path.join(stored.resultDir, 'transcript.txt'), '書き換え');

    const comparison = await buildSessionComparison(deps(), SESSION_ID);
    for (const tool of ['windows-standard-voice-input', 'aqua-voice']) {
      expect(cellOf(comparison, tool).rejectedCount).toBe(0);
    }
    expect(comparison.rows[0]!.unattributedRejected).toHaveLength(1);
  });
});

/**
 * R1.1 — what the matrix will and will not count.
 *
 * A cell is a claim that a specific tool produced (or failed to produce) a
 * specific observation. That claim rests entirely on the Result's `tool`
 * section, so only a Result whose metadata is sealed and intact can fill one.
 *
 * Unsealed P2-A Results are not errors and are not hidden — they are shown
 * against the Case, outside the columns.
 */
describe('R1.1: only sealed Results count as per-tool coverage', () => {
  async function seedSession() {
    await writeRun(SHORT_RUN);
    return createBenchmarkSession(createInput([SHORT_RUN]), {
      ...deps(),
      now: () => NOW,
      sessionId: SESSION_ID,
    });
  }

  function cellOf(comparison: Awaited<ReturnType<typeof buildSessionComparison>>, tool: string) {
    return comparison.rows[0]!.cells.find((candidate) => candidate.tool === tool)!;
  }

  /** A P2-A Result, written exactly as P2-A wrote them: no integrity record. */
  async function saveLegacyV1Result(
    toolId: 'windows-standard-voice-input' | 'aqua-voice',
    transcript: string,
    resultId: string,
  ) {
    const evidence = await verifyRunEvidence(runStore, SHORT_RUN);
    const legacy = {
      schema_version: 1,
      result_id: resultId,
      run_id: SHORT_RUN,
      captured_at: NOW.toISOString(),
      tool: { id: toolId, name: BUILT_IN_TOOL_NAMES[toolId], version: null },
      capture: { method: 'manual-paste', delivery_path: 'speaker-to-mic' },
      run_evidence: {
        manifest_schema_version: evidence.manifestSchemaVersion,
        test_id: evidence.testId,
        source_sha256: evidence.sourceSha256,
        audio_sha256: evidence.audioSha256,
      },
      transcript: {
        file: 'transcript.txt',
        encoding: 'utf-8',
        line_endings: 'lf',
        sha256: sha(transcript),
        bytes: Buffer.byteLength(transcript, 'utf8'),
      },
    };
    return resultStore.saveResult(resultId, {
      transcriptText: transcript,
      resultJson: Buffer.from(`${JSON.stringify(legacy, null, 2)}\n`, 'utf8'),
    });
  }

  it('counts two sealed Results as coverage on both sides', async () => {
    await seedSession();
    await saveResult(
      SHORT_RUN,
      'windows-standard-voice-input',
      'Windows の観測',
      '20260907T060000000Z-dddd0001',
    );
    await saveResult(SHORT_RUN, 'aqua-voice', 'Aqua の観測', '20260907T060001000Z-dddd0002');

    const comparison = await buildSessionComparison(deps(), SESSION_ID);
    for (const tool of BOTH_TOOLS) {
      expect(cellOf(comparison, tool)).toMatchObject({ status: 'covered', verifiedCount: 1 });
    }
    expect(comparison.rows[0]!.legacyUnsealed).toEqual([]);
    expect(comparison.rows[0]!.unattributedRejected).toEqual([]);
  });

  it('keeps a legacy v1 Result out of the cells and shows it against the Case', async () => {
    await seedSession();
    const resultId = '20260907T060002000Z-dddd0003';
    await saveLegacyV1Result('windows-standard-voice-input', 'legacy の観測', resultId);

    const comparison = await buildSessionComparison(deps(), SESSION_ID);
    expect(cellOf(comparison, 'windows-standard-voice-input')).toMatchObject({
      status: 'missing',
      verifiedCount: 0,
      rejectedCount: 0,
    });
    expect(cellOf(comparison, 'aqua-voice').status).toBe('missing');
    expect(comparison.rows[0]!.legacyUnsealed).toEqual([
      { resultId, toolId: 'windows-standard-voice-input', status: 'verified' },
    ]);
    expect(comparison.rows[0]!.unattributedRejected).toEqual([]);
  });

  it('does not let a legacy Result mask a sealed one for the same tool', async () => {
    await seedSession();
    await saveLegacyV1Result(
      'windows-standard-voice-input',
      'legacy の観測',
      '20260907T060003000Z-dddd0004',
    );
    await saveResult(
      SHORT_RUN,
      'windows-standard-voice-input',
      'Windows の観測',
      '20260907T060004000Z-dddd0005',
    );

    const comparison = await buildSessionComparison(deps(), SESSION_ID);
    // The sealed one covers the cell. The legacy one is reported alongside it,
    // not folded into the count.
    expect(cellOf(comparison, 'windows-standard-voice-input')).toMatchObject({
      status: 'covered',
      verifiedCount: 1,
    });
    expect(comparison.rows[0]!.legacyUnsealed).toHaveLength(1);
  });

  it('does not move a Result between columns on a valid-to-valid identity edit', async () => {
    await seedSession();
    const resultId = '20260907T060005000Z-dddd0006';
    await saveResult(SHORT_RUN, 'windows-standard-voice-input', 'Windows の観測', resultId);

    const file = resultStore.resolveResultFile(resultId, 'result.json');
    const stored = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    const tool = stored.tool as Record<string, unknown>;
    tool.id = 'aqua-voice';
    tool.name = BUILT_IN_TOOL_NAMES['aqua-voice'];
    await writeFile(file, `${JSON.stringify(stored, null, 2)}\n`);

    const comparison = await buildSessionComparison(deps(), SESSION_ID);
    // Neither the column it left nor the column it was pushed into.
    for (const candidate of BOTH_TOOLS) {
      expect(cellOf(comparison, candidate)).toMatchObject({
        status: 'missing',
        verifiedCount: 0,
        rejectedCount: 0,
      });
    }
    expect(comparison.rows[0]!.unattributedRejected).toHaveLength(1);
    expect(comparison.rows[0]!.unattributedRejected[0]!.reason).toBe('RESULT_INTEGRITY_MISMATCH');
  });

  it('counts a sealed Windows Result with a missing transcript against Windows', async () => {
    await seedSession();
    const resultId = '20260907T060006000Z-dddd0007';
    const stored = await saveResult(
      SHORT_RUN,
      'windows-standard-voice-input',
      'Windows の観測',
      resultId,
    );
    await rm(path.join(stored.resultDir, 'transcript.txt'), { force: true });

    const comparison = await buildSessionComparison(deps(), SESSION_ID);
    expect(cellOf(comparison, 'windows-standard-voice-input')).toMatchObject({
      status: 'rejected-only',
      rejectedCount: 1,
    });
    expect(cellOf(comparison, 'aqua-voice')).toMatchObject({
      status: 'missing',
      rejectedCount: 0,
    });
    expect(comparison.rows[0]!.unattributedRejected).toEqual([]);
  });

  it('counts a sealed Aqua Result with a missing transcript against Aqua', async () => {
    await seedSession();
    const resultId = '20260907T060007000Z-dddd0008';
    const stored = await saveResult(SHORT_RUN, 'aqua-voice', 'Aqua の観測', resultId);
    await rm(path.join(stored.resultDir, 'transcript.txt'), { force: true });

    const comparison = await buildSessionComparison(deps(), SESSION_ID);
    expect(cellOf(comparison, 'aqua-voice')).toMatchObject({
      status: 'rejected-only',
      rejectedCount: 1,
    });
    expect(cellOf(comparison, 'windows-standard-voice-input')).toMatchObject({
      status: 'missing',
      rejectedCount: 0,
    });
    expect(comparison.rows[0]!.unattributedRejected).toEqual([]);
  });

  it('does not attribute a legacy Result with a missing transcript to a cell', async () => {
    await seedSession();
    const resultId = '20260907T060008000Z-dddd0009';
    const stored = await saveLegacyV1Result('aqua-voice', 'legacy の観測', resultId);
    await rm(path.join(stored.resultDir, 'transcript.txt'), { force: true });

    const comparison = await buildSessionComparison(deps(), SESSION_ID);
    for (const tool of BOTH_TOOLS) {
      expect(cellOf(comparison, tool)).toMatchObject({ status: 'missing', rejectedCount: 0 });
    }
    expect(comparison.rows[0]!.legacyUnsealed).toEqual([
      {
        resultId,
        toolId: 'aqua-voice',
        status: 'rejected',
        reason: 'RESULT_TRANSCRIPT_MISSING',
        message: 'transcript.txt を読み込めません。',
      },
    ]);
    expect(comparison.rows[0]!.unattributedRejected).toEqual([]);
  });
});
