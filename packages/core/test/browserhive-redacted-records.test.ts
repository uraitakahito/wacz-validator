// @module-tag engine
/**
 * `browserhive/redacted-records` のテスト。
 *
 * 守っている主張は BrowserHive WARC Profile 1.2.0 の Redacted records。値を置き換えたレコードは
 * `BrowserHive-Redacted` で名乗り、値を含む文字でない本文は落として `WARC-Truncated: secret` で言う。
 *
 * **落とす標本と通す標本は 1 か所だけ違う。** `***` の在り処が要求行か見出しの値か本文か、数が足りるか、metadata の
 * 指す先が response か request か。どれか 1 つでも同じ形にすると、「レコード全体で `***` を数える」「重ねて数える」
 * 「最初の 1 本だけ見る」のような誤った実装が緑で通る。
 *
 * **値が残っていないことは、ここでも確かめていない。** rule が値を知らないので、確かめようがない。
 */
import { describe, expect, it } from "vitest";
import type { Issue, Report, RuleProfile } from "../src/validate/domain.js";
import { sha256Base32, sha256Hex } from "../src/wacz/digest.js";
import { responseRecordId, type FixtureOptions } from "./fixtures/generator.js";
import { firedWarc11Rules, metadataHeader, rawRecord, reportFor } from "./fixtures/warc11.js";

const RULE = "browserhive/redacted-records";
const WARC_PROFILE = "https://uraitakahito.github.io/browserhive-warc-spec";
const WARC_1_1 = `${WARC_PROFILE}/1.1.0/`;
const WARC_1_2 = `${WARC_PROFILE}/1.2.0/`;
const WACZ_1_22 = "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.22.0/";
const FIRST = "archive/data-000.warc.gz";
const SECOND = "archive/data-001.warc.gz";

/** 値を置き換えた URI。query の値が `***` になった。 */
const URI = "https://shop.test/login?key=***";

const recordId = (n: number): string => `<urn:uuid:00000000-0000-0000-0000-${String(1000 + n).padStart(12, "0")}>`;

/** HTTP のメッセージのレコード 1 つ。 */
interface MessageSpec {
  /** 既定は `request`。 */
  type?: string;
  uri?: string;
  /** `WARC-Record-ID` の番号。既定は 0。 */
  id?: number;
  /** `BrowserHive-Redacted` の値。配列なら行を繰り返す。 */
  redacted?: string | readonly string[];
  /** `WARC-Truncated` の値。 */
  truncated?: string;
  /** HTTP の開始行とヘッダの行。省くと type ごとの短い形。 */
  head?: readonly string[];
  body?: string;
  /** block を直に渡す（閉じていない HTTP のヘッダや、HTTP でない block のため）。`head`・`body` より優先。 */
  block?: string;
  /** `Content-Type`。既定は `application/http;msgtype=<type>`。 */
  contentType?: string;
  /** 見出しに足す行。 */
  fields?: readonly string[];
}

const REQUEST_HEAD = ["GET /login HTTP/1.1", "Host: shop.test"];
const RESPONSE_HEAD = ["HTTP/1.1 200 OK", "Content-Type: text/html"];

const blockOf = ({ type = "request", head, body = "", block }: MessageSpec): string =>
  block ?? `${(head ?? (type === "response" ? RESPONSE_HEAD : REQUEST_HEAD)).join("\r\n")}\r\n\r\n${body}`;

const message = (spec: MessageSpec = {}): Buffer => {
  const { type = "request", uri = URI, id = 0, redacted, truncated, contentType, fields = [] } = spec;
  const block = blockOf(spec);
  const redactedLines = redacted === undefined ? [] : typeof redacted === "string" ? [redacted] : redacted;
  return rawRecord(
    [
      "WARC/1.1",
      `WARC-Type: ${type}`,
      `WARC-Record-ID: ${recordId(id)}`,
      "WARC-Date: 2026-05-13T00:00:00Z",
      `WARC-Target-URI: ${uri}`,
      `Content-Type: ${contentType ?? `application/http;msgtype=${type}`}`,
      ...redactedLines.map((line) => `BrowserHive-Redacted: ${line}`),
      ...(truncated === undefined ? [] : [`WARC-Truncated: ${truncated}`]),
      ...fields,
      `Content-Length: ${String(Buffer.byteLength(block))}`,
    ],
    block,
  );
};

/** `application/warc-fields` の metadata のレコード 1 つ。 */
const metadata = (over: { refersTo?: string; body?: string; uri?: string; id?: number; fields?: readonly string[] } = {}): Buffer => {
  const { refersTo, body = "truncated: secret\r\nencodedDataLength: 4821\r\n", uri = URI, id = 500, fields = [] } = over;
  return rawRecord(
    [
      ...metadataHeader(5000 + id, Buffer.byteLength(body)),
      `WARC-Target-URI: ${uri}`,
      ...(refersTo === undefined ? [] : [`WARC-Refers-To: ${refersTo}`]),
      ...fields,
    ],
    body,
  );
};

/** `records` を warcinfo の後ろに持ち、warcinfo が `declared` を名乗る本 1 冊の archive。 */
const archive = (records: readonly Buffer[], declared: string | null = WARC_1_2): FixtureOptions => ({
  ...(declared === null ? {} : { warcinfoLines: [`conformsTo: ${declared}`] }),
  warcRawMembers: [...records],
});

const issuesOf = (report: Report): Issue[] => report.issues.filter((issue) => issue.rule === RULE);

const run = async (options: FixtureOptions, profile: RuleProfile = "browserhive"): Promise<Issue[]> =>
  issuesOf(await reportFor(options, profile));

/** 言ったことを、鍵の末尾と params の組で。 */
const said = (issues: readonly Issue[]): [string, unknown][] =>
  issues.map((issue) => [issue.messageKey.slice(RULE.length + 1), issue.params]);

const check = async (...records: readonly Buffer[]): Promise<[string, unknown][]> => said(await run(archive(records)));

describe("browserhive/redacted-records", () => {
  describe("正の形", () => {
    it("仕様の例の request（target-uri=1, headers=1, payload=2）には何も言わず、WARC 1.1 の rule も何も言わない", async () => {
      const report = await reportFor(
        archive([
          message({
            redacted: "target-uri=1, headers=1, payload=2",
            head: [
              "POST /login?key=*** HTTP/1.1",
              "Host: shop.test",
              "Content-Type: application/x-www-form-urlencoded",
              "Content-Length: 32",
              "X-Api-Key: ***",
            ],
            body: "user=alice&password=***&note=***",
          }),
        ]),
        "browserhive",
      );
      expect(issuesOf(report)).toEqual([]);
      expect(firedWarc11Rules(report)).toEqual([]);
    });

    it("欄を持たないレコードは見ない —— 本文や見出しに *** が在っても、オリジンが送った字かもしれない", async () => {
      expect(
        await check(
          message({
            type: "response",
            uri: "https://shop.test/a",
            head: ["HTTP/1.1 200 OK", "X-Note: ***"],
            body: "/*** a comment ***/",
          }),
        ),
      ).toEqual([]);
    });
  });

  describe("欄を持てるレコード", () => {
    it.each(["metadata", "resource", "revisit", "conversion", "continuation"])("%s が欄を持てば言う", async (type) => {
      expect(await check(message({ type, redacted: "target-uri=1", contentType: "text/plain", block: "x" }))).toEqual([
        ["type", { type, url: URI }],
      ]);
    });

    it("warcinfo が欄を持っても言う", async () => {
      const issues = await run({
        warcinfoLines: [`conformsTo: ${WARC_1_2}`],
        warcRecordPatches: [{ index: 0, set: { "BrowserHive-Redacted": "target-uri=1" } }],
      });
      expect(said(issues)).toEqual([["type", { type: "warcinfo", url: "?" }]]);
    });

    it("見出しの名前の大文字小文字が違っても同じ欄に数える —— WARC 1.1 は名前の大文字小文字を区別しない", async () => {
      expect(
        await check(message({ type: "metadata", contentType: "text/plain", block: "x", fields: ["browserhive-redacted: target-uri=1"] })),
      ).toEqual([["type", { type: "metadata", url: URI }]]);
    });

    it("request と response の欄は言わない", async () => {
      expect(await check(message({ redacted: "target-uri=1" }), message({ type: "response", id: 1, redacted: "target-uri=1" }))).toEqual([]);
    });

    it("値を置き換えた URI を持つ metadata が、欄を持たないのは正しい", async () => {
      expect(await check(metadata({ body: "action: deny\r\npattern: *://shop.test/*\r\nmethod: GET\r\n" }))).toEqual([]);
    });
  });

  describe("欄の形", () => {
    it.each([
      "target-uri=1",
      "headers=1",
      "payload=1",
      "target-uri=1, headers=1",
      "target-uri=1, payload=1",
      "headers=1, payload=1",
      "target-uri=1, headers=1, payload=1",
    ])("%s は文法どおり", async (redacted) => {
      expect(
        await check(message({ redacted, head: ["POST /login HTTP/1.1", "Host: shop.test", "X-Api-Key: ***"], body: "password=***" })),
      ).toEqual([]);
    });

    it("数は 2 桁でもよい", async () => {
      expect(await check(message({ redacted: "payload=10", body: "***".repeat(10) }))).toEqual([]);
    });

    it.each([
      ["空", ""],
      ["数が 0", "target-uri=0"],
      ["先頭に 0", "target-uri=01"],
      ["負の数", "target-uri=-1"],
      ["小数", "target-uri=1.0"],
      ["数が無い", "target-uri="],
      ["= が無い", "target-uri"],
      ["知らない名前", "body=1"],
      ["大文字", "TARGET-URI=1"],
      ["順が違う（headers の前に payload）", "payload=1, headers=1"],
      ["順が違う（target-uri の前に headers）", "headers=1, target-uri=1"],
      ["同じ名前が 2 回", "target-uri=1, target-uri=1"],
      ["区切りに空白が無い", "target-uri=1,headers=1"],
      ["区切りの空白が 2 つ", "target-uri=1,  headers=1"],
      ["区切りがセミコロン", "target-uri=1; headers=1"],
      ["前の区切りだけ", ", target-uri=1"],
      ["後の区切りだけ", "target-uri=1, "],
      ["= の前後の空白", "target-uri = 1"],
    ])("%s は文法に反する", async (_label, redacted) => {
      expect(
        await check(message({ redacted, head: ["GET /login HTTP/1.1", "X-Api-Key: ***"], body: "***" })),
      ).toEqual([["form", { url: URI, found: redacted }]]);
    });

    it("欄が 2 つ在れば言う —— 部分は 1 つの欄に並ぶ", async () => {
      expect(await check(message({ redacted: ["target-uri=1", "headers=1"], head: ["GET /login HTTP/1.1", "X-Api-Key: ***"] }))).toEqual([
        ["repeated", { url: URI, count: "2" }],
      ]);
    });
  });

  describe("数", () => {
    const form = (redacted: string, over: MessageSpec = {}): Promise<[string, unknown][]> => check(message({ redacted, ...over }));

    it("target-uri=N: WARC-Target-URI の *** が足りなければ言う", async () => {
      expect(await form("target-uri=2")).toEqual([["count", { url: URI, part: "target-uri", declared: "2", found: "1" }]]);
    });

    it("target-uri=N: 要求行の *** は数えない —— 要求行は URI の同じ出現を繰り返すだけ", async () => {
      const uri = "https://shop.test/login";
      expect(await form("target-uri=1", { uri, head: ["GET /login?key=*** HTTP/1.1", "Host: shop.test"] })).toEqual([
        ["count", { url: uri, part: "target-uri", declared: "1", found: "0" }],
      ]);
    });

    it("target-uri=N: *** は重ねて数えない —— **** は 1 つ", async () => {
      const uri = "https://shop.test/?a=****";
      expect(await form("target-uri=2", { uri })).toEqual([["count", { url: uri, part: "target-uri", declared: "2", found: "1" }]]);
    });

    it("target-uri=N: 並んだ置き換えは別々に数える —— ****** は 2 つ", async () => {
      expect(await form("target-uri=2", { uri: "https://shop.test/?a=******" })).toEqual([]);
    });

    it("headers=N: 見出しの値の *** を、欄をまたいで足して数える", async () => {
      expect(await form("headers=3", { head: ["GET /login HTTP/1.1", "Cookie: a=***; b=***", "X-Api-Key: ***"] })).toEqual([]);
      expect(await form("headers=4", { head: ["GET /login HTTP/1.1", "Cookie: a=***; b=***", "X-Api-Key: ***"] })).toEqual([
        ["count", { url: URI, part: "headers", declared: "4", found: "3" }],
      ]);
    });

    it.each([
      ["要求行", { head: ["GET /login?key=*** HTTP/1.1", "Host: shop.test"] }],
      ["状態行", { type: "response", head: ["HTTP/1.1 200 ***", "Content-Type: text/html"] }],
      ["見出しの名前", { head: ["GET /login HTTP/1.1", "X-***: value"] }],
      ["本文", { body: "password=***" }],
    ])("headers=N: %s の *** は数えない", async (_label, over) => {
      expect(await form("headers=1", over)).toEqual([["count", { url: URI, part: "headers", declared: "1", found: "0" }]]);
    });

    it("payload=N: 本文の *** が足りなければ言う", async () => {
      expect(await form("payload=2", { body: "password=***" })).toEqual([["count", { url: URI, part: "payload", declared: "2", found: "1" }]]);
    });

    it("payload=N: 見出しの *** は数えない", async () => {
      expect(await form("payload=1", { head: ["GET /login HTTP/1.1", "X-Api-Key: ***"] })).toEqual([
        ["count", { url: URI, part: "payload", declared: "1", found: "0" }],
      ]);
    });

    it("名乗った数より多い *** は言わない —— オリジンが送った同じ字が混ざる", async () => {
      expect(await form("target-uri=1, headers=1, payload=1", {
        uri: "https://shop.test/?a=***&b=***",
        head: ["GET /?a=***&b=*** HTTP/1.1", "X-A: ***", "X-B: ***"],
        body: "/*** a comment ***/ ***",
      })).toEqual([]);
    });

    it("response でも同じに数える", async () => {
      expect(
        await form("target-uri=1, headers=1, payload=2", {
          type: "response",
          head: ["HTTP/1.1 200 OK", "Set-Cookie: s=***; Path=/"],
          body: "<p>welcome ***</p>",
        }),
      ).toEqual([["count", { url: URI, part: "payload", declared: "2", found: "1" }]]);
    });

    it("HTTP のメッセージでない block には、見出しの *** が無い", async () => {
      expect(await form("headers=1", { contentType: "text/plain", block: "X-Api-Key: ***" })).toEqual([
        ["count", { url: URI, part: "headers", declared: "1", found: "0" }],
      ]);
    });

    it("同じ本の同じ誤りは 4 件まで出し、残りの数を最後に載せる", async () => {
      const issues = await run(archive([0, 1, 2, 3, 4, 5].map((id) => message({ id, redacted: "headers=1" }))));
      expect(issues).toHaveLength(4);
      expect(issues.at(-1)?.params?.["more"]).toBe(2);
      expect(issues[0]?.severity).toBe("error");
      expect(issues[0]?.location?.entry).toBe("archive/data.warc.gz");
      expect(issues[0]?.location?.offset).toBeGreaterThan(0);
    });
  });

  describe("WARC-Truncated: secret", () => {
    const droppedResponse = (over: MessageSpec = {}): Buffer =>
      message({ type: "response", id: 1, truncated: "secret", head: ["HTTP/1.1 200 OK", "Content-Type: application/pdf"], ...over });

    it("本文の無い response と、それを指す truncated: secret の metadata の組には何も言わない", async () => {
      expect(await check(droppedResponse(), metadata({ refersTo: recordId(1) }))).toEqual([]);
    });

    it("metadata が先でも、後でも同じ", async () => {
      expect(await check(metadata({ refersTo: recordId(1) }), droppedResponse())).toEqual([]);
    });

    it("値の綴りを置き換えずに本文を落とした request は、WARC-Truncated だけを持つ —— metadata は応答の本文について言うので要らない", async () => {
      expect(await check(message({ truncated: "secret" }))).toEqual([]);
    });

    it("見出しの値を置き換えたうえで本文を落としてよい —— 落とすことは payload に数えない", async () => {
      expect(
        await check(
          droppedResponse({ redacted: "target-uri=1, headers=1", head: ["HTTP/1.1 200 OK", "Content-Type: application/pdf", "X-Key: ***"] }),
          metadata({ refersTo: recordId(1) }),
        ),
      ).toEqual([]);
    });

    it("本文を落としたのに payload を名乗れば言う", async () => {
      expect(await check(droppedResponse({ redacted: "payload=1" }), metadata({ refersTo: recordId(1) }))).toEqual([
        ["count", { url: URI, part: "payload", declared: "1", found: "0" }],
      ]);
    });

    it("response の HTTP のヘッダの後に本文が在れば言う", async () => {
      expect(await check(droppedResponse({ body: "%PDF-1.7" }), metadata({ refersTo: recordId(1) }))).toEqual([
        ["truncated-body", { url: URI, type: "response", bytes: "8" }],
      ]);
    });

    it("request の HTTP のヘッダの後に本文が在れば言う", async () => {
      expect(await check(message({ truncated: "secret", body: "%PDF-1.7" }))).toEqual([
        ["truncated-body", { url: URI, type: "request", bytes: "8" }],
      ]);
    });

    it("値の大文字小文字は揃えて読む —— warc/field-values の読み方と同じ", async () => {
      expect(await check(droppedResponse({ truncated: "SECRET", body: "%PDF-1.7" }), metadata({ refersTo: recordId(1) }))).toEqual([
        ["truncated-body", { url: URI, type: "response", bytes: "8" }],
      ]);
    });

    it("WARC-Truncated の値が secret でなければ、本文が在っても言わない", async () => {
      expect(await check(droppedResponse({ truncated: "length", body: "%PDF-1.7" }))).toEqual([]);
    });

    it.each([
      ["HTTP のヘッダが閉じていない", { block: "HTTP/1.1 200 OK\r\nContent-Type: application/pdf" }],
      ["block が空", { block: "" }],
      ["block が HTTP のメッセージでない", { contentType: "application/pdf", block: "%PDF-1.7" }],
    ])("%s なら言う —— 落とすのは本文で、ヘッダではない", async (_label, over) => {
      expect(await check(droppedResponse(over), metadata({ refersTo: recordId(1) }))).toEqual([
        ["truncated-no-http", { url: URI, type: "response" }],
      ]);
    });

    it("response を指す metadata が無ければ言う", async () => {
      expect(await check(droppedResponse())).toEqual([["no-metadata", { url: URI }]]);
    });

    it("response を指す metadata の truncated が secret でなければ言う", async () => {
      expect(await check(droppedResponse(), metadata({ refersTo: recordId(1), body: "truncated: too-large\r\n" }))).toEqual([
        ["no-metadata", { url: URI }],
      ]);
    });

    it("別の response を指す metadata では足りない", async () => {
      expect(await check(droppedResponse(), metadata({ refersTo: recordId(2) }))).toEqual([
        ["no-metadata", { url: URI }],
        ["metadata-target", { url: URI, target: recordId(2) }],
      ]);
    });

    it("truncated: secret の metadata が何も指さなければ言う", async () => {
      expect(await check(metadata())).toEqual([["metadata-target", { url: URI, target: "-" }]]);
    });

    it("truncated: secret の metadata が、WARC-Truncated の無い response を指せば言う", async () => {
      expect(await check(message({ type: "response", id: 1 }), metadata({ refersTo: recordId(1) }))).toEqual([
        ["metadata-target", { url: URI, target: recordId(1) }],
      ]);
    });

    it("truncated: secret の metadata が request を指せば言う —— この記録は応答についてだけ言う", async () => {
      expect(await check(message({ id: 1, truncated: "secret" }), metadata({ refersTo: recordId(1) }))).toEqual([
        ["metadata-target", { url: URI, target: recordId(1) }],
      ]);
    });

    it("組が別の本に在ることは言わない —— browserhive/exchange-in-one-file が言う", async () => {
      const report = await reportFor(
        {
          software: "browserhive/29.0.0",
          conformsTo: WACZ_1_22,
          warcName: "data-000.warc.gz",
          warcinfoLines: [`conformsTo: ${WARC_1_2}`],
          warcRawMembers: [droppedResponse()],
          extraWarcs: [
            { name: "data-001.warc.gz", warcinfoLines: [`conformsTo: ${WARC_1_2}`], rawMembers: [metadata({ refersTo: recordId(1) })] },
          ],
        },
        "browserhive",
      );
      expect(issuesOf(report)).toEqual([]);
      expect(report.issues.map((issue) => issue.messageKey)).toContain("browserhive/exchange-in-one-file.metadata");
    });
  });

  describe("持っているバイト列", () => {
    const head = ["POST /login HTTP/1.1", "Host: shop.test"];
    const body = "password=***";
    const spec: MessageSpec = { redacted: "payload=1", head, body };
    const held = Buffer.from(blockOf(spec));
    const payload = Buffer.from(body);
    /** 置き換える前の本文の digest。読み手が値の候補を試せる。 */
    const before = sha256Base32(Buffer.from("password=hunter2-long-enough"));

    it("WARC-Block-Digest と WARC-Payload-Digest が持っているバイト列を言えば、何も言わない", async () => {
      expect(
        await check(
          message({
            ...spec,
            fields: [`WARC-Block-Digest: ${sha256Base32(held)}`, `WARC-Payload-Digest: ${sha256Base32(payload)}`],
          }),
        ),
      ).toEqual([]);
    });

    it("digest は Base16 でも padding 付きの Base32 でも読む（warc/payload-digest と同じ読み方）", async () => {
      expect(
        await check(
          message({ ...spec, fields: [`WARC-Block-Digest: ${sha256Hex(held)}`, `WARC-Payload-Digest: ${sha256Base32(payload)}====`] }),
        ),
      ).toEqual([]);
    });

    it("WARC-Block-Digest が置き換える前の物なら言う", async () => {
      expect(await check(message({ ...spec, fields: [`WARC-Block-Digest: ${before}`] }))).toEqual([
        ["digest", { url: URI, field: "WARC-Block-Digest" }],
      ]);
    });

    it("WARC-Payload-Digest が置き換える前の物なら言う（warc/payload-digest の warning とは別に、error で）", async () => {
      const report = await reportFor(archive([message({ ...spec, fields: [`WARC-Payload-Digest: ${before}`] })]), "browserhive");
      expect(said(issuesOf(report))).toEqual([["digest", { url: URI, field: "WARC-Payload-Digest" }]]);
      expect(issuesOf(report)[0]?.severity).toBe("error");
      expect(report.issues.find((issue) => issue.rule === "warc/payload-digest")?.severity).toBe("warning");
    });

    it("WARC-Payload-Digest は本文の物で、block の物ではない", async () => {
      expect(await check(message({ ...spec, fields: [`WARC-Payload-Digest: ${sha256Base32(held)}`] }))).toEqual([
        ["digest", { url: URI, field: "WARC-Payload-Digest" }],
      ]);
    });

    it("本文を落としたレコードの digest が、落とした本文の物なら言う", async () => {
      const dropped = sha256Base32(Buffer.from("%PDF-1.7 ..."));
      expect(
        await check(message({ truncated: "secret", fields: [`WARC-Block-Digest: ${dropped}`, `WARC-Payload-Digest: ${dropped}`] })),
      ).toEqual([
        ["digest", { url: URI, field: "WARC-Block-Digest" }],
        ["digest", { url: URI, field: "WARC-Payload-Digest" }],
      ]);
    });

    it("本文を落としたレコードの digest が、空の本文の物なら言わない", async () => {
      expect(await check(message({ truncated: "secret", fields: [`WARC-Payload-Digest: ${sha256Base32(Buffer.alloc(0))}`] }))).toEqual([]);
    });

    it("sha256 でない digest は計算できないので言わない", async () => {
      expect(await check(message({ ...spec, fields: ["WARC-Block-Digest: sha1:AAAA"] }))).toEqual([]);
    });

    it("欄を持たないレコードの digest は見ない —— それは warc/payload-digest の話", async () => {
      expect(await check(message({ head, body, fields: [`WARC-Block-Digest: ${before}`] }))).toEqual([]);
    });

    it("HTTP の Content-Length が本文の長さなら言わない。名前の大文字小文字は問わない", async () => {
      expect(await check(message({ ...spec, head: [...head, "Content-Length: 12"] }))).toEqual([]);
      expect(await check(message({ ...spec, head: [...head, "content-length: 12"] }))).toEqual([]);
    });

    it("HTTP の Content-Length が置き換える前の長さなら言う", async () => {
      expect(await check(message({ ...spec, head: [...head, "Content-Length: 28"] }))).toEqual([
        ["http-length", { url: URI, declared: "28", actual: "12" }],
      ]);
    });

    it("本文を落としたレコードの HTTP の Content-Length は 0", async () => {
      const dropped = { truncated: "secret" };
      expect(await check(message({ ...dropped, head: [...head, "Content-Length: 0"] }))).toEqual([]);
      expect(await check(message({ ...dropped, head: [...head, "Content-Length: 4821"] }))).toEqual([
        ["http-length", { url: URI, declared: "4821", actual: "0" }],
      ]);
    });

    it("欄を持たないレコードの HTTP の Content-Length は見ない —— 本文の無い 302 は元の長さを残している", async () => {
      expect(await check(message({ type: "response", head: ["HTTP/1.1 302 Found", "Content-Length: 154"] }))).toEqual([]);
    });
  });

  describe("archive の宣言で分ける", () => {
    /** どの判定にも当たるレコード。 */
    const broken = (): Buffer[] => [
      message({ redacted: "nonsense" }),
      message({ id: 1, redacted: "headers=1" }),
      message({ type: "metadata", id: 2, redacted: "target-uri=1", contentType: "text/plain", block: "x" }),
      message({ type: "response", id: 3, truncated: "secret", body: "%PDF-1.7" }),
      metadata({ refersTo: recordId(4) }),
    ];
    const KEYS = ["form", "count", "type", "truncated-body", "no-metadata", "metadata-target"].sort();

    it.each([
      ["1.2.0", `${WARC_PROFILE}/1.2.0/`],
      ["1.3.0", `${WARC_PROFILE}/1.3.0/`],
      ["1.10.0（文字列として比べると 1.2.0 より小さい）", `${WARC_PROFILE}/1.10.0/`],
      ["2.0.0", `${WARC_PROFILE}/2.0.0/`],
    ])("%s を名乗る本は見る", async (_label, declared) => {
      const keys = said(await run(archive(broken(), declared))).map(([key]) => key);
      expect(keys.sort()).toEqual(KEYS);
    });

    it.each([
      ["1.1.0", WARC_1_1],
      ["1.0.0", `${WARC_PROFILE}/1.0.0/`],
      ["0.9.0", `${WARC_PROFILE}/0.9.0/`],
      ["版でない latest/", `${WARC_PROFILE}/latest/`],
      ["WARC 1.1 そのもの", "http://iipc.github.io/warc-specifications/specifications/warc-format/warc-1.1/"],
      ["WACZ Profile の 1.22.0", WACZ_1_22],
    ])("%s を名乗る本は見ない", async (_label, declared) => {
      expect(await run(archive(broken(), declared))).toEqual([]);
    });

    it("名乗りの無い本は見ない", async () => {
      expect(await run(archive(broken(), null))).toEqual([]);
    });

    it("先頭が warcinfo でない本は見ない —— それは browserhive/warc-files が言う", async () => {
      const report = await reportFor(
        {
          software: "browserhive/29.0.0",
          conformsTo: WACZ_1_22,
          warcName: "data-000.warc.gz",
          warcinfoLines: [`conformsTo: ${WARC_1_2}`],
          extraWarcs: [{ name: "data-001.warc.gz", omitWarcinfo: true, rawMembers: broken() }],
        },
        "browserhive",
      );
      expect(issuesOf(report)).toEqual([]);
      expect(report.issues.map((issue) => issue.messageKey)).toContain("browserhive/warc-files.first-record");
    });

    it("先頭が warcinfo でなければ、本文に conformsTo の行が在っても見ない", async () => {
      const claim = metadata({ refersTo: recordId(9), body: `conformsTo: ${WARC_1_2}\r\ntruncated: secret\r\n` });
      const issues = await run({
        warcName: "data-000.warc.gz",
        warcinfoLines: [`conformsTo: ${WARC_1_2}`],
        extraWarcs: [{ name: "data-001.warc.gz", omitWarcinfo: true, rawMembers: [claim, ...broken()] }],
      });
      expect(issues).toEqual([]);
    });

    it("先頭のレコードが読めなければ、その本は見ない", async () => {
      const issues = await run({
        warcName: "data-000.warc.gz",
        warcinfoLines: [`conformsTo: ${WARC_1_2}`],
        extraWarcs: [{ name: "data-001.warc.gz", omitWarcinfo: true, rawMembers: [Buffer.from("not a record"), ...broken()] }],
      });
      expect(issues).toEqual([]);
    });

    it("途中のレコードが読めなくても、後ろのレコードを見る", async () => {
      expect(await check(Buffer.from("not a record"), message({ redacted: "nonsense" }))).toEqual([["form", { url: URI, found: "nonsense" }]]);
    });

    it("本ごとに分ける —— 1.2.0 を名乗る本だけを見る", async () => {
      const badRecords = [message({ redacted: "nonsense" })];
      const locationsOf = async (first: string, second: string): Promise<(string | undefined)[]> => {
        const issues = await run({
          warcName: "data-000.warc.gz",
          warcinfoLines: [`conformsTo: ${first}`],
          warcRawMembers: badRecords,
          extraWarcs: [{ name: "data-001.warc.gz", warcinfoLines: [`conformsTo: ${second}`], rawMembers: badRecords }],
        });
        return issues.map((issue) => issue.location?.entry);
      };
      expect(await locationsOf(WARC_1_2, WARC_1_1)).toEqual([FIRST]);
      expect(await locationsOf(WARC_1_1, WARC_1_2)).toEqual([SECOND]);
    });

    it.each(["spec", "lenient"] as const)("%s の profile では走らない", async (profile) => {
      expect(await run(archive(broken()), profile)).toEqual([]);
    });
  });

  describe("WARC-Target-URI の ***（warc/field-values が見る）", () => {
    const FIELD_VALUES = "warc/field-values";
    const reportOf = (uri: string, profile: RuleProfile = "browserhive"): Promise<Report> =>
      reportFor(
        archive([message({ uri, redacted: "target-uri=1" }), message({ uri, type: "response", id: 1, redacted: "target-uri=1" }), metadata({ uri, body: "reason: loadingFailed\r\n" })]),
        profile,
      );

    it.each(["https:***?b=c", "https:***", "https://***/x", "https://x/?a=***", "data:text/plain;base64,***"])(
      "%s は URI のままで、どの rule も誤りと言わない",
      async (uri) => {
        const report = await reportOf(uri);
        expect(report.issues.filter((issue) => issue.rule === FIELD_VALUES)).toEqual([]);
        expect(report.issues.filter((issue) => issue.severity === "error").map((issue) => issue.messageKey)).toEqual([]);
      },
    );

    it.each(["***", "***?b=c", "***://shop.test/", "//***/x", "h***?b=c"])(
      "%s は scheme が無いので、request・response・metadata のどれでも uri-form の error",
      async (uri) => {
        const report = await reportOf(uri);
        const found = report.issues.filter((issue) => issue.rule === FIELD_VALUES);
        expect(found.map((issue) => [issue.messageKey, issue.severity, issue.params?.["record"]])).toEqual([
          [`${FIELD_VALUES}.uri-form`, "error", "2"],
          [`${FIELD_VALUES}.uri-form`, "error", "3"],
          [`${FIELD_VALUES}.uri-form`, "error", "4"],
        ]);
      },
    );

    it("*** だけの URI も、URI の誤り以外の error にはならず、例外で落ちない", async () => {
      const report = await reportOf("***");
      expect([...new Set(report.issues.filter((issue) => issue.severity === "error").map((issue) => issue.messageKey))]).toEqual([
        `${FIELD_VALUES}.uri-form`,
      ]);
    });
  });

  describe("WARC-Truncated: secret と warc/field-values", () => {
    it.each(["spec", "browserhive", "lenient"] as const)("%s の profile でも、拡張の理由として info のまま", async (profile) => {
      const report = await reportFor(archive([message({ truncated: "secret" })]), profile);
      expect(
        report.issues.filter((issue) => issue.rule === "warc/field-values").map((issue) => [issue.messageKey, issue.severity]),
      ).toEqual([["warc/field-values.unknown-truncated-reason", "info"]]);
    });
  });

  describe("URL を突き合わせる rule は、*** を含む URL でも誤らない", () => {
    const UA = "Mozilla/5.0 Probe BrowserHive";
    /** 値を含まない URL。これと同じことを言うかを比べる。 */
    const PLAIN = "https://shop.test/account?tab=1";
    const SNAPSHOT_ID = "urn:uuid:00000000-0000-0000-0000-000000003000";
    const SHOT = "<!DOCTYPE html><title>t</title>";
    const DATE = "2026-05-13T00:00:00.000Z";

    /** ツリーの行。`url` は読んだ文書を名乗る。 */
    const treeOf = (url: string): Record<string, unknown> => ({
      profile: "browserhive:axtree/1",
      url,
      takenAt: DATE,
      stage: "after-behaviors",
      devicePixelRatio: 1,
      viewport: { width: 1280, height: 800 },
      nodes: 1,
      tree: [{ role: "RootWebArea", name: "t" }],
    });

    /**
     * 同じ URL を、archive の URL を持つ場所の全部に書いた archive。主文書の response と request、読めなかった本文の
     * response と metadata、DOM の写し、ページ一覧、索引、mainPageURL、document、ツリー、crashedTargets。
     * 全部に同じ置き換えが当たった形で、`over` は 1 か所だけを別の URL にする。
     */
    const whole = (url: string, over: Partial<FixtureOptions> = {}): FixtureOptions => {
      const shot = `urn:browserhive:snapshot:after-load:${url}`;
      const unread = `${url}&part=css`;
      return {
        software: "browserhive/29.0.0",
        conformsTo: WACZ_1_22,
        warcName: "data-000.warc.gz",
        warcinfoFilename: "data-000.warc.gz",
        warcinfoLines: [`conformsTo: ${WARC_1_2}`],
        pageUrl: url,
        pageEntries: [
          { id: "document", url, ts: DATE, title: "t" },
          { id: "shot", url: shot, ts: DATE, stage: "after-load", title: "t" },
        ],
        settings: {
          signature: "none",
          viewport: { width: 1280, height: 800 },
          devicePixelRatios: [1],
          session: "isolated",
          userAgent: UA,
          behaviors: [],
          variables: {},
          secrets: ["api_token"],
          secretArchive: {},
          limits: { maxResponseBytes: 1000, maxTaskBytes: 1000, maxWarcBytes: 1000 },
          urlPolicies: [],
          contentTypePolicies: [],
        },
        document: { url },
        axtree: treeOf(url),
        storage: { profile: "browserhive:storage/2", stage: "after-behaviors", valuesRecorded: false, origins: [] },
        settle: {
          strategy: "fully-loaded",
          endedBy: "quiet",
          waitedMs: 2310,
          devicePixelRatio: 1,
          limits: { minMs: 1000, maxMs: 3000, quietMs: 1000, networkConcurrency: 0 },
          load: { atMs: 210 },
          network: { quietAtMs: 2205 },
          cpu: { quietAtMs: 2104 },
          dom: { quietAtMs: 2004 },
        },
        logs: "",
        completeness: {
          bodylessUrls: [],
          truncatedUrls: [],
          uninterceptedUrls: [unread],
          crashedTargets: [{ type: "iframe", status: "crashed", url }],
          complete: false,
        },
        snapshots: [{ stage: "after-load", url: shot, date: DATE, record: SNAPSHOT_ID, bytes: Buffer.byteLength(SHOT), secretsReplaced: 0 }],
        warcResponses: [
          { uri: url, mime: "text/html", body: "<p>welcome</p>" },
          { uri: unread, mime: "text/css", body: "", truncated: "unspecified" },
        ],
        warcResources: [{ uri: shot, date: DATE, recordId: `<${SNAPSHOT_ID}>`, body: SHOT }],
        warcMetadata: [
          { uri: shot, date: DATE, refersTo: `<${SNAPSHOT_ID}>`, fields: { snapshot: "after-load", "document-uri": url, "secrets-replaced": "0" } },
          { uri: unread, refersTo: responseRecordId(1), fields: { truncated: "not-intercepted" } },
        ],
        warcRawMembers: [message({ uri: url, head: ["GET / HTTP/1.1", "Host: shop.test", `User-Agent: ${UA}`] })],
        ...over,
      };
    };

    /** rule と鍵だけを、件数も含めて並べた物。URL の字の違いは言わない。 */
    const keysOf = async (options: FixtureOptions): Promise<string[]> =>
      (await reportFor(options, "browserhive")).issues.map((issue) => `${issue.severity} ${issue.messageKey}`).sort();

    /** 値を含まない URL に言うこと。ここに在る物は、URL の置き換えとは関係が無い。 */
    const baseline = async (): Promise<string[]> => keysOf(whole(PLAIN));

    it.each(["https:***?b=c", "https://***/x", "https://x/?a=***"])("%s を全部の場所に書いても、値を含まない URL と同じことを言う", async (url) => {
      expect(await keysOf(whole(url))).toEqual(await baseline());
    });

    it("値を含まない URL の archive に、error は 1 つも出ない —— 下の比べ方が、早く戻った rule で空振りしていないことの前提", async () => {
      expect((await baseline()).filter((key) => key.startsWith("error "))).toEqual([]);
    });

    it.each<[string, Partial<FixtureOptions>, string]>([
      ["mainPageURL", { mainPageUrlOverride: PLAIN }, "warning cdxj/pages-mainpage.no-cdxj-record"],
      // 写しの document-uri は *** を持つので、身元の warning（not-in-archive）は出ない（WACZ Profile 1.22.0）。ツリーとは突き合わせる。
      ["document.url", { document: { url: PLAIN } }, "error browserhive/document-withheld.tree-url"],
      ["ツリーの url", { axtree: treeOf(PLAIN) }, "error browserhive/document-withheld.tree-url"],
      [
        "uninterceptedUrls",
        { completeness: { bodylessUrls: [], truncatedUrls: [], uninterceptedUrls: [PLAIN], crashedTargets: [], complete: false } },
        "error browserhive/unintercepted-listed.unlisted",
      ],
    ])("対照: %s だけ置き換えを落とすと、突き合わせる rule が言う", async (_label, over, expected) => {
      expect(await keysOf(whole("https://x/?a=***", over))).toContain(expected);
    });

    it("対照: request の WARC-Target-URI だけ置き換えを落とすと、主文書の要求として照らされなくなる（User-Agent を見ない）", async () => {
      const other = message({ uri: PLAIN, head: ["GET / HTTP/1.1", "Host: shop.test", "User-Agent: other"] });
      const same = message({ uri: "https://x/?a=***", head: ["GET / HTTP/1.1", "Host: shop.test", "User-Agent: other"] });
      expect(await keysOf(whole("https://x/?a=***", { warcRawMembers: [other] }))).not.toContain(
        "error browserhive/user-agent-recorded.mismatch",
      );
      expect(await keysOf(whole("https://x/?a=***", { warcRawMembers: [same] }))).toContain(
        "error browserhive/user-agent-recorded.mismatch",
      );
    });

    it("*** だけの URL は、値を含まない URL に言うことに uri-form が足されるだけで、例外で落ちない", async () => {
      const plain = await baseline();
      const bare = await keysOf(whole("***"));
      const extra = [...bare];
      for (const key of plain) {
        const at = extra.indexOf(key);
        if (at !== -1) extra.splice(at, 1);
      }
      expect(extra.length).toBeGreaterThan(0);
      expect([...new Set(extra)]).toEqual(["error warc/field-values.uri-form"]);
    });
  });
});
