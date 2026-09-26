---
title: テストの実行
description: pnpm check が見る範囲、意図的に skip される corpus テスト、そして CI が回すもの
---

日常的に使うものは 1 コマンドに収まっています。

```sh
pnpm check
```

`pnpm audit` と root の scripts の試験を走らせたあと、パッケージごとに
`typecheck → lint → build → test` を回します。7 パッケージを依存順に処理するので、壊れたときは**原因のパッケージ**で
止まります ― 3 つ下流で気づくことにはなりません。

**ここまでにネットワークもコンテナも、ディスク上の WACZ も必要ありません。**
それを必要とする唯一のスイートは、明示的に指定しない限り skip されます（後述）。

## コマンド

| コマンド | 範囲 |
| --- | --- |
| `pnpm check` | audit + root の scripts の試験 + 7 パッケージ全部。**CI が回すもの。** |
| `pnpm test` | テストのみ、全パッケージのあとに root の scripts |
| `pnpm test:scripts` | root の scripts 自身の試験（`node --test`） |
| `pnpm --filter @wacz-validator/core test` | 1 パッケージだけ |
| `pnpm --filter @wacz-validator/core test:watch` | 1 パッケージを watch |
| `pnpm typecheck` / `pnpm lint` / `pnpm build` | 1 段階を全パッケージに |
| `pnpm test:ui` | ブラウザの UI で全パッケージ（watch） |
| `pnpm test:report` | `html/` に静的レポート |

`--filter` に渡すのはディレクトリ名ではなく**パッケージ名**です ―
`@wacz-validator/contract`、`@wacz-validator/core`、`@wacz-validator/validate-cli`、`@wacz-validator/daemon`、
`@wacz-validator/protocol`、`@wacz-validator/tui`。

`@wacz-validator/protocol` にはテストがありません。ここは wire contract そのもので、
`check` は `build` で終わります。抜けているのではなく、**走らせるものが無い**からです。

## 観点で絞る

テストには**観点のタグ**が付いています。ファイル名やディレクトリではなく、
**何を検査しているか**で引けます。

```bash
pnpm exec vitest --listTags                        # 語彙の一覧
pnpm exec vitest run --tagsFilter frictionless     # 13 件
pnpm exec vitest run --tagsFilter 'docs && i18n'   # 2 件
pnpm exec vitest run --tagsFilter '!corpus'
pnpm test:ui --tagsFilter frictionless             # UI を絞って開く
```

UI を開いたあとは、検索欄に `tag:frictionless` と打っても同じです。

| タグ | 意味 |
| --- | --- |
| `frictionless` | WACZ が土台にする Data Package の検査 |
| `wacz` | WACZ の構造（必須ファイル・予約ディレクトリ） |
| `cdxj` | 索引フォーマットと wabac 互換 |
| `warc` | WARC レコードとダイジェスト |
| `engine` | ルールを束ねて回す層 |
| `corpus` | コーパス駆動。実アーカイブを開く |
| `docs` | ドキュメントとコードの整合 |
| `i18n` | メッセージと翻訳 |
| `cli` | コマンドライン表面 |
| `remote` | S3 越しの読み取り |
| `daemon` / `tui` | それぞれのパッケージ |

:::caution[速さのためではありません]
全 203 件が 3.5 秒で終わります。**絞る目的は「引けること」だけ**で、
実行時間ではありません。Vitest の tags にはタグ側で `timeout` や `retry` を
指定する用途もありますが、**この repo では使っていません** ――
実行方針を分けたいテストの種類が無いからです。
:::

### タグを足すとき

**順序が決まっています。**

1. リポジトリルートの **`test-tags.ts`** に**語彙を宣言する**
2. テストファイルの冒頭に `// @module-tag <名前>` を書く

逆にすると `strictTags`（既定で有効）が働き、**1 件も走らずにエラーで止まります**。

語彙が `vitest.config.ts` ではなく独立したファイルにあるのは、**走らせ方が 2 通りある**
ためです ―― `pnpm test:ui` はルートの config を通りますが、`pnpm test`（＝ `pnpm -r test`）と
`pnpm check` は**各パッケージの config しか読みません**。`test-tags.ts` を
ルートと 3 パッケージの config が読むことで、どちらの経路でも同じ語彙が見えます。

ファイル全体ではなく 1 件だけに付けたいときは、テスト側の options を使います ――
`it("…", { tags: ["frictionless"] }, () => {…})`。
`rule-docs.test.ts` が実例で、ファイルとしては `docs` ですが、
その中の 1 件だけが `frictionless` でもあります。

`packages/core/test/test-tags.test.ts` が**付け忘れと使われない語彙を落とします**。
`strictTags` が捕まえるのは「宣言していないタグを使った」だけで、逆向きは捕まえません。

## UI で見る

```bash
pnpm test:ui
```

観点で絞って開くこともできます。

```bash
pnpm test:ui --tagsFilter frictionless        # frictionless だけで開く
pnpm test:ui --tagsFilter 'docs && i18n'
```

開いたあとに切り替えるなら、サイドバーの検索欄に **`tag:frictionless`** と打ちます
（`tag:` の後ろは `--tagsFilter` と同じ式が書けます）。
どのタグがあるかは [観点で絞る](#観点で絞る) の表か `pnpm exec vitest --listTags` で。

`core`・`daemon`・`tui` を**1 つの画面**に集めます。ルートの `vitest.config.ts` が
`projects` で各パッケージの config を指しているだけなので、`include` や
`environment` の定義はパッケージ側の 1 か所のままです ―― UI 用に設定が
二重化することはありません。

`pnpm test` は変わらず `pnpm -r test` を通ります。**両者が走らせる集合は同じ**で、
それは合計が一致することで確かめてあります（190 passed / 10 skipped）。

`pnpm test:report` は `html/` に静的レポートを出します。
**`file://` では開けません** ―― `npx vite preview --outDir html` のように配信してください。

:::note
`@wacz-validator/protocol` は `projects` に入れていません。テストが無いので、
入れると UI に**空のプロジェクト**が並び、「テストが足りない」と読めてしまいます。
「走らせるものが無い」のであって、欠けているのではありません。
:::

## なぜ `build` が `test` より前なのか

各パッケージの `check` は `typecheck && lint && build && test` で、この順序は意図的です。
`@wacz-validator/validate-cli`・`@wacz-validator/daemon`・`@wacz-validator/tui` はビルドの一部として `build-info.ts` を生成するので、
古いまま（あるいは無いまま）テストを回すと**別物を検査する**ことになります。
型エラーと lint は数秒で終わるのに対しビルドは長い ― 安いゲートを先に置く、という理由もあります。

## corpus テスト

`@wacz-validator/core` にはもう 1 種類のテストがあります。インラインで組み立てた fixture ではなく、
[wacz-validator-corpus](https://uraitakahito.github.io/wacz-validator-corpus/ja/) リポジトリの**実物の WACZ** を検証するものです。
アーカイブ本体が要るので `CORPUS_DIR` を読み、**未設定なら skip します**。

```
Test Files  20 passed | 2 skipped (22)
      Tests  113 passed | 4 skipped (117)
```

通常の `pnpm check` はこう見えます。この skip があるおかげで、日常のコマンドは
外部に依存しないままでいられます。

走らせるには、corpus を**固定してあるバージョンで**このリポジトリの隣に
クローンし、
**絶対パス**で指し示します。

```sh
git clone --branch "$(cat .corpus-version)" \
  https://github.com/uraitakahito/wacz-validator-corpus.git ../wacz-validator-corpus
git -C ../wacz-validator-corpus lfs pull

CORPUS_DIR="$(cd ../wacz-validator-corpus && pwd)" pnpm --filter @wacz-validator/core test:corpus
```

リポジトリ直下の `.corpus-version` は tag を 1 つだけ持ちます —— このチェック
アウトが検証対象とする corpus のリリースです。CI も同じファイルを読むので、
**CI が緑なのと手元が緑なのは同じ意味**になります。違うバージョンを渡すと
**スイートは走らずに落ちます**。期待値が合わないという分かりにくい失敗になる前に、
渡されたものを名指しします。

```
CORPUS_DIR は 28bcc70 を指していますが、この wacz-validator は v0.1.0 に固定されています。
```

リリース資産の tarball を展開したものは git のチェックアウトではないのでバージョンを
読めません。その場合は**止めずに通します** —— 「判定できない」と「判定して違う」は
別だからです。

`$(cd … && pwd)` は飾りではありません。`pnpm --filter` は作業ディレクトリを
`packages/core` に移してスクリプトを走らせるので、相対パスの `CORPUS_DIR` は
シェルではなくそこを基準に解決されます。つまり `../wacz-validator-corpus` は
`packages/wacz-validator-corpus` を探しに行き、何も見つからず、**「manifest が無い」と
言いながら skip します**。シェルの側で先に絶対パスへ変換しておけば、この問題自体が
起きません。

| script | 内容 |
| --- | --- |
| `test:corpus` | corpus の全アーカイブを検証し、`manifest.json` と突き合わせる |
| `corpus:docs:check` | corpus のカタログが `manifest.json` からずれていたら失敗させる |
| `corpus:build` | アーカイブと manifest を**再生成する** |

### 新しい corpus へ移る

corpus に何かをマージしても、ここは何も変わりません —— このチェックアウトは
`.corpus-version` の tag に対して検証し続けます。追随は明示的な行為で、3 段階です。

1. wacz-validator-corpus 側で変更をマージし、**リリースを切る**
2. `.corpus-version` を新しい tag に書き換える
3. その書き換えと、それに伴うコード変更を**1 つの wacz-validator PR** にまとめて出す

最後の点が固定する理由です。PR は**自分の足元で動かない corpus**に対して測られるので、
緑か赤かがその PR だけで決まります。

`corpus:build` と `corpus:docs` はバージョンの検査を意図的に素通りします —— あれらは
*次の* corpus リリースを作る側なので、固定先と違うバージョンに対して走る
必要があります。

:::danger[`corpus:build` は書く前に消します]
`$CORPUS_DIR/fixtures` を**丸ごと**削除してから作り直します。corpus リポジトリが
追跡していないものは復元不能に消えます ― 実際に作業が失われたことがあります。

実行前に corpus リポジトリで `git status` を確認してください。そして
**再生成できないアーカイブが入ったディレクトリを `CORPUS_DIR` に指定しないでください。**
:::

## CI が回すもの

5 つの workflow があり、ローカルで `pnpm check` として再現できるのは最初の 1 つだけです。

| workflow | 内容 |
| --- | --- |
| `check` | `pnpm check` ― 日常のスイート全部 |
| `corpus` | wacz-validator-corpus を **`.corpus-version` のバージョンで**クローンし、`corpus:docs:check` と `test:corpus` |
| `pack-smoke` | `@wacz-validator/contract`・`@wacz-validator/core`・`@wacz-validator/validate-cli`・`@wacz-validator/tui` を `npm pack` し、まっさらなディレクトリに入れてバイナリを実行 |
| `site` | ドキュメントをビルドし、参照を検証 |
| `docs` | サイトを公開 |

`pack-smoke` は他が捕まえられないものを捕まえます ― **ここではビルドもテストも通るのに、
壊れた tarball を出荷してしまう**ケースです。`files` の指定漏れや、バイナリの実行権限が
落ちているといった類のものです。
