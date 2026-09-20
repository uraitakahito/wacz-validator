---
title: Break it on purpose
description: Take a WACZ captured by BrowserHive, break it deliberately, and watch a rule turn red
---

A validator's green means one of two things: it checked and found nothing, or it
never checked at all. **There is one way to tell them apart — break the archive
and watch a rule turn red.**

`wacz-validator-break`, from the `@wacz-validator/devtools` package (development only, never
published), saves you from writing that one step by hand every time.

## The flow

| Step | Tool | What it does |
| --- | --- | --- |
| 1 | BrowserHive | Capture a page; the WACZ lands in S3 |
| 2 | aws cli | Pull it down |
| 3 | `wacz-validator-validate` | **Take a baseline.** Nothing below means anything unless this is green |
| 4 | `wacz-validator-break` | Break it on purpose |
| 5 | `wacz-validator-validate` | Watch it turn red |

**Steps 3 and 5 are a pair.** Looking only at 5 and concluding "it is red, so the
check works" leaves you blind the day you pick up an archive that was already
broken.

## 1. Capture with BrowserHive

Pick a page that touches several hosts. With a single host you get one chain, and
neither sharing nor substitution is visible.

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

The dev stack speaks TLS, so grpcurl is given the stack's development CA.
`Capture` answers once the capture has finished — seconds for this page — and the
response says where the WACZ went. **Take the location from the response rather
than assembling the key yourself**: the name carries slots you would have to know
about (the empty correlation id is why there are two underscores). Stay in this
shell; the next step reads `$WACZ`.

:::caution
The `san` check needs an archive captured by **BrowserHive 3.7.0 or later**.
Below that, `browserhive/tls-san` lands in `skipped` — which is the correct
behaviour. Chain verification itself does not depend on the version.
:::

## 2. Pull it down

```sh
cd ~/projects/crawler/wacz-validator
AWS_ACCESS_KEY_ID=browserhive AWS_SECRET_ACCESS_KEY=browserhive \
  aws --endpoint-url http://seaweedfs.crawler-storage:8333 s3 cp "$WACZ" ./demo.wacz
```

## 3. Take a baseline

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

The full `summary` also counts the rules that passed. That count grows every time
a rule is added, so this page shows only `failed`.

Two things to look at.

- **`failed: 0`** — nothing is broken. This is what lets you attribute the red
  below to the mutation.
- **the `info` line** — the rule actually ran. Without it, nothing you break will
  turn red, because nothing is being checked.

## 4. Break it

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

**The certificates stay real.** Rather than substituting made-up DER, the tool
borrows an intermediate from another host's chain — leaving two genuine
certificates in an order that does not link.

:::note
`wacz-validator-break` changes **only the one thing it names**. It writes entries back
with their original compression, so no unrelated finding appears — one that does
is a finding a reader will chase.
:::

## 5. Watch it turn red

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

**Only now can you say the check works.** Step 3 green, step 5 red — the
difference is the whole of the evidence.

### One break, two hosts red

That is correct. Certificate chains are de-duplicated **by content**, so several
hosts can point at the same one.

```
www.iana.org           chainRef=9a57318f8c89976c
cse.google.com         chainRef=c52653c92800f6fd  ┐ same chain
www.google.com         chainRef=d4c643e77f3e2f17  │
clients1.google.com    chainRef=c52653c92800f6fd  ┘
```

Break it and every host pointing at it is affected.

## Reading it as a ladder in the TUI

```sh
node packages/tui/dist/cli.js --profile browserhive ./demo-broken.wacz
```

Press `enter` on the issue and the chain opens as a ladder per host: `─┐` links
to the next certificate with a verified signature, `─✗` does not.

For CI and scripts use `wacz-validator-validate`'s JSON — the TUI needs a terminal, but
**the same `details` is in the JSON**.
