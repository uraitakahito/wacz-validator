// @module-tag engine
/**
 * `browserhive/http-message-length` のテスト。
 *
 * 守っている主張は BrowserHive WARC Profile 1.6.0 の Length of the HTTP message。`response` のレコードの HTTP の
 * `Content-Length` は、あるならレコードの持つ本文の長さを言い、HTTP のメッセージは `Transfer-Encoding` を持たない。
 *
 * **落とす標本と通す標本は 1 か所だけ違う。** 長さの値、`Transfer-Encoding` の有無、レコードの種類、warcinfo が名乗る版。
 * どれか 1 つでも同じ形にすると、「見出しの名を大文字で探す」「request も見る」「版を見ない」のような誤った実装が緑で通る。
 */
import { describe, expect, it } from "vitest";
import type { Issue, Report, RuleProfile } from "../src/validate/domain.js";
import type { FixtureOptions } from "./fixtures/generator.js";
import { firedWarc11Rules, rawRecord, reportFor } from "./fixtures/warc11.js";

const RULE = "browserhive/http-message-length";
const WARC_PROFILE = "https://uraitakahito.github.io/browserhive-warc-spec";
const WARC_1_5 = `${WARC_PROFILE}/1.5.0/`;
const WARC_1_6 = `${WARC_PROFILE}/1.6.0/`;
const WARC_1_7 = `${WARC_PROFILE}/1.7.0/`;
const WARC_2_0 = `${WARC_PROFILE}/2.0.0/`;
const URI = "https://site.test/start";

const recordId = (n: number): string => `<urn:uuid:00000000-0000-0000-0000-${String(2000 + n).padStart(12, "0")}>`;

interface MessageSpec {
  /** 既定は `response`。 */
  type?: string;
  id?: number;
  /** HTTP の開始行とヘッダの行。 */
  head: readonly string[];
  body?: string;
}

/** HTTP のメッセージのレコード 1 つ。WARC の `Content-Length` は block の長さどおり。 */
const message = ({ type = "response", id = 0, head, body = "" }: MessageSpec): Buffer => {
  const block = `${head.join("\r\n")}\r\n\r\n${body}`;
  return rawRecord(
    [
      "WARC/1.1",
      `WARC-Type: ${type}`,
      `WARC-Record-ID: ${recordId(id)}`,
      "WARC-Date: 2026-11-28T00:00:00Z",
      `WARC-Target-URI: ${URI}`,
      `Content-Type: application/http;msgtype=${type}`,
      `Content-Length: ${String(Buffer.byteLength(block))}`,
    ],
    block,
  );
};

/** 本文の無い 302。`extra` はサーバが付けた見出し。 */
const redirect = (...extra: string[]): Buffer =>
  message({ head: ["HTTP/1.1 302 Found", "Location: /landing", "Content-Type: text/plain", ...extra] });

/** `records` を warcinfo の後ろに持ち、warcinfo が `declared` を名乗る本 1 冊の archive。 */
const archive = (records: readonly Buffer[], declared: string | null = WARC_1_6): FixtureOptions => ({
  ...(declared === null ? {} : { warcinfoLines: [`conformsTo: ${declared}`] }),
  warcRawMembers: [...records],
});

const issuesOf = (report: Report): Issue[] => report.issues.filter((issue) => issue.rule === RULE);

const run = async (options: FixtureOptions, profile: RuleProfile = "browserhive"): Promise<Issue[]> =>
  issuesOf(await reportFor(options, profile));

/** 言ったことを、鍵の末尾と params の組で。 */
const said = (issues: readonly Issue[]): [string, unknown][] =>
  issues.map((issue) => [issue.messageKey.slice(RULE.length + 1), issue.params]);

const check = async (records: readonly Buffer[], declared?: string | null): Promise<[string, unknown][]> =>
  said(await run(archive(records, declared)));

describe("browserhive/http-message-length", () => {
  describe("通す形", () => {
    it("長さの行も小分けの印も無い本文の無い 302 には何も言わず、WARC 1.1 の rule も何も言わない", async () => {
      const report = await reportFor(archive([redirect()]), "browserhive");
      expect(issuesOf(report)).toEqual([]);
      expect(firedWarc11Rules(report)).toEqual([]);
    });

    it("本文の長さを言う応答には何も言わない（本文のある 200 と、長さ 0 を言う本文の無い応答）", async () => {
      expect(
        await check([
          message({ id: 1, head: ["HTTP/1.1 200 OK", "Content-Type: text/plain", "Content-Length: 6"], body: "target" }),
          message({ id: 2, head: ["HTTP/1.1 204 No Content", "Content-Length: 0"] }),
        ]),
      ).toEqual([]);
    });

    it("見出しの名の大小を問わず読む —— 小文字の content-length: 6 は 6 バイトの本文と合う", async () => {
      expect(
        await check([message({ head: ["HTTP/1.1 200 OK", "content-length: 6"], body: "target" })]),
      ).toEqual([]);
    });
  });

  describe("落とす形", () => {
    it("サーバの Content-Length: 35 が残った本文の無い 302 を言う", async () => {
      expect(await check([redirect("Content-Length: 35")])).toEqual([
        ["http-length", { url: URI, type: "response", declared: "35", actual: "0" }],
      ]);
    });

    it("Transfer-Encoding: chunked が残った本文の無い 302 を言う", async () => {
      expect(await check([redirect("Transfer-Encoding: chunked")])).toEqual([
        ["transfer-encoding", { url: URI, type: "response", value: "chunked" }],
      ]);
    });

    it("HEAD への答えと 304 が言う長さも、レコードの中では本文の長さと読まれるので言う", async () => {
      expect(
        await check([
          message({ id: 1, head: ["HTTP/1.1 200 OK", "Content-Type: text/plain", "Content-Length: 1234"] }),
          message({ id: 2, head: ["HTTP/1.1 304 Not Modified", "ETag: \"v1\"", "Content-Length: 777"] }),
        ]),
      ).toEqual([
        ["http-length", { url: URI, type: "response", declared: "1234", actual: "0" }],
        ["http-length", { url: URI, type: "response", declared: "777", actual: "0" }],
      ]);
    });

    it("同じ名の Content-Length が 2 つ並べば、後ろの値で照らす（前の値だけが合っていても通さない）", async () => {
      expect(
        await check([message({ head: ["HTTP/1.1 200 OK", "Content-Length: 6", "Content-Length: 35"], body: "target" })]),
      ).toEqual([["http-length", { url: URI, type: "response", declared: "35", actual: "6" }]]);
    });

    it("値を置き換えた本文の無い 302 に残った chunked も言う（redacted-records は長さしか見ない）", async () => {
      const redacted = rawRecord(
        [
          "WARC/1.1",
          "WARC-Type: response",
          `WARC-Record-ID: ${recordId(9)}`,
          "WARC-Date: 2026-11-28T00:00:00Z",
          `WARC-Target-URI: ${URI}`,
          "Content-Type: application/http;msgtype=response",
          "BrowserHive-Redacted: headers=1",
          `Content-Length: ${String(Buffer.byteLength("HTTP/1.1 302 Found\r\nLocation: /target?t=***\r\nTransfer-Encoding: chunked\r\n\r\n"))}`,
        ],
        "HTTP/1.1 302 Found\r\nLocation: /target?t=***\r\nTransfer-Encoding: chunked\r\n\r\n",
      );
      expect(await check([redacted])).toEqual([["transfer-encoding", { url: URI, type: "response", value: "chunked" }]]);
    });

    it("本文のある応答でも、長さが本文と違えば言う", async () => {
      expect(
        await check([message({ head: ["HTTP/1.1 200 OK", "Content-Length: 7"], body: "target" })]),
      ).toEqual([["http-length", { url: URI, type: "response", declared: "7", actual: "6" }]]);
    });
  });

  describe("request（1.7.0 から）", () => {
    const post = (head: readonly string[], body = "", fields: readonly string[] = []): Buffer => {
      const block = `${["POST /upload HTTP/1.1", "Host: site.test", ...head].join("\r\n")}\r\n\r\n${body}`;
      return rawRecord(
        [
          "WARC/1.1",
          "WARC-Type: request",
          `WARC-Record-ID: ${recordId(7)}`,
          "WARC-Date: 2026-11-28T00:00:00Z",
          `WARC-Target-URI: ${URI}`,
          "Content-Type: application/http;msgtype=request",
          ...fields,
          `Content-Length: ${String(Buffer.byteLength(block))}`,
        ],
        block,
      );
    };

    it("本文の長さを言う要求と、本文を得られず長さの無い印つきの要求には何も言わない", async () => {
      expect(
        await check(
          [post(["Content-Length: 6"], "a=1&b2"), post(["Content-Type: application/octet-stream"], "", ["WARC-Truncated: unspecified"])],
          WARC_1_7,
        ),
      ).toEqual([]);
    });

    it("本文が 0 バイトなのに送った長さ 2048 が残った要求を言う", async () => {
      expect(await check([post(["Content-Length: 2048"], "", ["WARC-Truncated: unspecified"])], WARC_1_7)).toEqual([
        ["http-length", { url: URI, type: "request", declared: "2048", actual: "0" }],
      ]);
    });

    it("本文を持つのに長さが無い要求を言う —— 長さの無い HTTP/1.1 の要求は本文 0 と読まれる（応答には言わない）", async () => {
      expect(await check([post([], "a=1&b2")], WARC_1_7)).toEqual([["http-length-missing", { url: URI, actual: "6" }]]);
      expect(await check([message({ head: ["HTTP/1.1 200 OK"], body: "target" })], WARC_1_7)).toEqual([]);
    });

    it("WARC-Truncated: unspecified の要求が本文を持てば言う", async () => {
      expect(await check([post(["Content-Length: 6"], "a=1&b2", ["WARC-Truncated: unspecified"])], WARC_1_7)).toEqual([
        ["truncated-body", { url: URI, bytes: "6" }],
      ]);
    });
  });

  describe("当てない所", () => {
    it("1.6.0 を名乗る本の request は見ない —— 同じ要求でも 1.7.0 を名乗る本なら言う", async () => {
      const head = ["POST /form HTTP/1.1", "Host: site.test", "Content-Length: 35", "Transfer-Encoding: chunked"];
      expect(await check([message({ type: "request", head })], WARC_1_6)).toEqual([]);
      expect((await check([message({ type: "request", head })], WARC_1_7)).map(([key]) => key)).toEqual([
        "http-length",
        "transfer-encoding",
      ]);
    });

    it("1.5.0 を名乗る本と、名乗りの無い本には当てない。1.6.0 より新しい版には当てる", async () => {
      const records = [redirect("Content-Length: 35")];
      expect(await check(records, WARC_1_5)).toEqual([]);
      expect(await check(records, null)).toEqual([]);
      expect(await check(records, `${WARC_PROFILE}/latest/`)).toEqual([]);
      expect((await check(records, WARC_2_0)).map(([key]) => key)).toEqual(["http-length"]);
      // 版を字で比べると 1.10.0 が 1.6.0 より前に並ぶ。数で比べる。
      expect((await check(records, `${WARC_PROFILE}/1.10.0/`)).map(([key]) => key)).toEqual(["http-length"]);
    });

    it("browserhive の profile だけで走る", async () => {
      const options = archive([redirect("Content-Length: 35")]);
      expect(await run(options, "spec")).toEqual([]);
      expect(await run(options, "lenient")).toEqual([]);
      expect((await run(options, "browserhive")).length).toBe(1);
    });
  });
});
