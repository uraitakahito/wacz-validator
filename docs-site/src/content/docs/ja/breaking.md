---
title: 壊して確かめる
description: BrowserHive で撮った WACZ をわざと壊し、rule が赤くなるところまでを通す
---

validator の「緑」は 2 通りの意味を持ちます ― 検査して問題が無かったのか、
そもそも検査していないのか。**区別する方法は 1 つで、壊して赤くなるところを
見ること**です。

`@wacz-validator/devtools`(publish しない開発用パッケージ)の `wacz-validator-break` は、
その 1 手間を毎回書き直さずに済むようにする道具です。

## 全体の流れ

| 段 | 道具 | やること |
| --- | --- | --- |
| 1 | BrowserHive | ページを取り込み、WACZ を S3 へ |
| 2 | aws cli | S3 から手元へ落とす |
| 3 | `wacz-validator-validate` | **基準を取る**。ここが緑でなければ以降に意味が無い |
| 4 | `wacz-validator-break` | わざと壊す |
| 5 | `wacz-validator-validate` | 赤くなることを確かめる |

**3 と 5 は対です。** 5 だけを見て「赤いから検査は働いている」と結論すると、
元から壊れていたアーカイブを掴んだときに気づけません。

## 1. BrowserHive で取り込む

複数の host に触れるページを選びます。1 host だとチェーンが 1 本しか入らず、
共有や差し替えの様子が見えません。

```sh
cd ~/projects/crawler/browserhive
pnpm run stack:up

WACZ=$(grpcurl -cacert dev-stack/tls/insecure-dev-tls-ca.crt \
  -import-path src/rpc/proto -proto browserhive/v1/capture.proto \
  -d '{"url":"https://www.iana.org/","labels":["chain-demo"],
       "captureFormats":{"png":false,"webp":false,"html":false,
                         "links":false,"mhtml":false,"wacz":true}}' \
  browserhive.browserhive:50051 browserhive.v1.CaptureService/Capture \
  | jq -r .report.artifacts.wacz)
echo "$WACZ"
```

```
s3://browserhive/66385280-2a2c-494d-9e2b-8e7198bb650b__chain-demo.wacz
```

dev スタックは TLS で話すので、grpcurl にはスタックの開発用 CA を渡します。
`Capture` は取り込みが終わってから答え(このページなら数秒)、応答が WACZ の
置き場所を持っています。**鍵は自分で組み立てず、応答から取ってください** ―
名前には知っていないと組めない枠があります(correlation id が空なので、
`_` が 2 つ続きます)。次の段で `$WACZ` を読むので、同じ shell のまま進みます。

:::caution
`san` の検査には **BrowserHive 3.7.0 以降**で撮ったものが要ります。それ未満では
`browserhive/tls-san` が `skipped` に入ります(それが正しい挙動です)。
チェーンの検証自体は版を問いません。
:::

## 2. S3 から手元へ落とす

```sh
cd ~/projects/crawler/wacz-validator
AWS_ACCESS_KEY_ID=browserhive AWS_SECRET_ACCESS_KEY=browserhive \
  aws --endpoint-url http://seaweedfs.crawler-storage:8333 s3 cp "$WACZ" ./demo.wacz
```

## 3. 基準を取る

```sh
pnpm install && pnpm -r build

node packages/validate-cli/dist/wacz-validator-validate.js \
  --profile browserhive ./demo.wacz \
  | jq -r '"failed: \(.summary.failed)",
           (.issues[] | select(.rule|startswith("browserhive/tls"))
            | "  [\(.severity)] \(.message)")'
```

```
failed: 0
  [info] 4 host の証明書チェーンを検証しました
```

`summary` 全体には pass した rule の数も入っています。その数は rule が増えるたびに
変わるので、このページでは `failed` だけを見せます。

見るところは 2 つです。

- **`failed: 0`** ― 壊れていない。この後の「赤」が壊し方によるものだと言える前提
- **`[info] N host の…`** ― rule が実際に走った印。これが無ければ、以降どれだけ
  壊しても赤くなりません(検査していないので)

## 4. わざと壊す

```sh
node packages/devtools/dist/break-wacz.js --list
```

```
壊し方、書き換える対象、そして出させる報告:

  swap-intermediate        datapackage.json             → browserhive/tls-chain.broken-link
  reverse-chain            datapackage.json             → browserhive/tls-chain.leaf-not-first
  drop-chains              datapackage.json             → browserhive/tls-chain.dangling-ref
  garbage-der              datapackage.json             → browserhive/tls-chain.unparseable
  san-drift                datapackage.json             → browserhive/tls-san.drift
  axtree-drop-level        accessibility/axtree.jsonl   → browserhive/axtree-shape.missing-member
  axtree-unknown-property  accessibility/axtree.jsonl   → browserhive/axtree-shape.unknown-property
  axtree-keep-generic      accessibility/axtree.jsonl   → browserhive/axtree-shape.collapsed-role
  axtree-wrong-profile     accessibility/axtree.jsonl   → browserhive/axtree-shape.unknown-profile
```

```sh
node packages/devtools/dist/break-wacz.js \
  ./demo.wacz ./demo-broken.wacz -m swap-intermediate
```

```
壊しました: clients1.google.com のチェーンの中間を www.google.com のものへ差し替え
  → ./demo-broken.wacz
期待する報告: browserhive/tls-chain.broken-link
```

**証明書は本物のままです。** DER を作り物に差し替えるのではなく、別の host の
チェーンから中間証明書を借りて置き換えます ― 正しい証明書が 2 通、繋がらない
組み合わせで並んでいる状態になります。

:::note
`wacz-validator-break` は**名乗った 1 箇所しか変えません**。zip の圧縮方式も元のまま
書き戻すので、壊し方と無関係な指摘は増えません ― 増えると、読み手はそれを
追いかけることになります。
:::

## 5. 赤くなることを確かめる

```sh
node packages/validate-cli/dist/wacz-validator-validate.js \
  --profile browserhive ./demo-broken.wacz \
  | jq -r '"failed: \(.summary.failed)",
           (.issues[] | select(.severity=="error") | "  [\(.severity)] \(.message)")'
```

```
failed: 2
  [error] cse.google.com: 0 番目の証明書が次と繋がっていません(発行者 WR2 / 次の subject WE2)
  [error] clients1.google.com: 0 番目の証明書が次と繋がっていません(発行者 WR2 / 次の subject WE2)
```

**ここまで見て、初めて「この検査は働いている」と言えます。** 3 が緑で 5 が赤 ―
差が出たことだけが証拠です。

### 1 つ壊したのに 2 つ赤くなる

正しい挙動です。証明書チェーンは**内容で重複排除**されているので、複数の host が
同じ 1 本を指していることがあります。

```
www.iana.org           chainRef=9a57318f8c89976c
cse.google.com         chainRef=c52653c92800f6fd  ┐ 同じチェーンを共有
www.google.com         chainRef=d4c643e77f3e2f17  │
clients1.google.com    chainRef=c52653c92800f6fd  ┘
```

そこを壊せば、指している host すべてが影響を受けます。

## TUI で梯子として見る

```sh
node packages/tui/dist/cli.js --profile browserhive --lang ja ./demo-broken.wacz
```

Issues ビューで `enter` を押すと、host ごとのチェーンが梯子として開きます。
`─┐` が「次と繋がっていて署名も通った」、`─✗` が切れている印です。

CI やスクリプトでは `wacz-validator-validate` の JSON を使ってください ― TUI は端末が
要りますが、**同じ `details` がそのまま JSON に入っています**。
