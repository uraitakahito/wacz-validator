/**
 * WaczTransport
 *
 * 「WACZ の `ZipFile` をどう得るか」を表す値。 transport ごとに名前付き
 * factory (`fileTransport` / `s3Transport`) で生成する。
 * `WaczReader.open(transport)` はこの `openZip()` を呼ぶだけで、
 * transport の種別を知らない — 多態は transport 値が担う。
 *
 * 依存の向き: この module は `WaczReader` を import しない (factory は
 * `ZipFile` を返すだけ)。`reader.ts` 側が `import type { WaczTransport }`
 * で型のみ参照するので、runtime の循環参照は発生しない。
 */
import { fromReader, open as yauzlOpen, type ZipFile } from "yauzl-promise";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import {
  s3UriToBucketKey,
  stripUrlQuery,
  type AbsolutePath,
  type HttpUrl,
  type ReportSource,
  type S3Source,
} from "../validate/domain.js";
import { S3RangeReader } from "./s3-range-reader.js";
import { HttpRangeReader } from "./http-range-reader.js";
import { buildS3Client } from "./s3-client-factory.js";

export interface WaczTransport {
  /** この transport が開く WACZ の identity。`WaczReader.source` になる。 */
  readonly source: ReportSource;
  /** transport 固有の方法で yauzl の `ZipFile` を開く。 */
  openZip(): Promise<ZipFile>;
}

/**
 * identity ({@link S3Source}) に接続設定 `forcePathStyle` を足した、open
 * に使う「解決済み」 source。 runtime 専用で、 wire format (`Report.source`)
 * には出さない (`s3Transport` が identity に剥がす)。 forcePathStyle の
 * env / CLI flag 解決は cli.ts の責務で、 ここには resolved な boolean が届く。
 */
export interface ResolvedS3Source extends S3Source {
  /** path-style addressing を強制するか (bundled SeaweedFS / MinIO 等)。 */
  forcePathStyle: boolean;
}

export const fileTransport = (path: AbsolutePath): WaczTransport => ({
  source: { kind: "file", path },
  openZip: () => yauzlOpen(path),
});

/**
 * identity ({@link HttpSource}) に「実際に叩く URL」を足した、open に使う
 * 「解決済み」 source。 runtime 専用で、 wire format (`Report.source`) には
 * 出さない —— 署名付き URL の query には `X-Amz-Signature` が入っており、
 * report は画面にも JSON にも出るため。 `ResolvedS3Source` が
 * `forcePathStyle` を wire に漏らさないのと同じ判断。
 */
export interface ResolvedHttpSource {
  /** 署名つきでありうる、実際に GET する URL。 */
  url: HttpUrl;
}

/**
 * http transport — `HttpRangeReader` で range GET を重ねて ZIP を読む。
 *
 * **HEAD を使わない。** 署名は GET に対して作られているので、署名付き URL への
 * HEAD は 403 になる (実測)。総サイズは最初の range GET の `Content-Range` から
 * 取る (`probeSize`)。S3 版が `HeadObjectCommand` を 1 回挟むのと同じ位置の往復。
 */
export const httpTransport = (source: ResolvedHttpSource): WaczTransport => ({
  // **query を剥がして identity にする。** 署名は資格情報で、identity ではない。
  source: { kind: "http", url: stripUrlQuery(source.url) },
  openZip: async () => {
    const reader = new HttpRangeReader(source.url);
    const size = await reader.probeSize();
    return fromReader(reader, size);
  },
});

/**
 * s3 transport — `forcePathStyle` から `S3Client` を構築し、
 * `HeadObjectCommand` で `ContentLength` を 1 回先に取得して
 * `S3RangeReader` 経由で `fromReader` に渡す (yauzl-promise の `fromReader`
 * は total size 必須なので、S3 側に明示的に問い合わせる手順)。
 *
 * `source` は `forcePathStyle` 付きの {@link ResolvedS3Source} を受け取るが、
 * `WaczTransport.source` (= `WaczReader.source` / `Report.source`) には
 * identity (`{ kind, uri }`) だけを載せる。 `source` を spread すると
 * `forcePathStyle` が wire (JSON report) に漏れるので、明示的に剥がす。
 */
export const s3Transport = (source: ResolvedS3Source): WaczTransport => ({
  source: { kind: "s3", uri: source.uri },
  openZip: async () => {
    const client = buildS3Client(source.forcePathStyle);
    const { bucket, key } = s3UriToBucketKey(source.uri);
    const head = await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
    );
    const size = head.ContentLength;
    if (size === undefined) {
      throw new Error(`S3 HeadObject returned no ContentLength for ${source.uri}`);
    }
    const rangeReader = new S3RangeReader(client, bucket, key);
    return fromReader(rangeReader, size);
  },
});
