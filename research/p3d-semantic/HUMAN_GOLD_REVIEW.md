# Human Gold Review — probes-v1

**Status: not reviewed. Every row below is `☐ pending`.**

The labels in `probes-v1.json` were **proposed by the research agent** that built
this spike. No person has independently confirmed them. Until this file records
otherwise:

- every accuracy figure in this directory is **provisional accuracy against
  proposed labels**, and is written that way;
- nothing in this repository describes the corpus as human-authored or
  human-reviewed;
- **Claude Code must not fill in the review column.** An agent approving its own
  labels would make this artifact worse than not having it — it would look like
  independent confirmation and be nothing of the kind.

## How to review

For each row, ask one question and nothing else:

> Would a reader acting on the **hypothesis** do the same thing as a reader
> acting on the **reference**?

Yes → `preserved`. No, or they would be missing something they needed →
`changed`. Judge meaning only: spelling, script, width, case, numeral form and
unit form are not meaning.

Mark each row `☑ approved`, or `✗ rejected → <label>` with the corrected label.

When every row is settled, set `gold_provenance.human_review_status` in
`probes-v1.json`, recompute `probes-v1.sha256`, and rerun every script. The
digest is checked before any result is trusted, so correcting the corpus
invalidates the existing evidence by design — which is the point.

## What is being proposed

| | |
| --- | --- |
| Probes | 28 |
| Proposed `preserved` | 13 |
| Proposed `changed` | 15 |
| Marked hard negative | 13 |
| Corpus digest | `5a14302d80732959b5ae249de1daaf731f8e9596fd86042d526b7fafc4475b0a` |

## The 28 pairs

| id | category | reference | hypothesis | proposed | reason | why | hard neg | human review |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| p01 | surface | GitHub に PR を出してください。 | github に PR を出してください。 | preserved | SURFACE_ONLY | Case only. Required hard case: GitHub vs github. | no | ☐ pending |
| p02 | surface | ＰＲ を出してください。 | PR を出してください. | preserved | SURFACE_ONLY | Fullwidth letters and an ideographic full stop. | no | ☐ pending |
| p03 | surface | 天井高は 2700mm を確保してください。 | 天井高は2700mmを確保してください。 | preserved | SURFACE_ONLY | Spacing only. | no | ☐ pending |
| p04 | numeral-unit-form | 天井高は 2700mm を確保してください。 | 天井高は二千七百ミリを確保してください。 | preserved | NUMERAL_OR_UNIT_FORM | Required hard case: 2700mm vs 二千七百ミリ. Same quantity, different numeral and unit spelling. | no | ☐ pending |
| p05 | domain-term-form | コア側に water closet をまとめる方針です。 | コア側にウォータークローゼットをまとめる方針です。 | preserved | DOMAIN_TERM_FORM | Required hard case: water closet vs ウォータークローゼット. | no | ☐ pending |
| p06 | numeral-unit-form | 基準階の専有面積は 320㎡ です。 | 基準階の専有面積は320平米です。 | preserved | NUMERAL_OR_UNIT_FORM | Same area, different unit spelling. | no | ☐ pending |
| p07 | numeral-unit-form | 次回の定例は 午前10時 から開始します。 | 次回の定例は午前十時から開始します。 | preserved | NUMERAL_OR_UNIT_FORM | Same clock time, different numeral form. | no | ☐ pending |
| p08 | domain-term-form | モデルの更新は Revit 側で行ってください。 | モデルの更新はレビット側で行ってください。 | preserved | DOMAIN_TERM_FORM | Tool name transliterated. | no | ☐ pending |
| p09 | domain-term-form | 会議室は north side に寄せてください。 | 会議室はノースサイドに寄せてください。 | preserved | DOMAIN_TERM_FORM | Same direction, transliterated. Pairs with p13, which changes the direction itself. | no | ☐ pending |
| p10 | paraphrase | 来週までには固めたいという感じです。 | 来週までに決めたいと考えています。 | preserved | PARAPHRASE | Same commitment and same deadline. | no | ☐ pending |
| p11 | paraphrase | えーと、まずですね、あの、基準階のプランなんですけど、そのー、コア側の納まりがまだ決まっていなくて。 | まず基準階のプランですが、コア側の納まりがまだ決まっていません。 | preserved | PARAPHRASE | Fillers removed, content identical. | no | ☐ pending |
| p12 | self-correction | 天井高は二千六百ミリで、あ、すみません、二千七百ミリでした。 | 天井高は二千七百ミリです。 | preserved | SELF_CORRECTION | Required hard case: the final intent of a self-correction is kept. The retracted 2600 is correctly absent. | no | ☐ pending |
| p13 | direction | 会議室は north side に寄せてください。 | 会議室は south side に寄せてください。 | changed | DIRECTION_LOCATION | Required hard case: north side vs south side. Two characters apart, opposite instruction. | yes | ☐ pending |
| p14 | negation | 設備ルートとの干渉は梁貫通で逃がさない方針です。 | 設備ルートとの干渉は梁貫通で逃がす方針です。 | changed | NEGATION | Required hard case: 梁貫通で逃がさない vs 梁貫通で逃がす. Polarity reversed. | yes | ☐ pending |
| p15 | value | 天井高は 2700mm を確保してください。 | 天井高は 2600mm を確保してください。 | changed | VALUE | Required hard case: 2700mm vs 2600mm. One digit, a different building. | yes | ☐ pending |
| p16 | value | 次回の定例は 午前10時 から開始します。 | 次回の定例は 午後10時 から開始します。 | changed | VALUE | Required hard case: 午前10時 vs 午後10時. Twelve hours apart. | yes | ☐ pending |
| p17 | unit | 基準階の専有面積は 320㎡ です。 | 基準階の専有面積は 320mm です。 | changed | UNIT | Same number, incompatible unit. | yes | ☐ pending |
| p18 | unit | 外気処理空調機の風量は 590㎥/h で計画しています。 | 外気処理空調機の風量は 590m/s で計画しています。 | changed | UNIT | Airflow reported as a velocity. | yes | ☐ pending |
| p19 | direction | west side の会議室だけは西日が厳しいので、外付けのルーバーを検討してください。 | east side の会議室だけは西日が厳しいので、外付けのルーバーを検討してください。 | changed | DIRECTION_LOCATION | Opposite façade. | yes | ☐ pending |
| p20 | direction | 外気処理空調機を屋上に置く案で進めてください。 | 外気処理空調機を地下機械室に置く案で進めてください。 | changed | DIRECTION_LOCATION | Different location, different structural and routing consequences. | yes | ☐ pending |
| p21 | instruction-action | 電気室の位置も、幹線ルートと合わせて一度整理しておいてください。 | 電気室の位置も、幹線ルートと合わせて一度整理しておきました。 | changed | INSTRUCTION_ACTION | A request became a report of completed work. | yes | ☐ pending |
| p22 | value | ルーバーのピッチは現時点では三百ミリを想定しています。 | ルーバーのピッチは現時点では三千ミリを想定しています。 | changed | VALUE | One order of magnitude. | yes | ☐ pending |
| p23 | omission | 天井高は二千七百ミリを確保し、会議室は north side に寄せてください。 | 会議室は north side に寄せてください。 | changed | OMISSION | A required dimension is simply gone. | no | ☐ pending |
| p24 | addition | 会議室は north side に寄せてください。 | 会議室は north side に寄せて、天井高は二千七百ミリを確保してください。 | changed | ADDITION | An instruction nobody gave. | no | ☐ pending |
| p25 | self-correction | 面積は、えーと、三百二十平米、ではなくて三百五十平米で見ておいてください。 | 面積は三百二十平米で見ておいてください。 | changed | SELF_CORRECTION | The retracted value survived and the corrected one did not. The mirror image of p12. | yes | ☐ pending |
| p26 | ordering | マージ前に必ず npm run build を通してください。 | マージ後に npm run build を通してください。 | changed | ORDERING | The gate moved to after the thing it was meant to gate. | yes | ☐ pending |
| p27 | actor | この判断は意匠側と構造側で合意してから決めましょう。 | この判断は意匠側だけで決めましょう。 | changed | ACTOR | One party dropped out of a decision that required both. | yes | ☐ pending |
| p28 | domain-term-form | 低層部は打ち放しコンクリートとします。 | 低層部は打ちっぱなしコンクリートとします。 | preserved | DOMAIN_TERM_FORM | Colloquial spelling of the same finish. | no | ☐ pending |

## Pairs most worth a second opinion

A wrong label here would move the headline numbers, and a reasonable person could
disagree with the proposal:

- **p04** `2700mm` ↔ `二千七百ミリ` — proposed `preserved`. The measured LLM
  disagrees in **both** input variants. Either the label is right and the model is
  wrong, or the label needs changing; the numbers in
  `SEMANTIC_METHOD_COMPARISON.md` read very differently depending on which.
- **p10**, **p11** — paraphrase and filler removal. Where paraphrase stops being
  `preserved` is a judgement call, not a rule.
- **p12** and **p25** — the two self-corrections, written as deliberate mirrors.
  If the reasoning for one is wrong, the other is wrong too.
- **p23** / **p24** — omission and addition, proposed `changed` on the grounds
  that a reader is either missing something or acting on something nobody said.
- **p28** `打ち放し` ↔ `打ちっぱなし` — proposed `preserved` as a colloquial
  spelling of one finish. A domain reviewer may know better.
