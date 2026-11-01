/**
 * WARC 1.1 の欄の値の形。`warc11-fields.ts` の目録が各欄に与えた `FieldValueKind` を、
 * 値 1 つに当てて「違反（shall に反する）」と「注意（should や注釈の推奨に反する）」に分ける。
 *
 * 文法は §4・§5 の ABNF と、注釈つき 1.1 の community recommendation / errata に従う:
 *   - `<uri>` の record-id は `"<" uri ">"`。中は RFC 3986 の URI で、登録された scheme を名乗る
 *     （scheme の綴りだけ見る。登録簿は見ない）。内部の空白は無し
 *   - 1.1 で `uri` から `<>` が外れた（Target-URI・Refers-To-Target-URI・Profile）。付いていれば
 *     文法に反する。読む側は外して読む（注釈）
 *   - WARC-Date は W3CDTF の UTC。小数は 1〜9 桁（§5.4）
 *   - digest は `algorithm ":" digest-value`。値に `=` と `/` を許す（errata #48）。label は小文字が
 *     推奨（recommendation #80）
 *   - IPv4 は dotted quad、IPv6 は RFC 4291 の形。RFC 5952 の正規形が推奨（recommendation #100）
 *   - media-type は `type "/" subtype *( OWS ";" OWS parameter )`（errata #38 で OWS を許す）
 *   - WARC-Truncated の reason は 4 つ。他は拡張（違反ではない）
 *   - WARC-Type は 8 つ。他は拡張で、読む側は無視する（違反ではない）
 */
import { isIPv4, isIPv6 } from "node:net";
import { type FieldValueKind, isWarcRecordType, TRUNCATED_REASONS } from "./warc11-fields.js";

export interface FieldValueVerdict {
  /** shall に反する形。messageKey の末尾になる。 */
  violation?: string;
  /** should や推奨に反する形、または仕様が定義しない値。messageKey の末尾になる。 */
  advisory?: string;
  /** message に差し込む値（正規形・label など）。 */
  params?: Record<string, string>;
}

const OK: FieldValueVerdict = {};

/** RFC 7230 の token（RFC 2616 の token と同じ集合）。 */
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** 絶対 URI の最低限: scheme ":" 以降、空白と `<>` を含まない。RFC 3986 の scheme の綴り。 */
const ABSOLUTE_URI = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s<>]*$/;

/** W3CDTF（ISO 8601 の W3C profile）。粒度は年から秒の小数まで。 */
const W3CDTF =
  /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2}))?)?)?$/;

const MEDIA_TYPE = (() => {
  const token = String.raw`[!#$%&'*+.^_\x60|~0-9A-Za-z-]+`;
  const quoted = String.raw`"(?:[^"\\]|\\.)*"`;
  return new RegExp(String.raw`^${token}/${token}(?:[ \t]*;[ \t]*${token}=(?:${token}|${quoted}))*$`);
})();

const checkRecordId = (value: string): FieldValueVerdict => {
  const m = /^<([^<>\s]+)>$/.exec(value);
  if (m === null) return { violation: "record-id-form" };
  return ABSOLUTE_URI.test(m[1] ?? "") ? OK : { violation: "record-id-form" };
};

const checkUri = (value: string): FieldValueVerdict => {
  // 1.0 の癖で `<>` に包んだ値。読む側は外して読むが、1.1 の文法には反する。
  if (/^<.*>$/.test(value)) return { violation: "uri-angle-brackets" };
  return ABSOLUTE_URI.test(value) ? OK : { violation: "uri-form" };
};

const checkDate = (value: string): FieldValueVerdict => {
  const m = W3CDTF.exec(value);
  if (m === null) return { violation: "date-form" };
  const [, year, month, day, hour, minute, second, fraction, zone] = m;
  if (fraction !== undefined && fraction.length > 9) return { violation: "date-fraction-digits" };
  if (zone !== undefined && zone !== "Z" && zone !== "+00:00" && zone !== "-00:00") return { violation: "date-not-utc" };
  // 暦の上で在る日時か。文法を通った値だけが来るので、ここで落ちるのは 13 月や 25 時。
  const probe = new Date(
    Date.UTC(
      Number(year),
      month === undefined ? 0 : Number(month) - 1,
      day === undefined ? 1 : Number(day),
      hour === undefined ? 0 : Number(hour),
      minute === undefined ? 0 : Number(minute),
      second === undefined ? 0 : Number(second),
    ),
  );
  const inRange =
    !Number.isNaN(probe.getTime()) &&
    (month === undefined || probe.getUTCMonth() === Number(month) - 1) &&
    (day === undefined || probe.getUTCDate() === Number(day)) &&
    (hour === undefined || probe.getUTCHours() === Number(hour)) &&
    (minute === undefined || probe.getUTCMinutes() === Number(minute)) &&
    (second === undefined || Number(second) <= 60);
  return inRange ? OK : { violation: "date-form" };
};

const checkDigest = (value: string): FieldValueVerdict => {
  const colon = value.indexOf(":");
  if (colon <= 0) return { violation: "digest-form" };
  const label = value.slice(0, colon);
  const digest = value.slice(colon + 1);
  if (!TOKEN.test(label) || !/^[A-Za-z0-9+/=_-]+$/.test(digest)) return { violation: "digest-form" };
  return label === label.toLowerCase() ? OK : { advisory: "digest-label-uppercase", params: { label } };
};

/**
 * RFC 5952 の正規形: 小文字・各 group の先頭の 0 を落とす・最長の 0 の列を `::` に（同じ長さなら最初・
 * 1 group だけなら縮めない）。末尾に IPv4 を埋め込んだ形（`::ffff:1.2.3.4`）はそのまま返す。
 */
const canonicalIpv6 = (value: string): string => {
  if (value.includes(".")) return value;
  const [head = "", tail] = value.split("::");
  const heads = head === "" ? [] : head.split(":");
  const tails = tail === undefined || tail === "" ? [] : tail.split(":");
  const zeros = tail === undefined ? [] : Array.from({ length: 8 - heads.length - tails.length }, () => "0");
  const groups = [...heads, ...zeros, ...tails].map((g) => Number.parseInt(g, 16).toString(16));
  let bestStart = -1;
  let bestLength = 0;
  for (let i = 0; i < groups.length; ) {
    if (groups[i] !== "0") {
      i += 1;
      continue;
    }
    let j = i;
    while (j < groups.length && groups[j] === "0") j += 1;
    if (j - i > bestLength) {
      bestStart = i;
      bestLength = j - i;
    }
    i = j;
  }
  if (bestLength < 2) return groups.join(":");
  const before = groups.slice(0, bestStart).join(":");
  const after = groups.slice(bestStart + bestLength).join(":");
  return `${before}::${after}`;
};

const checkIpAddress = (value: string): FieldValueVerdict => {
  if (/^\[.*\]$/.test(value)) return { violation: "ip-brackets" };
  if (isIPv4(value)) return OK;
  if (!isIPv6(value)) return { violation: "ip-form" };
  const canonical = canonicalIpv6(value);
  return canonical === value ? OK : { advisory: "ip-not-canonical", params: { canonical } };
};

/** 欄の値 1 つを、その欄の形に当てる。 */
export const checkFieldValue = (kind: FieldValueKind, value: string): FieldValueVerdict => {
  // 名だけ書いて値の無い欄。TEXT（WARC-Filename）だけは空でも文法に合う。
  if (value === "" && kind !== "text") return { violation: "empty" };
  switch (kind) {
    case "record-id":
      return checkRecordId(value);
    case "uri":
      return checkUri(value);
    case "date":
      return checkDate(value);
    case "digits":
      return /^\d+$/.test(value) ? OK : { violation: "digits-form" };
    case "record-type":
      return isWarcRecordType(value.toLowerCase()) ? OK : { advisory: "unknown-record-type" };
    case "labelled-digest":
      return checkDigest(value);
    case "ip-address":
      return checkIpAddress(value);
    case "truncated-reason":
      return (TRUNCATED_REASONS as readonly string[]).includes(value.toLowerCase())
        ? OK
        : { advisory: "unknown-truncated-reason" };
    case "media-type":
      return MEDIA_TYPE.test(value) ? OK : { violation: "media-type-form" };
    case "text":
      return OK;
  }
};

/** `<uri>` の中身。`<>` が無ければそのまま。 */
export const stripAngleBrackets = (value: string): string => {
  const m = /^<(.*)>$/.exec(value);
  return m?.[1] ?? value;
};

/** media-type の type/subtype（小文字）と parameter（名は小文字・値は引用符を外す）。文法に合わなければ `undefined`。 */
export const parseMediaType = (
  value: string,
): { type: string; parameters: Record<string, string> } | undefined => {
  if (!MEDIA_TYPE.test(value)) return undefined;
  const [head = "", ...rest] = value.split(";");
  const parameters: Record<string, string> = {};
  for (const part of rest) {
    const eq = part.indexOf("=");
    const name = part.slice(0, eq).trim().toLowerCase();
    const raw = part.slice(eq + 1).trim();
    parameters[name] = raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(.)/g, "$1") : raw;
  }
  return { type: head.trim().toLowerCase(), parameters };
};
