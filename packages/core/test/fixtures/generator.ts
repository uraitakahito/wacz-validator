/**
 * WACZ fixture generator。
 *
 * メモリ上で最小だが spec 準拠の WACZ を組み立てる (それ自身は I/O
 * を持たない — 呼び出し側が出力先を選ぶ)。mutation hook を露出して
 * いるので、組み立てロジックを書き直さずに、test が corrupted な
 * バリアントを生成できる。
 *
 * "good.wacz" をチェックイン fixture にしないのはなぜか: 入力は
 * シンプル、producer (browserhive) は進化中で、"good" の baseline は
 * ここで encode する spec を追いかけたい。バイナリ blob をチェック
 * インすると assertion が opaque になる ("ファイルが変わったので
 * test が壊れた")。generator なら diff が review 可能。
 *
 * レイアウトは browserhive の `src/storage/wacz/packager.ts` に従う:
 *
 *   archive/data.warc.gz       STORE
 *   pages/pages.jsonl          DEFLATE
 *   indexes/index.cdxj         DEFLATE
 *   fuzzy.json                 DEFLATE
 *   datapackage.json           DEFLATE
 */
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { Writable } from "node:stream";
import { gzipSync } from "node:zlib";
// archiver 8 は ESM-only で、format ごとのクラスを export する
// (v7 の factory `archiver("zip", ...)` はもう存在しない)。
// @types/archiver は依然 v7 の surface を tracking しているので
// type shim を src/types/archiver.d.ts に置いている。
import { ZipArchive } from "archiver";

// ---------------------------------------------------------------------------
// 設定 knob — corrupted バリアントが上書きしたいと思う各 field を露出
// する。デフォルトは完全に valid な最小 WACZ を生成する。
// ---------------------------------------------------------------------------

export interface FixtureOptions {
  taskId?: string;
  pageUrl?: string;
  pageTitle?: string;
  capturedAt?: string;
  software?: string;
  waczVersion?: string;
  /**
   * `profile` field of datapackage.json. Set to `null` to OMIT the field
   * entirely (covers rule #1 "missing profile" case); set to a string to
   * override the value (covers "wrong profile" case).
   */
  profile?: string | null;
  /**
   * `$schema` field of datapackage.json — Data Package **v2** の名乗り
   * (v2 は v1 の `profile` を廃止しこれに置き換えた)。`undefined` なら
   * field ごと書かない。
   *
   * `profile` と非対称なのは意図的。`profile` は既定で書かれるので「既定 /
   * 上書き / 省略」の 3 値が要るが、`schema` は既定で書かれないため値を渡す
   * かどうかの 2 値で足りる。
   *
   * 値の妥当性 (v2 が要求する「解決可能な URL であること」など) はここでは
   * 検証しない — 生成側は「何を名乗らせるか」だけを決め、判断は rule 側の
   * 責務。現状 wacz-validator に `$schema` を読む rule は無い。
   */
  schema?: string;
  /**
   * Override the body of `datapackage.json#resources[]`. When `undefined`,
   * the generator computes hashes from the actual content (the "good"
   * baseline). Pass `(default) => default.map(...)` to mutate specific
   * resources — e.g. corrupt a hash to exercise rule #5.
   */
  mutateResources?: (defaults: DatapackageResource[]) => DatapackageResource[];
  /** Replace the CDXJ filename field on every entry (rule #3). */
  cdxjFilenameOverride?: string;
  /**
   * Replace the entire body of `indexes/index.cdxj` with this raw string,
   * bypassing the well-formed CDXJ builder. Used to exercise
   * `cdxj/index-valid-data` (§5.2.2 "Index files MUST contain CDXJ data"):
   * e.g. `"not cdxj at all\n"` makes the index unparseable. The resource
   * hash is still computed from the actual bytes, so `resource-hashes`
   * stays green and only the parse-validity rule fires.
   */
  cdxjOverride?: string;
  /**
   * When true, gzip the cdxj body and rename to `index.cdxj.gz` (rule #4).
   * The generator switches the ZIP entry name accordingly.
   */
  cdxjGzipped?: boolean;
  /**
   * When true, name the index `indexes/index.cdxj.gz` but store the body as
   * raw (un-gzipped) bytes — i.e. it claims to be gzip but is not. Used to
   * exercise the `gzip-error` branch of `cdxj/index-valid-data` (a `.gz`
   * index that cannot be decompressed). Takes precedence over `cdxjGzipped`.
   */
  cdxjGzipBroken?: boolean;
  /**
   * When true, omit `datapackage.json` entirely. Lets rule #1 / #5 see the
   * "absent" branch.
   */
  omitDatapackage?: boolean;
  /**
   * §5.2 の MUST ファイルを欠落させる(`wacz/required-files` 用)。entry を
   * ZIP から落とすだけでなく、対応する `datapackage.json#resources[]` の宣言も
   * 落とす — 「不在かつ未宣言」を再現し、required-files を単独で踏ませる
   * (resource-hashes の "missing" と二重にならない)。
   */
  omitPages?: boolean;
  omitArchive?: boolean;
  omitIndexes?: boolean;
  /**
   * `WARC-Type: response` のレコード (HTTP の状態行・見出し・本文つき) を warcinfo の
   * 後ろに足す。CDXJ にも offset / length つきの行が並ぶので、索引から 1 メンバを
   * 切り出す読み (`WaczReader.member`) や、レコードの中身を返す口の試験に使う。
   * 既定の標本には無い —— 応答レコードを持つ標本が無かったので足した。
   */
  warcResponses?: WarcResponseSpec[];
  /**
   * When true, store the WARC entry as DEFLATE rather than STORE
   * (browserhive's invariant from packager.ts). Triggers rule #6.
   */
  warcDeflate?: boolean;
  /**
   * When set, flip a single byte at this offset of the WARC.gz bytes
   * before placing them in the zip. Used to break the gzip member
   * decoding (rule #7).
   */
  warcCorruptAt?: number;
  /**
   * Append this many `WARC-Type: metadata` records (browserhive's
   * incomplete/failed-request convention, `application/warc-fields` body)
   * to the WARC as extra gzip members. Exercises `warc/recording-complete`.
   */
  warcIncompleteRecords?: number;
  /**
   * `warcIncompleteRecords` のリッチ版。各要素が 1 件の metadata レコードを
   * 表し、案3 で追加された `resourceType` / `blockedReason` field を任意で
   * 載せる。`warc/recording-complete` の byResourceType / byBlockedReason
   * 集計を動かす。`warcIncompleteRecords` と併用すると両方が連結される。
   */
  warcIncompleteSpec?: { resourceType?: string; blockedReason?: string }[];
  /**
   * When set, override the CDXJ `offset` field on every entry with this
   * value (string form, matching the producer convention). Used to
   * exercise rule #8.
   */
  cdxjOffsetOverride?: string;
  /**
   * When true, replace the CDXJ `length` field with a sentinel value
   * that won't match the actual WARC member length. Used to exercise
   * the length-mismatch branch of rule #8.
   */
  cdxjLengthMismatch?: boolean;
  /**
   * Override datapackage.mainPageURL. When this differs from `pageUrl`
   * (the URL recorded in pages.jsonl / CDXJ), rule #9 fires.
   */
  mainPageUrlOverride?: string;
  /**
   * When true, inject a deliberately-wrong `WARC-Payload-Digest` header
   * into the warcinfo record. Triggers rule #10.
   */
  payloadDigestBad?: boolean;
  /**
   * Producer flavour. Controls indexing layout:
   *
   *   - `"browserhive"` (default): emit a single plain
   *     `indexes/index.cdxj`. Matches BrowserHive's producer
   *     conventions and the `browserhive` rule profile's
   *     expectations.
   *   - `"webrecorder"`: emit `indexes/index.cdx.gz` (gzipped CDXJ
   *     content) paired with `indexes/index.idx` carrying the
   *     `!meta { format: "cdxj-gzip-1.0", filename: "index.cdx.gz" }`
   *     header. Matches Webrecorder's example archives and the
   *     pywb / wacz-creator convention.
   *
   * Independent of `cdxjGzipped` — the older option only rewrote the
   * BrowserHive layout's filename. `producer: "webrecorder"` emits
   * the full pair.
   */
  producer?: "browserhive" | "webrecorder";
  /**
   * `browserhive:capture.tls` をそのまま書き込む。undefined なら member ごと
   * 書かない —— tls はプロファイルの任意 member なので、不在も正しい形。
   *
   * 中身を検査しないのはここの責務ではないため。壊れた chainRef も、証明書に
   * ならない base64 も、そのまま通す —— それを問題と呼ぶかは rule が決める。
   */
  /**
   * `accessibility/axtree.jsonl` の中身。
   *
   * オブジェクトを渡せば 1 行の JSONL として書き、文字列を渡せばそのまま書く
   * (JSON として読めない行を作るため)。`undefined` ならエントリごと作らない ——
   * 撮っていない capture も正しい形なので。
   */
  axtree?: Record<string, unknown> | string;
  /**
   * `browserhive:capture.storage` (目録) をそのまま書き込む。undefined なら
   * member ごと書かない —— **目録は profile 1.1.0 の必須**なので、その不在自体が
   * 検査の対象になる。tls と非対称なのはそのため。
   */
  storage?: Record<string, unknown>;
  /**
   * `browserhive:capture.settings` をそのまま書き込む。undefined なら member ごと
   * 書かない —— **settings は profile 1.2.0 の必須**なので、その不在自体が
   * 検査の対象になる。storage と同じく tls とは非対称。
   *
   * 中身は検査しない。member を落とした形も、型を違えた形も、そのまま通す ——
   * それを問題と呼ぶかは rule が決める。
   */
  settings?: Record<string, unknown>;
  /**
   * `browserhive:capture.dismissal` をそのまま書き込む。undefined なら member ごと
   * 書かない —— **除去は任意**で、不在は「配信されたままのページを保存した」という
   * 意味になるので、tls と同じく不在も正しい形。
   *
   * 中身は検査しない。member を落とした形も、`unreadable` と結果を並べた形も
   * そのまま通す —— それを問題と呼ぶかは rule が決める。
   */
  dismissal?: Record<string, unknown>;
  /**
   * `browserhive:capture.settle` をそのまま書き込む。undefined なら member ごと
   * 書かない —— **settle は profile 1.7.0 の必須**なので、その不在自体が検査の対象になる。
   *
   * 中身は検査しない。時刻を省いた形も、null の隣に quiet を書いた形も、そのまま通す ——
   * それを問題と呼ぶかは rule が決める。
   */
  settle?: Record<string, unknown>;
  /**
   * `behaviors/custom.jsonl` の中身。オブジェクトの配列なら 1 行ずつ JSONL に、
   * 文字列ならそのまま書く (JSON として読めない行を作るため)。undefined なら
   * エントリごと作らない —— **不在は「持ち込みを置かなかった」で、正しい形**。
   */
  behaviorsCustom?: Record<string, unknown>[] | string;
  /**
   * `storage/origins.jsonl` の中身。オブジェクトの配列なら 1 行ずつ JSONL に、
   * 文字列ならそのまま書く (JSON として読めない行を作るため)。
   */
  storageValues?: Record<string, unknown>[] | string;
  tls?: {
    hosts: Record<string, Record<string, unknown> | null>;
    chains: Record<string, readonly string[]>;
  };
  /**
   * G1 (warc/extension-gzip-match): GZIP 済みの WARC を `.warc.gz` ではなく
   * `archive/data.warc` という名前で格納し、拡張子と中身の gzip 状態を
   * 不一致にする。
   */
  warcExtensionMismatch?: boolean;
  /**
   * G2 (pages/page-schema): pages.jsonl に壊れた page 行を 1 つ足す。
   * "not-json" = JSON でない行、"missing-prop" = url/ts を欠く行。
   */
  pagesBadLine?: "not-json" | "missing-prop";
  /**
   * G3 (datapackage/digest): `datapackage-digest.json` を制御する。
   * 既定(undefined)は datapackage.json の正しい sha256 を同梱。
   * "absent" = 同梱しない、"bad-hash" = 誤った hash を入れる。
   */
  digest?: "absent" | "bad-hash";
  /**
   * `datapackage-digest.json` に `signedData` を同梱する (wacz-auth/signature)。
   *
   * 中身は素通しする —— 署名は呼ぶ側が作る。ここで鍵を持つと、fixture が
   * 「正しい署名」を 1 通りしか作れなくなり、壊した形を試験できない。
   */
  signedData?: Record<string, unknown>;
  /**
   * G4 (wacz/reserved-dirs-clean): 予約ディレクトリ `archive/` に
   * 異物ファイル(`archive/notes.txt`)を追加する。
   */
  reservedDirExtraFile?: boolean;
  /**
   * G5 (datapackage/resources-complete): resources に未宣言の孤児ファイル
   * (`extra.bin`)を root に追加する。
   */
  orphanFile?: boolean;
}

interface DatapackageResource {
  name: string;
  path: string;
  hash: string;
  bytes: number;
}

/** `warcResponses` の 1 件。body は HTTP の entity body そのもの。 */
export interface WarcResponseSpec {
  uri: string;
  mime: string;
  body: Buffer | string;
  /** HTTP の状態コード。既定 200。 */
  status?: number;
}

/** 組み立てた WARC の各メンバ (gzip 1 つ = レコード 1 つ) の位置。 */
export interface WarcRecordInfo {
  type: "warcinfo" | "response" | "metadata";
  offset: number;
  length: number;
  uri?: string;
  mime?: string;
  status?: number;
}

// ---------------------------------------------------------------------------
// WARC コンテンツ — 単一の最小 `warcinfo` レコード。CDXJ が参照する
// には十分で、必要なら test 内で手計算できる程度には小さい。形状は
// browserhive の `buildWarcInfoRecord` の出力に揃えている。
// ---------------------------------------------------------------------------

/**
 * 単一の `warcinfo` レコードを組み立てる。`payloadDigestBad` が true
 * のとき、`WARC-Payload-Digest` を意図的に固定の偽値にセットして
 * rule #10 を発火させる。それ以外のときは実体 body から digest を
 * 計算して、デフォルト fixture では rule が pass する。
 */
const buildWarcInfoBytes = (software: string, payloadDigestBad: boolean): Buffer => {
  const body = `software: ${software}\r\n`;
  const bodyBuf = Buffer.from(body, "utf-8");
  const digest = payloadDigestBad
    ? "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    : sha256Base32(bodyBuf);
  const headers = [
    "WARC/1.1",
    "WARC-Type: warcinfo",
    "WARC-Record-ID: <urn:uuid:00000000-0000-0000-0000-000000000001>",
    "WARC-Date: 2026-05-13T00:00:00Z",
    `WARC-Payload-Digest: ${digest}`,
    `Content-Length: ${String(bodyBuf.byteLength)}`,
    "Content-Type: application/warc-fields",
    "",
    "",
  ].join("\r\n");
  return Buffer.concat([Buffer.from(headers, "utf-8"), bodyBuf, Buffer.from("\r\n\r\n", "utf-8")]);
};

/**
 * browserhive が失敗/未完了の取得を記録するときの `WARC-Type: metadata`
 * レコード(`application/warc-fields` body)を 1 件組み立てる。
 * `warc/recording-complete` rule のテスト用。`opts` で案3 の
 * `resourceType` / `blockedReason` field を任意で載せる(byResourceType /
 * byBlockedReason 集計を動かす)。
 */
const buildIncompleteMetadataBytes = (
  idx: number,
  opts: { resourceType?: string; blockedReason?: string } = {},
): Buffer => {
  const lines = ["incomplete: true", "reason: loadingFailed"];
  if (opts.resourceType !== undefined) lines.push(`resourceType: ${opts.resourceType}`);
  if (opts.blockedReason !== undefined) lines.push(`blockedReason: ${opts.blockedReason}`);
  const body = Buffer.from(`${lines.join("\r\n")}\r\n`, "utf-8");
  const headers = [
    "WARC/1.1",
    "WARC-Type: metadata",
    `WARC-Record-ID: <urn:uuid:00000000-0000-0000-0000-${String(idx + 100).padStart(12, "0")}>`,
    "WARC-Date: 2026-05-13T00:00:00Z",
    `WARC-Target-URI: https://tracker.example/req/${String(idx)}`,
    "Content-Type: application/warc-fields",
    `Content-Length: ${String(body.byteLength)}`,
    "",
    "",
  ].join("\r\n");
  return Buffer.concat([Buffer.from(headers, "utf-8"), body, Buffer.from("\r\n\r\n", "utf-8")]);
};

/**
 * `WARC-Type: response` レコードを 1 件組み立てる。形は BrowserHive の書く応答と
 * 同じ: WARC の見出し → 空行 → HTTP の状態行と見出し → 空行 → entity body → `\r\n\r\n`。
 * `WARC-Payload-Digest` は entity body の sha256 (rule `warc/payload-digest` が pass する)。
 */
const buildResponseBytes = (idx: number, spec: WarcResponseSpec): Buffer => {
  const body = typeof spec.body === "string" ? Buffer.from(spec.body, "utf-8") : spec.body;
  const status = spec.status ?? 200;
  const http = Buffer.concat([
    Buffer.from(
      [
        `HTTP/1.1 ${String(status)} ${status === 200 ? "OK" : "Status"}`,
        `content-type: ${spec.mime}`,
        `content-length: ${String(body.byteLength)}`,
        "",
        "",
      ].join("\r\n"),
      "utf-8",
    ),
    body,
  ]);
  const headers = [
    "WARC/1.1",
    "WARC-Type: response",
    `WARC-Record-ID: <urn:uuid:00000000-0000-0000-0000-${String(idx + 200).padStart(12, "0")}>`,
    "WARC-Date: 2026-05-13T00:00:00Z",
    `WARC-Target-URI: ${spec.uri}`,
    `WARC-Payload-Digest: ${sha256Base32(body)}`,
    "Content-Type: application/http;msgtype=response",
    `Content-Length: ${String(http.byteLength)}`,
    "",
    "",
  ].join("\r\n");
  return Buffer.concat([Buffer.from(headers, "utf-8"), http, Buffer.from("\r\n\r\n", "utf-8")]);
};

const buildWarcGz = (
  software: string,
  opts: {
    payloadDigestBad: boolean;
    corruptAt?: number;
    incompleteRecords?: number;
    incompleteSpec?: { resourceType?: string; blockedReason?: string }[];
    responses?: WarcResponseSpec[];
  },
): { bytes: Buffer; recordLength: number; offset: number; records: WarcRecordInfo[] } => {
  const raw = buildWarcInfoBytes(software, opts.payloadDigestBad);
  const gz = gzipSync(raw);
  // bit を 1 つ反転して gzip member が decode できないようにする。
  // gzip *の後* に corrupt させているのは、corruption が iterator に
  // 可視であってほしいため (producer が書こうとした uncompressed な
  // raw bytes に corruption を入れるのではない)。
  if (opts.corruptAt !== undefined && opts.corruptAt < gz.byteLength) {
    // 範囲付き index 書き込み (corruptAt < gz.byteLength)。
    // security/detect-object-injection rule はこの preset では無効。
    // ここでの index アクセスは意図的な fixture mutation。
    gz[opts.corruptAt] = (gz[opts.corruptAt] ?? 0) ^ 0xff;
  }
  // メンバを順に積み、それぞれの位置を記録する。warcinfo は常に offset 0 なので、
  // CDXJ・warc-offsets の既存の期待は変わらない。
  const members: Buffer[] = [];
  const records: WarcRecordInfo[] = [];
  let at = 0;
  const push = (member: Buffer, info: Omit<WarcRecordInfo, "offset" | "length">): void => {
    members.push(member);
    records.push({ ...info, offset: at, length: member.byteLength });
    at += member.byteLength;
  };
  push(gz, { type: "warcinfo" });
  // 応答レコードは warcinfo の直後。索引にも offset / length つきで並ぶ。
  (opts.responses ?? []).forEach((spec, i) => {
    push(gzipSync(buildResponseBytes(i, spec)), {
      type: "response",
      uri: spec.uri,
      mime: spec.mime,
      status: spec.status ?? 200,
    });
  });
  // テスト用: 未完了 metadata を別 gzip member として連結。
  const plainCount = opts.incompleteRecords ?? 0;
  for (let i = 0; i < plainCount; i++) {
    push(gzipSync(buildIncompleteMetadataBytes(i)), { type: "metadata" });
  }
  // リッチ版(resourceType / blockedReason 付き)は plain の後ろに連結。
  // idx は衝突しないよう plainCount からの連番にする。
  (opts.incompleteSpec ?? []).forEach((spec, i) => {
    push(gzipSync(buildIncompleteMetadataBytes(plainCount + i, spec)), { type: "metadata" });
  });
  return { bytes: Buffer.concat(members), recordLength: gz.byteLength, offset: 0, records };
};

/** 応答レコード 1 件ぶんの CDXJ 行。offset / length は組み立てたメンバの実位置。 */
const buildResponseCdxjLine = (filename: string, record: WarcRecordInfo): string => {
  const json = JSON.stringify({
    url: record.uri,
    mime: record.mime,
    status: String(record.status ?? 200),
    digest: "sha256:0000",
    length: String(record.length),
    offset: String(record.offset),
    filename,
  });
  return `${record.uri ?? ""} 20260513000000 ${json}\n`;
};

// sha256:<base32> 用ヘルパ — fixture generator を self-contained に
// 保つために src/wacz/digest.ts のものをミラーしている。
const sha256Base32 = (bytes: Buffer): string => {
  const digest = createHash("sha256").update(bytes).digest();
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of digest) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      const ch = alphabet[(value >> bits) & 0x1f];
      if (ch !== undefined) out += ch;
    }
  }
  if (bits > 0) {
    const ch = alphabet[(value << (5 - bits)) & 0x1f];
    if (ch !== undefined) out += ch;
  }
  return `sha256:${out}`;
};

const buildCdxjLine = (
  filename: string,
  length: number,
  offset: number,
  cdxjUrl: string,
  opts: { offsetOverride?: string; lengthMismatch?: boolean },
): string => {
  // warcinfo レコード 1 件の 1 行。ここで動かす rule にとって SURT /
  // timestamp は問題にならない — well-formed なら何でも動く。
  const json = JSON.stringify({
    url: cdxjUrl,
    mime: "application/warc-fields",
    status: "0",
    digest: "sha256:0000",
    length: opts.lengthMismatch ? String(length + 999) : String(length),
    offset: opts.offsetOverride ?? String(offset),
    filename,
  });
  return `${cdxjUrl} 20260513000000 ${json}\n`;
};

const buildPagesJsonl = (
  taskId: string,
  pageUrl: string,
  pageTitle: string,
  ts: string,
): string => {
  const header = JSON.stringify({ format: "json-pages-1.0", id: taskId, title: pageTitle });
  const entry = JSON.stringify({ id: taskId, url: pageUrl, ts, title: pageTitle });
  return `${header}\n${entry}\n`;
};

const buildFuzzyJson = (): string => `${JSON.stringify({ rules: [] }, null, 2)}\n`;

const sha256Hex = (bytes: Buffer): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

// ---------------------------------------------------------------------------
// メインエントリポイント。
// ---------------------------------------------------------------------------

export interface BuiltFixture {
  bytes: Buffer;
  /** WARC の各メンバの位置 (warcinfo・応答・metadata の順)。 */
  warcRecords: WarcRecordInfo[];
}

/** WACZ を完全にメモリ上で組み立てる。ZIP の bytes を返す。 */
export const buildWacz = async (options: FixtureOptions = {}): Promise<BuiltFixture> => {
  const taskId = options.taskId ?? "00000000-0000-0000-0000-000000000001";
  const pageUrl = options.pageUrl ?? "https://example.com/";
  const pageTitle = options.pageTitle ?? "Example";
  const capturedAt = options.capturedAt ?? "2026-05-13T00:00:00.000Z";
  const software = options.software ?? "wacz-validator-fixture/0.0.0";
  const waczVersion = options.waczVersion ?? "1.1.1";
  // ZIP entry の mtime を固定する。archiver は date 未指定だと現在時刻を
  // 刻むため、決定的な byte 出力 (corpus を Git LFS に置く際の churn 回避)
  // には capturedAt 由来の固定値を全 entry に渡す必要がある。
  const entryDate = new Date(capturedAt);

  const warc = buildWarcGz(software, {
    payloadDigestBad: options.payloadDigestBad ?? false,
    ...(options.warcCorruptAt !== undefined && { corruptAt: options.warcCorruptAt }),
    ...(options.warcIncompleteRecords !== undefined && {
      incompleteRecords: options.warcIncompleteRecords,
    }),
    ...(options.warcIncompleteSpec !== undefined && {
      incompleteSpec: options.warcIncompleteSpec,
    }),
    ...(options.warcResponses !== undefined && { responses: options.warcResponses }),
  });

  const cdxjFilename = options.cdxjFilenameOverride ?? "data.warc.gz";
  // CDXJ "url" field は replay ツールが lookup する URL。何も
  // override しないとき rule #9 が mainPageURL を cover できるよう、
  // pageUrl を使う。
  // cdxjOverride が指定されたら、well-formed な CDXJ 組み立てを丸ごと
  // バイパスして生の文字列を本文にする(非CDXJ を再現 → index-valid-data)。
  // 応答レコードがあれば、その行を warcinfo の行の後ろに並べる。
  const cdxjBody =
    options.cdxjOverride ??
    buildCdxjLine(cdxjFilename, warc.recordLength, warc.offset, pageUrl, {
      ...(options.cdxjOffsetOverride !== undefined && {
        offsetOverride: options.cdxjOffsetOverride,
      }),
      ...(options.cdxjLengthMismatch !== undefined && {
        lengthMismatch: options.cdxjLengthMismatch,
      }),
    }) +
      warc.records
        .filter((record) => record.type === "response")
        .map((record) => buildResponseCdxjLine(cdxjFilename, record))
        .join("");
  const cdxjBytesPlain = Buffer.from(cdxjBody, "utf-8");

  // Index レイアウト — producer + legacy な `cdxjGzipped` knob に依存。
  //
  //   * producer "browserhive" (デフォルト) + cdxjGzipped=false →
  //     `indexes/index.cdxj` の単一 entry (plain text)
  //   * producer "browserhive" + cdxjGzipped=true →
  //     `indexes/index.cdxj.gz` の単一 entry (ペア無し)。
  //     `cdxj/index-not-gzipped` (browserhive profile) AND
  //     `cdxj/index-recognised-by-wabac` (認識可能 index 無し) を
  //     動かすため。
  //   * producer "webrecorder" → `indexes/index.cdx.gz` 加えて
  //     gzip ペアを名指す `!meta` header を持つ
  //     `indexes/index.idx`。Webrecorder / pywb の wacz-creator
  //     出力をミラー。
  const producer = options.producer ?? "browserhive";

  interface IndexEntry {
    name: string;
    bytes: Buffer;
  }
  const indexEntries: IndexEntry[] = [];
  if (producer === "webrecorder") {
    const cdxGz = gzipSync(cdxjBytesPlain);
    indexEntries.push({ name: "indexes/index.cdx.gz", bytes: cdxGz });
    const idxText =
      `!meta ${JSON.stringify({ format: "cdxj-gzip-1.0", filename: "index.cdx.gz" })}\n` + cdxjBody;
    indexEntries.push({ name: "indexes/index.idx", bytes: Buffer.from(idxText, "utf-8") });
  } else {
    // cdxjGzipBroken は `.cdxj.gz` と名乗りつつ中身を未圧縮の生バイトにして
    // gunzip 失敗(index-valid-data の gzip-error 分岐)を再現する。
    const gzNamed = (options.cdxjGzipped ?? false) || (options.cdxjGzipBroken ?? false);
    const cdxjEntryName = gzNamed ? "indexes/index.cdxj.gz" : "indexes/index.cdxj";
    const cdxjBytes =
      options.cdxjGzipBroken === true
        ? cdxjBytesPlain
        : options.cdxjGzipped
          ? gzipSync(cdxjBytesPlain)
          : cdxjBytesPlain;
    indexEntries.push({ name: cdxjEntryName, bytes: cdxjBytes });
  }

  let pagesBody = buildPagesJsonl(taskId, pageUrl, pageTitle, capturedAt);
  if (options.pagesBadLine === "not-json") {
    pagesBody += "this is not json\n";
  } else if (options.pagesBadLine === "missing-prop") {
    pagesBody += `${JSON.stringify({ id: taskId, title: "no url or ts" })}\n`;
  }
  const pagesBytes = Buffer.from(pagesBody, "utf-8");

  const fuzzyBody = buildFuzzyJson();
  const fuzzyBytes = Buffer.from(fuzzyBody, "utf-8");

  const axtreeBytes =
    options.axtree === undefined
      ? undefined
      : Buffer.from(
          typeof options.axtree === "string"
            ? options.axtree
            : `${JSON.stringify(options.axtree)}\n`,
          "utf-8",
        );

  const behaviorsCustomBytes =
    options.behaviorsCustom === undefined
      ? undefined
      : Buffer.from(
          typeof options.behaviorsCustom === "string"
            ? options.behaviorsCustom
            : options.behaviorsCustom.map((line) => `${JSON.stringify(line)}\n`).join(""),
          "utf-8",
        );

  const storageBytes =
    options.storageValues === undefined
      ? undefined
      : Buffer.from(
          typeof options.storageValues === "string"
            ? options.storageValues
            : options.storageValues.map((o) => JSON.stringify(o)).join("\n") + "\n",
          "utf-8",
        );

  const defaultResources: DatapackageResource[] = [
    {
      name: "data.warc.gz",
      path: "archive/data.warc.gz",
      hash: sha256Hex(warc.bytes),
      bytes: warc.bytes.byteLength,
    },
    ...indexEntries.map((e) => ({
      name: e.name.split("/").pop() ?? e.name,
      path: e.name,
      hash: sha256Hex(e.bytes),
      bytes: e.bytes.byteLength,
    })),
    {
      name: "pages.jsonl",
      path: "pages/pages.jsonl",
      hash: sha256Hex(pagesBytes),
      bytes: pagesBytes.byteLength,
    },
    {
      name: "fuzzy.json",
      path: "fuzzy.json",
      hash: sha256Hex(fuzzyBytes),
      bytes: fuzzyBytes.byteLength,
    },
    ...(storageBytes === undefined
      ? []
      : [
          {
            name: "origins.jsonl",
            path: "storage/origins.jsonl",
            hash: sha256Hex(storageBytes),
            bytes: storageBytes.byteLength,
          },
        ]),
    ...(axtreeBytes === undefined
      ? []
      : [
          {
            name: "axtree.jsonl",
            path: "accessibility/axtree.jsonl",
            hash: sha256Hex(axtreeBytes),
            bytes: axtreeBytes.byteLength,
          },
        ]),
    ...(behaviorsCustomBytes === undefined
      ? []
      : [
          {
            name: "custom.jsonl",
            path: "behaviors/custom.jsonl",
            hash: sha256Hex(behaviorsCustomBytes),
            bytes: behaviorsCustomBytes.byteLength,
          },
        ]),
  ];

  // omit 指定された MUST ファイルは resources 宣言からも落とす(実体と宣言を一致)。
  const declaredDefaults = defaultResources.filter(
    (r) =>
      !(options.omitArchive === true && r.path.startsWith("archive/")) &&
      !(options.omitIndexes === true && r.path.startsWith("indexes/")) &&
      !(options.omitPages === true && r.path === "pages/pages.jsonl"),
  );

  const resources = options.mutateResources
    ? options.mutateResources(declaredDefaults)
    : declaredDefaults;

  const datapackage: Record<string, unknown> = {
    // `$schema` は慣例どおり先頭に置く (JSON Schema 系の descriptor の書式)。
    ...(options.schema !== undefined && { $schema: options.schema }),
    wacz_version: waczVersion,
    name: `wacz-validator-fixture-${taskId}`,
    software,
    created: capturedAt,
    mainPageURL: options.mainPageUrlOverride ?? pageUrl,
    mainPageDate: capturedAt,
    title: pageTitle,
    resources,
  };
  if (options.profile !== null) {
    datapackage["profile"] = options.profile ?? "data-package";
  }
  if (options.tls !== undefined) {
    datapackage["browserhive:capture"] = { tls: options.tls };
  }
  if (options.storage !== undefined) {
    const capture = (datapackage["browserhive:capture"] ?? {}) as Record<string, unknown>;
    capture["storage"] = options.storage;
    datapackage["browserhive:capture"] = capture;
  }
  if (options.settings !== undefined) {
    const capture = (datapackage["browserhive:capture"] ?? {}) as Record<string, unknown>;
    capture["settings"] = options.settings;
    datapackage["browserhive:capture"] = capture;
  }
  if (options.dismissal !== undefined) {
    const capture = (datapackage["browserhive:capture"] ?? {}) as Record<string, unknown>;
    capture["dismissal"] = options.dismissal;
    datapackage["browserhive:capture"] = capture;
  }
  if (options.settle !== undefined) {
    const capture = (datapackage["browserhive:capture"] ?? {}) as Record<string, unknown>;
    capture["settle"] = options.settle;
    datapackage["browserhive:capture"] = capture;
  }
  const datapackageBytes = Buffer.from(`${JSON.stringify(datapackage, null, 2)}\n`, "utf-8");

  // `archiver` を Buffer-collecting な Writable に pipe してメモリ上
  // で ZIP を組み立てる。tmp ファイルに書いてから読む方式ではなく
  // こうしているのは、test を hermetic に保つため — ケース間で
  // ファイルシステム状態が残らない。
  const chunks: Buffer[] = [];
  const collector = new Writable({
    write(chunk: Buffer, _enc, cb): void {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });

  const zip = new ZipArchive({ zlib: { level: 6 } });
  const finished = new Promise<void>((resolveFinished, rejectFinished) => {
    collector.on("finish", () => {
      resolveFinished();
    });
    collector.on("error", rejectFinished);
    zip.on("error", rejectFinished);
    zip.on("warning", rejectFinished);
  });

  zip.pipe(collector);

  // 内側の warc.gz はデフォルトで STORE (既に gzip 済み — 二重圧縮
  // するとサイズが膨らむだけ)。`warcDeflate` で DEFLATE に切り替えて
  // rule #6 を動かす。
  if (!(options.omitArchive ?? false)) {
    // 既定は archive/data.warc.gz(gzip 内容に正しい拡張子)。
    // warcExtensionMismatch で gzip 内容のまま `.warc` 名にし、G1 を踏ませる。
    zip.append(warc.bytes, {
      name: options.warcExtensionMismatch === true ? "archive/data.warc" : "archive/data.warc.gz",
      store: !(options.warcDeflate ?? false),
      date: entryDate,
    });
  }
  if (!(options.omitIndexes ?? false)) {
    for (const entry of indexEntries) {
      zip.append(entry.bytes, { name: entry.name, date: entryDate });
    }
  }
  if (!(options.omitPages ?? false)) {
    zip.append(pagesBytes, { name: "pages/pages.jsonl", date: entryDate });
  }
  zip.append(fuzzyBytes, { name: "fuzzy.json", date: entryDate });
  if (storageBytes !== undefined) {
    zip.append(storageBytes, { name: "storage/origins.jsonl", date: entryDate });
  }
  if (behaviorsCustomBytes !== undefined) {
    zip.append(behaviorsCustomBytes, { name: "behaviors/custom.jsonl", date: entryDate });
  }
  if (axtreeBytes !== undefined) {
    zip.append(axtreeBytes, { name: "accessibility/axtree.jsonl", date: entryDate });
  }
  if (!options.omitDatapackage) {
    zip.append(datapackageBytes, { name: "datapackage.json", date: entryDate });
  }

  // §5.2.5 datapackage-digest.json — 既定で datapackage.json の正しい sha256 を
  // 同梱し、黄金が datapackage/digest を pass するようにする。"absent" で省略、
  // "bad-hash" で誤った hash を入れて rule を踏ませる。
  if (options.digest !== "absent") {
    const dpHash =
      options.digest === "bad-hash" ? `sha256:${"0".repeat(64)}` : sha256Hex(datapackageBytes);
    const digestBytes = Buffer.from(
      `${JSON.stringify(
        {
          path: "datapackage.json",
          hash: dpHash,
          ...(options.signedData !== undefined && { signedData: options.signedData }),
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    zip.append(digestBytes, { name: "datapackage-digest.json", date: entryDate });
  }

  // G4: 予約ディレクトリ archive/ への異物。
  if (options.reservedDirExtraFile === true) {
    zip.append(Buffer.from("stray\n", "utf-8"), { name: "archive/notes.txt", date: entryDate });
  }
  // G5: resources に未宣言の孤児ファイル。
  if (options.orphanFile === true) {
    zip.append(Buffer.from("orphan\n", "utf-8"), { name: "extra.bin", date: entryDate });
  }

  await zip.finalize();
  await finished;

  return { bytes: Buffer.concat(chunks), warcRecords: warc.records };
};

/** 便利関数: WACZ を組み立ててディスクに書き出す。 */
export const buildWaczToFile = async (
  path: string,
  options: FixtureOptions = {},
): Promise<void> => {
  const { bytes } = await buildWacz(options);
  await writeFile(path, bytes);
};
