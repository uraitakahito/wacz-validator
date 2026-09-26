# @wacz-validator/validate-cli

`wacz-validator-validate` — WACZ を検証して machine-readable な JSON report を stdout に出す非対話 CLI。検証そのものは [`@wacz-validator/core`](https://github.com/uraitakahito/wacz-validator/tree/main/packages/core) が行い、この package は引数の解釈と出力の発火だけを持つ。

同じ report を対話的に読みたい場合は
[`@wacz-validator/tui`](https://github.com/uraitakahito/wacz-validator/tree/main/packages/tui)
を使う。

## 使い方

サンプル WACZ で試したい場合は Webrecorder 公開の
[`webrecorder/example-webarchive`](https://github.com/webrecorder/example-webarchive)
から小さい archive を取得できる:

```sh
mkdir -p /tmp/wacz-validator-demo
curl -sL \
  https://raw.githubusercontent.com/webrecorder/example-webarchive/main/items/wikipedia/archive.wacz \
  -o /tmp/wacz-validator-demo/wikipedia.wacz
```

以降の例の `PATH` はこの `/tmp/wacz-validator-demo/wikipedia.wacz` に
読み替えると動かせる:

```sh
# Local file
wacz-validator-validate PATH
# S3 (AWS credentials は default credential chain — env / shared config / IAM role)
wacz-validator-validate s3://BUCKET/KEY.wacz
# spec (default) | browserhive | lenient
wacz-validator-validate SOURCE --profile PROFILE
```

rule 別の失敗例や profile 差を試したい場合は、30 標本を揃えた
[wacz-validator-corpus](https://github.com/uraitakahito/wacz-validator-corpus) を使う —
入手方法とカタログは
[事例カタログ](https://uraitakahito.github.io/wacz-validator/ja/corpus/)。

## Exit codes

| Code | 意味                                             |
| ---- | ------------------------------------------------ |
| `0`  | validation 成功 — `error` severity の issue なし |
| `1`  | validation 失敗 — `error` issue が 1 件以上      |
| `2`  | operational な失敗 (ファイルが開けないなど)      |

warning / info レベルの issue が exit code を反転させることは無い。

## 出力 schema

stdout には `Report` が出力される。full schema は
[JSON レポート](https://uraitakahito.github.io/wacz-validator/ja/json-report/)
を参照。短い例:

```json
{
  "validatorVersion": "0.31.0",
  "profile": { "name": "spec" },
  "source": { "kind": "file", "path": "/tmp/good.wacz" },
  "summary": { "passed": 12, "failed": 0, "warnings": 0, "info": 0, "durationMs": 12 },
  "issues": [],
  "stats": { "warcRecordCount": 1, "warcArchiveBytes": 246, "hosts": ["example.com"] }
}
```

## プロファイル

| Profile             | こういうときに使う                                                                  |
| ------------------- | ----------------------------------------------------------------------------------- |
| `spec` (デフォルト) | WACZ-spec + wabac.js 互換を求めたい。ほとんどの consumer はこれ。                   |
| `browserhive`       | BrowserHive capture を検証する。producer-strict な check を有効化。                 |
| `lenient`           | legacy archive をトリアージしたい。"replay が壊れる" 系の hard error だけが欲しい。 |

rule 単位の profile 別 severity matrix は
[Rules](https://uraitakahito.github.io/wacz-validator/ja/rules/)
を参照。

## 環境変数

| Env                                                          | 用途                                                                                              |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION` | SDK 標準 — credentials / region。SDK の default chain がそのまま読む。                            |
| `AWS_ENDPOINT_URL_S3`                                        | SDK 標準 (v3.395+) — bundled SeaweedFS のような非 AWS endpoint を向くときに。                     |
| `WACZ_VALIDATOR_S3_FORCE_PATH_STYLE`                                | `"true"` のときだけ `forcePathStyle: true` を立てる。SeaweedFS / MinIO 等の path-style addressing 用。 |
| `WACZ_VALIDATOR_LANG`                                                | メッセージの言語。`--lang` フラグが優先、無ければこれ、無ければ `LANG` / `en`。                    |

bundled SeaweedFS の compose stack は repo root の `compose.{dev,prod}.yaml`
を参照。

## library として使いたい場合

この package は bin しか持たない (`main` も `types` も無い)。in-process で
validation を駆動したいなら [`@wacz-validator/core`](https://github.com/uraitakahito/wacz-validator/tree/main/packages/core)
を直接 import する。
