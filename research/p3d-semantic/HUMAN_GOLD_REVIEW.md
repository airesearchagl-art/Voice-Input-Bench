# Human Gold Review — probes-v1

**Status: Human review COMPLETE.**

| | |
| --- | --- |
| Reviewed | **28 / 28** |
| Approved | **28** |
| Rejected | **0** |
| Label changes | **0** |
| Reviewed at | **2026-09-08** |
| Decided by | the **project owner**, acting as the human gate for P3-D-A |
| Recorded by | Claude Code, transcribing that decision — **not deciding it** |

Every proposed label was confirmed as written. No label was overturned, so
`probes-v1.json` carries the same 28 labels it did before this review; what
changed is that they are now **confirmed**, not proposed.

### Where the approval came from

The labels were **proposed by the research agent** that built this spike. They
were then reviewed by the project owner, via ChatGPT orchestration, outside this
repository, and returned as an explicit 28/28 approval. This file records that
result.

**This is a transcription, not a judgement made here.** Claude Code did not
evaluate any pair for this promotion, did not approve any row on its own
authority, and could not have: an agent confirming the labels it wrote is not
independent confirmation, whatever the file ends up saying. The distinction is
preserved in `probes-v1.json`, where `gold_provenance.authoring` still reads
`research-agent` and the approval is recorded in separate fields alongside it.
Authorship and review are two facts, and promoting one must not overwrite the
other.

### Historical — the rule that applied while this file was pending

Until 2026-09-08 this file read:

> **Claude Code must not fill in the review column.** An agent approving its own
> labels would make this artifact worse than not having it — it would look like
> independent confirmation and be nothing of the kind.

That rule held for the whole of R1 and R1.1, and every accuracy figure published
in those rounds is labelled *provisional accuracy against proposed labels*
accordingly. Those figures are kept and stay labelled that way. The rule was
lifted by a human decision arriving from outside this repository, which is the
only thing that could have lifted it.

## How to review

For each row, ask one question and nothing else:

> Would a reader acting on the **hypothesis** do the same thing as a reader
> acting on the **reference**?

Yes → `preserved`. No, or they would be missing something they needed →
`changed`. Judge meaning only: spelling, script, width, case, numeral form and
unit form are not meaning.

Mark each row `☑ approved`, or `✗ rejected → <label>` with the corrected label.
*(This section is kept for a future corpus. The 2026-09-08 review returned
`☑ approved` on all 28.)*

When every row is settled, set `gold_provenance.human_review_status` in
`probes-v1.json`, recompute `probes-v1.sha256`, and rerun every script. The
digest is checked before any result is trusted, so correcting the corpus
invalidates the existing evidence by design — which is the point.

## What is being proposed

| | |
| --- | --- |
| Probes | 28 |
| `preserved` — proposed, and confirmed | 13 |
| `changed` — proposed, and confirmed | 15 |
| Marked hard negative | 13 |
| Corpus digest **reviewed** | `5a14302d80732959b5ae249de1daaf731f8e9596fd86042d526b7fafc4475b0a` |
| Corpus digest **after promotion** | `40715f8298628ad3af77a678451c26c835688f173d562efa52fb58c1a194b092` |

The digest moved because recording the review edits `gold_provenance`, not
because a label moved. The pairs and their labels are byte-identical to the ones
reviewed; a diff of `probes-v1.json` across the promotion touches nothing else.
Every stored result was re-acquired against the new digest rather than
re-stamped, which is the whole point of checking the digest before trusting a
result.

## The 28 pairs

| id | category | reference | hypothesis | proposed | reason | why | hard neg | human review |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| p01 | surface | GitHub に PR を出してください。 | github に PR を出してください。 | preserved | SURFACE_ONLY | Case only. Required hard case: GitHub vs github. | no | ☑ approved |
| p02 | surface | ＰＲ を出してください。 | PR を出してください. | preserved | SURFACE_ONLY | Fullwidth letters and an ideographic full stop. | no | ☑ approved |
| p03 | surface | 天井高は 2700mm を確保してください。 | 天井高は2700mmを確保してください。 | preserved | SURFACE_ONLY | Spacing only. | no | ☑ approved |
| p04 | numeral-unit-form | 天井高は 2700mm を確保してください。 | 天井高は二千七百ミリを確保してください。 | preserved | NUMERAL_OR_UNIT_FORM | Required hard case: 2700mm vs 二千七百ミリ. Same quantity, different numeral and unit spelling. | no | ☑ approved |
| p05 | domain-term-form | コア側に water closet をまとめる方針です。 | コア側にウォータークローゼットをまとめる方針です。 | preserved | DOMAIN_TERM_FORM | Required hard case: water closet vs ウォータークローゼット. | no | ☑ approved |
| p06 | numeral-unit-form | 基準階の専有面積は 320㎡ です。 | 基準階の専有面積は320平米です。 | preserved | NUMERAL_OR_UNIT_FORM | Same area, different unit spelling. | no | ☑ approved |
| p07 | numeral-unit-form | 次回の定例は 午前10時 から開始します。 | 次回の定例は午前十時から開始します。 | preserved | NUMERAL_OR_UNIT_FORM | Same clock time, different numeral form. | no | ☑ approved |
| p08 | domain-term-form | モデルの更新は Revit 側で行ってください。 | モデルの更新はレビット側で行ってください。 | preserved | DOMAIN_TERM_FORM | Tool name transliterated. | no | ☑ approved |
| p09 | domain-term-form | 会議室は north side に寄せてください。 | 会議室はノースサイドに寄せてください。 | preserved | DOMAIN_TERM_FORM | Same direction, transliterated. Pairs with p13, which changes the direction itself. | no | ☑ approved |
| p10 | paraphrase | 来週までには固めたいという感じです。 | 来週までに決めたいと考えています。 | preserved | PARAPHRASE | Same commitment and same deadline. | no | ☑ approved |
| p11 | paraphrase | えーと、まずですね、あの、基準階のプランなんですけど、そのー、コア側の納まりがまだ決まっていなくて。 | まず基準階のプランですが、コア側の納まりがまだ決まっていません。 | preserved | PARAPHRASE | Fillers removed, content identical. | no | ☑ approved |
| p12 | self-correction | 天井高は二千六百ミリで、あ、すみません、二千七百ミリでした。 | 天井高は二千七百ミリです。 | preserved | SELF_CORRECTION | Required hard case: the final intent of a self-correction is kept. The retracted 2600 is correctly absent. | no | ☑ approved |
| p13 | direction | 会議室は north side に寄せてください。 | 会議室は south side に寄せてください。 | changed | DIRECTION_LOCATION | Required hard case: north side vs south side. Two characters apart, opposite instruction. | yes | ☑ approved |
| p14 | negation | 設備ルートとの干渉は梁貫通で逃がさない方針です。 | 設備ルートとの干渉は梁貫通で逃がす方針です。 | changed | NEGATION | Required hard case: 梁貫通で逃がさない vs 梁貫通で逃がす. Polarity reversed. | yes | ☑ approved |
| p15 | value | 天井高は 2700mm を確保してください。 | 天井高は 2600mm を確保してください。 | changed | VALUE | Required hard case: 2700mm vs 2600mm. One digit, a different building. | yes | ☑ approved |
| p16 | value | 次回の定例は 午前10時 から開始します。 | 次回の定例は 午後10時 から開始します。 | changed | VALUE | Required hard case: 午前10時 vs 午後10時. Twelve hours apart. | yes | ☑ approved |
| p17 | unit | 基準階の専有面積は 320㎡ です。 | 基準階の専有面積は 320mm です。 | changed | UNIT | Same number, incompatible unit. | yes | ☑ approved |
| p18 | unit | 外気処理空調機の風量は 590㎥/h で計画しています。 | 外気処理空調機の風量は 590m/s で計画しています。 | changed | UNIT | Airflow reported as a velocity. | yes | ☑ approved |
| p19 | direction | west side の会議室だけは西日が厳しいので、外付けのルーバーを検討してください。 | east side の会議室だけは西日が厳しいので、外付けのルーバーを検討してください。 | changed | DIRECTION_LOCATION | Opposite façade. | yes | ☑ approved |
| p20 | direction | 外気処理空調機を屋上に置く案で進めてください。 | 外気処理空調機を地下機械室に置く案で進めてください。 | changed | DIRECTION_LOCATION | Different location, different structural and routing consequences. | yes | ☑ approved |
| p21 | instruction-action | 電気室の位置も、幹線ルートと合わせて一度整理しておいてください。 | 電気室の位置も、幹線ルートと合わせて一度整理しておきました。 | changed | INSTRUCTION_ACTION | A request became a report of completed work. | yes | ☑ approved |
| p22 | value | ルーバーのピッチは現時点では三百ミリを想定しています。 | ルーバーのピッチは現時点では三千ミリを想定しています。 | changed | VALUE | One order of magnitude. | yes | ☑ approved |
| p23 | omission | 天井高は二千七百ミリを確保し、会議室は north side に寄せてください。 | 会議室は north side に寄せてください。 | changed | OMISSION | A required dimension is simply gone. | no | ☑ approved |
| p24 | addition | 会議室は north side に寄せてください。 | 会議室は north side に寄せて、天井高は二千七百ミリを確保してください。 | changed | ADDITION | An instruction nobody gave. | no | ☑ approved |
| p25 | self-correction | 面積は、えーと、三百二十平米、ではなくて三百五十平米で見ておいてください。 | 面積は三百二十平米で見ておいてください。 | changed | SELF_CORRECTION | The retracted value survived and the corrected one did not. The mirror image of p12. | yes | ☑ approved |
| p26 | ordering | マージ前に必ず npm run build を通してください。 | マージ後に npm run build を通してください。 | changed | ORDERING | The gate moved to after the thing it was meant to gate. | yes | ☑ approved |
| p27 | actor | この判断は意匠側と構造側で合意してから決めましょう。 | この判断は意匠側だけで決めましょう。 | changed | ACTOR | One party dropped out of a decision that required both. | yes | ☑ approved |
| p28 | domain-term-form | 低層部は打ち放しコンクリートとします。 | 低層部は打ちっぱなしコンクリートとします。 | preserved | DOMAIN_TERM_FORM | Colloquial spelling of the same finish. | no | ☑ approved |

## Pairs most worth a second opinion

*Written while the review was pending. The 2026-09-08 review approved every one
of them as proposed; they are kept because they name the pairs where the
reasoning is thinnest, and that is still true of a confirmed label.*

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
