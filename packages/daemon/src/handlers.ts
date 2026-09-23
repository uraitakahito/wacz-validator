/**
 * daemon のハンドラ — core を所有する stateless な検証ロジック。
 *
 * 各ハンドラは source URI を開いて操作し、必ず close する(状態を残さない)。
 * `WaczReader` は range read なので、毎回 open しても全体を読み直さず安い
 * (http は末尾を 1 往復で取り、その内側の読みは往復しない)。
 * i18n は `renderJson(report, locale)` で解決して {@link WireReport} を返す。
 *
 * 中身は**窓**で返す。呼び手が範囲を決め、daemon は要る分だけ読む —— 行の窓は
 * 流す読みで要る行まで、1 レコードは索引の offset / length で 1 メンバだけ。
 */
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  DEFAULT_SELECTOR,
  describeCause,
  parseProfileSelector,
  type ProfileSelector,
} from "@wacz-validator/contract";
import {
  DEFAULT_RULES,
  WaczReader,
  explodeLine,
  fileTransport,
  httpHeader,
  httpTransport,
  iterateWarcMembers,
  mimeOf,
  parseCdxj,
  parseRecord,
  parseReportSource,
  renderJson,
  resolveLocale,
  runValidation,
  s3Transport,
  summarizeMember,
  type ParsedRecord,
  type ReportSource,
} from "@wacz-validator/core";
import type {
  ReadLineParams,
  ReadLineResult,
  ReadLinesParams,
  ReadLinesResult,
  ReadRecordParams,
  ReadRecordResult,
  ReadRecordsParams,
  ReadRecordsResult,
  RecordSummary,
  RpcErrorCode,
  ValidateParams,
  WireLine,
  WireReport,
} from "@wacz-validator/protocol";
import { BUILD_INFO } from "./generated/build-info.js";
import { RASTER, classifyBody, gunzipCapped, isGzip } from "./record-body.js";

/** 行の窓の 1 行の上限。一覧に出す分なので、長い行は先頭だけ。 */
const LINE_CAP = 2 * 1024;
/** 1 行を丸ごと返すときの上限。BrowserHive の axtree.jsonl は 1 行 400 KB を超える。 */
const LINE_MAX = 4 * 1024 * 1024;
/** 行の窓の count の上限。 */
const LINES_MAX = 500;
/** レコードの一覧の count の上限。 */
const RECORDS_MAX = 1000;
/** レコードの本文をテキストとして返す上限。 */
const TEXT_CAP = 64 * 1024;
/** 1 メンバを展開する上限 (画像の実体もここまで)。 */
const BODY_MAX = 8 * 1024 * 1024;

/** RpcError に map できる、コード付きの daemon エラー。 */
export class DaemonError extends Error {
  readonly code: RpcErrorCode;
  constructor(code: RpcErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "DaemonError";
  }
}

/** `/record/body` が raster でない本文を頼まれたとき。REST は 415 で返す。 */
export class NotRasterError extends DaemonError {
  constructor(mime: string | undefined) {
    super("badRequest", `not a raster image: ${mime ?? "(no content-type)"}`);
    this.name = "NotRasterError";
  }
}

/**
 * wire の source URI を検証済み ReportSource に parse する(file:// 変換はここに集約)。
 * file:// は絶対パスへ、s3:// / http(s):// / 絶対パスはそのまま parseReportSource に
 * 渡し、ブランド付き AbsolutePath / S3Uri / HttpUrl を得る。
 */
const parseSourceUri = (wireUri: string): ReportSource => {
  const parsed = parseReportSource(wireUri.startsWith("file://") ? fileURLToPath(wireUri) : wireUri);
  if (!parsed.ok) throw new DaemonError("openFailed", parsed.error.kind);
  return parsed.value;
};

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

/** source を開いて f を走らせ、必ず閉じる。窓の口はどれもこの形。 */
const withReader = async <T>(uri: string, f: (reader: WaczReader) => Promise<T>): Promise<T> => {
  const reader = await openFromSource(parseSourceUri(uri), false);
  try {
    return await f(reader);
  } finally {
    await reader.close();
  }
};

// ── 引数の検査。REST では JSON がそのまま来るので、型は信じない ──────────
const requirePath = (path: unknown): string => {
  if (typeof path !== "string" || path === "") throw new DaemonError("badRequest", "path is required");
  return path;
};

const requireInt = (value: unknown, name: string, min: number): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw new DaemonError("badRequest", `${name} must be an integer >= ${String(min)}`);
  }
  return value;
};

const clampCount = (count: number, max: number): number => Math.min(count, max);

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
  const reader = await openFromSource(parseSourceUri(params.source.uri), params.s3ForcePathStyle ?? false);
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

/** 行の窓。要る行まで流し、1 行余分に読んで「続きがあるか」を知る。 */
export const readLines = async (params: ReadLinesParams): Promise<ReadLinesResult> => {
  const path = requirePath(params.path);
  const from = requireInt(params.from, "from", 0);
  const count = clampCount(requireInt(params.count, "count", 1), LINES_MAX);
  return withReader(params.source.uri, async (reader) => {
    const stream = await reader.openLines(path, LINE_CAP);
    if (stream === undefined) throw new DaemonError("badRequest", `no entry: ${path}`);
    const lines: WireLine[] = [];
    let next: number | null = null;
    let n = 0;
    for await (const line of stream.lines) {
      if (n >= from) {
        if (lines.length === count) {
          next = n;
          break;
        }
        lines.push({ n, ...line });
      }
      n++;
    }
    return { lines, next, gunzipped: stream.gunzipped };
  });
};

/** 1 行を丸ごと。切れた行・binary は割らない (fields は空)。 */
export const readLine = async (params: ReadLineParams): Promise<ReadLineResult> => {
  const path = requirePath(params.path);
  const n = requireInt(params.n, "n", 0);
  return withReader(params.source.uri, async (reader) => {
    const stream = await reader.openLines(path, LINE_MAX);
    if (stream === undefined) throw new DaemonError("badRequest", `no entry: ${path}`);
    let i = 0;
    for await (const line of stream.lines) {
      if (i === n) {
        return {
          n,
          ...line,
          fields: line.cut || line.binary ? [] : explodeLine(line.text),
          gunzipped: stream.gunzipped,
        };
      }
      i++;
    }
    throw new DaemonError("badRequest", `line ${String(n)} is past the end of ${path} (${String(i)} lines)`);
  });
};

/**
 * この WARC を指す索引 (CDXJ) の offset の集合。索引の `filename` が WARC の basename と
 * 一致する行だけ数える。索引が無ければ空 —— 全レコードが「索引に無い」になる。
 */
const indexedOffsets = async (reader: WaczReader, warcName: string): Promise<Set<number>> => {
  const offsets = new Set<number>();
  for (const name of reader.entryNames()) {
    if (!name.startsWith("indexes/")) continue;
    const plain = name.endsWith(".cdxj") || name.endsWith(".cdx");
    const gz = name.endsWith(".cdxj.gz") || name.endsWith(".cdx.gz");
    if (!plain && !gz) continue;
    const raw = await reader.readEntry(name);
    if (raw === undefined) continue;
    let text: string;
    try {
      text = (gz ? gunzipSync(raw) : raw).toString("utf-8");
    } catch {
      continue; // 壊れた索引は「無い」と同じ
    }
    for (const entry of parseCdxj(text).entries) {
      if (entry.fields["filename"] !== warcName) continue;
      const offset = Number(entry.fields["offset"]);
      if (Number.isInteger(offset)) offsets.add(offset);
    }
  }
  return offsets;
};

/** WARC を頭から歩いた一覧。daemon は状態を持たないので、窓を送るたびに歩き直す。 */
export const readRecords = async (params: ReadRecordsParams): Promise<ReadRecordsResult> => {
  const path = requirePath(params.path);
  const from = requireInt(params.from, "from", 0);
  const count = clampCount(requireInt(params.count, "count", 1), RECORDS_MAX);
  return withReader(params.source.uri, async (reader) => {
    const bytes = await reader.readEntry(path);
    if (bytes === undefined) throw new DaemonError("badRequest", `no entry: ${path}`);
    const indexed = await indexedOffsets(reader, posix.basename(path));
    const all: RecordSummary[] = [];
    // loose: 最初の壊れたメンバで止まる。そこまでは出す
    for (const member of iterateWarcMembers(bytes, { loose: true })) {
      all.push({ ...summarizeMember(member), indexed: indexed.has(member.offset) });
    }
    const to = Math.min(all.length, from + count);
    return { records: all.slice(from, to), next: to < all.length ? to : null, total: all.length };
  });
};

/** 1 メンバを切り出して展開し、レコードに割る。 */
const openRecord = async (
  params: ReadRecordParams,
): Promise<{ parsed: ParsedRecord; truncated: boolean }> => {
  const path = requirePath(params.path);
  const offset = requireInt(params.offset, "offset", 0);
  const length = requireInt(params.length, "length", 1);
  return withReader(params.source.uri, async (reader) => {
    let member: Buffer;
    try {
      member = await reader.member(path, offset, length);
    } catch (cause) {
      throw new DaemonError("badRequest", describeCause(cause));
    }
    const { data, truncated } = isGzip(member)
      ? await gunzipCapped(member, BODY_MAX)
      : { data: member, truncated: false };
    const parsed = parseRecord(data);
    if (parsed === undefined) {
      throw new DaemonError("badRequest", `no WARC record at ${path}@${String(offset)}`);
    }
    return { parsed, truncated };
  });
};

/** 本文の content-type。HTTP なら HTTP の見出し、でなければ WARC の Content-Type。 */
const mimeOfRecord = (parsed: ParsedRecord): string | undefined =>
  parsed.http !== undefined
    ? mimeOf(httpHeader(parsed.http, "content-type"))
    : mimeOf(parsed.warc.find((h) => h.name.toLowerCase() === "content-type")?.value);

/** 1 レコード。本文は text / image (大きさだけ) / binary (大きさだけ)。 */
export const readRecord = async (params: ReadRecordParams): Promise<ReadRecordResult> => {
  const { parsed, truncated } = await openRecord(params);
  return {
    warc: parsed.warc,
    ...(parsed.http !== undefined && { http: parsed.http }),
    body: classifyBody(mimeOfRecord(parsed), parsed.body, TEXT_CAP, truncated),
  };
};

/** 画像の実体。raster 以外は {@link NotRasterError} (REST は 415)。 */
export const readRecordBody = async (
  params: ReadRecordParams,
): Promise<{ mime: string; bytes: Buffer }> => {
  const { parsed, truncated } = await openRecord(params);
  const mime = mimeOfRecord(parsed);
  if (mime === undefined || !RASTER.has(mime)) throw new NotRasterError(mime);
  if (truncated) {
    throw new DaemonError("badRequest", `record body exceeds ${String(BODY_MAX)} bytes`);
  }
  return { mime, bytes: parsed.body };
};
