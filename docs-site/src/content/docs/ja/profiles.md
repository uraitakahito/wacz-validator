---
title: プロファイル
description: --profile が変えるものと、決して変えないもの。
---

`--profile <name>` は、producer 固有 / 様式的な指摘をどれだけ厳しく扱うかを
選びます。既定は `spec` です。

profile が組み替えるのは **severity だけです。spec が要求する check を抑止する
ことはありません** — `MUST` 違反はどの profile でも報告されます(`lenient` では
`info` として出るだけです)。

## 3 つの profile

### `spec`(既定)

WACZ spec + wabac.js loader 互換。この profile で exit 0 になる archive は、
[ReplayWeb.page](https://replayweb.page/) で正しく replay できることが
期待されます(wabac.js 自体のバグを除く)。

「この archive は正しいか?」を問うときはこれを使います。

### `browserhive`

`spec` の上に BrowserHive の
より厳しい producer 慣習を重ねます。たとえば
`indexes/index.cdxj` は plain で置く、という慣習があるため、`.idx` とペアでも
`.cdxj.gz` は許しません。

BrowserHive 生成の archive だと分かっていて、その house rule も守らせたいときに
使います。他の producer の出力に当てると、その archive が従うと約束していない
慣習まで指摘することになります。

#### producer のバージョンを添える

BrowserHive はバージョンによって出力が変わります。`@` で添えると、その
バージョンで正しいと分かっている rule だけが走ります。

```sh
wacz-validator-validate --profile browserhive@2.1.0 archive.wacz
```

バージョンを添えなければ、バージョンに条件を持つ rule も**すべて走ります**
（従来どおり）。

バージョンが合わずに走らせなかった rule は、JSON の `skipped` に残ります ——
**黙って消しません**。読者が「問題なし」と「見ていない」を区別できないと、報告が嘘に
近づくからです。

```json
"skipped": [
  {
    "rule": "warc/recording-complete",
    "reason": "profile-version",
    "range": ">=1.11.0"
  }
]
```

:::caution[バージョンは archive と照合されません]
`--profile browserhive@1.0.0` と打っても、その archive が本当に 1.0.0 製かは
検査しません。`datapackage.json` の `software` には producer 名とバージョンが
書かれていますが、wacz-validator はまだ読んでいません。**バージョンは操作者の申告です。**
:::

### `lenient`

producer 固有 / 様式的な指摘をすべて `info` に降格させ、replay を壊す
hard error だけを残します。

legacy な archive をトリアージするとき、つまり「正しいか?」ではなく
「救えるか?」を問うときに使います。

## どの rule が実際に変わるのか

[Rules](/wacz-validator/ja/rules/) の表の severity の欄には、各 rule の既定値の下に、どの profile が何に組み替えるかが正確に出ています。
既定値の下に何も無い rule は、3 つの profile すべてで同じ挙動です。

この行は各 rule の `applicability` 宣言から生成しているので、**要約ではなく一次情報**です。

## WARC 1.1 の rule の等級

WARC 1.1 が記録に求めることを見る `warc/*` の rule は、どの profile でも走ります。
profile が変えるのは指摘の等級だけで、等級は指摘の種類で決まります。

| 指摘 | `spec` | `browserhive` | `lenient` |
| --- | --- | --- | --- |
| 記録の形が崩れている（版の行が無い・CRLF でなく LF・block と合わない `Content-Length`・記録を閉じる CRLF CRLF が無い） | `error` | `error` | `error` |
| 版の行が `WARC/1.1` でない | `warning` | `error` | `info` |
| WARC 1.1 が要る欄が無い・禁じる欄が在る・値の形が違う（*shall*・*shall not*） | `warning` | `error` | `info` |
| 勧めに従っていない（*should* と、注釈つきの本文の community recommendation） | `info` | `warning` | `info` |
| 規格が決めていないもの（知らない record type・知らない切り詰めの理由・知らない `revisit` の profile） | `info` | `info` | `info` |

形の崩れがどこでも `error` なのは、読む側が記録の境目を見失い、索引と replay も一緒に失うからです。
*shall* に反する欄があっても wabac.js の replay はほとんど壊れないので、`spec` は `warning` にします。
BrowserHive は自分の WARC を WARC 1.1 のファイルだと名乗るので、`browserhive` は同じ指摘を `error` にします。

## exit code

profile が exit code に影響するのは severity 経由だけです。何を failure と
数えるかは変わりませんが、`info` に降格した rule は failure に寄与しなくなります。
report から exit code への変換は `@wacz-validator/protocol` の `exitCodeFor` にあり、
CLI と TUI が共有しているので両者がずれることはありません。
