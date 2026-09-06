'use client';

import { useCallback, useEffect, useState } from 'react';
import type { TTSCapabilities, TTSVoice } from '@/tts/TTSProvider';
import type { AivmModelsProbe } from '@/tts/AivisSpeechProvider';
import type { RunManifest } from '@/benchmark/manifest';
import { MANUAL_TEST_ID, resolveSourceSelection } from '@/benchmark/sourceSelection';

/**
 * The bench UI — one page.
 *
 * Engine is fixed to AivisSpeech for Phase 1, so there is no engine selector.
 * Only Voice/Style, Speed and Volume are user-adjustable; format, sample rate
 * and channel count are fixed so Runs stay comparable.
 *
 * Generate produces a persisted Run rather than a throwaway blob, so the page
 * shows the Run's identity (id, test id, segmentation, hashes, byte count) and
 * plays the stored `audio.wav` back through the Run's own audio route.
 *
 * The text is either typed here or taken from a built-in Benchmark Case. For a
 * Case the body shown below is display only — the server reads its own copy.
 */

interface ApiErrorShape {
  kind: string;
  message: string;
  endpoint?: string;
  httpStatus?: number;
  detail?: string;
}

interface StatusOk {
  ok: true;
  engineName: string;
  engineVersion: string;
  engineUrl: string;
  providerId: string;
  aivmModels: AivmModelsProbe;
}

/** What `POST /api/generate` returns once a Run has been persisted. */
interface GeneratedRun {
  ok: true;
  runId: string;
  audioUrl: string;
  manifest: RunManifest;
}

/** One built-in Benchmark Case, as listed by `GET /api/cases`. */
interface BenchmarkCaseSummary {
  id: string;
  title: string;
  intent: string;
  /** Shown so the operator can see what will be spoken. Display only. */
  text: string;
  charCount: number;
  expectedSegmentCount: number;
}

const DEFAULT_TEXT = 'これはボイスインプットベンチの疎通確認用テキストです。';

async function readApiError(response: Response): Promise<ApiErrorShape> {
  try {
    const body: unknown = await response.json();
    if (
      typeof body === 'object' &&
      body !== null &&
      'error' in body &&
      typeof (body as { error: unknown }).error === 'object' &&
      (body as { error: unknown }).error !== null
    ) {
      return (body as { error: ApiErrorShape }).error;
    }
  } catch {
    // fall through to the generic shape below
  }
  return {
    kind: 'UNEXPECTED',
    message: `サーバーが HTTP ${response.status} を返しました。`,
    httpStatus: response.status,
  };
}

function ErrorPanel({ title, error }: { title: string; error: ApiErrorShape }) {
  return (
    <div className="alert error" role="alert">
      <span className="kind">
        {title}: {error.kind}
      </span>
      <p>{error.message}</p>
      {(error.endpoint ?? error.httpStatus ?? error.detail) !== undefined && (
        <div className="meta">
          {error.endpoint ? `endpoint: ${error.endpoint}\n` : ''}
          {error.httpStatus ? `http: ${error.httpStatus}\n` : ''}
          {error.detail ? `detail: ${error.detail}` : ''}
        </div>
      )}
    </div>
  );
}

export default function Page() {
  const [status, setStatus] = useState<StatusOk | null>(null);
  const [statusError, setStatusError] = useState<ApiErrorShape | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);

  const [voices, setVoices] = useState<TTSVoice[]>([]);
  const [capabilities, setCapabilities] = useState<TTSCapabilities | null>(null);
  const [voicesError, setVoicesError] = useState<ApiErrorShape | null>(null);
  const [noVoicesInstalled, setNoVoicesInstalled] = useState(false);

  const [cases, setCases] = useState<BenchmarkCaseSummary[]>([]);
  const [testId, setTestId] = useState<string>(MANUAL_TEST_ID);
  const [text, setText] = useState(DEFAULT_TEXT);
  const [styleId, setStyleId] = useState<number | null>(null);
  const [speedScale, setSpeedScale] = useState(1);
  const [volumeScale, setVolumeScale] = useState(1);

  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<ApiErrorShape | null>(null);
  // The player reads the stored Run, not an in-memory blob: what you hear is
  // the canonical artifact on disk, not a copy that was never persisted.
  const [run, setRun] = useState<GeneratedRun | null>(null);

  const loadStatus = useCallback(async () => {
    setStatusLoading(true);
    setStatusError(null);
    try {
      const response = await fetch('/api/status', { cache: 'no-store' });
      if (!response.ok) {
        setStatus(null);
        setStatusError(await readApiError(response));
        return;
      }
      setStatus((await response.json()) as StatusOk);
    } catch (caught) {
      setStatus(null);
      setStatusError({
        kind: 'ENGINE_CONNECTION_FAILED',
        message: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      setStatusLoading(false);
    }
  }, []);

  const loadVoices = useCallback(async () => {
    // Clear voice state up front. If this load fails, no previously selected
    // voice may survive: Generate would otherwise post a styleId the engine has
    // not confirmed in this session, and the Run would cite a voice we never
    // actually looked up.
    setVoicesError(null);
    setNoVoicesInstalled(false);
    setVoices([]);
    setStyleId(null);
    setCapabilities(null);

    try {
      const response = await fetch('/api/voices', { cache: 'no-store' });
      if (!response.ok) {
        setVoicesError(await readApiError(response));
        return;
      }
      const body = (await response.json()) as {
        voices: TTSVoice[];
        capabilities: TTSCapabilities;
        warning: string | null;
      };
      setVoices(body.voices);
      setCapabilities(body.capabilities);
      setSpeedScale(body.capabilities.speed.default);
      setVolumeScale(body.capabilities.volume.default);
      setNoVoicesInstalled(body.warning === 'NO_VOICES_INSTALLED');
      setStyleId(body.voices[0]?.styleId ?? null);
    } catch (caught) {
      setVoicesError({
        kind: 'ENGINE_CONNECTION_FAILED',
        message: caught instanceof Error ? caught.message : String(caught),
      });
    }
  }, []);

  const loadCases = useCallback(async () => {
    try {
      const response = await fetch('/api/cases', { cache: 'no-store' });
      if (!response.ok) return;
      const body = (await response.json()) as { cases: BenchmarkCaseSummary[] };
      setCases(body.cases);
    } catch {
      // The Benchmark Case list is a convenience; a failure here must not stop
      // the operator from running a manual Run.
      setCases([]);
    }
  }, []);

  const reload = useCallback(() => {
    void loadStatus();
    void loadVoices();
    void loadCases();
  }, [loadCases, loadStatus, loadVoices]);

  useEffect(() => {
    reload();
  }, [reload]);

  const generate = useCallback(async () => {
    if (styleId === null) return;
    // Same guard as the button, so a stale click cannot get past it either.
    if (
      !resolveSourceSelection({
        testId,
        text,
        knownCaseIds: cases.map((benchmarkCase) => benchmarkCase.id),
      }).ready
    ) {
      return;
    }
    setGenerating(true);
    setGenerateError(null);
    setRun(null);
    try {
      const response = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // For a Benchmark Case the server reads its own copy of the text;
        // `text` here is only meaningful for a manual Run.
        body: JSON.stringify({ testId, text, styleId, speedScale, volumeScale }),
      });
      if (!response.ok) {
        setGenerateError(await readApiError(response));
        return;
      }
      setRun((await response.json()) as GeneratedRun);
    } catch (caught) {
      setGenerateError({
        kind: 'UNEXPECTED',
        message: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      setGenerating(false);
    }
  }, [cases, speedScale, styleId, testId, text, volumeScale]);

  const selectedCase = cases.find((benchmarkCase) => benchmarkCase.id === testId);
  const connected = status !== null;
  // Decided from what the page can actually see. A selected case whose body
  // never loaded blocks Generate rather than letting the server synthesize one
  // text while the operator reads another.
  const selection = resolveSourceSelection({
    testId,
    text,
    knownCaseIds: cases.map((benchmarkCase) => benchmarkCase.id),
  });
  const canGenerate = connected && styleId !== null && selection.ready && !generating;
  const speedRange = capabilities?.speed ?? { min: 0.5, max: 2, step: 0.05, default: 1 };
  const volumeRange = capabilities?.volume ?? { min: 0, max: 2, step: 0.05, default: 1 };

  return (
    <main className="page">
      <header className="page-header">
        <h1>Voice Input Bench</h1>
        <p>Text → local TTS → canonical WAV + Manifest</p>
      </header>

      <section className="panel">
        <h2>AivisSpeech Connection</h2>
        <div className="status-line">
          <span
            className={`dot ${statusLoading ? '' : connected ? 'ok' : 'err'}`}
            aria-hidden="true"
          />
          <span>
            {statusLoading ? '確認中…' : connected ? 'Connected' : 'Not connected'}
          </span>
          <button type="button" className="secondary" onClick={reload} disabled={statusLoading}>
            再確認
          </button>
        </div>

        <dl className="kv">
          <dt>Engine</dt>
          <dd>AivisSpeech</dd>
          <dt>Engine Version</dt>
          <dd>{status?.engineVersion ?? '—'}</dd>
          <dt>Engine URL</dt>
          <dd>{status?.engineUrl ?? '—'}</dd>
          <dt>AIVM Models</dt>
          <dd>
            {status === null
              ? '—'
              : status.aivmModels.status === 'ok'
                ? `${status.aivmModels.models.length} 件`
                : `取得失敗 (${status.aivmModels.error?.kind ?? 'UNKNOWN'})`}
          </dd>
        </dl>

        {statusError && (
          <>
            <div style={{ height: 12 }} />
            <ErrorPanel title="Status" error={statusError} />
          </>
        )}
      </section>

      <section className="panel">
        <h2>Input</h2>

        <div className="field">
          <label htmlFor="testId">Test</label>
          <select id="testId" value={testId} onChange={(event) => setTestId(event.target.value)}>
            <option value={MANUAL_TEST_ID}>Manual — 自分で入力する</option>
            {cases.map((benchmarkCase) => (
              <option key={benchmarkCase.id} value={benchmarkCase.id}>
                {benchmarkCase.id} — {benchmarkCase.title}（{benchmarkCase.charCount} 字 /{' '}
                {benchmarkCase.expectedSegmentCount} segment）
              </option>
            ))}
          </select>
          {selectedCase && <p className="fixed-note">{selectedCase.intent}</p>}
        </div>

        <div className="field">
          <label htmlFor="text">
            Test Text
            {selectedCase && (
              <span className="hint">
                Benchmark Case 本文（読み取り専用・サーバー側の正本を使用）
              </span>
            )}
          </label>
          <textarea
            id="text"
            value={selectedCase ? selectedCase.text : text}
            onChange={(event) => setText(event.target.value)}
            readOnly={selectedCase !== undefined}
            placeholder="合成するテキストを入力"
          />
        </div>

        <div className="field">
          <label htmlFor="voice">Voice / Style</label>
          <select
            id="voice"
            value={styleId ?? ''}
            onChange={(event) => setStyleId(Number(event.target.value))}
            disabled={voices.length === 0}
          >
            {voices.length === 0 && <option value="">（利用可能な音声がありません）</option>}
            {voices.map((voice) => (
              <option key={voice.styleId} value={voice.styleId}>
                {voice.label} (id: {voice.styleId})
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="speed">
            Speed<span className="hint">speedScale</span>
          </label>
          <div className="slider-row">
            <input
              id="speed"
              type="range"
              min={speedRange.min}
              max={speedRange.max}
              step={speedRange.step}
              value={speedScale}
              onChange={(event) => setSpeedScale(Number(event.target.value))}
            />
            <output htmlFor="speed">{speedScale.toFixed(2)}</output>
          </div>
        </div>

        <div className="field">
          <label htmlFor="volume">
            Volume<span className="hint">volumeScale</span>
          </label>
          <div className="slider-row">
            <input
              id="volume"
              type="range"
              min={volumeRange.min}
              max={volumeRange.max}
              step={volumeRange.step}
              value={volumeScale}
              onChange={(event) => setVolumeScale(Number(event.target.value))}
            />
            <output htmlFor="volume">{volumeScale.toFixed(2)}</output>
          </div>
        </div>

        <button type="button" onClick={() => void generate()} disabled={!canGenerate}>
          {generating ? '生成中…' : 'Generate'}
        </button>

        <p className="fixed-note">
          固定: Format WAV / Sample Rate {capabilities?.fixedSampleRate ?? 44100} Hz / Stereo{' '}
          {String(capabilities?.fixedStereo ?? false)}
        </p>

        {!selection.ready && selection.reason === 'CASE_NOT_LOADED' && (
          <>
            <div style={{ height: 12 }} />
            <div className="alert error" role="alert">
              <span className="kind">CASE_NOT_LOADED</span>
              <p>
                Benchmark Case <code>{testId}</code> の本文を取得できていません。本文が確認できない
                Case で Run を作らないため、Generate を無効にしています。再確認するか Manual
                を選び直してください。
              </p>
            </div>
          </>
        )}

        {noVoicesInstalled && (
          <>
            <div style={{ height: 12 }} />
            <div className="alert warn" role="status">
              <span className="kind">NO_VOICES_INSTALLED</span>
              <p>
                Engine には接続できましたが、利用可能な音声モデルが 0 件です。AivisSpeech
                側に音声モデルがインストールされているか確認してください。
              </p>
            </div>
          </>
        )}

        {voicesError && (
          <>
            <div style={{ height: 12 }} />
            <ErrorPanel title="Voices" error={voicesError} />
          </>
        )}
      </section>

      <section className="panel">
        <h2>Output</h2>
        {run ? (
          <>
            <audio controls src={run.audioUrl}>
              お使いのブラウザは audio 要素に対応していません。
            </audio>
            <div style={{ height: 12 }} />
            <dl className="kv">
              <dt>Run ID</dt>
              <dd>{run.runId}</dd>
              <dt>Test ID</dt>
              <dd>{run.manifest.test_id}</dd>
              <dt>Generated At</dt>
              <dd>{run.manifest.generated_at}</dd>
              <dt>Segmentation</dt>
              <dd>
                {run.manifest.segmentation.strategy} / {run.manifest.segmentation.segment_count}{' '}
                segment（target {run.manifest.segmentation.target_max_chars} 字）
              </dd>
              <dt>Text SHA-256</dt>
              <dd>{run.manifest.source.sha256}</dd>
              <dt>Audio SHA-256</dt>
              <dd>{run.manifest.audio.sha256}</dd>
              <dt>Audio Bytes</dt>
              <dd>{run.manifest.audio.bytes.toLocaleString('en-US')}</dd>
            </dl>
            <p className="fixed-note">
              保存済み Run: <code>data/runs/{run.runId}/</code> — source.txt / audio.wav /
              provider-query.json / manifest.json
            </p>
          </>
        ) : (
          <p className="fixed-note">まだ Run は生成されていません。</p>
        )}

        {generateError && (
          <>
            <div style={{ height: 12 }} />
            <ErrorPanel title="Generate" error={generateError} />
          </>
        )}
      </section>
    </main>
  );
}
