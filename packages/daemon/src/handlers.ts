/**
 * daemon のハンドラ — core を所有する stateless な検証ロジック。
 *
 * 各ハンドラは source URI を開いて操作し、必ず close する(状態を残さない)。
 * `WaczReader` は range read なので、毎回 open しても全体を読み直さず安い。
 * i18n は `renderJson(report, locale)` で解決して {@link WireReport} を返す。
 */
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SELECTOR,
  describeCause,
  parseProfileSelector,
  type ProfileSelector,
} from "@wacz-validator/contract";
import {
  DEFAULT_RULES,
  WaczReader,
  fileTransport,
  parseReportSource,
  renderJson,
  resolveLocale,
  runValidation,
  httpTransport,
  s3Transport,
  type ReportSource,
} from "@wacz-validator/core";
import type {
  ReadEntryParams,
  ReadEntryResult,
  RpcErrorCode,
  ValidateParams,
  WireReport,
} from "@wacz-validator/protocol";
import { BUILD_INFO } from "./generated/build-info.js";
import { previewEntry } from "./entry-preview.js";

/** content プレビューの上限(byte 相当)。これを超えたら truncated。 */
const PREVIEW_CAP = 64 * 1024;

/** RpcError に map できる、コード付きの daemon エラー。 */
export class DaemonError extends Error {
  readonly code: RpcErrorCode;
  constructor(code: RpcErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "DaemonError";
  }
}

/**
 * wire の source URI を検証済み ReportSource に parse する(file:// 変換はここに集約)。
 * file:// は絶対パスへ、s3:// / http(s):// / 絶対パスはそのまま parseReportSource に
 * 渡し、ブランド付き AbsolutePath / S3Uri / HttpUrl を得る。
 * 推論戻り値は Result<ReportSource, ParseSourceError>。
 */
const parseSourceUri = (wireUri: string) =>
  parseReportSource(wireUri.startsWith("file://") ? fileURLToPath(wireUri) : wireUri);

/** 検証済み・判別済み・brand 済の source を開くだけ(失敗は I/O のみ openFailed に正規化)。 */
const openFromSource = async (
  source: ReportSource,
  s3ForcePathStyle: boolean,
): Promise<WaczReader> => {
  try {
    // **switch で書く。** ReportSource に variant が増えたとき、三項の連鎖は
    // 黙って「最後の枝」に落ちるが、switch は網羅性検査で止まる。
    switch (source.kind) {
      case "s3":
        return await WaczReader.open(
          s3Transport({ ...source, forcePathStyle: s3ForcePathStyle }),
        );
      case "http":
        // **署名つきの URL がそのまま来る。** transport が identity に剥がすので、
        // report にも wire error にも query は出ない。
        return await WaczReader.open(httpTransport({ url: source.url }));
      case "file":
        return await WaczReader.open(fileTransport(source.path));
    }
  } catch (cause) {
    // ここが wire に載る文字列を決める最上流。ここで捨てた情報は、受け手
    // (tui) では二度と復元できない — 向こうに届くのは string だけ。
    throw new DaemonError("openFailed", describeCause(cause));
  }
};

/**
 * wire の `profile` 文字列を selector に。
 *
 * 未知の値を**既定に落とさない**のが要点 — 以前はここが `undefined` を
 * 返し、`runValidation` が黙って `spec` を使っていた。クライアントは
 * 自分の指定が無視されたことに気づけなかった。
 */
const toSelector = (profile: string | undefined): ProfileSelector => {
  if (profile === undefined) return DEFAULT_SELECTOR;
  const selector = parseProfileSelector(profile);
  if (selector === null) throw new DaemonError("badRequest", `unknown profile: ${profile}`);
  return selector;
};

/** WACZ を検証し、解決済みの WireReport を返す(stateless)。 */
export const validate = async (params: ValidateParams): Promise<WireReport> => {
  const locale = resolveLocale(params.locale);
  const profile = toSelector(params.profile);
  const parsed = parseSourceUri(params.source.uri);
  if (!parsed.ok) throw new DaemonError("openFailed", parsed.error.kind);
  const reader = await openFromSource(parsed.value, params.s3ForcePathStyle ?? false);
  try {
    const result = await runValidation(reader, {
      validatorVersion: BUILD_INFO.version,
      rules: DEFAULT_RULES,
      profile,
    });
    if (!result.ok) throw new DaemonError("engineFailed", "validation engine failed");
    return JSON.parse(renderJson(result.value, locale)) as WireReport;
  } finally {
    await reader.close();
  }
};

/** 1 エントリの内容を上限つきで返す(stateless・range read)。 */
export const readEntry = async (params: ReadEntryParams): Promise<ReadEntryResult> => {
  const parsed = parseSourceUri(params.source.uri);
  if (!parsed.ok) throw new DaemonError("openFailed", parsed.error.kind);
  const reader = await openFromSource(parsed.value, false);
  try {
    const buf = await reader.readEntry(params.path);
    if (!buf) return { kind: "text", content: "", truncated: false, gunzipped: false };
    return await previewEntry(params.path, buf, PREVIEW_CAP);
  } finally {
    await reader.close();
  }
};
