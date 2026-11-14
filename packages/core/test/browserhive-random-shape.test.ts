// @module-tag engine
/**
 * `browserhive/random-shape` のテスト。
 *
 * 守っている主張は WACZ Profile 1.26.0 の random・random-directory・random-lines。`browserhive:capture.random`
 * が、ページのスクリプトが受け取った乱数を package が持つか（`recorded`）を言い、持つなら package は
 * `random/values.jsonl` と `random/recorder.js` を持って resources に載せ、持たないなら（文書を伏せた package も）
 * どちらも持たない。各行は `browserhive:random/1` を名乗る JSON のオブジェクトで、文書の行と値の行の決まった
 * member と値を持ち、文書の行の `record` は `archive/` の `response` のレコードを名指す。
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

const RULE = "browserhive/random-shape";
const ENTRY = "random/values.jsonl";
const RECORDER = "random/recorder.js";
const DATAPACKAGE = "datapackage.json";
const WACZ_1_25 = "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.25.0/";
const WACZ_1_26 = "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.26.0/";
const RANDOM = "browserhive:random/1";

type Line = Record<string, unknown>;

/** `warcResponses` の `idx` 番目の response を、行の `record` の形（山括弧なし）で。 */
const recordOf = (idx: number): string => responseRecordId(idx).slice(1, -1);

/** response のレコードの `WARC-Date`。文書の行の `date` と同じ字。 */
const DATES = ["2026-11-14T02:10:00.757Z", "2026-11-14T02:10:01.204Z", "2026-11-14T02:10:01.300Z"] as const;

/** 残した交信。主の文書、フレームの文書、主の文書が読んだスクリプト。 */
const goodResponses = (): WarcResponseSpec[] => [
  { uri: "https://shop.test/", mime: "text/html", body: "<p>shop</p>", date: DATES[0] },
  { uri: "https://shop.test/widgets/recommend", mime: "text/html", body: "<p>widget</p>", date: DATES[1] },
  { uri: "https://shop.test/assets/hero.js", mime: "text/javascript", body: "Math.random()", date: DATES[2] },
];

const HERO = "https://shop.test/assets/hero.js";

/**
 * 正しい控え。行の番号（1 から）と中身:
 *
 *   1  文書 0（主のフレーム。response を名指す）
 *   2  文書 0 の値 0（Math.random）
 *   3  文書 1（フレームの中。response を名指す）
 *   4  文書 1 の値 0（crypto.randomUUID）
 *   5  文書 0 の値 1（crypto.getRandomValues・4 バイト。文書 1 の行の後ろに挟まる）
 *   6  文書 0 の値 2（Math.random。呼び出し元の URL が無い）
 *   7  文書 3（data: の URL。response が無いので record も date も無い。番号は飛んでよい）
 *   8  文書 3 の値 0（crypto.getRandomValues・16 バイト。value を省いた）
 */
const goodLines = (): Line[] => [
  { profile: RANDOM, kind: "document", document: 0, url: "https://shop.test/", frame: "main", dpr: 1, record: recordOf(0), date: DATES[0] },
  { profile: RANDOM, kind: "draw", document: 0, seq: 0, api: "Math.random", caller: HERO, value: 0.25390625 },
  { profile: RANDOM, kind: "document", document: 1, url: "https://shop.test/widgets/recommend", frame: "frame", dpr: 1, record: recordOf(1), date: DATES[1] },
  { profile: RANDOM, kind: "draw", document: 1, seq: 0, api: "crypto.randomUUID", caller: "https://shop.test/widgets/recommend.js", value: "3f2a9c1e-7b4d-4e8a-9f6c-0d1e2b3c4a5f" },
  { profile: RANDOM, kind: "draw", document: 0, seq: 1, api: "crypto.getRandomValues", caller: HERO, bytes: 4, value: "q83vEg==" },
  { profile: RANDOM, kind: "draw", document: 0, seq: 2, api: "Math.random", caller: "", value: 0.8125 },
  { profile: RANDOM, kind: "document", document: 3, url: "data:text/html,", frame: "frame", dpr: 2 },
  { profile: RANDOM, kind: "draw", document: 3, seq: 0, api: "crypto.getRandomValues", caller: "", bytes: 16 },
];

const RECORDER_SOURCE = "(() => { /* recorder */ })();\n";

/** 要約。行を増やし減らししたら、ここで数を渡す（生成器は行から作らない）。 */
const summaryOf = (lines: readonly Line[]): Record<string, unknown> => ({
  recorded: true,
  documents: lines.filter((l) => l["kind"] === "document").length,
  draws: lines.filter((l) => l["kind"] === "draw").length,
  truncated: false,
});

/** WACZ Profile 1.26.0 を名乗る正しい archive。`over` で 1 か所を崩す。 */
const archive = (over: Partial<FixtureOptions> = {}): FixtureOptions => ({
  software: "browserhive/32.0.0",
  conformsTo: WACZ_1_26,
  document: { url: "https://shop.test/" },
  warcResponses: goodResponses(),
  randomValues: goodLines(),
  randomRecorder: RECORDER_SOURCE,
  randomSummary: summaryOf(goodLines()),
  ...over,
});

/** `random/` のエントリを持たない archive（resources の行も無い。ほかは `archive(over)` と同じ）。 */
const withoutEntries = (over: Partial<FixtureOptions> = {}): FixtureOptions => {
  const { randomValues: _values, randomRecorder: _recorder, ...rest } = archive(over);
  return rest;
};

/** 控えた値を持たない package（`recorded: false`、エントリなし）。 */
const notRecorded = (skipped: unknown, over: Partial<FixtureOptions> = {}): FixtureOptions =>
  withoutEntries({ randomSummary: { recorded: false, skipped }, ...over });

/** 正しい控えの `index` 番目の行（0 から）を `patch` で崩す。`undefined` の値は member ごと消す。 */
const withLine = (index: number, patch: Line): Line[] =>
  goodLines().map((line, i) =>
    i === index ? Object.fromEntries(Object.entries({ ...line, ...patch }).filter(([, v]) => v !== undefined)) : line,
  );

/** 行を差し替え、要約の数も行に合わせる。 */
const withLines = (lines: Line[]): Partial<FixtureOptions> => ({ randomValues: lines, randomSummary: summaryOf(lines) });

const bad = (messageKey: string, params: MsgParams, location: IssueLocation | number = { entry: ENTRY }): Issue => ({
  rule: RULE,
  severity: "error",
  messageKey: `${RULE}.${messageKey}`,
  params,
  location: typeof location === "number" ? { entry: ENTRY, line: location } : location,
});

const inDatapackage = { entry: DATAPACKAGE };

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

describe("browserhive/random-shape", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "wacz-validator-random-shape-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const run = async (options: FixtureOptions, selector: ProfileSelector = { name: "browserhive" }): Promise<Issue[]> =>
    (await reportFor(tmpDir, options, selector)).issues.filter((i) => i.rule === RULE);

  /** 指摘の鍵だけ（`browserhive/random-shape.` を除く）。 */
  const keys = async (options: FixtureOptions): Promise<string[]> =>
    (await run(options)).map((i) => i.messageKey.slice(RULE.length + 1));

  describe("正しい archive", () => {
    it("決まりどおりの控えなら何も言わず、rule は passed に数えられる", async () => {
      const good = await reportFor(tmpDir, archive(), { name: "browserhive" });
      expect(good.issues.filter((i) => i.rule === RULE)).toEqual([]);
      // 2 つのエントリは resources に載っている（datapackage/resources-complete も何も言わない）。
      for (const path of [ENTRY, RECORDER]) {
        expect(good.entries.find((e) => e.path === path)).toMatchObject({ present: true, expectedBy: ["datapackage"], issues: [] });
      }
      // 控えの 1 行だけを崩した同じ archive では、passed がこの rule の 1 つだけ減る。
      const broken = await reportFor(tmpDir, archive({ randomValues: withLine(1, { caller: undefined }) }), { name: "browserhive" });
      expect(broken.issues.filter((i) => i.rule === RULE)).toHaveLength(1);
      expect(good.summary.passed).toBe(broken.summary.passed + 1);
    });

    it("値の行が無くても、文書の行だけのエントリで足りる。行の無い空のファイルでもよい", async () => {
      const documents = goodLines().filter((l) => l["kind"] === "document");
      expect(await run(archive(withLines(documents)))).toEqual([]);
      expect(await run(archive({ randomValues: "", randomSummary: { recorded: true, documents: 0, draws: 0, truncated: false } }))).toEqual([]);
    });

    it("控えを頼まれなかった package（recorded: false・not-requested）はエントリを持たない", async () => {
      expect(await run(notRecorded("not-requested"))).toEqual([]);
      expect(await run(notRecorded("failed"))).toEqual([]);
    });

    it("文書を伏せた package は withheld と言い、エントリを持たない。頼まれていなければ not-requested でよい（並びで先）", async () => {
      const document = { url: "https://shop.test/", withheld: "url-policy" };
      expect(await run(notRecorded("withheld", { document }))).toEqual([]);
      expect(await run(notRecorded("not-requested", { document }))).toEqual([]);
    });

    it("残したシークレットが在れば、url の *** は記録の WARC-Target-URI のどんな字の並びにも合う", async () => {
      const warcResponses = goodResponses();
      warcResponses[0] = { ...warcResponses[0], uri: "https://shop.test/?token=kept-value-1" } as WarcResponseSpec;
      const randomValues = withLine(0, { url: "https://shop.test/?token=***" });
      const settings = { secrets: ["token"], secretArchive: { token: "keep" } };
      expect(await run(archive({ warcResponses, randomValues, settings }))).toEqual([]);
      // 残したシークレットが無ければ、*** はただの字で、合わない。
      expect(await keys(archive({ warcResponses, randomValues, settings: { secrets: ["token"], secretArchive: {} } }))).toEqual(["url-differs"]);
    });

    it("value を省いた値の行と、別の文書の行に挟まった行は、そのままでよい", async () => {
      // 正しい控えの 5 行目は文書 1 の行の後ろの文書 0 の行、8 行目は value の無い行。
      const lines = goodLines();
      expect(lines[4]?.["document"]).toBe(0);
      expect(lines[7]?.["value"]).toBeUndefined();
      expect(await run(archive())).toEqual([]);
    });
  });

  describe("要約（browserhive:capture.random）", () => {
    it("WACZ Profile 1.26.0 を名乗る archive が random を持たなければ error（エントリと行は在っても照らさない）", async () => {
      const { randomSummary: _dropped, ...rest } = archive();
      expect(await run(rest)).toEqual([bad("summary-missing", { found: "undefined" }, inDatapackage)]);
      const { randomSummary: _also, ...bare } = withoutEntries();
      expect(await run(bare)).toEqual([bad("summary-missing", { found: "undefined" }, inDatapackage)]);
    });

    it("オブジェクトでなければ error", async () => {
      expect(await run(archive({ randomSummary: true }))).toEqual([bad("summary-missing", { found: "true" }, inDatapackage)]);
    });

    it("recorded が真偽値でなければ error", async () => {
      expect(await run(archive({ randomSummary: { ...summaryOf(goodLines()), recorded: "true" } }))).toEqual([
        bad("recorded", { found: '"true"' }, inDatapackage),
      ]);
    });

    it("recorded が true なら、documents・draws が 0 以上の整数で、truncated が真偽値", async () => {
      expect(await run(archive({ randomSummary: { ...summaryOf(goodLines()), documents: "3" } }))).toEqual([
        bad("summary-member", { member: "documents", found: '"3"' }, inDatapackage),
      ]);
      expect(await run(archive({ randomSummary: { ...summaryOf(goodLines()), draws: -1 } }))).toEqual([
        bad("summary-member", { member: "draws", found: "-1" }, inDatapackage),
      ]);
      const { truncated: _dropped, ...noTruncated } = summaryOf(goodLines());
      expect(await run(archive({ randomSummary: noTruncated }))).toEqual([
        bad("summary-member", { member: "truncated", found: "undefined" }, inDatapackage),
      ]);
    });

    it("recorded が true なら skipped を、false なら documents・draws・truncated を持たない", async () => {
      expect(await run(archive({ randomSummary: { ...summaryOf(goodLines()), skipped: "failed" } }))).toEqual([
        bad("summary-unexpected", { recorded: "true", members: "skipped" }, inDatapackage),
      ]);
      expect(await run(withoutEntries({ randomSummary: { recorded: false, skipped: "failed", documents: 0, truncated: false } }))).toEqual([
        bad("summary-unexpected", { recorded: "false", members: "documents, truncated" }, inDatapackage),
      ]);
    });

    it("recorded が false なら、skipped が決まった値のどれか", async () => {
      expect(await run(notRecorded("disabled"))).toEqual([bad("skipped", { found: '"disabled"' }, inDatapackage)]);
      expect(await run(notRecorded(undefined))).toEqual([bad("skipped", { found: "undefined" }, inDatapackage)]);
    });

    it("文書を伏せた package の skipped が failed なら error（withheld が並びで先）", async () => {
      const document = { url: "https://shop.test/", withheld: "no-archive" };
      expect(await run(notRecorded("failed", { document }))).toEqual([bad("skipped-not-withheld", { withheld: '"no-archive"' }, inDatapackage)]);
    });

    it("skipped が withheld なのに document が withheld を持たなければ error", async () => {
      expect(await run(notRecorded("withheld"))).toEqual([bad("skipped-withheld-unfounded", {}, inDatapackage)]);
    });

    it("documents・draws が、文書の行・値の行の数と違えば error", async () => {
      expect(await run(archive({ randomSummary: { ...summaryOf(goodLines()), documents: 4 } }))).toEqual([
        bad("count", { member: "documents", declared: "4", found: 3 }),
      ]);
      // 最後の値の行を抜いて、要約を直さない。
      expect(await run(archive({ randomValues: goodLines().slice(0, -1) }))).toEqual([bad("count", { member: "draws", declared: "5", found: 4 })]);
    });
  });

  describe("エントリ", () => {
    it("recorded が true なのに random/values.jsonl か random/recorder.js が無ければ error（無い物ごとに）", async () => {
      const { randomValues: _dropped, ...noValues } = archive();
      expect(await run(noValues)).toEqual([bad("missing", { entry: ENTRY }, { entry: ENTRY })]);
      const { randomRecorder: _also, ...noRecorder } = archive();
      expect(await run(noRecorder)).toEqual([bad("missing", { entry: RECORDER }, { entry: RECORDER })]);
    });

    it("エントリが在っても、resources に載っていなければ error", async () => {
      const mutateResources: FixtureOptions["mutateResources"] = (defaults) => defaults.filter((r) => r.path !== ENTRY);
      expect(await run(archive({ mutateResources }))).toEqual([bad("not-in-resources", { entry: ENTRY }, { entry: ENTRY })]);
    });

    it("recorded が false なのにエントリを持てば error（在る物ごとに。行は見ない）", async () => {
      const options = { ...archive({ randomValues: withLine(1, { caller: undefined }) }), randomSummary: { recorded: false, skipped: "not-requested" } };
      expect(await run(options)).toEqual([bad("unexpected", { entry: ENTRY }, { entry: ENTRY }), bad("unexpected", { entry: RECORDER }, { entry: RECORDER })]);
    });

    it("文書を伏せた package がエントリを持てば error（unexpected とは言わない）", async () => {
      const document = { url: "https://shop.test/", withheld: "url-policy" };
      const options = { ...archive({ document }), randomSummary: { recorded: false, skipped: "withheld" } };
      expect(await run(options)).toEqual([
        bad("withheld-entry", { entry: ENTRY, withheld: '"url-policy"' }, { entry: ENTRY }),
        bad("withheld-entry", { entry: RECORDER, withheld: '"url-policy"' }, { entry: RECORDER }),
      ]);
    });

    it("文書を伏せた package が recorded: true と言えば error（エントリは無い）", async () => {
      const document = { url: "https://shop.test/", withheld: "deny" };
      expect(await run(withoutEntries({ document }))).toEqual([bad("recorded-withheld", { withheld: '"deny"' }, inDatapackage)]);
    });

    it("JSON でない行と、オブジェクトでない JSON の行は error。空の行は飛ばし、行番号はファイルの行で数える（行の数は比べない）", async () => {
      const [first, second] = goodLines();
      const randomValues = `${JSON.stringify(first)}\n${JSON.stringify(second)}\nnot json\n\n[1,2]\n`;
      expect(await run(archive({ randomValues }))).toEqual([bad("not-json", { line: "3" }, 3), bad("not-json", { line: "5" }, 5)]);
    });
  });

  describe("行の member", () => {
    it("browserhive:random/1 でない版を名乗る行は、そのことだけを言う（その先は見ず、文書の番号と seq は数える）", async () => {
      expect(await run(archive({ randomValues: withLine(0, { profile: "browserhive:random/2", frame: "top" }) }))).toEqual([
        bad("unknown-profile", { line: "1", found: '"browserhive:random/2"' }, 1),
      ]);
      expect(await run(archive({ randomValues: withLine(1, { profile: undefined, api: "x" }) }))).toEqual([
        bad("unknown-profile", { line: "2", found: "undefined" }, 2),
      ]);
    });

    it("kind が無ければ error（その行の先は見ない）", async () => {
      expect(await run(archive({ randomValues: withLine(5, { kind: undefined }) }))).toEqual([bad("missing-member", { line: "6", members: "kind" }, 6)]);
    });

    it("kind が document でも draw でもなければ error", async () => {
      expect(await run(archive({ randomValues: withLine(5, { kind: "random" }) }))).toEqual([bad("kind", { line: "6", found: '"random"' }, 6)]);
    });

    it("文書の行の必須の member が無ければ、1 件にまとめて並べる", async () => {
      expect(await run(archive({ randomValues: withLine(2, { frame: undefined }) }))).toEqual([bad("missing-member", { line: "3", members: "frame" }, 3)]);
      expect(await run(archive({ randomValues: withLine(6, { url: undefined, dpr: undefined }) }))).toEqual([
        bad("missing-member", { line: "7", members: "url, dpr" }, 7),
      ]);
    });

    it("値の行の必須の member が無ければ error", async () => {
      expect(await run(archive({ randomValues: withLine(5, { caller: undefined }) }))).toEqual([bad("missing-member", { line: "6", members: "caller" }, 6)]);
    });

    it("document・seq・bytes が 0 以上の整数でなければ error", async () => {
      expect(await run(archive({ randomValues: withLine(7, { document: -1 }) }))).toEqual([
        bad("not-count", { line: "8", member: "document", found: "-1" }, 8),
      ]);
      expect(await run(archive({ randomValues: withLine(5, { seq: "2" }) }))).toEqual([bad("not-count", { line: "6", member: "seq", found: '"2"' }, 6)]);
      expect(await run(archive({ randomValues: withLine(4, { bytes: 4.5 }) }))).toEqual([bad("not-count", { line: "5", member: "bytes", found: "4.5" }, 5)]);
    });

    it("url・caller・date が文字列でなければ error", async () => {
      expect(await run(archive({ randomValues: withLine(6, { url: 5 }) }))).toEqual([bad("not-string", { line: "7", member: "url", found: "5" }, 7)]);
      expect(await run(archive({ randomValues: withLine(5, { caller: null }) }))).toEqual([bad("not-string", { line: "6", member: "caller", found: "null" }, 6)]);
      expect(await run(archive({ randomValues: withLine(0, { date: 1_763_086_200_757 }) }))).toEqual([
        bad("not-string", { line: "1", member: "date", found: "1763086200757" }, 1),
      ]);
    });

    it("frame が main でも frame でもなければ error", async () => {
      expect(await run(archive({ randomValues: withLine(2, { frame: "iframe" }) }))).toEqual([bad("frame", { line: "3", found: '"iframe"' }, 3)]);
    });

    it("dpr が数でなければ error", async () => {
      expect(await run(archive({ randomValues: withLine(6, { dpr: "2" }) }))).toEqual([bad("dpr", { line: "7", found: '"2"' }, 7)]);
    });
  });

  describe("文書の行の並び", () => {
    it("2 つの文書の行が同じ document を持てば error（後の行で言う）", async () => {
      const lines = [...goodLines(), { ...goodLines()[2] }];
      expect(await run(archive(withLines(lines)))).toEqual([bad("document-repeated", { line: "9", document: "1", firstLine: "3" }, 9)]);
    });

    it("文書の行が document の昇順でなければ error（番号の飛びは言わない）", async () => {
      const lines = [...goodLines(), { ...goodLines()[6], document: 2 }];
      expect(await run(archive(withLines(lines)))).toEqual([bad("document-order", { line: "9", document: "2", previous: "3", previousLine: "7" }, 9)]);
    });
  });

  describe("record と WARC のレコード", () => {
    it("record と date の片方だけを持てば error", async () => {
      expect(await run(archive({ randomValues: withLine(0, { date: undefined }) }))).toEqual([
        bad("record-date-pair", { line: "1", present: "record", absent: "date" }, 1),
      ]);
      expect(await run(archive({ randomValues: withLine(2, { record: undefined }) }))).toEqual([
        bad("record-date-pair", { line: "3", present: "date", absent: "record" }, 3),
      ]);
    });

    it("record が実在しない ID なら error", async () => {
      const ghost = "urn:uuid:00000000-0000-0000-0000-00000000dead";
      expect(await run(archive({ randomValues: withLine(0, { record: ghost }) }))).toEqual([bad("record-unknown", { line: "1", found: `"${ghost}"` }, 1)]);
    });

    it("山括弧つきの ID と、request のレコードの ID は、response を名指していない", async () => {
      expect(await run(archive({ randomValues: withLine(0, { record: responseRecordId(0) }) }))).toEqual([
        bad("record-unknown", { line: "1", found: `"${responseRecordId(0)}"` }, 1),
      ]);
      const request = "<urn:uuid:00000000-0000-0000-0000-000000000400>";
      const warcRequests = [{ uri: "https://shop.test/", recordId: request, date: DATES[0] }];
      expect(await run(archive({ warcRequests, randomValues: withLine(0, { record: request.slice(1, -1) }) }))).toEqual([
        bad("record-unknown", { line: "1", found: `"${request.slice(1, -1)}"` }, 1),
      ]);
    });

    it("date が、名指した response の WARC-Date と 1 字でも違えば error", async () => {
      expect(await run(archive({ randomValues: withLine(0, { date: "2026-11-14T02:10:00.758Z" }) }))).toEqual([
        bad("date-differs", { line: "1", found: "2026-11-14T02:10:00.758Z", date: DATES[0], record: `"${recordOf(0)}"` }, 1),
      ]);
    });

    it("名指した response の WARC-Target-URI が url と違えば error", async () => {
      expect(await run(archive({ randomValues: withLine(2, { url: "https://shop.test/widgets/other" }) }))).toEqual([
        bad("url-differs", { line: "3", url: "https://shop.test/widgets/other", target: "https://shop.test/widgets/recommend", record: `"${recordOf(1)}"` }, 3),
      ]);
    });

    it("data: の URL の url が、最初のコンマの後ろに中身を持てば error", async () => {
      expect(await run(archive({ randomValues: withLine(6, { url: "data:text/html,<p>hi</p>" }) }))).toEqual([bad("data-url-data", { line: "7" }, 7)]);
    });
  });

  describe("値の行", () => {
    it("document が、それより前の文書の行に無ければ error", async () => {
      expect(await run(archive({ randomValues: withLine(7, { document: 9 }) }))).toEqual([bad("draw-document-unknown", { line: "8", document: "9" }, 8)]);
      // 文書の行より前に置いた値の行も、前に無い。
      const lines = goodLines();
      const [document1, draw1] = [lines[2], lines[3]] as [Line, Line];
      lines.splice(2, 2, draw1, document1);
      expect(await run(archive({ randomValues: lines }))).toEqual([bad("draw-document-unknown", { line: "3", document: "1" }, 3)]);
    });

    it("seq が、その文書の最初の値の行で 0、続く行で 1 つずつ増えなければ error", async () => {
      expect(await run(archive({ randomValues: withLine(5, { seq: 3 }) }))).toEqual([
        bad("seq-order", { line: "6", document: "0", seq: "3", expected: "2" }, 6),
      ]);
      expect(await run(archive({ randomValues: withLine(3, { seq: 1 }) }))).toEqual([
        bad("seq-order", { line: "4", document: "1", seq: "1", expected: "0" }, 4),
      ]);
    });

    it("api が決まった値でなければ error（その行の bytes と value は見ない）", async () => {
      expect(await run(archive({ randomValues: withLine(4, { api: "crypto.getRandomBytes" }) }))).toEqual([
        bad("api", { line: "5", found: '"crypto.getRandomBytes"' }, 5),
      ]);
    });

    it("crypto.getRandomValues の行に bytes が無ければ error", async () => {
      expect(await run(archive({ randomValues: withLine(4, { bytes: undefined }) }))).toEqual([bad("bytes-missing", { line: "5" }, 5)]);
    });

    it("ほかの行が bytes を持てば error", async () => {
      expect(await run(archive({ randomValues: withLine(1, { bytes: 8 }) }))).toEqual([bad("bytes-unexpected", { line: "2", api: "Math.random" }, 2)]);
    });

    it("value が api の決める形でなければ error", async () => {
      const valueOf = async (index: number, value: unknown): Promise<Issue[]> => run(archive({ randomValues: withLine(index, { value }) }));
      expect(await valueOf(1, 1)).toEqual([bad("value", { line: "2", api: "Math.random", found: "1" }, 2)]);
      expect(await valueOf(1, -0.5)).toEqual([bad("value", { line: "2", api: "Math.random", found: "-0.5" }, 2)]);
      expect(await valueOf(1, "0.5")).toEqual([bad("value", { line: "2", api: "Math.random", found: '"0.5"' }, 2)]);
      expect(await valueOf(3, "3F2A9C1E-7B4D-4E8A-9F6C-0D1E2B3C4A5F")).toEqual([
        bad("value", { line: "4", api: "crypto.randomUUID", found: '"3F2A9C1E-7B4D-4E8A-9F6C-0D1E2B3C4A5F"' }, 4),
      ]);
      expect(await valueOf(3, "3f2a9c1e7b4d4e8a9f6c0d1e2b3c4a5f")).toEqual([
        bad("value", { line: "4", api: "crypto.randomUUID", found: '"3f2a9c1e7b4d4e8a9f6c0d1e2b3c4a5f"' }, 4),
      ]);
      // 埋め字の無い base64 と、URL 用の字の base64。
      expect(await valueOf(4, "q83vEg")).toEqual([bad("value", { line: "5", api: "crypto.getRandomValues", found: '"q83vEg"' }, 5)]);
      expect(await valueOf(4, "q8_vEg==")).toEqual([bad("value", { line: "5", api: "crypto.getRandomValues", found: '"q8_vEg=="' }, 5)]);
    });

    it("crypto.getRandomValues の value が、ちょうど bytes バイトでなければ error", async () => {
      expect(await run(archive({ randomValues: withLine(4, { value: "q83v" }) }))).toEqual([bad("value-length", { line: "5", bytes: "4", found: 3 }, 5)]);
      expect(await run(archive({ randomValues: withLine(4, { bytes: 0 }) }))).toEqual([bad("value-length", { line: "5", bytes: "0", found: 4 }, 5)]);
    });
  });

  describe("同じ指摘は丸める", () => {
    /** 6 行とも caller の無い値の行の控え。 */
    const repeated = (): FixtureOptions => {
      const draws = Array.from({ length: 6 }, (_, seq) => ({ profile: RANDOM, kind: "draw", document: 0, seq, api: "Math.random", value: 0.5 }));
      return archive(withLines([goodLines()[0] ?? {}, ...draws]));
    };

    it("同じエントリの同じ指摘は 4 件まで出し、4 件目が残りの数を運ぶ", async () => {
      const issues = await run(repeated());
      expect(issues.map((i) => `${i.messageKey.slice(RULE.length + 1)}@${String(i.location?.line)}/${String(i.params?.["more"] ?? "")}`)).toEqual([
        "missing-member@2/",
        "missing-member@3/",
        "missing-member@4/",
        "missing-member@5/2",
      ]);
    });

    it("残りの数の文は、WARC の本ではなくファイルを言う", async () => {
      const report = await reportFor(tmpDir, repeated(), { name: "browserhive" });
      const messages = (locale: "en" | "ja"): string[] =>
        (JSON.parse(renderJson(report, locale)) as { issues: { rule: string; message: string }[] }).issues
          .filter((i) => i.rule === RULE)
          .map((i) => i.message);
      expect(messages("ja")[3]).toBe("random/values.jsonl の 5 行目に caller が無い（BrowserHive WACZ Profile 1.26.0 の必須）（同じファイルにほか 2 件）");
      expect(messages("en")[3]).toBe("random/values.jsonl line 5 lacks caller (required by BrowserHive WACZ Profile 1.26.0) (and 2 more like this in the same file)");
    });
  });

  describe("版の条件", () => {
    /** 版の条件のほかでは必ず落ちる archive。要約の数が合わず、行が壊れている。 */
    const broken = (): FixtureOptions =>
      archive({ randomSummary: { ...summaryOf(goodLines()), documents: 9 }, randomValues: withLine(1, { caller: undefined, value: 2 }) });

    it("WACZ Profile 1.25.0 を名乗る archive には当てない（random が無くても、エントリが壊れていても）", async () => {
      const { randomSummary: _dropped, ...bare } = withoutEntries({ conformsTo: WACZ_1_25 });
      expect(await run(bare)).toEqual([]);
      expect(await run({ ...broken(), conformsTo: WACZ_1_25 })).toEqual([]);
    });

    it("同じ archive でも、1.26.0 を名乗れば落ちる（黙ったのは archive の版のせい）", async () => {
      expect(await keys(broken())).toEqual(["missing-member", "value", "count"]);
    });

    it("archive が版を名乗らなければ当てない", async () => {
      const { conformsTo: _dropped, ...unnamed } = broken();
      expect(await run(unnamed)).toEqual([]);
    });

    it("spec の profile では走らない（browserhive 固有の形）", async () => {
      expect(await run(broken(), { name: "spec" })).toEqual([]);
    });
  });
});
