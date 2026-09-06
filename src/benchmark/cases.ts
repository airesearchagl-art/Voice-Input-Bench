import { toCanonicalText } from '@/lib/canonicalText';

/**
 * Built-in Benchmark Cases.
 *
 * The text here is the server-side source of truth. A client selects a case by
 * ID and never supplies the body: if the caller could send the text, two Runs
 * carrying the same `test_id` could contain different words, and comparing them
 * would be meaningless.
 *
 * Every body is stored LF-only and is passed through `toCanonicalText` on read
 * anyway, so the canonical text of a case Run is exactly what is written here.
 */

/** `test_id` used when the operator typed the text themselves. */
export const MANUAL_TEST_ID = 'manual';

export interface BenchmarkCase {
  id: string;
  title: string;
  /** What this case is meant to stress. */
  intent: string;
  text: string;
}

const CASES: BenchmarkCase[] = [
  {
    id: 'architecture-short-001',
    title: '建築 — 短文',
    intent: '単一セグメントで収まる短い建築ドメインの発話。',
    text: '基準階の会議室は north side に寄せて、コア側に water closet をまとめる方針で進めます。天井高は二千七百ミリを確保してください。',
  },
  {
    id: 'architecture-long-001',
    title: '建築 — 長文',
    intent: '決定的分割と segment 結合を通す長い建築ドメインの発話。',
    text: [
      '今回の基本設計では、敷地の南側に大きく開いたアプローチを取りつつ、north side にサービス動線をまとめる構成を採用します。',
      '一階のエントランスホールは天井高を四千二百ミリまで上げて、外部の広場と視覚的に連続させたいと考えています。',
      'ここでガラスのマリオンを細く見せたいので、方立の断面はできるだけ絞り込んでください。',
      '',
      '基準階については、コア側に water closet と給湯室をまとめ、執務エリアを無柱空間として確保する方針です。',
      '会議室は north side に寄せて、外光が入りすぎない条件を作ります。',
      'ただし、west side の会議室だけは西日が厳しいので、外付けのルーバーを検討してください。',
      'ルーバーのピッチは意匠と設備の取り合いを見ながら決めますが、現時点では三百ミリを想定しています。',
      '',
      '構造については、スパンを大きく取る方針なので、梁せいが天井内に収まるかどうかを早めに確認したいところです。',
      '設備ルートとの干渉が出た場合は、梁貫通で逃がすのか、天井高を部分的に下げるのかを、意匠側と構造側で合意してから決めましょう。',
      'この判断は後戻りが大きいので、来週の定例までに一次案を出してください。',
      '',
      '外装は、低層部を打ち放しコンクリート、基準階以上をカーテンウォールとする二層構成を考えています。',
      '打ち放しの目地割りは階高と開口の位置に合わせて整理し、割付図を別途起こしてください。',
      'カーテンウォールの方立ピッチは、内部の間仕切り位置と揃うように調整します。',
      '',
      '設備計画では、外気処理空調機を屋上に置く案と、地下機械室に置く案の両方を比較してください。',
      '屋上案は配管ルートが短くなる一方で、荷重と防振の検討が増えます。',
      '地下案は搬入と更新性に不安が残るので、将来の機器更新の動線までを見たうえで判断したいです。',
      '電気室の位置も、幹線ルートと合わせて一度整理しておいてください。',
      '',
      '内装については、執務エリアは基本的にシステム天井としますが、会議室とリフレッシュエリアだけは仕上げを変えたいと考えています。',
      '床は基本的に OA フロアで、配線容量は将来の増設を見込んで余裕を持たせてください。',
      '什器のレイアウトは後段で詰めますが、コンセントと LAN の位置だけは早めに仮決めが必要です。',
      '',
      '最後に工程ですが、実施設計への移行判断を来月の頭に置きたいので、それまでに構造と設備の主要な取り合いを潰しておきたいです。',
      '未決事項は一覧にして、決裁が必要なものと設計側で決められるものを分けて整理してください。',
      '来週の定例では、外装の割付案と設備ルートの一次案を持ち寄って、その場で方向性を決めましょう。',
    ].join('\n'),
  },
  {
    id: 'filler-001',
    title: 'フィラー',
    intent: '「えーと」「あの」などのフィラーが多い自然発話。',
    text: 'えーと、まずですね、あの、基準階のプランなんですけど、そのー、コア側の納まりがまだ決まっていなくて、まあ、来週までには固めたいという感じです。えー、それで、あの、会議室の位置なんですが、うーん、north side でいいと思うんですけど、まあ、そのあたりは意匠側と相談してから決めます。',
  },
  {
    id: 'correction-001',
    title: '言い直し',
    intent: '発話中の自己修正・訂正が含まれるケース。',
    text: '天井高は二千六百ミリで、あ、すみません、二千七百ミリでした。それから会議室は south side に、いや違う、north side に寄せる方針です。面積は、えーと、三百二十平米、ではなくて三百五十平米で見ておいてください。',
  },
  {
    id: 'numbers-units-001',
    title: '数値と単位',
    intent: '寸法・面積・風量・速度・時刻など、数値と単位の書き起こし精度。',
    text: '天井高は 2700mm を確保してください。基準階の専有面積は 320㎡ です。外気処理空調機の風量は 590㎥/h で計画しています。エントランス前の設計風速は 3m/s を想定します。次回の定例は 午前10時 から開始します。',
  },
  {
    id: 'coding-001',
    title: '開発用語',
    intent: '固有名詞・英字略語・コマンド文字列の書き起こし精度。',
    text: 'BIM モデルの更新は Revit 側で行ってから、GitHub に PR を出してください。レビューのときは commit SHA を控えておいて、どの版を見たのかを残してください。マージ前に必ず npm run build を通して、ビルドが壊れていないことを確認してください。',
  },
];

/** Frozen so a request handler cannot mutate the source of truth. */
export const BENCHMARK_CASES: readonly BenchmarkCase[] = CASES.map((benchmarkCase) =>
  Object.freeze({ ...benchmarkCase, text: toCanonicalText(benchmarkCase.text) }),
);

export function getBenchmarkCase(id: string): BenchmarkCase | undefined {
  return BENCHMARK_CASES.find((benchmarkCase) => benchmarkCase.id === id);
}

export function isBenchmarkCaseId(id: string): boolean {
  return getBenchmarkCase(id) !== undefined;
}
