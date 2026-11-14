# @wacz-validator/core

WACZ validation engine。WACZ を読んで rule を走らせ、machine-readable な `Report` を返す library。rule は仕様 (WACZ 1.1.1・Data Package・WARC 1.1・wacz-auth 0.1.0) と [wabac.js](https://github.com/webrecorder/wabac.js) replay engine の実際の loader 挙動から導出されており、既知 producer に対するより厳しい check 用に producer 固有 profile も任意で選べる。

この engine の上で動く interactive な terminal UI が必要なら
[`@wacz-validator/tui`](https://github.com/uraitakahito/wacz-validator/tree/main/packages/tui)
を使う。

## CLI が要るなら

この package は library だけで bin を持たない。非対話の
`wacz-validator-validate` コマンドは
[`@wacz-validator/validate-cli`](https://github.com/uraitakahito/wacz-validator/tree/main/packages/validate-cli)
にある。

## ライブラリとしての使い方

```ts
import {
  runValidation,
  WaczReader,
  DEFAULT_RULES,
  parseReportSource,
  fileTransport,
  httpTransport,
  s3Transport,
  type ReportSource,
} from "@wacz-validator/core";

// Local file でも s3:// URI でも http(s):// の URL でも、`parseReportSource` が
// transport を判定して `Result<ReportSource, …>` を返す。`source.kind` で
// `fileTransport` / `httpTransport` / `s3Transport` を選び、`WaczReader.open` に渡す。
// s3 は接続設定 `forcePathStyle` を足した ResolvedS3Source を渡す。
const parsed = parseReportSource("/path/to/file.wacz");
// または: parseReportSource("s3://bucket/key.wacz");
// または: parseReportSource("https://host/key.wacz?X-Amz-Signature=…");
if (!parsed.ok) throw new Error(parsed.error.kind);

// switch で書く —— `ReportSource` に kind が増えたとき、網羅性の検査で止まる。
const transportFor = (source: ReportSource) => {
  switch (source.kind) {
    case "s3":
      return s3Transport({ ...source, forcePathStyle: false });
    case "http":
      // 署名つきの URL はそのまま渡す。report の `source` には query を落とした URL が載る。
      return httpTransport({ url: source.url });
    case "file":
      return fileTransport(source.path);
  }
};

const reader = await WaczReader.open(transportFor(parsed.value));
try {
  const result = await runValidation(reader, {
    validatorVersion: "0.0.0",
    rules: DEFAULT_RULES,
    profile: { name: "spec" },
  });
  if (result.ok) console.log(JSON.stringify(result.value, null, 2));
} finally {
  await reader.close();
}
```

`WaczReader.source` が `Report.source` の唯一の入力経路。`runValidation`
は reader から自動で取るので caller が path を二度渡す必要はない。
`forcePathStyle` は `ResolvedS3Source` で指定する (SeaweedFS / MinIO 等の
S3 互換 endpoint 向け)。これは接続設定なので `Report.source` の wire
format (`{ kind, uri }`) には出ない。さらに細かい transport 制御が必要なら
`WaczTransport` interface を自前実装すればよい。

公開する export の一式は `src/public.ts` にある。workspace の中でこれを
消費するのは、engine を自分の process で動かす package
(`@wacz-validator/daemon`・`@wacz-validator/validate-cli`) と、型だけを
引く `@wacz-validator/protocol`。`@wacz-validator/tui` は core を import
せず、daemon 越しに protocol の型で話す。
