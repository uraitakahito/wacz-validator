// @module-tag engine
/**
 * `browserhive/crashed-targets-listed` のテスト。
 *
 * 守っている主張は profile 1.21.0 の crashedTargets。renderer が落ちた、主文書以外の target を一覧に載せ、
 * 一覧が空でなければ `complete` は `false`。一覧は整列し、方針か `document.withheld` が求めるときは `url` を書かない。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProfileSelector } from "@wacz-validator/contract";
import { parseReportSource, type Issue, type Report } from "../src/validate/domain.js";
import { runValidation } from "../src/validate/engine.js";
import { DEFAULT_RULES } from "../src/validate/rules/index.js";
import { fileTransport } from "../src/wacz/transport.js";
import { WaczReader } from "../src/wacz/reader.js";
import { buildWacz, type FixtureOptions } from "./fixtures/generator.js";

const RULE = "browserhive/crashed-targets-listed";
const PROFILE_1_21 = "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.21.0/";
const PROFILE_1_20 = "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.20.0/";

const ADS = "https://ads.test/frame";
const CRASHED = { type: "iframe", url: ADS, status: "crashed" };

const bad = (messageKey: string, params: Record<string, string> = {}): Issue => ({
  rule: RULE,
  severity: "error",
  messageKey: `${RULE}.${messageKey}`,
  params,
  location: { entry: "datapackage.json" },
});

/** 1.21.0 を名乗る archive。`over` で崩す。 */
const archive = (crashedTargets: unknown, over: Partial<FixtureOptions> & { complete?: boolean } = {}): FixtureOptions => {
  const { complete, ...rest } = over;
  return {
    conformsTo: PROFILE_1_21,
    completeness: {
      bodylessUrls: [],
      truncatedUrls: [],
      uninterceptedUrls: [],
      ...(crashedTargets !== undefined && { crashedTargets }),
      complete: complete ?? (Array.isArray(crashedTargets) ? crashedTargets.length === 0 : true),
    },
    ...rest,
  };
};

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

describe("browserhive/crashed-targets-listed", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "wacz-validator-crashed-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const run = async (options: FixtureOptions, selector: ProfileSelector = { name: "browserhive" }): Promise<Issue[]> =>
    (await reportFor(tmpDir, options, selector)).issues.filter((i) => i.rule === RULE);

  it("一覧が空で complete が true なら、何も言わない", async () => {
    expect(await run(archive([]))).toEqual([]);
  });

  it("載っていて complete が false なら、何も言わない", async () => {
    expect(await run(archive([CRASHED]))).toEqual([]);
  });

  it("一覧が無ければ error", async () => {
    expect(await run(archive(undefined))).toEqual([bad("missing")]);
  });

  it("一覧が配列でなければ error", async () => {
    expect(await run(archive("iframe"))).toEqual([bad("missing")]);
  });

  it("一覧が空でないのに complete が true なら error —— 頁の一部が死んだことを archive が打ち消している", async () => {
    expect(await run(archive([CRASHED], { complete: true }))).toEqual([bad("complete-true")]);
  });

  it.each([
    ["オブジェクトでない", "iframe"],
    ["type が無い", { url: ADS, status: "crashed" }],
    ["status が無い", { type: "iframe", url: ADS }],
    ["type が文字列でない", { type: 1, url: ADS, status: "crashed" }],
    ["url が文字列でない", { type: "iframe", url: 1, status: "crashed" }],
  ])("項目の形が違えば error: %s", async (_name, entry) => {
    expect(await run(archive([entry]))).toEqual([bad("bad-entry", { index: "0" })]);
  });

  it("url・type・status の順に整列し、url の無い項目が前なら、何も言わない", async () => {
    expect(
      await run(
        archive([
          { type: "iframe", status: "killed" },
          { type: "worker", status: "crashed" },
          { type: "iframe", url: "https://a.test/", status: "crashed" },
          { type: "iframe", url: "https://b.test/", status: "crashed" },
          { type: "iframe", url: "https://b.test/", status: "killed" },
          { type: "worker", url: "https://b.test/", status: "crashed" },
        ]),
      ),
    ).toEqual([]);
  });

  it("コードポイント順なら何も言わない —— 言語の辞書順 (localeCompare) では並びが変わる URL で", async () => {
    const entries = ["B", "a", "x-y", "x/y", "x?y", "x_y"].map((rest) => ({
      type: "iframe",
      url: `https://a.test/${rest}`,
      status: "crashed",
    }));
    expect(await run(archive(entries))).toEqual([]);
  });

  it("言語の辞書順で並べた archive は error", async () => {
    const entries = ["a", "B"].map((rest) => ({ type: "iframe", url: `https://a.test/${rest}`, status: "crashed" }));
    expect(await run(archive(entries))).toEqual([bad("unsorted", { index: "1" })]);
  });

  it.each([
    ["url の順", [{ type: "iframe", url: "https://b.test/", status: "crashed" }, { type: "iframe", url: "https://a.test/", status: "crashed" }]],
    ["url の無い項目が後ろ", [{ type: "iframe", url: "https://a.test/", status: "crashed" }, { type: "iframe", status: "crashed" }]],
    ["type の順", [{ type: "worker", url: ADS, status: "crashed" }, { type: "iframe", url: ADS, status: "crashed" }]],
    ["status の順", [{ type: "iframe", url: ADS, status: "killed" }, { type: "iframe", url: ADS, status: "crashed" }]],
  ])("並びが違えば error: %s", async (_name, entries) => {
    expect(await run(archive(entries))).toEqual([bad("unsorted", { index: "1" })]);
  });

  it.each(["no-archive", "deny"])("最初に当たる方針が %s の URL を書けば error", async (action) => {
    const pattern = "*://ads.test/*";
    expect(await run(archive([CRASHED], { settings: { urlPolicies: [{ pattern, action }] } }))).toEqual([
      bad("url-by-policy", { url: ADS, pattern, action }),
    ]);
  });

  it("URL を書かなければ、方針が当たる取り込みでも何も言わない", async () => {
    const entry = { type: "iframe", status: "crashed" };
    expect(await run(archive([entry], { settings: { urlPolicies: [{ pattern: "*://ads.test/*", action: "deny" }] } }))).toEqual([]);
  });

  it("対照: 最初に当たる方針が no-body なら、後ろの deny が当たっても URL を書いてよい", async () => {
    const urlPolicies = [
      { pattern: "*://ads.test/*", action: "no-body" },
      { pattern: "*://ads.test/*", action: "deny" },
    ];
    expect(await run(archive([CRASHED], { settings: { urlPolicies } }))).toEqual([]);
  });

  it("主文書を伏せた取り込みで URL を書けば error", async () => {
    expect(await run(archive([CRASHED], { document: { withheld: "no-archive" } }))).toEqual([
      bad("url-by-document", { url: ADS, withheld: "no-archive" }),
    ]);
  });

  it("1.21.0 より前を名乗る archive と、名乗らない archive には当てない", async () => {
    expect(await run(archive(undefined, { conformsTo: PROFILE_1_20 }))).toEqual([]);
    expect(await run({ completeness: { complete: true, bodylessUrls: [], truncatedUrls: [] } })).toEqual([]);
  });

  it("browserhive の外の profile には当てない", async () => {
    expect(await run(archive([CRASHED], { complete: true }), { name: "spec" })).toEqual([]);
    expect(await run(archive([CRASHED], { complete: true }), { name: "lenient" })).toEqual([]);
  });
});
