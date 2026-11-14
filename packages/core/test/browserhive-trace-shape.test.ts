// @module-tag engine
/**
 * `browserhive/trace-shape` のテスト。
 *
 * 守っている主張は WACZ Profile 1.23.0 の trace・trace-directory・trace-lines。package は取り込みの trace
 * `trace/events.jsonl` を持ち（行が無ければ空のファイル）、resources に載せ、`browserhive:capture.trace` が
 * 行の数を言う。各行は `browserhive:trace/1` を名乗る JSON のオブジェクトで、決まった member と値を持ち、
 * `record` は `archive/` の `response` のレコードを名指す。
 *
 * 標本は正しい archive（`archive()`）から 1 か所だけを崩して作る。崩した 1 か所を、狙った鍵 1 つだけが言うことを
 * 見る —— rule がその 1 か所を見ていることを、区別できる入力で確かめるため。版の条件は、同じ崩れた archive の
 * 版の名乗りだけを替えて見る。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProfileSelector } from "@wacz-validator/contract";
import type { MsgParams } from "../src/i18n/translate.js";
import { renderJson } from "../src/render/json.js";
import { parseReportSource, type Issue, type IssueLocation, type Report } from "../src/validate/domain.js";
import { runValidation } from "../src/validate/engine.js";
import { DEFAULT_RULES } from "../src/validate/rules/index.js";
import { fileTransport } from "../src/wacz/transport.js";
import { WaczReader } from "../src/wacz/reader.js";
import { buildWacz, responseRecordId, type FixtureOptions, type WarcResponseSpec } from "./fixtures/generator.js";

const RULE = "browserhive/trace-shape";
const ENTRY = "trace/events.jsonl";
const DATAPACKAGE = "datapackage.json";
const WARC = "archive/data.warc.gz";
const WACZ_1_22 = "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.22.0/";
const WACZ_1_23 = "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.23.0/";
const TRACE = "browserhive:trace/1";

type Line = Record<string, unknown>;

/** `warcResponses` の `idx` 番目の response を、行の `record` の形（山括弧なし）で。 */
const recordOf = (idx: number): string => responseRecordId(idx).slice(1, -1);

/** response のレコードの `WARC-Date`。行の `startedAt` と同じ字。 */
const DATES = ["2026-11-13T05:00:00.749Z", "2026-11-13T05:00:00.757Z", "2026-11-13T05:00:01.032Z"] as const;

/** 残した交信。リダイレクトの 2 段と、その文書が読んだスクリプト。 */
const goodResponses = (): WarcResponseSpec[] => [
  { uri: "http://site.test/", mime: "text/html", body: "", status: 301, date: DATES[0] },
  { uri: "https://site.test/", mime: "text/html", body: "<p>hello</p>", date: DATES[1] },
  { uri: "https://site.test/app.js", mime: "text/javascript", body: "fetch('/stream')", date: DATES[2] },
];

const TIMING = { dnsMs: 0, connectMs: 1, tlsMs: 0, sendMs: 0, waitMs: 4, receiveMs: 1 };

/**
 * 正しい trace。行の番号（1 から）と中身:
 *
 *   1・2  リダイレクトの 2 段（同じ id。それぞれが自分の response を名指す）
 *   3     読み終えて、response を残した要求
 *   4     方針で残さなかった要求（not-archived）
 *   5     送らせなかった要求（denied）
 *   6     失敗した要求
 *   7     終わりを見られない要求（pending・endUnobservable）
 *   8     読み終えたが、response を書く前に取り込みが止まった要求（record が無い）
 *   9     追うのをやめた要求（evicted）
 *   10    data: の URL（中身の代わりに長さ。urlCut を持つ）
 */
const goodLines = (): Line[] => [
  {
    profile: TRACE, kind: "request", id: "8B877D6D", hop: 0, dpr: 1, url: "http://site.test/", method: "GET",
    resourceType: "Document", initiator: { type: "other" }, startedAt: DATES[0], ms: 324,
    response: { status: 301, protocol: "http/1.1" }, timing: TIMING, durationMs: 8, outcome: "redirected", record: recordOf(0),
  },
  {
    profile: TRACE, kind: "request", id: "8B877D6D", hop: 1, dpr: 1, url: "https://site.test/", method: "GET",
    resourceType: "Document", initiator: { type: "other" }, startedAt: DATES[1], ms: 332,
    response: { status: 200, protocol: "h2" }, timing: TIMING, durationMs: 41, encodedBytes: 5120, outcome: "finished", record: recordOf(1),
  },
  {
    profile: TRACE, kind: "request", id: "1234.2", hop: 0, dpr: 1, url: "https://site.test/app.js", method: "GET",
    resourceType: "Script", initiator: { type: "parser", url: "https://site.test/", line: 3 }, startedAt: DATES[2], ms: 607,
    response: { status: 200, protocol: "h2", fromCache: true }, timing: TIMING, durationMs: 12, encodedBytes: 214, outcome: "finished", record: recordOf(2),
  },
  {
    profile: TRACE, kind: "request", id: "1234.3", hop: 0, dpr: 1, url: "https://analytics.test/collect?v=2", method: "POST",
    resourceType: "Ping", startedAt: "2026-11-13T05:00:01.630Z", ms: 1205, outcome: "not-archived",
  },
  {
    profile: TRACE, kind: "request", id: "1234.4", hop: 0, dpr: 1, url: "https://ads.test/pixel.gif", method: "GET",
    resourceType: "Image", startedAt: "2026-11-13T05:00:01.640Z", ms: 1215, outcome: "denied",
  },
  {
    profile: TRACE, kind: "request", id: "1234.5", hop: 0, dpr: 1, url: "https://gone.test/font.woff2", method: "GET",
    resourceType: "Font", initiator: { type: "parser", url: "https://site.test/" }, startedAt: "2026-11-13T05:00:01.650Z", ms: 1225,
    durationMs: 30, outcome: "failed", error: "net::ERR_NAME_NOT_RESOLVED",
  },
  {
    profile: TRACE, kind: "request", id: "1234.6", hop: 0, dpr: 1, url: "https://frames.test/embed", method: "GET",
    resourceType: "Document", initiator: { type: "parser", url: "https://site.test/" }, startedAt: "2026-11-13T05:00:01.660Z", ms: 1235,
    outcome: "pending", endUnobservable: true,
  },
  {
    profile: TRACE, kind: "request", id: "1234.7", hop: 0, dpr: 1, url: "https://site.test/late.json", method: "GET",
    resourceType: "Fetch", initiator: { type: "script", url: "https://site.test/app.js", line: 1 }, startedAt: "2026-11-13T05:00:01.700Z", ms: 1275,
    response: { status: 200, protocol: "h2" }, timing: TIMING, durationMs: 9, encodedBytes: 88, outcome: "finished",
  },
  {
    profile: TRACE, kind: "request", id: "1234.8", hop: 0, url: "https://site.test/stream", method: "GET",
    resourceType: "Fetch", initiator: { type: "script", url: "https://site.test/app.js", line: 1 }, startedAt: "2026-11-13T05:00:01.710Z", ms: 1285,
    outcome: "evicted",
  },
  {
    profile: TRACE, kind: "request", id: "1234.9", hop: 0, dpr: 1, url: "data:image/png;base64,(1366)", urlCut: true, method: "GET",
    resourceType: "Image", initiator: { type: "parser", url: "https://site.test/" }, startedAt: "2026-11-13T05:00:01.720Z", ms: 1295,
    response: { status: 200 }, durationMs: 0, encodedBytes: 0, outcome: "finished",
  },
];

/**
 * WACZ Profile 1.23.0 を名乗る正しい archive。`over` で 1 か所を崩す。要約（`traceSummary`）は生成器が行から
 * 作らないので、行を増やし減らししたら、ここで渡す。
 */
const archive = (over: Partial<FixtureOptions> = {}): FixtureOptions => ({
  software: "browserhive/31.0.0",
  conformsTo: WACZ_1_23,
  warcResponses: goodResponses(),
  trace: goodLines(),
  traceSummary: { lines: goodLines().length, dropped: 0 },
  ...over,
});

/** trace のエントリを持たない archive（resources の行も無い。要約とほかは `archive(over)` と同じ）。 */
const withoutEntry = (over: Partial<FixtureOptions> = {}): FixtureOptions => {
  const { trace: _dropped, ...rest } = archive(over);
  return rest;
};

/** 正しい trace の `index` 番目の行（0 から）を `patch` で崩す。`undefined` の値は member ごと消す。 */
const withLine = (index: number, patch: Line): Line[] =>
  goodLines().map((line, i) =>
    i === index ? Object.fromEntries(Object.entries({ ...line, ...patch }).filter(([, v]) => v !== undefined)) : line,
  );

const bad = (messageKey: string, params: MsgParams, location: IssueLocation | number = { entry: ENTRY }): Issue => ({
  rule: RULE,
  severity: "error",
  messageKey: `${RULE}.${messageKey}`,
  params,
  location: typeof location === "number" ? { entry: ENTRY, line: location } : location,
});

const reportFor = async (tmpDir: string, options: FixtureOptions, selector: ProfileSelector): Promise<Report> => {
  const { bytes } = await buildWacz(options);
  const path = join(tmpDir, "fixture.wacz");
  await writeFile(path, bytes);
  const source = parseReportSource(path);
  if (!source.ok || source.value.kind !== "file") throw new Error("unreachable");
  const reader = await WaczReader.open(fileTransport(source.value.path));
  try {
    const result = await runValidation(reader, { validatorVersion: "0.0.0", rules: DEFAULT_RULES, profile: selector });
    if (!result.ok) throw new Error("runValidation returned err — unreachable");
    return result.value;
  } finally {
    await reader.close();
  }
};

describe("browserhive/trace-shape", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "wacz-validator-trace-shape-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const run = async (options: FixtureOptions, selector: ProfileSelector = { name: "browserhive" }): Promise<Issue[]> =>
    (await reportFor(tmpDir, options, selector)).issues.filter((i) => i.rule === RULE);

  /** 指摘の鍵だけ（`browserhive/trace-shape.` を除く）。 */
  const keys = async (options: FixtureOptions): Promise<string[]> =>
    (await run(options)).map((i) => i.messageKey.slice(RULE.length + 1));

  describe("正しい archive", () => {
    it("決まりどおりの trace なら何も言わず、rule は passed に数えられる", async () => {
      const good = await reportFor(tmpDir, archive(), { name: "browserhive" });
      expect(good.issues.filter((i) => i.rule === RULE)).toEqual([]);
      // trace は resources に載っている（datapackage/resources-complete も何も言わない）。
      expect(good.entries.find((e) => e.path === ENTRY)).toMatchObject({ present: true, expectedBy: ["datapackage"], issues: [] });
      // trace の 1 行だけを崩した同じ archive では、passed がこの rule の 1 つだけ減る。
      const broken = await reportFor(tmpDir, archive({ trace: withLine(2, { method: undefined }) }), { name: "browserhive" });
      expect(broken.issues.filter((i) => i.rule === RULE)).toHaveLength(1);
      expect(good.summary.passed).toBe(broken.summary.passed + 1);
    });

    it("行が無ければ空のファイルで足りる（response も無い取り込み）", async () => {
      expect(await run(archive({ warcResponses: [], trace: "", traceSummary: { lines: 0, dropped: 0 } }))).toEqual([]);
    });

    it("行を省いたと言う package（dropped が 1 以上）では、名指されていない response が在ってよい", async () => {
      const trace = goodLines().filter((_, i) => i !== 2);
      expect(await run(archive({ trace, traceSummary: { lines: trace.length, dropped: 1 } }))).toEqual([]);
    });

    it("http(s) でない response は、名指されなくてよい", async () => {
      const warcResponses = [...goodResponses(), { uri: "urn:example:note", mime: "text/plain", body: "note" }];
      expect(await run(archive({ warcResponses }))).toEqual([]);
    });

    it("2 本目の本の response も、record で名指せる", async () => {
      const second = "<urn:uuid:00000000-0000-0000-0000-000000000300>";
      const extraWarcs = [
        { name: "data-001.warc.gz", responses: [{ uri: "https://site.test/late.json", mime: "application/json", body: "{}", recordId: second, date: "2026-11-13T05:00:01.700Z" }] },
      ];
      expect(await run(archive({ extraWarcs, trace: withLine(7, { record: second.slice(1, -1) }) }))).toEqual([]);
    });

    it("時刻の順は見ない（行は producer の作った順で、startedAt も ms も戻りうる）", async () => {
      const trace = goodLines();
      trace[4] = { ...trace[4], startedAt: "2026-11-13T05:00:00.100Z", ms: 3 };
      expect(await run(archive({ trace }))).toEqual([]);
    });

    it("行の url は WARC-Target-URI と照らさない（値を置き換え、切るので、同じとは限らない）", async () => {
      const trace = withLine(2, { url: "https://site.test/app.js?token=***", urlCut: true });
      expect(await run(archive({ trace }))).toEqual([]);
    });
  });

  describe("エントリ", () => {
    it("trace/events.jsonl が無ければ error（そのことだけを言う）", async () => {
      expect(await run(withoutEntry())).toEqual([bad("missing", {})]);
    });

    it("エントリが在っても、resources に載っていなければ error", async () => {
      const mutateResources: FixtureOptions["mutateResources"] = (defaults) => defaults.filter((r) => r.path !== ENTRY);
      expect(await run(archive({ mutateResources }))).toEqual([bad("not-in-resources", {})]);
    });

    it("JSON でない行と、オブジェクトでない JSON の行は error。空の行は飛ばし、行番号はファイルの行で数える", async () => {
      const [first, second] = goodLines();
      const trace = `${JSON.stringify(first)}\n${JSON.stringify(second)}\nnot json\n\n[1,2]\n`;
      const warcResponses = goodResponses().slice(0, 2);
      // 行の数は、読めない行も数える（空の行は数えない）。
      expect(await run(archive({ warcResponses, trace, traceSummary: { lines: 4, dropped: 0 } }))).toEqual([
        bad("not-json", { line: "3" }, 3),
        bad("not-json", { line: "5" }, 5),
      ]);
    });
  });

  describe("要約（browserhive:capture.trace）", () => {
    it("trace の member が無ければ error。行の数と、名指されていない response は見ない", async () => {
      const { traceSummary: _dropped, ...rest } = archive({ trace: goodLines().slice(0, 2) });
      expect(await run(rest)).toEqual([bad("summary-missing", { found: "undefined" }, { entry: DATAPACKAGE })]);
    });

    it("オブジェクトでなければ error", async () => {
      expect(await run(archive({ traceSummary: 10 }))).toEqual([bad("summary-missing", { found: "10" }, { entry: DATAPACKAGE })]);
    });

    it("lines と dropped が 0 以上の整数でなければ error", async () => {
      expect(await run(archive({ traceSummary: { lines: "10", dropped: 0 } }))).toEqual([
        bad("summary-member", { member: "lines", found: '"10"' }, { entry: DATAPACKAGE }),
      ]);
      expect(await run(archive({ traceSummary: { lines: 10 } }))).toEqual([
        bad("summary-member", { member: "dropped", found: "undefined" }, { entry: DATAPACKAGE }),
      ]);
      expect(await run(archive({ traceSummary: { lines: 10, dropped: -1 } }))).toEqual([
        bad("summary-member", { member: "dropped", found: "-1" }, { entry: DATAPACKAGE }),
      ]);
    });

    it("lines がエントリの行の数と違えば error", async () => {
      expect(await run(archive({ traceSummary: { lines: 11, dropped: 0 } }))).toEqual([bad("line-count", { declared: "11", found: 10 })]);
      // 行を 1 つ抜いて要約を直さない。抜いたのは response を名指さない行なので、言うのは数だけ。
      const trace = goodLines().filter((_, i) => i !== 8);
      expect(await run(archive({ trace }))).toEqual([bad("line-count", { declared: "10", found: 9 })]);
    });
  });

  describe("行の member", () => {
    it("必須の member が 1 つ無ければ error", async () => {
      expect(await run(archive({ trace: withLine(2, { method: undefined }) }))).toEqual([
        bad("missing-member", { line: "3", members: "method" }, 3),
      ]);
    });

    it("必須の member が幾つも無ければ、1 件にまとめて並べる", async () => {
      const trace = withLine(3, { kind: undefined, hop: undefined, startedAt: undefined, outcome: undefined });
      expect(await run(archive({ trace }))).toEqual([bad("missing-member", { line: "4", members: "kind, hop, startedAt, outcome" }, 4)]);
    });

    it("startedAt の無い行が record を持っていても、言うのは無いことだけ", async () => {
      expect(await run(archive({ trace: withLine(2, { startedAt: undefined }) }))).toEqual([
        bad("missing-member", { line: "3", members: "startedAt" }, 3),
      ]);
    });

    it("browserhive:trace/1 でない版を名乗る行は、そのことだけを言う（その先は見ず、名指した response は名指されたまま）", async () => {
      const trace = withLine(2, { profile: "browserhive:trace/2", method: undefined, startedAt: "later" });
      expect(await run(archive({ trace }))).toEqual([bad("unknown-profile", { line: "3", found: '"browserhive:trace/2"' }, 3)]);
      expect(await run(archive({ trace: withLine(3, { profile: undefined }) }))).toEqual([
        bad("unknown-profile", { line: "4", found: "undefined" }, 4),
      ]);
    });

    it("kind が request でなければ error", async () => {
      expect(await run(archive({ trace: withLine(3, { kind: "websocket" }) }))).toEqual([bad("kind", { line: "4", found: '"websocket"' }, 4)]);
    });

    it("outcome が決まった値でなければ error（その行の、outcome で決まる決まりは見ない）", async () => {
      const trace = withLine(5, { outcome: "aborted", error: undefined });
      expect(await run(archive({ trace }))).toEqual([bad("outcome", { line: "6", found: '"aborted"' }, 6)]);
    });

    it("id・url・method が文字列でなければ error", async () => {
      expect(await run(archive({ trace: withLine(8, { id: 1234.8 }) }))).toEqual([
        bad("not-string", { line: "9", member: "id", found: "1234.8" }, 9),
      ]);
      expect(await run(archive({ trace: withLine(8, { url: null, method: ["GET"] }) }))).toEqual([
        bad("not-string", { line: "9", member: "url", found: "null" }, 9),
        bad("not-string", { line: "9", member: "method", found: '["GET"]' }, 9),
      ]);
    });

    it("hop と ms が負・小数・文字なら error", async () => {
      expect(await run(archive({ trace: withLine(3, { hop: -1 }) }))).toEqual([bad("hop", { line: "4", found: "-1" }, 4)]);
      expect(await run(archive({ trace: withLine(3, { hop: "0" }) }))).toEqual([bad("hop", { line: "4", found: '"0"' }, 4)]);
      expect(await run(archive({ trace: withLine(3, { ms: 1205.5 }) }))).toEqual([bad("ms", { line: "4", found: "1205.5" }, 4)]);
      expect(await run(archive({ trace: withLine(3, { ms: "1205" }) }))).toEqual([bad("ms", { line: "4", found: '"1205"' }, 4)]);
    });

    it("startedAt が RFC 3339 の時刻でなければ error", async () => {
      expect(await run(archive({ trace: withLine(3, { startedAt: "2026-11-13 05:00:01" }) }))).toEqual([
        bad("started-at", { line: "4", found: '"2026-11-13 05:00:01"' }, 4),
      ]);
      expect(await run(archive({ trace: withLine(3, { startedAt: 1_763_010_001_630 }) }))).toEqual([
        bad("started-at", { line: "4", found: "1763010001630" }, 4),
      ]);
    });
  });

  describe("リダイレクトの連なり（同じ id の行）", () => {
    it("同じ id の 2 行の hop を入れ替えると error（昇順でない）", async () => {
      const trace = goodLines();
      trace[0] = { ...trace[0], hop: 1 };
      trace[1] = { ...trace[1], hop: 0 };
      expect(await run(archive({ trace }))).toEqual([
        bad("hop-order", { line: "2", id: "8B877D6D", hop: "0", previous: "1", previousLine: "1" }, 2),
      ]);
    });

    it("同じ id の 2 行が同じ hop を持てば error（昇順でない、とは言わない）", async () => {
      expect(await run(archive({ trace: withLine(1, { hop: 0 }) }))).toEqual([
        bad("hop-repeated", { line: "2", id: "8B877D6D", hop: "0", firstLine: "1" }, 2),
      ]);
    });

    it("id の違う行の hop は比べない。間の空いた hop も言わない", async () => {
      expect(await run(archive({ trace: withLine(1, { hop: 5 }) }))).toEqual([]);
    });
  });

  describe("outcome で決まる member", () => {
    it("残さなかった要求の行が応答の status を持てば error", async () => {
      expect(await run(archive({ trace: withLine(3, { response: { status: 204 } }) }))).toEqual([
        bad("withheld-member", { line: "4", outcome: "not-archived", members: "response" }, 4),
      ]);
    });

    it("送らせなかった要求の行が持たない member を幾つも持てば、1 件にまとめて並べる（durationMs と encodedBytes も、ここでだけ言う）", async () => {
      const trace = withLine(4, { initiator: { type: "parser" }, timing: TIMING, durationMs: 3, encodedBytes: 43 });
      expect(await run(archive({ trace }))).toEqual([
        bad("withheld-member", { line: "5", outcome: "denied", members: "initiator, timing, durationMs, encodedBytes" }, 5),
      ]);
    });

    it("同じ response を、失敗した要求の行が持っても何も言わない（持てないのは not-archived と denied の行だけ）", async () => {
      expect(await run(archive({ trace: withLine(5, { response: { status: 204 } }) }))).toEqual([]);
    });

    it("失敗した要求の行に error が無ければ error", async () => {
      expect(await run(archive({ trace: withLine(5, { error: undefined }) }))).toEqual([bad("error-missing", { line: "6" }, 6)]);
    });

    it("失敗していない要求の行が error を持てば error", async () => {
      expect(await run(archive({ trace: withLine(8, { error: "net::ERR_ABORTED" }) }))).toEqual([
        bad("error-unexpected", { line: "9", outcome: "evicted" }, 9),
      ]);
    });

    it("pending でない行が endUnobservable を持てば error", async () => {
      expect(await run(archive({ trace: withLine(8, { endUnobservable: true }) }))).toEqual([
        bad("end-unobservable", { line: "9", outcome: "evicted" }, 9),
      ]);
    });

    it("producer が終わりを見ていない行（pending・evicted）が durationMs を持てば error", async () => {
      expect(await run(archive({ trace: withLine(6, { durationMs: 5 }) }))).toEqual([
        bad("duration-unexpected", { line: "7", outcome: "pending" }, 7),
      ]);
      expect(await run(archive({ trace: withLine(8, { durationMs: 0 }) }))).toEqual([
        bad("duration-unexpected", { line: "9", outcome: "evicted" }, 9),
      ]);
    });

    it("読み終えていない行（redirected・failed）が encodedBytes を持てば error（durationMs は持ってよい）", async () => {
      expect(await run(archive({ trace: withLine(0, { encodedBytes: 120 }) }))).toEqual([
        bad("encoded-bytes-unexpected", { line: "1", outcome: "redirected" }, 1),
      ]);
      expect(await run(archive({ trace: withLine(5, { encodedBytes: 0 }) }))).toEqual([
        bad("encoded-bytes-unexpected", { line: "6", outcome: "failed" }, 6),
      ]);
    });

    it("pending の行が durationMs と encodedBytes の両方を持てば、決まりごとに 1 件ずつ言う", async () => {
      expect(await keys(archive({ trace: withLine(6, { durationMs: 5, encodedBytes: 88 }) }))).toEqual([
        "duration-unexpected",
        "encoded-bytes-unexpected",
      ]);
    });

    it("urlCut・endUnobservable・response.fromCache は、在れば true", async () => {
      expect(await run(archive({ trace: withLine(8, { urlCut: false }) }))).toEqual([
        bad("flag-not-true", { line: "9", member: "urlCut", found: "false" }, 9),
      ]);
      expect(await run(archive({ trace: withLine(6, { endUnobservable: false }) }))).toEqual([
        bad("flag-not-true", { line: "7", member: "endUnobservable", found: "false" }, 7),
      ]);
      expect(await run(archive({ trace: withLine(2, { response: { status: 200, protocol: "h2", fromCache: "yes" } }) }))).toEqual([
        bad("flag-not-true", { line: "3", member: "response.fromCache", found: '"yes"' }, 3),
      ]);
    });

    it("url が data: の URL なのに urlCut が無ければ error", async () => {
      expect(await run(archive({ trace: withLine(9, { urlCut: undefined }) }))).toEqual([bad("data-url-not-cut", { line: "10" }, 10)]);
    });
  });

  describe("record と WARC のレコード", () => {
    it("record が実在しない ID なら error（response を名指していなかった行で。言うのはそのことだけ）", async () => {
      const ghost = "urn:uuid:00000000-0000-0000-0000-00000000dead";
      expect(await run(archive({ trace: withLine(7, { record: ghost }) }))).toEqual([
        bad("record-unknown", { line: "8", found: `"${ghost}"` }, 8),
      ]);
    });

    it("response を名指していた行の record を書き換えると、名指す先が無いことと、名指されない response の 2 つを言う", async () => {
      const ghost = "urn:uuid:00000000-0000-0000-0000-00000000dead";
      expect(await keys(archive({ trace: withLine(2, { record: ghost }) }))).toEqual(["record-unknown", "response-unnamed"]);
    });

    it("山括弧つきの ID と、request のレコードの ID は、response を名指していない", async () => {
      expect(await run(archive({ trace: withLine(7, { record: responseRecordId(2) }) }))).toEqual([
        bad("record-unknown", { line: "8", found: `"${responseRecordId(2)}"` }, 8),
      ]);
      const request = "<urn:uuid:00000000-0000-0000-0000-000000000400>";
      const warcRequests = [{ uri: "https://site.test/late.json", recordId: request, date: "2026-11-13T05:00:01.700Z" }];
      expect(await run(archive({ warcRequests, trace: withLine(7, { record: request.slice(1, -1) }) }))).toEqual([
        bad("record-unknown", { line: "8", found: `"${request.slice(1, -1)}"` }, 8),
      ]);
      expect(await run(archive({ trace: withLine(7, { record: 2 }) }))).toEqual([bad("record-unknown", { line: "8", found: "2" }, 8)]);
    });

    it("startedAt が、名指した response の WARC-Date と 1 ms でも違えば error", async () => {
      expect(await run(archive({ trace: withLine(2, { startedAt: "2026-11-13T05:00:01.033Z" }) }))).toEqual([
        bad("started-at-differs", { line: "3", found: "2026-11-13T05:00:01.033Z", date: DATES[2], record: `"${recordOf(2)}"` }, 3),
      ]);
    });

    it("同じ時刻でも、字が違えば error（末尾の 0 を落とした秒）", async () => {
      const warcResponses = goodResponses();
      warcResponses[2] = { ...warcResponses[2], date: "2026-11-13T05:00:01.03Z" } as WarcResponseSpec;
      expect(await run(archive({ warcResponses, trace: withLine(2, { startedAt: "2026-11-13T05:00:01.030Z" }) }))).toEqual([
        bad("started-at-differs", { line: "3", found: "2026-11-13T05:00:01.030Z", date: "2026-11-13T05:00:01.03Z", record: `"${recordOf(2)}"` }, 3),
      ]);
    });

    it("2 行が同じ record を持てば error（後の行で言う）", async () => {
      const trace = withLine(7, { record: recordOf(2), startedAt: DATES[2] });
      expect(await run(archive({ trace }))).toEqual([bad("record-repeated", { line: "8", record: `"${recordOf(2)}"`, firstLine: "3" }, 8)]);
    });

    it("response を 1 つ足して行を足さなければ error（レコードの場所で言う）", async () => {
      const warcResponses = [...goodResponses(), { uri: "https://site.test/extra.css", mime: "text/css", body: "p{}" }];
      const issues = await run(archive({ warcResponses }));
      expect(issues).toEqual([
        bad("response-unnamed", { url: "https://site.test/extra.css", record: recordOf(3) }, { entry: WARC, offset: expect.any(Number) as number }),
      ]);
      expect(issues[0]?.location?.offset).toBeGreaterThan(0);
    });

    it("2 本目の本の response も、名指されていなければ error", async () => {
      const second = "<urn:uuid:00000000-0000-0000-0000-000000000300>";
      const extraWarcs = [{ name: "data-001.warc.gz", responses: [{ uri: "https://site.test/extra.css", mime: "text/css", body: "p{}", recordId: second }] }];
      expect(await run(archive({ extraWarcs }))).toEqual([
        bad("response-unnamed", { url: "https://site.test/extra.css", record: second.slice(1, -1) }, { entry: "archive/data-001.warc.gz", offset: expect.any(Number) as number }),
      ]);
    });
  });

  describe("同じ指摘は丸める", () => {
    /** 6 行とも method の無い trace と、名指されない response が 6 つの archive。 */
    const repeated = (): FixtureOptions => {
      const trace = goodLines()
        .slice(3, 9)
        .map((line) => Object.fromEntries(Object.entries(line).filter(([member]) => member !== "method")));
      const warcResponses = Array.from({ length: 6 }, (_, i) => ({ uri: `https://site.test/${String(i)}.css`, mime: "text/css", body: "p{}" }));
      return archive({ warcResponses, trace, traceSummary: { lines: trace.length, dropped: 0 } });
    };

    it("同じエントリの同じ指摘は 4 件まで出し、4 件目が残りの数を運ぶ", async () => {
      const issues = await run(repeated());
      expect(issues.map((i) => `${i.messageKey.slice(RULE.length + 1)}@${String(i.location?.line ?? i.location?.entry)}/${String(i.params?.["more"] ?? "")}`)).toEqual([
        "missing-member@1/",
        "missing-member@2/",
        "missing-member@3/",
        "missing-member@4/2",
        `response-unnamed@${WARC}/`,
        `response-unnamed@${WARC}/`,
        `response-unnamed@${WARC}/`,
        `response-unnamed@${WARC}/2`,
      ]);
    });

    it("残りの数の文は、WARC の本ではなくファイルを言う（ja の共通の文は「同じ本に」）", async () => {
      const report = await reportFor(tmpDir, repeated(), { name: "browserhive" });
      const messages = (locale: "en" | "ja"): string[] =>
        (JSON.parse(renderJson(report, locale)) as { issues: { rule: string; message: string }[] }).issues
          .filter((i) => i.rule === RULE)
          .map((i) => i.message);
      expect(messages("ja")[3]).toBe("trace/events.jsonl の 4 行目に method が無い（BrowserHive WACZ Profile 1.23.0 の必須）（同じファイルにほか 2 件）");
      expect(messages("ja")[2]).toBe("trace/events.jsonl の 3 行目に method が無い（BrowserHive WACZ Profile 1.23.0 の必須）");
      expect(messages("en")[3]).toBe("trace/events.jsonl line 4 lacks method (required by BrowserHive WACZ Profile 1.23.0) (and 2 more like this in the same file)");
    });
  });

  describe("版の条件", () => {
    /** 版の条件のほかでは必ず落ちる archive。行が壊れ、名指されない response が在る。 */
    const broken = (): FixtureOptions =>
      archive({
        warcResponses: [...goodResponses(), { uri: "https://site.test/extra.css", mime: "text/css", body: "p{}" }],
        trace: withLine(2, { method: undefined, startedAt: "2026-11-13T05:00:01.033Z", hop: -1 }),
      });

    it("WACZ Profile 1.22.0 を名乗る archive には当てない（trace が無くても、要約が無くても、行が壊れていても）", async () => {
      expect(await run({ ...broken(), conformsTo: WACZ_1_22 })).toEqual([]);
      const { traceSummary: _dropped, ...bare } = withoutEntry({ conformsTo: WACZ_1_22 });
      expect(await run(bare)).toEqual([]);
      // 同じ archive でも、1.23.0 を名乗れば落ちる。黙ったのは archive の版のせいで、trace の形のせいではない。
      expect(await keys(broken())).toEqual(["missing-member", "hop", "started-at-differs", "response-unnamed"]);
      expect(await keys({ ...bare, conformsTo: WACZ_1_23 })).toEqual(["summary-missing", "missing"]);
    });

    it("archive が版を名乗らなければ当てない", async () => {
      const { conformsTo: _dropped, ...unnamed } = broken();
      expect(await run(unnamed)).toEqual([]);
    });

    it("producer の版を添えた実行でも、決めるのは archive の版（skipped にも入らない）", async () => {
      const report = await reportFor(tmpDir, broken(), { name: "browserhive", version: { major: 1, minor: 0, patch: 0 } });
      expect(report.issues.filter((i) => i.rule === RULE)).toHaveLength(4);
      expect((report.skipped ?? []).map((s) => s.rule)).not.toContain(RULE);
      const old = await reportFor(tmpDir, { ...broken(), conformsTo: WACZ_1_22 }, { name: "browserhive", version: { major: 30, minor: 0, patch: 0 } });
      expect((old.skipped ?? []).map((s) => s.rule)).not.toContain(RULE);
    });

    it("spec の profile では走らない（browserhive 固有の形）", async () => {
      expect(await run(broken(), { name: "spec" })).toEqual([]);
    });
  });
});
