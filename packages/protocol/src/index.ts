/**
 * wacz-validator daemon protocol — tui / daemon / browser の画面が共有する契約。
 *
 * 大半は型(`import type` で core を参照するが runtime には残らない)。加えて
 * クライアントが validation engine を引き込まずに済むよう、軽量な CLI 契約
 * (profile/locale 定数・`exitCodeFor`・`CliOutcome`)も通す — 実体は
 * `@wacz-validator/contract` に在り、あちらは何も import しない葉 package なので
 * browser でも安全に bundle できる。
 *
 * daemon が validation を所有し、i18n は `renderJson(report, locale)` で解決して
 * {@link WireReport} を返すので、クライアントはカタログ不要の薄い表示器でよい。
 *
 * 案1(URI 参照渡し・stateless): 各リクエストが `source.uri` を運び、
 * daemon は open → 読む → close するだけで状態を持たない。
 *
 * WACZ の中身は**窓**で返す —— 行の窓 ({@link ReadLinesParams})、1 行を丸ごと
 * ({@link ReadLineParams})、WARC のレコードの一覧 ({@link ReadRecordsParams})、
 * 1 レコード ({@link ReadRecordParams})。窓の位置は呼び手が持つ。かつての
 * `readEntry` (丸ごと読んで 64 KiB で切る) は消した —— 大きい WACZ では
 * 索引の 2 割しか見えず、切れた行は割れなかった。
 */
import type {
  Field,
  Issue,
  Report,
  ResolvedDocLink,
  WarcHeader,
  WarcRecordSummary,
} from "@wacz-validator/core";

// クライアント(tui / browser)が core を直接 import せずに済むよう、表示用の
// 型を protocol から re-export する(すべて型なので runtime には残らない)。
export type {
  AbsolutePath,
  ResolvedDocLink,
  ExpectedBy,
  Field,
  IssueLocation,
  Locale,
  ReportEntry,
  ReportSource,
  ReportStats,
  ReportSummary,
  RuleProfile,
  Severity,
  WarcHeader,
  WarcRecordSummary,
} from "@wacz-validator/core";

/** WACZ の在り処。案1 では URI のみ(`file://` / `s3://` / `https://`)。 */
export interface SourceRef {
  kind: "uri";
  uri: string;
}

export interface ValidateParams {
  source: SourceRef;
  /** rule profile(`spec` / `browserhive` / `lenient`)。未指定は daemon の既定。 */
  profile?: string;
  /** 表示 locale。daemon が renderJson でこの locale に解決する。 */
  locale: string;
  /** s3:// source 用の path-style addressing(SeaweedFS / MinIO 等)。 */
  s3ForcePathStyle?: boolean;
}

// ── 中身の窓 ─────────────────────────────────────────────────────────

/** 行の窓。1 行は daemon の cap (2 KiB) で切り、count は上限 (500) で丸める。 */
export interface ReadLinesParams {
  source: SourceRef;
  path: string;
  /** 0 始まりの行番号。 */
  from: number;
  count: number;
}

export interface WireLine {
  n: number;
  text: string;
  /** cap を超えていて、text は先頭だけ。 */
  cut: boolean;
  /** NUL を含む・UTF-8 でない。text は空で、bytes だけ。 */
  binary: boolean;
  /** 行の本来の長さ(改行を除く)。 */
  bytes: number;
}

export interface ReadLinesResult {
  lines: WireLine[];
  /** 続きの from。null は末尾まで読んだ。 */
  next: number | null;
  /** 中身が gzip だったので展開している(`.warc.gz` 等)。 */
  gunzipped: boolean;
}

/** 1 行を丸ごと(daemon の上限 4 MiB まで)。`fields` は core の `explodeLine` —— 切れた行・binary は割らない([])。 */
export interface ReadLineParams {
  source: SourceRef;
  path: string;
  n: number;
}

export interface ReadLineResult extends WireLine {
  fields: Field[];
  gunzipped: boolean;
}

/** WARC を頭から歩いた一覧。`path` は WARC の entry(`archive/data.warc.gz`)。 */
export interface ReadRecordsParams {
  source: SourceRef;
  path: string;
  from: number;
  count: number;
}

export interface RecordSummary extends WarcRecordSummary {
  /** この WARC を指す索引(CDXJ)に、この offset があるか。無いレコードは索引から辿れない。 */
  indexed: boolean;
}

export interface ReadRecordsResult {
  records: RecordSummary[];
  next: number | null;
  total: number;
}

/** 1 レコード。offset / length は索引の行か、一覧から。 */
export interface ReadRecordParams {
  source: SourceRef;
  path: string;
  offset: number;
  length: number;
}

/**
 * レコードの本文。テキストは文字列、raster の画像は大きさだけ(実体は REST の
 * `POST /record/body`)、それ以外は大きさだけ。文字化けを構造的に防ぐ。
 */
export type RecordBody =
  | { kind: "text"; content: string; truncated: boolean }
  | { kind: "image"; mime: string; byteLength: number }
  | { kind: "binary"; mime?: string; byteLength: number };

export interface ReadRecordResult {
  warc: WarcHeader[];
  /** WARC の Content-Type が application/http のとき、状態行と見出し。 */
  http?: { status: string; headers: WarcHeader[] };
  body: RecordBody;
}

// ── 報告 ─────────────────────────────────────────────────────────────

/** renderJson が解決した issue(`message` / `specUrl` / `conformance` が inline)。 */
export interface WireIssue extends Issue {
  message: string;
  specUrl?: string;
  conformance?: string;
  /** rule の出典(公式ドキュメント)リンク群。renderJson が rule 名で解決。 */
  docs?: readonly ResolvedDocLink[];
}

/** daemon が返す解決済み Report(renderJson 出力に対応)。 */
export interface WireReport extends Omit<Report, "issues"> {
  issues: WireIssue[];
}

export type RpcErrorCode = "openFailed" | "engineFailed" | "badRequest";
export interface RpcError {
  code: RpcErrorCode;
  message: string;
}

// ── WS の枠 ──────────────────────────────────────────────────────────

/** WS のメッセージ枠(相関 id つき request/response。セッション状態は持たない)。 */
export type RpcMethod =
  | "wacz-validator/validate"
  | "wacz-validator/readLines"
  | "wacz-validator/readLine"
  | "wacz-validator/readRecords"
  | "wacz-validator/readRecord"
  | "wacz-validator/ping";

/** wacz-validator/ping は引数を取らない。 */
export type PingParams = Record<string, never>;

/** /healthz と wacz-validator/ping が返す生存ステータス。 */
export interface HealthStatus {
  status: "ok";
  /** build が名乗る版。git のタグから決めて、ビルド時に焼き込み(report の `validatorVersion` と同じ)。 */
  version: string;
  /** 短い git SHA(未コミット変更があれば `-dirty` 付き)。ビルド時に焼き込み。 */
  gitSha: string;
  /** ビルド時刻(ISO8601)。 */
  builtAt: string;
  uptimeSec: number;
}

export type RpcParams =
  | ValidateParams
  | ReadLinesParams
  | ReadLineParams
  | ReadRecordsParams
  | ReadRecordParams
  | PingParams;

export type RpcResult =
  | WireReport
  | ReadLinesResult
  | ReadLineResult
  | ReadRecordsResult
  | ReadRecordResult
  | HealthStatus;

export interface RpcRequest {
  id: number;
  method: RpcMethod;
  params: RpcParams;
}
export interface RpcResponse {
  id: number;
  result?: RpcResult;
  error?: RpcError;
}

// ── CLI 契約 ───────────────────────────────────────────────────────────
// 持ち主は @wacz-validator/contract。あちらは何も import しない葉 package なので、
// ここを経由してもクライアントに validation engine は付いてこない。
//
// 以前はこの節が同じ定義を手で複製していた。型 (`RuleProfile`) は core から
// re-export しつつ値 (`ALL_PROFILES`) だけ複製していたので、core に profile を
// 足しても何もエラーにならず、wacz-validator-validate は受理するのに wacz-validator は
// 拒否する、という食い違いが型検査も全 test も緑のまま成立していた。

export {
  ALL_PROFILES,
  DEFAULT_PROFILE,
  DEFAULT_SELECTOR,
  SUPPORTED_LOCALES,
  describeCause,
  exitCodeFor,
  formatProfileSelector,
  parseProfileSelector,
} from "@wacz-validator/contract";
export type { CliOutcome, ProfileSelector, SemVer } from "@wacz-validator/contract";
