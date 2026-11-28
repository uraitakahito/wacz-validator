/**
 * `browserhive:capture.storage` と `storage/origins.jsonl` を読むための共有部分。
 *
 * 2 つの rule が同じものを読む —— 目録が在って形が合っているか
 * (`browserhive/storage-inventory`) と、値のファイルが在るならその形と目録との
 * 整合が取れているか (`browserhive/storage-shape`)。読み取りをここに集め、
 * rule 側は「何を問題とするか」だけを持つ。
 *
 * `tls` と違い、目録は BrowserHive WACZ Profile 1.1.0 の **MUST**。したがって不在は違反であって、
 * 「何も言うことがない」ではない —— `readStorage` が `null` を返す意味も、
 * あちらとは逆になる。
 *
 * Spec: https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.1.0/#storage
 */
import { datapackageOf } from "./datapackage-source.js";
import { fieldValues, parseWarcFieldsBody } from "../wacz/named-fields.js";
import type { WaczReader } from "../wacz/reader.js";
import { getHeader, type ParsedWarcRecord } from "../wacz/warc-header.js";

/** 値のファイル。目録が `valuesRecorded: true` のときだけ在る。 */
export const STORAGE_ENTRY = "storage/origins.jsonl";

/**
 * この版が読める profile の綴り。**古い順**に並べる。
 *
 * 2 つ在るのは `/2` が `/1` の上位互換ではないため —— `valuesRecorded` の意味が
 * 動いており (`/1` は「値を運んでいる」、`/2` は「値を**求められた**」)、
 * producer は WACZ Profile 1.6.0 の MUST に従って版を上げる。検証器が新しい方しか
 * 読めなければ、適合していた古いアーカイブを一斉に落とすことになる。
 */
export const KNOWN_STORAGE_PROFILES = [
  "browserhive:storage/1",
  "browserhive:storage/2",
] as const;

/** 表示用。`{expected}` に入る。 */
export const KNOWN_STORAGE_PROFILES_LABEL = KNOWN_STORAGE_PROFILES.join(" | ");

export const isKnownStorageProfile = (value: unknown): boolean =>
  typeof value === "string" && KNOWN_STORAGE_PROFILES.includes(value as never);

/** 目録が必ず持つ member。 */
export const INVENTORY_MEMBERS = [
  "profile",
  "stage",
  "valuesRecorded",
  "origins",
] as const;

/** 値のファイルの各行が必ず持つ member。 */
export const VALUE_LINE_MEMBERS = [
  "profile",
  "origin",
  "takenAt",
  "stage",
  "areas",
] as const;

/** 1 area の形。値は持たない。 */
export interface AreaShape {
  readonly keys?: unknown;
  readonly bytes?: unknown;
  readonly digest?: unknown;
}

export interface OriginShape {
  readonly origin?: unknown;
  readonly local?: unknown;
  readonly session?: unknown;
  readonly unreadable?: unknown;
}

export interface StorageInventory {
  readonly profile?: unknown;
  readonly stage?: unknown;
  readonly valuesRecorded?: unknown;
  readonly origins?: unknown;
}

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** `conformsTo` の URL から読む WACZ Profile の版。`/wacz-profile/1.14.0/` の形。 */
const CONFORMS_TO_VERSION = /\/wacz-profile\/(\d+)\.(\d+)\.(\d+)\//;

/**
 * archive が名乗る WACZ Profile の版 (`conformsTo`) が `major.minor` 以上か。名乗りが無いか読めなければ
 * `false` —— その版で初めて決まった MUST を、何に対して書かれたか分からない archive に当てない。
 */
export const profileAtLeast = (conformsTo: unknown, major: number, minor: number): boolean => {
  if (typeof conformsTo !== "string") return false;
  const match = CONFORMS_TO_VERSION.exec(conformsTo);
  if (match === null) return false;
  const [found, foundMinor] = [Number(match[1]), Number(match[2])];
  return found > major || (found === major && foundMinor >= minor);
};

/**
 * capture scripts（取り込みを頼む側が付けて、BrowserHive が頁の中で走らせるスクリプト）の後の時点の名。
 * archive が名乗る WACZ Profile の版 (`conformsTo`) で決める: 1.30.0 から `after-capture-scripts`、それより前
 * (名乗りが無いか読めないも) は `after-behaviors`。仕様は版ごとに値を決め、各版は後方互換ではないので、
 * どちらの版でも、もう一方の名は誤り。1.30.0 の WACZ は BrowserHive WARC Profile 1.8.0 と対で出るので、
 * WARC の本の中の名 (写しとスクリーンショットの URI・metadata の欄) も、この版で決める。
 * storage の目録と値の行の `stage`、snapshots と screenshots の時点の並び、スクリーンショットの URI が、これを使う。
 */
export const afterCaptureScriptsStage = (conformsTo: unknown): string =>
  profileAtLeast(conformsTo, 1, 30) ? "after-capture-scripts" : "after-behaviors";

/**
 * BrowserHive WARC Profile の版の URL。版ごとの文書を指し、`latest/` は版ではないので通さない。
 * WARC の本は、先頭の warcinfo の `conformsTo` でこれを名乗る（WACZ Profile が名乗る {@link profileAtLeast} の版とは別）。
 */
export const WARC_PROFILE_URL = /^https:\/\/uraitakahito\.github\.io\/browserhive-warc-spec\/(\d+)\.(\d+)\.\d+\/$/;

/** 値が `major.minor` 以上の BrowserHive WARC Profile の版の URL か。版の URL でなければ `false`。 */
export const warcProfileAtLeast = (conformsTo: string, major: number, minor: number): boolean => {
  const match = WARC_PROFILE_URL.exec(conformsTo);
  if (match === null) return false;
  const [found, foundMinor] = [Number(match[1]), Number(match[2])];
  return found > major || (found === major && foundMinor >= minor);
};

/**
 * 本の先頭のレコードが warcinfo で、`major.minor` 以上の BrowserHive WARC Profile を名乗るか。
 * 名乗りが無いか読めない本は `false` —— その版で初めて決まった MUST を、何に対して書かれたか分からない本に当てない。
 */
export const warcinfoDeclaresAtLeast = (first: ParsedWarcRecord, major: number, minor: number): boolean =>
  (getHeader(first, "WARC-Type") ?? "").toLowerCase() === "warcinfo" &&
  fieldValues(parseWarcFieldsBody(first.body).fields, "conformsTo").some((value) =>
    warcProfileAtLeast(value, major, minor),
  );

/** `sha256:` + 小文字 16 進 64 桁。WACZ Profile が定める形。 */
export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * `datapackage.json` から `browserhive:capture` を取り出す。
 *
 * `undefined` は「BrowserHive WACZ ではない / datapackage が読めない」。
 * その場合、WACZ Profile の MUST を当てる相手がそもそも居ない。
 */
export const readCapture = async (
  wacz: WaczReader,
): Promise<Record<string, unknown> | undefined> => {
  const { parsed: dp } = await datapackageOf(wacz);
  if (dp === null) return undefined;
  const capture = (dp as Record<string, unknown>)["browserhive:capture"];
  return isRecord(capture) ? capture : undefined;
};

/**
 * 値のファイルを 1 行ずつ。無ければ `null` (在ることを求めるのは呼び出し側の判断)。
 *
 * 行番号を添えるのは、落ちたときにどの行かを名指しするため —— JSON の
 * `Unexpected token` だけでは、10 万行のうちどこかが分からない。
 */
export const readStorageValues = async (
  wacz: WaczReader,
): Promise<{ lineNumber: number; parsed: Record<string, unknown> | null }[] | null> => {
  const raw = await wacz.readEntry(STORAGE_ENTRY);
  if (raw === undefined) return null;
  return raw
    .toString("utf8")
    .split("\n")
    .map((line, i) => ({ line: line.trim(), lineNumber: i + 1 }))
    .filter((x) => x.line.length > 0)
    .map(({ line, lineNumber }) => {
      try {
        const parsed: unknown = JSON.parse(line);
        return { lineNumber, parsed: isRecord(parsed) ? parsed : null };
      } catch {
        return { lineNumber, parsed: null };
      }
    });
};
