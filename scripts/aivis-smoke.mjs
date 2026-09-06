#!/usr/bin/env node
/**
 * Manual AivisSpeech integration smoke.
 *
 * Deliberately NOT part of `npm test`: the automated suite must run with the
 * engine stopped. This script is the opposite — it only makes sense against a
 * live engine, and it says so plainly when there isn't one.
 *
 *   npm run smoke:aivis
 *   npm run smoke:aivis -- --text "読み上げたいテキスト" --out out.wav
 *
 * It writes a WAV only when --out is given, and never touches data/runs/
 * (Run persistence is P1-B).
 */

import { writeFile } from 'node:fs/promises';

const DEFAULT_ENGINE_URL = 'http://127.0.0.1:10101';

function parseArgs(argv) {
  const args = { text: 'これは疎通確認用のテキストです。', out: null, speed: 1.0, volume: 1.0 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--text' && value) { args.text = value; i += 1; }
    else if (flag === '--out' && value) { args.out = value; i += 1; }
    else if (flag === '--speed' && value) { args.speed = Number(value); i += 1; }
    else if (flag === '--volume' && value) { args.volume = Number(value); i += 1; }
  }
  return args;
}

const engineUrl = (process.env.AIVIS_ENGINE_URL ?? DEFAULT_ENGINE_URL).replace(/\/+$/, '');
const args = parseArgs(process.argv.slice(2));

function step(label, detail) {
  console.log(`  ${label}${detail ? `: ${detail}` : ''}`);
}

async function main() {
  console.log(`AivisSpeech manual smoke — ${engineUrl}\n`);

  // 1. /version
  let version;
  try {
    const response = await fetch(`${engineUrl}/version`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    version = await response.json();
  } catch (error) {
    console.error('MANUAL_SMOKE_BLOCKED_ENGINE_NOT_RUNNING');
    console.error(`  ${engineUrl}/version へ到達できませんでした: ${error.message}`);
    console.error('  AivisSpeech / AivisSpeech Engine を起動してから再実行してください。');
    process.exitCode = 2;
    return;
  }
  step('GET  /version', JSON.stringify(version));

  // 2. /aivm_models (AivisSpeech-only; informational)
  try {
    const response = await fetch(`${engineUrl}/aivm_models`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const models = await response.json();
    const uuids = Object.keys(models ?? {});
    step('GET  /aivm_models', `${uuids.length} model(s)`);
    for (const uuid of uuids) {
      step('     model', `${models[uuid]?.manifest?.name ?? '(no name)'} [${uuid}]`);
    }
  } catch (error) {
    step('GET  /aivm_models', `FAILED — ${error.message}`);
  }

  // 3. /speakers
  const speakersResponse = await fetch(`${engineUrl}/speakers`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!speakersResponse.ok) {
    throw new Error(`/speakers HTTP ${speakersResponse.status}`);
  }
  const speakers = await speakersResponse.json();
  if (!Array.isArray(speakers)) throw new Error('/speakers did not return an array');
  const styles = speakers.flatMap((speaker) =>
    (speaker.styles ?? []).map((style) => ({
      label: `${speaker.name} / ${style.name}`,
      id: style.id,
    })),
  );
  step('GET  /speakers', `${speakers.length} speaker(s), ${styles.length} style(s)`);
  for (const style of styles.slice(0, 10)) {
    step('     style', `${style.label} (id: ${style.id})`);
  }
  if (styles.length === 0) {
    console.error('  音声モデルが 0 件です。AivisSpeech に音声モデルを追加してください。');
    process.exitCode = 3;
    return;
  }

  const styleId = styles[0].id;

  // 4. /audio_query
  const queryUrl = new URL(`${engineUrl}/audio_query`);
  queryUrl.searchParams.set('text', args.text);
  queryUrl.searchParams.set('speaker', String(styleId));
  const queryResponse = await fetch(queryUrl, {
    method: 'POST',
    signal: AbortSignal.timeout(30_000),
  });
  if (!queryResponse.ok) {
    throw new Error(`/audio_query HTTP ${queryResponse.status}: ${await queryResponse.text()}`);
  }
  const audioQuery = await queryResponse.json();
  step('POST /audio_query', `keys: ${Object.keys(audioQuery).join(', ')}`);

  // 5. /synthesis — overwrite only the fields the app owns
  const providerQuery = {
    ...audioQuery,
    speedScale: args.speed,
    volumeScale: args.volume,
    outputSamplingRate: 44100,
    outputStereo: false,
  };
  const synthesisUrl = new URL(`${engineUrl}/synthesis`);
  synthesisUrl.searchParams.set('speaker', String(styleId));
  const synthesisResponse = await fetch(synthesisUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'audio/wav' },
    body: JSON.stringify(providerQuery),
    signal: AbortSignal.timeout(120_000),
  });
  if (!synthesisResponse.ok) {
    throw new Error(`/synthesis HTTP ${synthesisResponse.status}: ${await synthesisResponse.text()}`);
  }
  const audio = Buffer.from(await synthesisResponse.arrayBuffer());
  const isWav = audio.length >= 12 && audio.toString('ascii', 0, 4) === 'RIFF' && audio.toString('ascii', 8, 12) === 'WAVE';
  step('POST /synthesis', `${audio.length} bytes, RIFF/WAVE=${isWav}`);
  if (!isWav) throw new Error('/synthesis did not return a WAV payload');

  if (args.out) {
    await writeFile(args.out, audio);
    step('wrote', args.out);
  }

  console.log('\nSMOKE OK');
}

main().catch((error) => {
  console.error(`\nSMOKE FAILED: ${error.message}`);
  process.exitCode = 1;
});
