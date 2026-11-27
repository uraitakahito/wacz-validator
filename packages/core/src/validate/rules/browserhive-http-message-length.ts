/**
 * Rule: browserhive/http-message-length (error · browserhive profile 限定)
 *
 * `response` のレコードの HTTP のメッセージが、レコードの持たない本文を言っていないか。BrowserHive WARC Profile 1.6.0 の
 * Length of the HTTP message が定める。見るのは 2 つ:
 *
 *   - HTTP の `Content-Length` は、あるなら、レコードが持つ本文（HTTP の見出しの後のバイト列）の長さ
 *   - HTTP のメッセージは `Transfer-Encoding` を持たない。本文は transfer coding を外して残すので、`chunked` が残ると
 *     読み手は無い小分けの本文を読もうとする
 *
 * どちらも、送る本文を持たない応答（リダイレクト・`304`・`HEAD` への答えなど）に当たる。そうした応答のレコードの本文は
 * 空なのに、サーバが送った長さや `chunked` が残っていると、レコードだけを読む読み手（jwarc など）が落とす。`HEAD` への
 * 答えと `304` の長さは HTTP では正しい値だが、レコードの中では本文の長さと読まれるので、ここでも言う。
 *
 * **`request` のレコードは見ない。** WARC Profile 1.6.0 はこの節を `response` だけに掛ける。値を置き換えた `request` の
 * 長さは `browserhive/redacted-records` が言う。
 *
 * **archive 自身の宣言 (`conformsTo`) で分ける。** 見るのは、先頭の warcinfo が 1.6.0 以上の BrowserHive WARC Profile を
 * 名乗る本だけ。それより前の本には、この決まりが無い。名乗りが無いか読めない本も見ない（`browserhive/warcinfo-declares-profile` が言う）。
 *
 * Spec: https://uraitakahito.github.io/browserhive-warc-spec/1.6.0/#http-message-length
 */
import { ok } from "../../result.js";
import { httpHeader, parseRecord } from "../../wacz/records.js";
import { getHeader, parseWarcRecord } from "../../wacz/warc-header.js";
import { iterateWarcMembers } from "../../wacz/warc-iter.js";
import { warcinfoDeclaresAtLeast } from "../browserhive-storage.js";
import type { IssueLocation, ValidationRule } from "../domain.js";
import { WarcIssueBucket } from "../warc-issue-bucket.js";
import { shown } from "../warc11-scan.js";

const RULE = "browserhive/http-message-length";

export const browserhiveHttpMessageLengthRule: ValidationRule = {
  name: "browserhive/http-message-length",
  descriptionKey: `${RULE}.desc`,
  conformance: "MUST",
  docs: [
    {
      label: "BrowserHive WARC Profile §Length of the HTTP message",
      url: {
        en: "https://uraitakahito.github.io/browserhive-warc-spec/1.6.0/#http-message-length",
        ja: "https://uraitakahito.github.io/browserhive-warc-spec/1.6.0/ja/#http-message-length",
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

    for (const entry of wacz.warcEntries()) {
      const buf = await wacz.readEntry(entry);
      if (buf === undefined) continue;
      let first = true;
      for (const member of iterateWarcMembers(buf, { loose: true })) {
        const record = parseWarcRecord(member.raw);
        if (first && (record === null || !warcinfoDeclaresAtLeast(record, 1, 6))) break;
        first = false;
        if (record === null) continue;
        if ((getHeader(record, "WARC-Type") ?? "").toLowerCase() !== "response") continue;
        const message = parseRecord(member.raw);
        // HTTP のメッセージでない（閉じた見出しを持たない）レコードは、長さを照らせない。
        if (message?.http === undefined) continue;

        const location: IssueLocation = { entry, offset: member.offset };
        const url = shown(getHeader(record, "WARC-Target-URI") ?? "?");
        const length = httpHeader(message.http, "Content-Length")?.trim();
        if (length !== undefined && length !== String(message.body.byteLength)) {
          report("http-length", { url, declared: shown(length), actual: String(message.body.byteLength) }, location);
        }
        const coding = httpHeader(message.http, "Transfer-Encoding");
        if (coding !== undefined) report("transfer-encoding", { url, value: shown(coding.trim()) }, location);
      }
    }
    return ok(bucket.drain());
  },
};
