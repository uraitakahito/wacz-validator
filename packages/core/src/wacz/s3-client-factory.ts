/**
 * S3Client を所与の `forcePathStyle` で構築する thin wrapper。
 *
 * 用途: bundled SeaweedFS のような非 AWS な S3 互換 endpoint を触るときに
 * `forcePathStyle: true` を選択させる手段が要る。 SDK は credentials /
 * region / endpoint (`AWS_*` 系) を env から自動解決するので、 wacz-validator 固有
 * の設定として残るのは path-style 切替の 1 つだけ。
 *
 * 呼び出し元は `s3Transport` (wacz/transport.ts) で、 `ResolvedS3Source`
 * が運んできた `forcePathStyle` を渡す。 env (`WACZ_VALIDATOR_S3_FORCE_PATH_STYLE`)
 * と CLI flag (`--s3-force-path-style`) の解決は CLI の入口 (validate-cli と tui) が行う
 * (`process.env[...] === "true"` を commander の `.option` default にして、
 * flag が立てば上書き)。 `buildS3Client` 自身は env を知らない pure な
 * wrapper として保たれる。
 */
import { S3Client } from "@aws-sdk/client-s3";

export const buildS3Client = (forcePathStyle: boolean): S3Client =>
  new S3Client({ forcePathStyle });
