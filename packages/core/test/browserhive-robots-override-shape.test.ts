// @module-tag engine
/**
 * `browserhive/robots-override-shape` のテスト。
 *
 * 守っている主張は WACZ Profile 1.29.0 の robotsOverride。`browserhive:capture.robotsOverride` は任意の member で、
 * 在るなら `exemptionId`・`reason`・`pathPattern`・`scope`・`grantedBy`・`grantedAt`・`expiresAt` をみな持つ
 * オブジェクト。どれも文字列で、member ごとに値の決まりを持つ（`reason` の長さは Unicode の code point で数える）。
 *
 * 標本は正しい archive（`archive()`）の申告から 1 か所だけを崩して作る。崩した 1 か所を、狙った指摘 1 つだけが
 * 言うことを見る —— rule がその 1 か所を見ていることを、区別できる入力で確かめるため。版の条件は、同じ崩れた
 * archive の版の名乗りだけを替えて見る。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProfileSelector } from "@wacz-validator/contract";
import type { MsgParams } from "../src/i18n/translate.js";
import { renderJson } from "../src/render/json.js";
import { parseReportSource, type Issue, type Report } from "../src/validate/domain.js";
import { runValidation } from "../src/validate/engine.js";
import { DEFAULT_RULES } from "../src/validate/rules/index.js";
import { fileTransport } from "../src/wacz/transport.js";
import { WaczReader } from "../src/wacz/reader.js";
import { buildWacz, type FixtureOptions } from "./fixtures/generator.js";

const RULE = "browserhive/robots-override-shape";
const WACZ_1_28 = "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.28.0/";
const WACZ_1_29 = "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.29.0/";
const MEMBERS = ["exemptionId", "reason", "pathPattern", "scope", "grantedBy", "grantedAt", "expiresAt"] as const;

/** 正しい申告。WACZ Profile 1.29.0 §robotsOverride の例のとおり。 */
const goodOverride = (): Record<string, unknown> => ({
  exemptionId: "42",
  reason: "The publisher agreed in writing that its press releases may be archived.",
  pathPattern: "/press/*",
  scope: "links",
  grantedBy: "user:204",
  grantedAt: "2026-11-20T02:15:00Z",
  expiresAt: "2027-11-20T02:15:00Z",
});

/** 正しい申告の member を `patch` で崩す。`undefined` の値は member ごと消す。 */
const overrideWith = (patch: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries({ ...goodOverride(), ...patch }).filter(([, v]) => v !== undefined));

/** WACZ Profile 1.29.0 を名乗る archive。`robotsOverride` を渡さなければ、申告を持たない。 */
const archive = (robotsOverride?: unknown, over: Partial<FixtureOptions> = {}): FixtureOptions => ({
  software: "browserhive/33.0.0",
  conformsTo: WACZ_1_29,
  document: { url: "https://shop.test/" },
  ...(robotsOverride === undefined ? {} : { robotsOverride }),
  ...over,
});

const bad = (messageKey: string, params: MsgParams): Issue => ({
  rule: RULE,
  severity: "error",
  messageKey: `${RULE}.${messageKey}`,
  params,
  location: { entry: "datapackage.json" },
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

describe("browserhive/robots-override-shape", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "wacz-validator-robots-override-shape-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const run = async (options: FixtureOptions, selector: ProfileSelector = { name: "browserhive" }): Promise<Issue[]> =>
    (await reportFor(tmpDir, options, selector)).issues.filter((i) => i.rule === RULE);

  describe("正しい archive", () => {
    it("robotsOverride が無ければ何も言わない（任意の member）", async () => {
      expect(await run(archive())).toEqual([]);
    });

    it("決まりどおりの申告なら何も言わず、rule は passed に数えられる", async () => {
      const good = await reportFor(tmpDir, archive(goodOverride()), { name: "browserhive" });
      expect(good.issues.filter((i) => i.rule === RULE)).toEqual([]);
      // 申告の 1 か所だけを崩した同じ archive では、passed がこの rule の 1 つだけ減る。
      const broken = await reportFor(tmpDir, archive(overrideWith({ scope: "all" })), { name: "browserhive" });
      expect(broken.issues.filter((i) => i.rule === RULE)).toHaveLength(1);
      expect(good.summary.passed).toBe(broken.summary.passed + 1);
    });

    it("scope は seeds でもよい。時刻は秒の小数つきでもよい", async () => {
      const override = overrideWith({ scope: "seeds", expiresAt: "2027-11-20T02:15:00.250Z" });
      expect(await run(archive(override))).toEqual([]);
    });

    it("reason は code point で 1 でも 500 でもよい", async () => {
      expect(await run(archive(overrideWith({ reason: "x" })))).toEqual([]);
      expect(await run(archive(overrideWith({ reason: "x".repeat(500) })))).toEqual([]);
    });

    it("絵文字 500 個の reason は通る（UTF-16 の code unit では 1000。数えるのは code point）", async () => {
      expect("😀".repeat(500)).toHaveLength(1000);
      expect(await run(archive(overrideWith({ reason: "😀".repeat(500) })))).toEqual([]);
    });

    it("pathPattern は / だけでもよい", async () => {
      expect(await run(archive(overrideWith({ pathPattern: "/" })))).toEqual([]);
    });

    it("表に無い member には何も言わない", async () => {
      expect(await run(archive(overrideWith({ note: 1 })))).toEqual([]);
    });
  });

  describe("member の欠けと型", () => {
    it.each(MEMBERS)("%s が無い", async (member) => {
      expect(await run(archive(overrideWith({ [member]: undefined })))).toEqual([bad("missing-member", { member })]);
    });

    it.each(MEMBERS)("%s が文字列でない", async (member) => {
      const found = member === "reason" || member === "grantedBy" ? "number" : "42";
      expect(await run(archive(overrideWith({ [member]: 42 })))).toEqual([bad("not-string", { member, found })]);
    });

    it.each(["reason", "grantedBy"] as const)("%s が文字列でない時、中身は報告に写さない", async (member) => {
      expect(await run(archive(overrideWith({ [member]: ["人の書いた言葉"] })))).toEqual([bad("not-string", { member, found: "array" })]);
      expect(await run(archive(overrideWith({ [member]: { text: "人の書いた言葉" } })))).toEqual([bad("not-string", { member, found: "object" })]);
    });

    it("null の member は、欠けではなく型の違いとして言う", async () => {
      expect(await run(archive(overrideWith({ expiresAt: null })))).toEqual([bad("not-string", { member: "expiresAt", found: "null" })]);
    });

    it("member が 1 つも無ければ、表の順に 7 つ言う", async () => {
      expect(await run(archive({}))).toEqual(MEMBERS.map((member) => bad("missing-member", { member })));
    });
  });

  describe("member の値", () => {
    it.each(["exemptionId", "grantedBy"] as const)("%s が空", async (member) => {
      expect(await run(archive(overrideWith({ [member]: "" })))).toEqual([bad("empty", { member })]);
    });

    it("reason が空", async () => {
      expect(await run(archive(overrideWith({ reason: "" })))).toEqual([bad("reason-length", { length: 0 })]);
    });

    it("reason が code point で 501", async () => {
      expect(await run(archive(overrideWith({ reason: "x".repeat(501) })))).toEqual([bad("reason-length", { length: 501 })]);
    });

    it("絵文字 501 個の reason は言う。長さは code point の数（1002 ではない）", async () => {
      expect(await run(archive(overrideWith({ reason: "😀".repeat(501) })))).toEqual([bad("reason-length", { length: 501 })]);
    });

    it.each(["press/*", "", "https://shop.test/press/*", " /press/*"])("pathPattern が / で始まらない（%j）", async (pathPattern) => {
      expect(await run(archive(overrideWith({ pathPattern })))).toEqual([bad("path-pattern", { found: JSON.stringify(pathPattern) })]);
    });

    it.each(["all", "", "Seeds", "seeds "])("scope が別の語（%j）", async (scope) => {
      expect(await run(archive(overrideWith({ scope })))).toEqual([bad("scope", { found: JSON.stringify(scope) })]);
    });

    it.each(["grantedAt", "expiresAt"] as const)("%s が date-time でない", async (member) => {
      // 終わりの 3 つ（空の前）は、形は RFC 3339 だが、offset が `Z` でない（spec 1.29.0 は `Z` と書くと定める）。
      for (const value of ["2026-11-20", "2026-11-20 02:15:00Z", "2026-11-20T02:15:00", "2026-13-20T02:15:00Z", "tomorrow", "2026-11-20T11:15:00+09:00", "2026-11-20T02:15:00+00:00", "2026-11-20T02:15:00z", ""]) {
        expect(await run(archive(overrideWith({ [member]: value })))).toEqual([bad("date-time", { member, found: JSON.stringify(value) })]);
      }
    });

    it("崩れた member が 2 つ以上なら、表の順に 1 つずつ言う", async () => {
      const override = overrideWith({ reason: "", scope: "all", grantedBy: undefined, expiresAt: "never" });
      expect(await run(archive(override))).toEqual([
        bad("reason-length", { length: 0 }),
        bad("scope", { found: '"all"' }),
        bad("missing-member", { member: "grantedBy" }),
        bad("date-time", { member: "expiresAt", found: '"never"' }),
      ]);
    });
  });

  describe("オブジェクトでない", () => {
    it.each([
      // 値は写さず、型の名だけを言う（配列の中の reason・grantedBy が報告に出ない）。
      ["文字列", "exempt", "string"],
      ["配列", [goodOverride()], "array"],
      ["true", true, "boolean"],
      ["null", null, "null"],
    ])("%s", async (_name, value, found) => {
      expect(await run(archive(value))).toEqual([bad("not-object", { found })]);
    });
  });

  describe("文", () => {
    it("en と ja の文になる", async () => {
      const override = overrideWith({ reason: "", scope: "all", grantedBy: undefined, expiresAt: "never" });
      const report = await reportFor(tmpDir, archive(override), { name: "browserhive" });
      const messages = (locale: "en" | "ja"): string[] =>
        (JSON.parse(renderJson(report, locale)) as { issues: { rule: string; message: string }[] }).issues
          .filter((i) => i.rule === RULE)
          .map((i) => i.message);
      expect(messages("en")).toEqual([
        "browserhive:capture.robotsOverride.reason holds 0 Unicode code points — it holds 1 to 500",
        'browserhive:capture.robotsOverride.scope is "all" — it must be seeds or links',
        "browserhive:capture.robotsOverride lacks grantedBy (required by BrowserHive WACZ Profile 1.29.0)",
        'browserhive:capture.robotsOverride.expiresAt is "never" — it must be an RFC 3339 date-time in UTC, with the offset written Z',
      ]);
      expect(messages("ja")).toEqual([
        "browserhive:capture.robotsOverride.reason が Unicode の code point で 0 —— 1〜500 でなければならない",
        'browserhive:capture.robotsOverride.scope が "all" —— seeds か links でなければならない',
        "browserhive:capture.robotsOverride に grantedBy がありません (BrowserHive WACZ Profile 1.29.0 の必須)",
        'browserhive:capture.robotsOverride.expiresAt が "never" —— UTC の RFC 3339 の date-time で、offset は Z でなければならない',
      ]);
    });
  });

  describe("版の条件", () => {
    /** 版の条件のほかでは必ず落ちる archive。 */
    const broken = (): FixtureOptions => archive("exempt");

    it("WACZ Profile 1.28.0 を名乗る archive には当てない（同じ名前の member が何であっても）", async () => {
      expect(await run({ ...broken(), conformsTo: WACZ_1_28 })).toEqual([]);
      expect(await run(archive(overrideWith({ scope: "all" }), { conformsTo: WACZ_1_28 }))).toEqual([]);
    });

    it("同じ archive でも、1.29.0 を名乗れば落ちる（黙ったのは archive の版のせい）", async () => {
      expect(await run(broken())).toEqual([bad("not-object", { found: "string" })]);
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
