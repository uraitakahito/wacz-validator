/**
 * Rule: browserhive/redacted-records (error · browserhive profile 限定)
 *
 * 値を置き換えたと名乗るレコードと、値を含む本文を落としたと名乗るレコードの形が、決まりどおりか。
 * BrowserHive WARC Profile 1.2.0 の Redacted records が定める。見るのは:
 *
 *   - `BrowserHive-Redacted` を持つのは `request` と `response` だけ。1 つのレコードに 1 つ
 *   - 値が文法どおり: `target-uri`・`headers`・`payload` の順に各 1 回まで、数は 1 以上で先頭に 0 が無く、区切りは `, `
 *   - 名乗った場所に、名乗った数以上の `***` が在る。`target-uri` は `WARC-Target-URI`、`headers` は HTTP のヘッダの
 *     欄の値（要求行と状態行、欄の名は数えない）、`payload` は本文
 *   - `WARC-Truncated: secret` の `request`・`response` は HTTP のメッセージで、ヘッダの後が空。`response` なら、
 *     それを `WARC-Refers-To` で指す metadata に `truncated: secret` が在る
 *   - `truncated: secret` の metadata は、`WARC-Truncated: secret` の `response` を指す（`request` は指さない）
 *   - この 2 種類のレコードの `WARC-Block-Digest`・`WARC-Payload-Digest`（sha256 のとき）と HTTP の `Content-Length`
 *     が、レコードが持っているバイト列を言っている。元のバイト列の digest が残っていると、読み手が値の候補を
 *     試せる。`warc/payload-digest` は不一致を warning でしか言わず、`WARC-Block-Digest` は見ない
 *
 * **値が残っていないことは、この rule では確かめられない。** 値を知らないので。緑が言うのは、名乗りとレコードの形が
 * 食い違っていないことだけで、レコードから値が消えたことではない。`BrowserHive-Redacted` を持たないレコードに `***` が
 * 在っても言わない —— オリジンが送った同じ字と区別できない。名乗らずに置き換えたレコードも、置き換えた場所を
 * 名乗り落としたレコードも、ここでは見つからない。
 *
 * **数は「以上」で比べる。** 置き換えの後の `***` には、オリジンが送った同じ字も混ざるので、同じ数とは限らない。
 * 数えるのは重ならない `***` で、`******` は 2 つ、`****` は 1 つ。置き換えた数より少なく数えることはない。
 *
 * **`WARC-Target-URI` が URI のままかは、ここでは言わない。** `warc/field-values` が、どのレコードでも言う
 * （`uri-form`）。scheme の残った形（`https:***?b=c`・`https://x/?a=***` と、host が `***` の形）は通り、`***` だけのものは落ちる。
 *
 * **archive 自身の宣言 (`conformsTo`) で分ける。** 見るのは、先頭の warcinfo が 1.2.0 以上の BrowserHive WARC Profile を
 * 名乗る本だけ。それより前の本には、この決まりが無い。名乗りが無いか読めない本も見ない（`browserhive/warcinfo-declares-profile` が言う）。
 *
 * Spec: https://uraitakahito.github.io/browserhive-warc-spec/1.2.0/#redacted-records
 */
import { ok } from "../../result.js";
import { fieldRecord, fieldValues, parseWarcFieldsBody } from "../../wacz/named-fields.js";
import { httpHeader, parseRecord, type ParsedRecord } from "../../wacz/records.js";
import { getHeader, parseWarcRecord, type ParsedWarcRecord } from "../../wacz/warc-header.js";
import { iterateWarcMembers } from "../../wacz/warc-iter.js";
import type { IssueLocation, ValidationRule } from "../domain.js";
import { WarcIssueBucket } from "../warc-issue-bucket.js";
import { shown } from "../warc11-scan.js";
import { compareSha256 } from "./warc-payload-digest.js";

const RULE = "browserhive/redacted-records";

const REDACTED_FIELD = "BrowserHive-Redacted";

/** 置き換えた値の印。 */
const MARK = "***";

/** 部分の名。WARC Profile の表の順で、欄の中もこの順に並ぶ。 */
const PART_NAMES: readonly string[] = ["target-uri", "headers", "payload"];

const PART = /^([a-z-]+)=([1-9]\d*)$/;

/** BrowserHive WARC Profile の版の URL。版ごとの文書を指す。`latest/` は版ではないので読まない。 */
const WARC_PROFILE_VERSION = /^https:\/\/uraitakahito\.github\.io\/browserhive-warc-spec\/(\d+)\.(\d+)\.\d+\/$/;

/** 値が 1.2.0 以上の BrowserHive WARC Profile か。 */
const isProfileWithRedaction = (conformsTo: string): boolean => {
  const match = WARC_PROFILE_VERSION.exec(conformsTo);
  if (match === null) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > 1 || (major === 1 && minor >= 2);
};

/** 本の先頭のレコードが warcinfo で、1.2.0 以上の版を名乗るか。 */
const declaresRedaction = (first: ParsedWarcRecord): boolean =>
  (getHeader(first, "WARC-Type") ?? "").toLowerCase() === "warcinfo" &&
  fieldValues(parseWarcFieldsBody(first.body).fields, "conformsTo").some(isProfileWithRedaction);

/** `BrowserHive-Redacted` の値を部分の名と数に読む。文法に合わなければ `undefined`。 */
const parseParts = (value: string): [string, number][] | undefined => {
  const parts: [string, number][] = [];
  let last = -1;
  for (const part of value.split(", ")) {
    const [, name = "", count = ""] = PART.exec(part) ?? [];
    const at = PART_NAMES.indexOf(name);
    // 知らない名前は -1、順の違いと繰り返しは直前以下になる。
    if (at <= last) return undefined;
    last = at;
    parts.push([name, Number(count)]);
  }
  return parts;
};

/** `***` の数。重ならないように左から数える。 */
const marksIn = (bytes: Buffer): number => {
  let count = 0;
  for (let at = bytes.indexOf(MARK); at !== -1; at = bytes.indexOf(MARK, at + MARK.length)) count += 1;
  return count;
};

/** 部分の場所に在る `***` の数。 */
const marksAt = (part: string, targetUri: string, message: ParsedRecord): number => {
  if (part === "target-uri") return marksIn(Buffer.from(targetUri));
  if (part === "payload") return marksIn(message.body);
  return (message.http?.headers ?? []).reduce((sum, header) => sum + marksIn(Buffer.from(header.value)), 0);
};

/** digest の欄が `bytes` を言っているか。sha256 でなければ計算できないので、言っていると見なす。無い欄も同じ。 */
const describes = (declared: string | undefined, bytes: Buffer): boolean =>
  declared === undefined ||
  !declared.toLowerCase().startsWith("sha256:") ||
  compareSha256(declared.slice("sha256:".length), bytes).same;

export const browserhiveRedactedRecordsRule: ValidationRule = {
  name: "browserhive/redacted-records",
  descriptionKey: `${RULE}.desc`,
  conformance: "MUST",
  docs: [
    {
      label: "BrowserHive WARC Profile §Redacted records",
      url: {
        en: "https://uraitakahito.github.io/browserhive-warc-spec/1.2.0/#redacted-records",
        ja: "https://uraitakahito.github.io/browserhive-warc-spec/1.2.0/ja/#redacted-records",
      },
    },
  ],
  applicability: {
    excludeProfiles: ["spec", "lenient"],
  },
  run: async (wacz) => {
    const bucket = new WarcIssueBucket();
    const report = (messageKey: string, params: Record<string, string>, location: IssueLocation): void => {
      bucket.push({ rule: RULE, severity: "error", messageKey: `${RULE}.${messageKey}`, params, location });
    };

    /** 本文を落とした `response` の `WARC-Record-ID` → その場所と URL。 */
    const dropped = new Map<string, { url: string; location: IssueLocation }>();
    /** `truncated: secret` の metadata が指す先と、その metadata の場所と URL。 */
    const claims: { target: string | undefined; url: string; location: IssueLocation }[] = [];

    for (const entry of wacz.warcEntries()) {
      const buf = await wacz.readEntry(entry);
      if (buf === undefined) continue;
      let first = true;
      for (const member of iterateWarcMembers(buf, { loose: true })) {
        const record = parseWarcRecord(member.raw);
        if (first && (record === null || !declaresRedaction(record))) break;
        first = false;
        if (record === null) continue;

        const location: IssueLocation = { entry, offset: member.offset };
        const type = (getHeader(record, "WARC-Type") ?? "").toLowerCase();
        const targetUri = getHeader(record, "WARC-Target-URI") ?? "?";
        const url = shown(targetUri);
        const fields = fieldValues(record.headers, REDACTED_FIELD);

        if (type !== "request" && type !== "response") {
          if (fields.length > 0) report("type", { type: type === "" ? "?" : type, url }, location);
          if (type === "metadata" && fieldRecord(parseWarcFieldsBody(record.body).fields)["truncated"] === "secret") {
            claims.push({ target: getHeader(record, "WARC-Refers-To"), url, location });
          }
          continue;
        }

        const truncated = getHeader(record, "WARC-Truncated")?.toLowerCase() === "secret";
        if (fields.length === 0 && !truncated) continue;
        const message = parseRecord(member.raw);
        if (message === undefined) continue;

        const [value] = fields;
        if (fields.length > 1) {
          report("repeated", { url, count: String(fields.length) }, location);
        } else if (value !== undefined) {
          const parts = parseParts(value);
          if (parts === undefined) report("form", { url, found: shown(value) }, location);
          for (const [part, declared] of parts ?? []) {
            const found = marksAt(part, targetUri, message);
            if (found < declared) report("count", { url, part, declared: String(declared), found: String(found) }, location);
          }
        }

        if (truncated) {
          if (message.http === undefined) report("truncated-no-http", { url, type }, location);
          else if (message.body.byteLength > 0) report("truncated-body", { url, type, bytes: String(message.body.byteLength) }, location);
          if (type === "response") {
            const id = getHeader(record, "WARC-Record-ID");
            if (id !== undefined) dropped.set(id, { url, location });
          }
        }

        // 持っているバイト列を言っているか。HTTP のメッセージでなければ、payload の digest と長さは照らせない。
        if (!describes(getHeader(record, "WARC-Block-Digest"), record.body)) {
          report("digest", { url, field: "WARC-Block-Digest" }, location);
        }
        if (message.http === undefined) continue;
        if (!describes(getHeader(record, "WARC-Payload-Digest"), message.body)) {
          report("digest", { url, field: "WARC-Payload-Digest" }, location);
        }
        const length = httpHeader(message.http, "Content-Length")?.trim();
        if (length !== undefined && length !== String(message.body.byteLength)) {
          report("http-length", { url, declared: length, actual: String(message.body.byteLength) }, location);
        }
      }
    }

    // 本を全部読んでから照らす。組が別の本に在ることは browserhive/exchange-in-one-file が言うので、どの本にも無いときだけ言う。
    const referred = new Set(claims.map((claim) => claim.target));
    for (const [id, { url, location }] of dropped) {
      if (!referred.has(id)) report("no-metadata", { url }, location);
    }
    for (const { target, url, location } of claims) {
      if (target === undefined || !dropped.has(target)) report("metadata-target", { url, target: target ?? "-" }, location);
    }
    return ok(bucket.drain());
  },
};
