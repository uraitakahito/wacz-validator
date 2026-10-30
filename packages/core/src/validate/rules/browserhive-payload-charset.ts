/**
 * Rule: browserhive/payload-charset (warning · browserhive profile 限定)
 *
 * 文字の本文が、サーバの送ったバイト列ではなく、書き手が文字符号を変えた物に見えないか。
 *
 * profile 1.13.0 は、response の payload をサーバのバイト列のまま (content-coding だけを外して) にし、
 * 文字符号を変えてはならない (MUST NOT) と定める。BrowserHive は v19 まで、browser が文字に読み替えた本文を
 * UTF-8 で書き戻していた。その跡は 2 つの形で残る:
 *
 *   - transcoded: Content-Type が UTF-8 でない charset を宣言するのに、本文がその charset で読めず、
 *     UTF-8 でなら読める (Shift_JIS の本文を UTF-8 に書き直した)
 *   - double-encoded: charset を宣言しない (か UTF-8 の) 本文が UTF-8 で読め、読んだ文字を windows-1252 の
 *     バイトに戻すと、また UTF-8 として読める latin1 の外の文字になる (UTF-8 の本文を windows-1252 として
 *     読み、UTF-8 で書き戻した。e-Gov 法令検索の CSS で見た形)
 *
 * 推測なので warning。正しい本文が偶然この形になることはまれだが、在りえなくはない。**版で分けない** ——
 * v19 までの archive の化けを洗い出すのが、この rule の役目の 1 つ。content-coding が残った本文
 * (`Content-Encoding` の在る応答) は、文字として読めないので見ない。
 *
 * Spec: https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.13.0/#response-payloads
 */
import { ok } from "../../result.js";
import { getHeader, httpEntityBody, parseWarcRecord } from "../../wacz/warc-header.js";
import { iterateWarcMembers } from "../../wacz/warc-iter.js";
import type { Issue, ValidationRule } from "../domain.js";

const RULE = "browserhive/payload-charset";
const WARC_ENTRY = "archive/data.warc.gz";

/** 文字の本文の型。`text/*` と、文字を運ぶ application の型。 */
const isTextType = (type: string): boolean =>
  type.startsWith("text/") ||
  ["application/javascript", "application/x-javascript", "application/ecmascript", "application/json", "application/xml"].includes(type) ||
  type.endsWith("+xml") ||
  type.endsWith("+json");

/** UTF-8 と、その部分集合。宣言がこれなら、transcoded は起きようがない。 */
const UTF8_LABELS: ReadonlySet<string> = new Set(["utf-8", "utf8", "unicode-1-1-utf-8", "us-ascii", "ascii"]);

/** windows-1252 が 0x80〜0x9F に置く文字 (WHATWG の表)。ほかの 0x80〜0xFF は latin1 と同じ。 */
const WINDOWS_1252_HIGH = new Map<number, number>([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87],
  [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e], [0x2018, 0x91],
  [0x2019, 0x92], [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97], [0x02dc, 0x98],
  [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b], [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f],
]);

/** 文字を windows-1252 のバイトに戻す。戻せない文字があれば `undefined`。 */
const toWindows1252 = (text: string): Buffer | undefined => {
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0xff) {
      bytes.push(code);
      continue;
    }
    const byte = WINDOWS_1252_HIGH.get(code);
    if (byte === undefined) return undefined;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
};

/** `fatal` の decoder で読む。読めなければ `undefined`。知らない label も `undefined`。 */
const decodeStrict = (bytes: Uint8Array, label: string): string | undefined => {
  try {
    return new TextDecoder(label, { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
};

const hasNonAscii = (bytes: Uint8Array): boolean => bytes.some((byte) => byte >= 0x80);

/** HTTP の見出しの値を 1 つ (名前の大文字と小文字は問わない)。見出しの block は latin1 で読む。 */
const httpHeader = (head: string, name: string): string | undefined => {
  for (const line of head.split("\r\n").slice(1)) {
    const colon = line.indexOf(":");
    if (colon > 0 && line.slice(0, colon).trim().toLowerCase() === name) return line.slice(colon + 1).trim();
  }
  return undefined;
};

/** 本文が化けた形なら、その種類と、知らせる値。化けていなければ `undefined`。 */
export const charsetFinding = (
  contentType: string,
  payload: Uint8Array,
): { kind: "transcoded"; charset: string } | { kind: "double-encoded" } | undefined => {
  const [rawType = "", ...params] = contentType.split(";");
  const type = rawType.trim().toLowerCase();
  if (!isTextType(type) || !hasNonAscii(payload)) return undefined;
  const asUtf8 = decodeStrict(payload, "utf-8");
  if (asUtf8 === undefined) return undefined;
  const charset = params
    .map((param) => param.trim())
    .find((param) => param.toLowerCase().startsWith("charset="))
    ?.slice("charset=".length)
    .replace(/^"|"$/g, "")
    .toLowerCase();
  if (charset !== undefined && !UTF8_LABELS.has(charset)) {
    // 宣言の charset で読めず、UTF-8 でなら読める。宣言の charset を decoder が知らなければ、何も言えない。
    try {
      new TextDecoder(charset);
    } catch {
      return undefined;
    }
    return decodeStrict(payload, charset) === undefined ? { kind: "transcoded", charset } : undefined;
  }
  // UTF-8 で読んだ文字を windows-1252 に戻すと、また UTF-8 として読め、latin1 の外の文字になる。
  const back = toWindows1252(asUtf8);
  if (back === undefined || !hasNonAscii(back)) return undefined;
  const again = decodeStrict(back, "utf-8");
  if (again === undefined) return undefined;
  return Array.from(again).some((char) => (char.codePointAt(0) ?? 0) > 0xff) ? { kind: "double-encoded" } : undefined;
};

export const browserhivePayloadCharsetRule: ValidationRule = {
  name: "browserhive/payload-charset",
  descriptionKey: `${RULE}.desc`,
  conformance: "MUST",
  docs: [
    {
      label: "BrowserHive WACZ Profile §Response payloads",
      url: {
        en: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.13.0/#response-payloads",
        ja: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.13.0/ja/#response-payloads",
      },
    },
  ],
  applicability: {
    excludeProfiles: ["spec", "lenient"],
  },
  run: async (wacz) => {
    const buf = await wacz.readEntry(WARC_ENTRY);
    if (buf === undefined) return ok([]);

    const issues: Issue[] = [];
    for (const member of iterateWarcMembers(buf, { loose: true })) {
      const record = parseWarcRecord(member.raw);
      if (record === null) continue;
      if ((getHeader(record, "WARC-Type") ?? "").toLowerCase() !== "response") continue;
      const payload = httpEntityBody(record);
      if (payload === null || payload.byteLength === 0) continue;
      const head = record.body.subarray(0, record.body.byteLength - payload.byteLength).toString("latin1");
      if (httpHeader(head, "content-encoding") !== undefined) continue;
      const found = charsetFinding(httpHeader(head, "content-type") ?? "", payload);
      if (found === undefined) continue;
      const url = getHeader(record, "WARC-Target-URI") ?? "?";
      issues.push({
        rule: RULE,
        severity: "warning",
        messageKey: `${RULE}.${found.kind}`,
        params: found.kind === "transcoded" ? { url, charset: found.charset } : { url },
        location: { entry: WARC_ENTRY },
      });
    }
    return ok(issues);
  },
};
