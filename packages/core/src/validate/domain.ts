/**
 * Validation ドメイン型。
 *
 * 各 rule は `Issue[]` を生成する。engine は rule ごとの出力を 1 つの
 * `Report` にマージする。HTTP / CLI / TUI の rendering 層は `Report`
 * しか消費しないので、新しい rule を加える際は `ValidationRule` を
 * export して registry に追加するだけでよく、他の層に変更は要らない。
 *
 * wire format (`Report`) は `--json` が出力するもので、`docs/json-schema.md`
 * が公開 schema として pin している (0.x line 中安定)。future-proofing
 * のための note:
 *   - `validatorVersion` によって downstream consumer が schema の drift
 *     を検出できる。
 *   - `summary.durationMs` を最初から入れることで、CI dashboard が
 *     コストの regression を trend として追える。
 *   - `Issue.details` は意図的に `unknown` — rule が hash diff、hex
 *     dump などを付ける。renderer は rule ごとに整形し、JSON schema
 *     としては "serialise 可能なら何でも"。
 */
import { isAbsolute, resolve as resolvePath } from "node:path";
import type { Locale } from "@wacz-validator/contract";
import type { MsgParams } from "../i18n/translate.js";
import { err, ok, type Result } from "../result.js";
import type { WaczReader } from "../wacz/reader.js";

export type Severity = "error" | "warning" | "info";

/**
 * spec の規範レベル(RFC 2119)。`Severity`(wacz-validator の影響判断・profile 依存)
 * とは直交する別軸で、spec が定める要件の強さを表す(profile 非依存)。
 */
export type Conformance = "MUST" | "MUST NOT" | "SHOULD" | "SHOULD NOT" | "MAY";

/**
 * Rule セットの selector。profile を選ぶと producer 固有な rule
 * (例: `cdxj/index-not-gzipped`) の severity が組み替えられるが、
 * spec が要求する check を silent にすることはない。デフォルトは
 * `spec`。
 *
 * - `spec` — WACZ spec + wabac.js loader 互換。デフォルトで、
 *   ほとんどの consumer が望む形。
 * - `browserhive` — `spec` の上に BrowserHive の producer 慣習を
 *   重ねる (例: plain な `indexes/index.cdxj` を要求、`.idx` と
 *   ペアでも `index.cdxj.gz` は許さない、など)。
 * - `lenient` — producer 固有 / 様式的な指摘をすべて `info` に
 *   降格させる。legacy archive をトリアージしていて "replay 破損"
 *   系の hard error だけを見たいときに便利。
 */
// 定義の持ち主は @wacz-validator/contract。engine も i18n も読まない葉 package に
// 置いてあるので、browser 側 (@wacz-validator/protocol 経由) が core を引き込まずに
// 同じ値を使える。ここは従来どおりの import 経路を保つための re-export。
import { ALL_PROFILES, type RuleProfile } from "@wacz-validator/contract";

export { ALL_PROFILES };
export type { RuleProfile };

/**
 * 各 rule が profile にどう反応するか。`severityByProfile` を使うと、
 * registry には 1 度だけ rule を置きつつ severity を調整できる。
 * `excludeProfiles` はその profile で rule を完全に silence する (まれ
 * — ある producer の慣習を離れると意味を持たない check で使う)。
 */
export interface RuleApplicability {
  /**
   * profile 別・messageKey 別の severity 上書き。
   *
   * **列挙した issue だけが書き換わる。** 書かなかった issue は rule が
   * push した severity のまま。
   *
   * 以前は profile ごとに severity を 1 つ書き、engine が「issue の
   * severity が rule のベースラインと一致するか」で対象を選んでいた。
   * あれは「作者にこだわりが無い」ことを値の一致で*推測*していたので、
   * 宣言を読んでも挙動が分からず、意図的にベースラインと同じ severity に
   * した issue も書き換わってしまった。ここでは推測せず対象を列挙する。
   */
  severityByProfile?: Partial<Record<RuleProfile, Record<string, Severity>>>;
  /** その profile で rule を完全に skip する (issue を 1 件も出さない)。 */
  excludeProfiles?: readonly RuleProfile[];
  /**
   * profile 別・**producer のバージョン範囲**。この rule が正しく判定できると
   * 分かっているバージョンを宣言する。
   *
   * selector がバージョンを名乗り (`--profile browserhive@1.10.0`)、それが範囲外
   * なら rule は走らず、その事実が `Report.skipped` に残る。**黙って
   * 消さない**のが要点 — 落ちた rule が見えないと、報告が「問題なし」
   * なのか「見ていない」なのか読者に区別できない。
   *
   * selector がバージョンを名乗らなければ範囲は見ない (＝ 従来どおり走る)。
   * 既定をそちらに置いているので、バージョンを書かない呼び出しの挙動は変わらない。
   *
   * 範囲式は `@wacz-validator/contract` の最小部分集合 (`>=x.y.z` / `<x.y.z` と
   * 空白区切りの AND)。解せない式は engine 実行時に throw する。
   */
  profileVersions?: Partial<Record<RuleProfile, string>>;
}

export interface IssueLocation {
  /** 問題が見つかった ZIP entry 名 (該当する場合)。 */
  entry?: string;
  /** text entry (CDXJ、pages.jsonl) 内の 1-based 行番号。 */
  line?: number;
  /** binary entry (WARC) 内の byte offset。 */
  offset?: number;
}

export interface Issue {
  /**
   * `<area>/<short-name>` 形式の安定した rule identifier。localise しない;
   * バージョン間で書式を変えない。
   */
  rule: string;
  severity: Severity;
  /**
   * メッセージの i18n キー(`<rule>/<short>`)。renderer が locale 別の
   * ICU カタログで解決する。human-readable な prose は core に持たない。
   */
  messageKey: string;
  /** メッセージに差し込むランタイム値(path・行番号・理由など)。 */
  params?: MsgParams;
  location?: IssueLocation;
  /**
   * renderer が必要に応じて expand できる structured payload。
   * JSON-serialisable に保つ (number、string、plain object、array)。
   * TUI (M2+) は "expand" キーでこれを描画し、JSON renderer は
   * そのまま round-trip する。
   */
  details?: unknown;
}

/**
 * rule が依拠する spec へのリンク。
 *
 * `url` は locale ごとに持てる。`en` を型で必須にしているのは、翻訳が
 * 無い spec (Frictionless / WARC) でも必ず 1 本は解決できるようにするため。
 * 書かれていない locale は `en` に落ちる。
 *
 * WACZ には和訳 (uraitakahito.github.io/specs) があり、**アンカーは本家と
 * 同じ**。和訳が見出しを英語のまま残しており、ReSpec がそこから id を
 * 生成するため — つまり base を差し替えるだけで ja の URL が作れる。
 */
export interface DocLink {
  label: string;
  url: { en: string } & Partial<Record<Locale, string>>;
}

/**
 * locale を 1 つ選んだあとの形。report に出るのはこちらで、`renderJson` が
 * message と同じタイミングで解決する。consumer は 1 本の URL しか見ない。
 */
export interface ResolvedDocLink {
  label: string;
  url: string;
}

export interface ValidationRule {
  /** `Issue.rule` に入るのと同じ値。 */
  name: string;
  /** rationale の i18n キー(`<rule>/desc`)。locale 別カタログで解決。 */
  descriptionKey: string;
  /**
   * spec の規範レベル(RFC 2119)。severity と独立で profile に依存しない —
   * 「spec が MUST と言っているか SHOULD か」を表す。renderer が rule 名から
   * 解決して表示する({@link Conformance})。
   */
  conformance: Conformance;
  /**
   * この rule が依拠する spec。**必須** — 出典の無い指摘は読者が裏を取れない。
   * 1 rule が複数 spec を跨ぐことがある (例 `datapackage/frictionless-structure`
   * は Data Package と Data Resource の両方)。
   */
  docs: readonly DocLink[];
  /**
   * profile 別の override。省略時は、rule が全 profile で baseline
   * severity のまま適用される。
   */
  applicability?: RuleApplicability;
  run: (wacz: WaczReader) => Promise<Result<Issue[], never>>;
}

// #region report-summary
export interface ReportSummary {
  passed: number;
  failed: number;
  warnings: number;
  info: number;
  durationMs: number;
}

/**
 * report を評価した profile。engine の `ProfileSelector` を wire 向けに写す。
 *
 * **バージョンは文字列で出す。** engine 内部の `SemVer` は `{ major, minor, patch }`
 * の三つ組だが、あれは parse の中間結果であって、報告を読む人が欲しいのは
 * `"2.1.0"` のほう。同じ report にある {@link SkippedRule} の `range`
 * (`">=1.11.0"`) とも並びが揃う。
 *
 * `version` は**操作者が名乗った producer のバージョン**で、archive と照合した
 * ものではない (`datapackage.json` の `software` は読んでいない)。
 */
export interface ReportProfile {
  name: RuleProfile;
  /** 未指定なら **key ごと出ない**。「バージョンを問わない」の意。 */
  version?: string;
}

/**
 * producer のバージョンが合わずに走らせなかった rule。
 *
 * `Report.skipped` は該当が 1 件も無ければ **key ごと出力されない**
 * (`stats` と同じ条件付き spread)。だからバージョンを指定しない実行の JSON は
 * 従来と 1 バイトも変わらない。
 */
export interface SkippedRule {
  rule: string;
  reason: "profile-version";
  /** rule が要求した範囲 (例 `">=1.11.0"`)。 */
  range: string;
  // 名乗られたバージョンはここには書かない。全エントリで同じ値になる複製で、
  // `Report.profile.version` から機械的に取れる。
}
// #endregion report-summary

/**
 * WACZ に関する人向けには有用だが issue モデルには馴染まない
 * informational な metadata — record 数、distinct な host 数など。
 * Renderer は summary 行の下にこれを表示する。engine が best-effort
 * で計算するため optional: WARC が壊れていても stats を取りに行く
 * ために report を block することはしない。
 */
export interface ReportStats {
  /** WARC iterator が yield した独立 gzip member 数。 */
  warcRecordCount: number;
  /** `archive/data.warc.gz` の byte 長 (ZIP 解凍後)。 */
  warcArchiveBytes: number;
  /** CDXJ entry の `url` field に現れる distinct な host。 */
  hosts: string[];
}

/**
 * 検証対象 WACZ の identity。`Report.source` および `WaczReader.source`
 * の wire format。
 *
 * `kind: "file"` は絶対パス、`kind: "s3"` は `s3://bucket/key` URI を
 * 表す。Brand 型 `AbsolutePath` / `S3Uri` を経由しないと構築できない
 * ので、relative path や malformed URI を Report に embed することは
 * compile / runtime のどちらでも防げる。
 */
declare const AbsolutePathBrand: unique symbol;
export type AbsolutePath = string & { readonly [AbsolutePathBrand]: true };

/**
 * parseReportSource / parseAbsolutePath / parseS3Uri が err variant
 * として返す失敗の集合。 caller (cli.ts) は kind で switch して
 * 種別ごとに message を組み立てる。 新しい transport (例: HTTP) を
 * 加えるときは ここに variant を 1 つ追加し、 formatParseSourceError
 * の switch が網羅性 chk で未対応に倒れる仕組みを利用する。
 */
export type ParseSourceError =
  | { kind: "invalid-s3-uri"; raw: string }
  | { kind: "not-absolute-path"; raw: string }
  | { kind: "invalid-http-url"; raw: string };

export const parseAbsolutePath = (
  raw: string,
): Result<AbsolutePath, ParseSourceError> => {
  const absolute = resolvePath(raw);
  if (!isAbsolute(absolute)) {
    return err({ kind: "not-absolute-path", raw });
  }
  return ok(absolute as AbsolutePath);
};

declare const S3UriBrand: unique symbol;
export type S3Uri = string & { readonly [S3UriBrand]: true };

const S3_URI_RE = /^s3:\/\/([^/]+)\/(.+)$/;

export const parseS3Uri = (raw: string): Result<S3Uri, ParseSourceError> => {
  if (!S3_URI_RE.test(raw)) {
    return err({ kind: "invalid-s3-uri", raw });
  }
  return ok(raw as S3Uri);
};

declare const HttpUrlBrand: unique symbol;
export type HttpUrl = string & { readonly [HttpUrlBrand]: true };

/**
 * `http(s)://` の WACZ を指す URL。**query を持ったまま brand する** —— 署名付き
 * URL (`?X-Amz-Signature=…`) をそのまま開けることが、この transport の用途だから。
 *
 * wire に載せるときは query を落とす ({@link stripUrlQuery})。署名は資格情報であって
 * identity ではなく、`Report.source` は画面にも JSON にも出る。
 */
export const parseHttpUrl = (raw: string): Result<HttpUrl, ParseSourceError> => {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return err({ kind: "invalid-http-url", raw });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return err({ kind: "invalid-http-url", raw });
  }
  return ok(raw as HttpUrl);
};

/**
 * 報告に載せる形へ落とす。**query を捨てる。**
 *
 * 署名付き URL の query には `X-Amz-Signature` が入っている。`Report.source` は
 * wire format なので、そのまま載せると報告を見られる相手が object を読めてしまう ——
 * 期限内であれば誰でも。identity として要るのは「どこの何か」だけ。
 */
export const stripUrlQuery = (url: HttpUrl): HttpUrl => {
  const parsed = new URL(url);
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString() as HttpUrl;
};

export const s3UriToBucketKey = (uri: S3Uri): { bucket: string; key: string } => {
  const m = S3_URI_RE.exec(uri);
  // parseS3Uri を通過しているので必ず match する。
  if (!m?.[1] || !m[2]) throw new Error("unreachable: malformed S3Uri reached s3UriToBucketKey");
  return { bucket: m[1], key: m[2] };
};

/** Local file の WACZ source。`path` は絶対パス (AbsolutePath brand 済)。 */
export interface FileSource {
  kind: "file";
  path: AbsolutePath;
}

/** S3 上の WACZ source。`uri` は `s3://bucket/key` (S3Uri brand 済)。 */
export interface S3Source {
  kind: "s3";
  uri: S3Uri;
}

/**
 * http(s) 上の WACZ source。`url` は **query を落としたもの** ——
 * 実際に叩く URL (署名つきでありうる) は runtime だけが持つ
 * (`ResolvedHttpSource`)。理由は {@link stripUrlQuery}。
 */
export interface HttpSource {
  kind: "http";
  url: HttpUrl;
}

/**
 * 検証対象 WACZ の identity。`Report.source` / `WaczReader.source` の
 * wire format。transport ごとの variant は {@link FileSource} / {@link S3Source} /
 * {@link HttpSource}。
 */
export type ReportSource = FileSource | S3Source | HttpSource;

export const parseReportSource = (
  raw: string,
): Result<ReportSource, ParseSourceError> => {
  if (raw.startsWith("s3://")) {
    const u = parseS3Uri(raw);
    if (!u.ok) return u;
    return ok({ kind: "s3", uri: u.value });
  }
  // **絶対パスの判定より前に置く。** 後ろに置くと `http://…` は
  // `parseAbsolutePath` に落ち、cwd からの相対パスとして解決されて
  // `ENOENT: … /wacz-validator/http:/127.0.0.1:8333/…` になる (実測)。
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    const u = parseHttpUrl(raw);
    if (!u.ok) return u;
    return ok({ kind: "http", url: u.value });
  }
  const p = parseAbsolutePath(raw);
  if (!p.ok) return p;
  return ok({ kind: "file", path: p.value });
};

/**
 * `ParseSourceError` を 1 行 message に変換する。 cli.ts (core / tui
 * 両方) が `CliOutcome.openFailed` の cause 用に呼ぶ。 switch が
 * exhaustive chk を発火するので、 `ParseSourceError` union に variant
 * を加えると ここで compile error が出て対応漏れを catch できる。
 */
export const formatParseSourceError = (e: ParseSourceError): string => {
  switch (e.kind) {
    case "invalid-s3-uri":
      return `invalid s3:// URI: ${e.raw}`;
    case "not-absolute-path":
      return `expected absolute path, got: ${e.raw}`;
    case "invalid-http-url":
      return `invalid http(s) URL: ${e.raw}`;
  }
};

/**
 * WACZ 内の 1 ファイル(ZIP エントリ)の一覧用レコード。renderer は
 * これを §5.1 風のディレクトリツリーに組み直し、issue を file に重ねて
 * 表示する。flat に持つことで JSON consumer がそのまま扱える。
 *
 * `present: false` は「期待されるが ZIP に実在しない」file を表す。
 * 「なぜ期待されるか」は {@link ReportEntry.expectedBy} が持つ — datapackage の
 * 宣言由来か、WACZ §5.2 の MUST 由来か。その場合 size / 圧縮は無い。
 */

/**
 * ReportEntry が「あるべき」とされる理由。
 *   - `"datapackage"`: datapackage.json の `resources[].path` に宣言されている。
 *   - `"wacz-spec"`: WACZ §5.2 が MUST とする(datapackage.json / pages/pages.jsonl /
 *     archive/ の WARC / indexes/ の index)。
 * 両方に該当することもある。空配列 = ZIP に実在するだけで、特に「期待」はされていない。
 */
export type ExpectedBy = "datapackage" | "wacz-spec";

export interface ReportEntry {
  /** ZIP エントリ path。例: `archive/data.warc.gz`。 */
  path: string;
  /** ZIP に実在するか。false = 期待されるが実在しない(欠落)。 */
  present: boolean;
  /** 解凍後のバイト数(present のみ)。 */
  uncompressedSize?: number;
  /** ZIP の圧縮方式(0=STORE / 8=DEFLATE)(present のみ)。 */
  compressionMethod?: number;
  /** なぜ「あるべき」か。{@link ExpectedBy} を参照。空 = 実在するだけ。 */
  expectedBy: ExpectedBy[];
  /**
   * wacz-spec 由来のとき、その spec 小節(§5.2.x)。path から `sectionForSpecPath`
   * で導出した値で、renderer が「§5.2.1」のように精密表示するのに使う。
   * §5.2 の対象外 path では undefined。
   */
  expectedSection?: string;
  /** この path を `location.entry` に持つ issue(rule + severity)。 */
  issues: { rule: string; severity: Severity }[];
}

// #region report
export interface Report {
  /**
   * この report を作った build の版。CLI と daemon は、build したときに git のタグから
   * 決めた版を渡す —— タグの上なら `0.31.0`、その先なら `0.31.0+3.gabcdef1`、未コミットの
   * 変更があれば `dirty` が付き、タグが見えなければ `unknown`。
   */
  validatorVersion: string;
  /** report を評価した profile。{@link ReportProfile} を参照。 */
  profile: ReportProfile;
  /** validate された WACZ の identity。{@link ReportSource} を参照。 */
  source: ReportSource;
  summary: ReportSummary;
  issues: Issue[];
  /** WACZ 内のファイル一覧 + 検証の紐付け。{@link ReportEntry} を参照。 */
  entries: ReportEntry[];
  /** best-effort な metadata — {@link ReportStats} を参照。 */
  stats?: ReportStats;
  /**
   * producer のバージョンが合わず走らせなかった rule。**該当が無ければ key ごと
   * 出ない** — {@link SkippedRule} を参照。
   */
  skipped?: readonly SkippedRule[];
}
// #endregion report
