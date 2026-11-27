/**
 * Rule: browserhive/http-message-length (error · browserhive profile 限定)
 *
 * `request`・`response` のレコードの HTTP のメッセージが、レコードの持つ本文と食い違う長さを言っていないか。BrowserHive
 * WARC Profile の Length of the HTTP message（`response` は 1.6.0、`request` は 1.7.0）と Request payloads（1.7.0）が定める。
 * 見るのは:
 *
 *   - HTTP の `Content-Length` は、あるなら、レコードが持つ本文（HTTP の見出しの後のバイト列）の長さ（http-length）
 *   - HTTP のメッセージは `Transfer-Encoding` を持たない。本文は transfer coding を外して残すので、`chunked` が残ると
 *     読み手は無い小分けの本文を読もうとする（transfer-encoding）
 *   - `request` だけ: 本文が空でなければ `Content-Length` を持つ。長さも `Transfer-Encoding` も無い HTTP/1.1 の要求は
 *     本文 0 バイトと読まれる（応答は逆に終わりまで読まれるので、応答には言わない）（http-length-missing）
 *   - `request` だけ: `WARC-Truncated: unspecified`（本文を得られなかった）なら本文を持たない（truncated-body）
 *
 * どちらも、送る本文を持たない応答（リダイレクト・`304`・`HEAD` への答えなど）に当たる。そうした応答のレコードの本文は
 * 空なのに、サーバが送った長さや `chunked` が残っていると、レコードだけを読む読み手（jwarc など）が落とす。`HEAD` への
 * 答えと `304` の長さは HTTP では正しい値だが、レコードの中では本文の長さと読まれるので、ここでも言う。
 *
 * 同じ名の見出しが 2 つあれば、`records.ts` の `httpHeader` のとおり後ろの値で見る（前の値が誤りでも、後ろの値が合えば通る）。
 *
 * **本文を得られなかった要求に `WARC-Truncated: unspecified` が付いているかは見られない。** レコードだけでは、ブラウザが
 * 本文を送ったかが分からない。見られるのは逆の向き（印の付いた要求が本文を持たない）だけ。
 *
 * **archive 自身の宣言 (`conformsTo`) で分ける。** 見るのは、先頭の warcinfo が BrowserHive WARC Profile の 1.6.0 以上を
 * 名乗る本の `response` と、1.7.0 以上を名乗る本の `request` だけ。それより前の本には、その決まりが無い。名乗りが無いか
 * 読めない本も見ない（`browserhive/warcinfo-declares-profile` が言う）。
 *
 * Spec: https://uraitakahito.github.io/browserhive-warc-spec/1.7.0/#http-message-length
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
        en: "https://uraitakahito.github.io/browserhive-warc-spec/1.7.0/#http-message-length",
        ja: "https://uraitakahito.github.io/browserhive-warc-spec/1.7.0/ja/#http-message-length",
      },
    },
    {
      label: "BrowserHive WARC Profile §Request payloads",
      url: {
        en: "https://uraitakahito.github.io/browserhive-warc-spec/1.7.0/#request-payloads",
        ja: "https://uraitakahito.github.io/browserhive-warc-spec/1.7.0/ja/#request-payloads",
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
      /** 本が request にも当たる版（1.7.0 以上）を名乗るか。 */
      let requests = false;
      for (const member of iterateWarcMembers(buf, { loose: true })) {
        const record = parseWarcRecord(member.raw);
        if (first) {
          if (record === null || !warcinfoDeclaresAtLeast(record, 1, 6)) break;
          requests = warcinfoDeclaresAtLeast(record, 1, 7);
        }
        first = false;
        if (record === null) continue;
        const type = (getHeader(record, "WARC-Type") ?? "").toLowerCase();
        if (type !== "response" && !(requests && type === "request")) continue;
        const message = parseRecord(member.raw);
        // HTTP のメッセージでない（閉じた見出しを持たない）レコードは、長さを照らせない。
        if (message?.http === undefined) continue;

        const location: IssueLocation = { entry, offset: member.offset };
        const url = shown(getHeader(record, "WARC-Target-URI") ?? "?");
        const held = message.body.byteLength;
        const length = httpHeader(message.http, "Content-Length")?.trim();
        if (length !== undefined && length !== String(held)) {
          report("http-length", { url, type, declared: shown(length), actual: String(held) }, location);
        }
        const coding = httpHeader(message.http, "Transfer-Encoding");
        if (coding !== undefined) report("transfer-encoding", { url, type, value: shown(coding.trim()) }, location);
        if (type !== "request") continue;
        // Transfer-Encoding を持っていても、長さの無い本文つきの要求は 1.7.0 の MUST に当たるので、両方を言う。
        if (length === undefined && held > 0) {
          report("http-length-missing", { url, actual: String(held) }, location);
        }
        if (getHeader(record, "WARC-Truncated")?.trim().toLowerCase() === "unspecified" && held > 0) {
          report("truncated-body", { url, bytes: String(held) }, location);
        }
      }
    }
    return ok(bucket.drain());
  },
};
