// @module-tag engine
/**
 * `browserhive/logs-shape` のテスト。
 *
 * 守っている主張は WACZ Profile 1.19.0 の logs-directory と logs-lines。package は取り込みのログ
 * `logs/capture.jsonl` を持ち（行が無ければ空のファイル）、各行は `browserhive:log/1` を名乗る JSON のオブジェクトで、
 * 決まった member と値を持ち、`script`・`dpr` は settings に在る物を名指し、文書を伏せた package はページの行を持たない。
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
import { parseReportSource, type Issue, type Report } from "../src/validate/domain.js";
import { runValidation } from "../src/validate/engine.js";
import { DEFAULT_RULES } from "../src/validate/rules/index.js";
import { fileTransport } from "../src/wacz/transport.js";
import { WaczReader } from "../src/wacz/reader.js";
import { buildWacz, type FixtureOptions } from "./fixtures/generator.js";

const RULE = "browserhive/logs-shape";
const ENTRY = "logs/capture.jsonl";
const WACZ_1_18 = "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.18.0/";
const WACZ_1_19 = "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.19.0/";
const LOG = "browserhive:log/1";

type Line = Record<string, unknown>;

/** 正しいログ。ページの誤り・producer の行・2 本の behavior の行（2 本目は 1 本目と同じ ms で、DPR の 2 回目）。 */
const goodLines = (): Line[] => [
  { profile: LOG, at: "2026-11-04T05:12:02.377Z", ms: 2348, dpr: 1, source: "page", level: "error", msg: "Uncaught TypeError" },
  {
    profile: LOG,
    at: "2026-11-04T05:12:03.016Z",
    ms: 2987,
    source: "browserhive",
    level: "warn",
    msg: "dropped 1250 lines",
    data: { dropped: 1250 },
  },
  {
    profile: LOG,
    at: "2026-11-04T05:12:04.551Z",
    ms: 4522,
    dpr: 1,
    source: "script",
    script: "site.test:gallery",
    level: "info",
    msg: "searched the gallery",
    data: { query: "gallery", results: 24 },
    truncated: true,
  },
  { profile: LOG, at: "2026-11-04T05:12:04.551Z", ms: 4522, dpr: 2, source: "script", script: "autoscroll", level: "debug", msg: "scrolled" },
];

const settings = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  signature: "none",
  viewport: { width: 1280, height: 800 },
  devicePixelRatios: [1, 2],
  session: "isolated",
  behaviors: [
    { id: "autoscroll", origin: "builtin" },
    { id: "site.test:gallery", origin: "custom" },
  ],
  preload: [],
  variables: {},
  secrets: [],
  limits: { maxResponseBytes: 20_971_520, maxTaskBytes: 209_715_200, maxWarcBytes: 1_000_000_000 },
  urlPolicies: [],
  contentTypePolicies: [],
  ...over,
});

/** WACZ Profile 1.19.0 を名乗る正しい archive。`over` で 1 か所を崩す。 */
const archive = (over: Partial<FixtureOptions> = {}): FixtureOptions => ({
  software: "browserhive/24.1.0",
  conformsTo: WACZ_1_19,
  settings: settings(),
  document: { url: "https://site.test/" },
  logs: goodLines(),
  ...over,
});

/** ログのエントリを持たない archive（ほかは `archive(over)` と同じ）。 */
const withoutLogs = (over: Partial<FixtureOptions> = {}): FixtureOptions => {
  const { logs: _dropped, ...rest } = archive(over);
  return rest;
};

/** 正しいログの `index` 番目の行（0 から）を `patch` で崩す。`undefined` の値は member ごと消す。 */
const withLine = (index: number, patch: Line): Line[] =>
  goodLines().map((line, i) =>
    i === index
      ? Object.fromEntries(Object.entries({ ...line, ...patch }).filter(([, v]) => v !== undefined))
      : line,
  );

const bad = (messageKey: string, params: MsgParams, line?: number): Issue => ({
  rule: RULE,
  severity: "error",
  messageKey: `${RULE}.${messageKey}`,
  params,
  location: line === undefined ? { entry: ENTRY } : { entry: ENTRY, line },
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

describe("browserhive/logs-shape", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "wacz-validator-logs-shape-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const run = async (options: FixtureOptions, selector: ProfileSelector = { name: "browserhive" }): Promise<Issue[]> =>
    (await reportFor(tmpDir, options, selector)).issues.filter((i) => i.rule === RULE);

  describe("正しい archive", () => {
    it("決まりどおりのログなら何も言わず、rule は passed に数えられる", async () => {
      const good = await reportFor(tmpDir, archive(), { name: "browserhive" });
      expect(good.issues.filter((i) => i.rule === RULE)).toEqual([]);
      // ログは resources に載っている（datapackage/resources-complete も何も言わない）。
      expect(good.entries.find((e) => e.path === ENTRY)).toMatchObject({ present: true, expectedBy: ["datapackage"], issues: [] });
      // ログの 1 行だけを崩した同じ archive では、passed がこの rule の 1 つだけ減る。
      const broken = await reportFor(tmpDir, archive({ logs: withLine(2, { level: undefined }) }), { name: "browserhive" });
      expect(broken.issues.filter((i) => i.rule === RULE)).toHaveLength(1);
      expect(good.summary.passed).toBe(broken.summary.passed + 1);
    });

    it("行が無ければ空のファイルで足りる", async () => {
      expect(await run(archive({ logs: "" }))).toEqual([]);
    });

    it("時差つきの時刻と、小文字の t・z も RFC 3339 として読む", async () => {
      const logs = goodLines();
      logs[0] = { ...logs[0], at: "2026-11-04T14:12:02.377+09:00" };
      logs[1] = { ...logs[1], at: "2026-11-04t05:12:03z" };
      expect(await run(archive({ logs }))).toEqual([]);
    });

    it("文書を伏せても、ページの行が無ければ何も言わない", async () => {
      const logs = goodLines().filter((line) => line["source"] !== "page");
      expect(await run(archive({ document: { url: "https://site.test/", withheld: "url-policy" }, logs }))).toEqual([]);
    });
  });

  describe("エントリ", () => {
    it("logs/capture.jsonl が無ければ error", async () => {
      expect(await run(withoutLogs())).toEqual([bad("missing", {})]);
    });

    it("JSON でない行と、オブジェクトでない JSON の行は error。空の行は飛ばし、行番号はファイルの行で数える", async () => {
      const [first] = goodLines();
      const logs = `${JSON.stringify(first)}\nnot json\n\n[1,2]\n`;
      expect(await run(archive({ logs }))).toEqual([bad("not-json", { line: "2" }, 2), bad("not-json", { line: "4" }, 4)]);
    });

    it("browserhive:log/1 でない版を名乗る行は、そのことだけを言う（その先の member は見ない）", async () => {
      const logs = withLine(1, { profile: "browserhive:log/2", level: undefined });
      expect(await run(archive({ logs }))).toEqual([bad("unknown-profile", { line: "2", found: '"browserhive:log/2"' }, 2)]);
    });
  });

  describe("行の member", () => {
    it("level の無い行は error", async () => {
      expect(await run(archive({ logs: withLine(2, { level: undefined }) }))).toEqual([
        bad("missing-member", { line: "3", members: "level" }, 3),
      ]);
    });

    it("必須の member が幾つも無ければ、1 件にまとめて並べる", async () => {
      const logs = withLine(1, { at: undefined, msg: undefined, source: undefined });
      expect(await run(archive({ logs }))).toEqual([bad("missing-member", { line: "2", members: "at, source, msg" }, 2)]);
    });

    it("at が RFC 3339 の時刻でなければ error", async () => {
      expect(await run(archive({ logs: withLine(0, { at: "2026-11-04 05:12:02" }) }))).toEqual([
        bad("at", { line: "1", found: '"2026-11-04 05:12:02"' }, 1),
      ]);
      expect(await run(archive({ logs: withLine(0, { at: 1_762_233_122_377 }) }))).toEqual([
        bad("at", { line: "1", found: "1762233122377" }, 1),
      ]);
    });

    it("ms が負・小数・文字なら error", async () => {
      expect(await run(archive({ logs: withLine(0, { ms: -1 }) }))).toEqual([bad("ms", { line: "1", found: "-1" }, 1)]);
      expect(await run(archive({ logs: withLine(0, { ms: 2348.5 }) }))).toEqual([bad("ms", { line: "1", found: "2348.5" }, 1)]);
      expect(await run(archive({ logs: withLine(0, { ms: "2348" }) }))).toEqual([bad("ms", { line: "1", found: '"2348"' }, 1)]);
    });

    it("ms が前の行より小さければ error（同じ値はよい）", async () => {
      expect(await run(archive({ logs: withLine(2, { ms: 2986 }) }))).toEqual([
        bad("ms-decreased", { line: "3", found: "2986", previous: "2987", previousLine: "2" }, 3),
      ]);
    });

    it("ms の読めない行を挟んでも、ms が読めた最後の行と比べる", async () => {
      const logs = withLine(1, { ms: "late" });
      logs[2] = { ...logs[2], ms: 2000 };
      expect(await run(archive({ logs }))).toEqual([
        bad("ms", { line: "2", found: '"late"' }, 2),
        bad("ms-decreased", { line: "3", found: "2000", previous: "2348", previousLine: "1" }, 3),
      ]);
    });

    it("source と level が決まった値でなければ error", async () => {
      expect(await run(archive({ logs: withLine(1, { source: "worker" }) }))).toEqual([
        bad("source", { line: "2", found: '"worker"' }, 2),
      ]);
      expect(await run(archive({ logs: withLine(1, { level: "fatal" }) }))).toEqual([
        bad("level", { line: "2", found: '"fatal"' }, 2),
      ]);
    });

    it("msg が文字列でなければ error", async () => {
      expect(await run(archive({ logs: withLine(1, { msg: { text: "dropped" } }) }))).toEqual([
        bad("msg", { line: "2", found: '{"text":"dropped"}' }, 2),
      ]);
    });

    it("truncated が boolean でなければ error", async () => {
      expect(await run(archive({ logs: withLine(2, { truncated: "yes" }) }))).toEqual([
        bad("truncated", { line: "3", found: '"yes"' }, 3),
      ]);
    });
  });

  describe("script と dpr は settings の物を名指す", () => {
    it("settings.behaviors に無い script は error", async () => {
      expect(await run(archive({ logs: withLine(3, { script: "autofetch" }) }))).toEqual([
        bad("script", { line: "4", found: '"autofetch"', behaviors: '["autoscroll","site.test:gallery"]' }, 4),
      ]);
    });

    it("source が script の行に script が無ければ error", async () => {
      expect(await run(archive({ logs: withLine(2, { script: undefined }) }))).toEqual([bad("script-missing", { line: "3" }, 3)]);
    });

    it("source が script でない行に script が在れば error", async () => {
      expect(await run(archive({ logs: withLine(0, { script: "autoscroll" }) }))).toEqual([
        bad("script-unexpected", { line: "1", source: "page", found: '"autoscroll"' }, 1),
      ]);
    });

    it("settings.devicePixelRatios に無い dpr は error（文字の 1 も数の 1 ではない）", async () => {
      expect(await run(archive({ logs: withLine(3, { dpr: 3 }) }))).toEqual([
        bad("dpr", { line: "4", found: "3", ratios: "[1,2]" }, 4),
      ]);
      expect(await run(archive({ logs: withLine(3, { dpr: "1" }) }))).toEqual([
        bad("dpr", { line: "4", found: '"1"', ratios: "[1,2]" }, 4),
      ]);
    });

    it("settings の behaviors と devicePixelRatios が読めなければ、script と dpr の値を照らさない", async () => {
      const logs = withLine(3, { script: "autofetch", dpr: 3 });
      const broken = settings({ behaviors: "autoscroll", devicePixelRatios: 1 });
      expect(await run(archive({ logs, settings: broken }))).toEqual([]);
      // 同じ行でも、settings が読めれば落ちる。黙ったのは settings のせいで、行のせいではない。
      expect(await run(archive({ logs }))).toHaveLength(2);
    });
  });

  describe("伏せた文書", () => {
    it("document が withheld を持つのにページの行が在れば、行の数と最初の行を 1 件で言う", async () => {
      const logs = [...goodLines(), { ...goodLines()[0], ms: 5000, msg: "late page line" }];
      expect(await run(archive({ document: { url: "https://site.test/", withheld: "url-policy" }, logs }))).toEqual([
        bad("withheld-page", { withheld: "url-policy", count: 2, first: "1" }, 1),
      ]);
    });

    it("unattributed で伏せたときも、ページの行を持たない", async () => {
      expect(await run(archive({ document: { withheld: "unattributed" } }))).toEqual([
        bad("withheld-page", { withheld: "unattributed", count: 1, first: "1" }, 1),
      ]);
    });

    it("伏せていなければ、ページの行が在ってよい（同じログで、document だけが違う）", async () => {
      expect(await run(archive({ document: { url: "https://site.test/" } }))).toEqual([]);
    });
  });

  describe("版の条件", () => {
    /** 版の条件のほかでは必ず落ちる archive。ログの行が壊れている。 */
    const broken = (): FixtureOptions =>
      archive({
        document: { url: "https://site.test/", withheld: "url-policy" },
        logs: withLine(2, { level: undefined, ms: 1, script: "autofetch" }),
      });

    it("WACZ Profile 1.18.0 を名乗る archive には当てない（ログが無くても、行が壊れていても）", async () => {
      expect(await run({ ...broken(), conformsTo: WACZ_1_18 })).toEqual([]);
      expect(await run(withoutLogs({ conformsTo: WACZ_1_18 }))).toEqual([]);
      // 同じ archive でも、1.19.0 を名乗れば落ちる。黙ったのは archive の版のせいで、ログの形のせいではない。
      expect(await run(broken())).toHaveLength(4);
      expect(await run(withoutLogs())).toEqual([bad("missing", {})]);
    });

    it("archive が版を名乗らなければ当てない", async () => {
      const { conformsTo: _dropped, ...unnamed } = broken();
      expect(await run(unnamed)).toEqual([]);
    });

    it("producer の版を添えた実行でも、決めるのは archive の版（skipped にも入らない）", async () => {
      const report = await reportFor(tmpDir, broken(), { name: "browserhive", version: { major: 1, minor: 0, patch: 0 } });
      expect(report.issues.filter((i) => i.rule === RULE)).toHaveLength(4);
      expect((report.skipped ?? []).map((s) => s.rule)).not.toContain(RULE);
    });

    it("spec の profile では走らない（browserhive 固有の形）", async () => {
      expect(await run(broken(), { name: "spec" })).toEqual([]);
    });
  });
});
