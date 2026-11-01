---
title: 用語 (Terminology)
description: WACZ の用語を、日本語の文章中でも英語のまま揃える方針。
---

WACZ 1.1.1 の
[Terminology](https://specs.webrecorder.net/wacz/1.1.1/#terminology)
([日本語訳](https://uraitakahito.github.io/specs/wacz/1.1.1/#terminology)) で
**定義された語は、日本語の文章中でも英単語のまま**書きます。docs にもソース
コメントにも同じ方針を適用します。

狙いは訳語の統一ではなく、**表記ゆれという選択肢自体を無くす**ことです。
「ウェブアーカイブ」と書くか `Web Archive` と書くかを毎回判断していると、
同じ文書の中で両方が現れます。

:::note[英語版との違い]
このページには英語版に対応する節がありません。英語話者にとって「spec の語を
英語で書く」は自明だからです。英語版は代わりに**用語の定義集**になっています。
対訳ではありますが**逐語訳ではありません**。
:::

## 固定する英単語

| 概念 | 文中でも使う(正) | 避ける(訳語・表記ゆれ) | 対象外(同形だが別概念) |
| ---- | ---------------- | ---------------------- | ---------------------- |
| ZIP コンテナ | `ZIP file`(format は `ZIP`) | 小文字 `zip` / `ZIP ファイル` / `ZIP アーカイブ` | `gzip` / 拡張子 `.zip` `.wacz` |
| WACZ / WARC | `WACZ` / `WARC` | —(既に英) | — |
| ウェブアーカイブ | `Web Archive` | `ウェブアーカイブ` / 裸の「アーカイブ」 | WACZ 内の `archive/` ディレクトリ |
| ページ | `Page` | `ページ` / `ウェブページ` | `spec ページ` など一般の web ページ |
| メディアタイプ | `Media Type` | `メディアタイプ` / `MIME` | HTTP ヘッダ名 `Content-Type` |
| コレクション | `Collection` | `コレクション` | — |
| パッケージ | `Package` | `パッケージ` | npm の `package` |
| その他 | `Context` / `Wayback Machine` / `IIPC` | 各訳語 | — |

`CDXJ` は §Terminology の定義語ではありませんが、同じく英語のまま書きます
(下記)。ただし**その中身を指す普通名詞は「索引」とします** —— 「インデックス」
「index」との三つ巴を避けるためで、`indexes/` のようなパス名は別です。

## spec が使うが定義していない語

上の表は WACZ §Terminology が定義する語です。spec はそこに載せないまま使う語も
あり、重みがあるのはこれです。

### `CDXJ`

`indexes/` に入る**索引**の形式です。採取した応答 1 件につき 1 行で、
**検索キー**（SURT）・**14 桁の採取時刻**・**JSON** の 3 つを空白で区切ります。

```
org,wikimedia,upload)/wikipedia/commons/4/4d/icon_pdf_file.png 20220831121514 {"url": "…", "mime": "image/png", "offset": "5504", "length": "1320", "filename": "rec-….warc.gz"}
```

JSON の `filename` / `offset` / `length` が要点で、「`archive/` のどのファイルの
何バイト目から何バイト読めばそのレコードか」を指します。再生器が WACZ 全体を
落とさずに済むのはこれがあるからで、必要な byte range だけ取りに行けます。

**SURT**（Sort-friendly URI Reordering Transform）は検索キーの形です。
`https://upload.wikimedia.org/…/icon.png` を
`org,wikimedia,upload)/…/icon.png` のように**ホストを逆順・カンマ区切り**に
します。逆順にすると同じドメインの下が辞書順で隣り合うので、索引を**二分探索**
できます。

索引が壊れると **WARC は無傷なのに再生できない**という状態になります。
[rule](/wacz-validator/ja/rules/) のうち、`cdxj-` で始まるものが CDXJ を見ているのはそのためです。

WACZ 1.1.1 §5.2.2 は「インデックスファイルは CDXJ データを含まなければならず
(MUST)、gzip 圧縮されてもよい (MAY)」と定めるだけで、形式そのものは
[pywb の CDXJ Format](https://pywb.readthedocs.io/en/latest/manual/indexing.html#cdxj-index)
を参照しています。

## 適用ルール

1. **その語が Terminology の「概念」を指すときだけ**英語化します。一般語
   (`spec ページ`)・別概念(`npm パッケージ`)・`gzip` は触りません。
2. **コード識別子(変数 / 関数 / 型 / rule 名)は対象外**です。この方針は prose
   (docs とコメント)だけに適用します。
3. WACZ = "Web Archive Collection Zipped"。WARC データとメタデータを `ZIP file` に
   まとめた `Web Archive` の `Package` です。

## 退行防止

訳語・表記ゆれの混入はレビューで弾きます。とくに明確な訳語(`ウェブアーカイブ` /
`メディアタイプ` / `ZIP ファイル` など)に注意してください。`Page` / `Package` は
概念依存(`spec ページ` / `npm パッケージ` は正)なので、文脈を見て判断します。
