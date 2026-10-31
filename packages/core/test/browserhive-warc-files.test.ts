// @module-tag engine
/**
 * `browserhive/warc-files` のテスト。
 *
 * 守っている主張は profile 1.14.0 の Archive files。`archive/` には `data-NNN.warc.gz` だけが 000 から
 * 飛びなく並び、各本は自分を名指す warcinfo で始まり、最後以外の本は `settings.limits.maxWarcBytes` 以上。
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
import { buildWacz, type ExtraWarcSpec, type FixtureOptions } from "./fixtures/generator.js";

const RULE = "browserhive/warc-files";
const PROFILE_1_14 = "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.14.0/";
const FIRST = "archive/data-000.warc.gz";
const SECOND = "archive/data-001.warc.gz";

const bad = (messageKey: string, params: Record<string, string>, entry?: string): Issue => ({
  rule: RULE,
  severity: "error",
  messageKey: `${RULE}.${messageKey}`,
  params,
  ...(entry !== undefined && { location: { entry } }),
});

/** 2 本の本を持つ、21.0.0 の形の archive。`over` で崩す。 */
const archive = (over: { maxWarcBytes?: unknown; second?: Partial<ExtraWarcSpec> | null } = {}): FixtureOptions => ({
  software: "browserhive/21.0.0",
  conformsTo: PROFILE_1_14,
  warcName: "data-000.warc.gz",
  warcinfoFilename: "data-000.warc.gz",
  settings: { limits: { maxResponseBytes: 1, maxTaskBytes: 1, maxWarcBytes: "maxWarcBytes" in over ? over.maxWarcBytes : 1 } },
  extraWarcs: over.second === null ? [] : [{ name: "data-001.warc.gz", warcinfoFilename: "data-001.warc.gz", ...over.second }],
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

describe("browserhive/warc-files", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "wacz-validator-warc-files-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const run = async (options: FixtureOptions, selector: ProfileSelector = { name: "browserhive" }): Promise<Issue[]> =>
    (await reportFor(tmpDir, options, selector)).issues.filter((i) => i.rule === RULE);

  it("連番の名・先頭の warcinfo・上限以上の本が揃っていれば、何も言わない", async () => {
    expect(await run(archive())).toEqual([]);
    expect(await run(archive({ second: null }))).toEqual([]);
  });

  it("archive/ に data-NNN.warc.gz 以外の名の本があれば、error", async () => {
    expect(await run(archive({ second: { name: "extra.warc.gz", warcinfoFilename: "extra.warc.gz" } }))).toEqual([
      bad("name", { entry: "archive/extra.warc.gz" }, "archive/extra.warc.gz"),
    ]);
  });

  it("連番に飛びがあれば、error", async () => {
    expect(await run(archive({ second: { name: "data-002.warc.gz", warcinfoFilename: "data-002.warc.gz" } }))).toEqual([
      bad("gap", { expected: SECOND, found: "archive/data-002.warc.gz" }, "archive/data-002.warc.gz"),
    ]);
  });

  it("先頭が warcinfo でない本があれば、error", async () => {
    const second: Partial<ExtraWarcSpec> = {
      omitWarcinfo: true,
      responses: [{ uri: "https://example.com/a.css", mime: "text/css", body: "a{}" }],
    };
    expect(await run(archive({ second }))).toEqual([bad("first-record", { entry: SECOND, type: "response" }, SECOND)]);
  });

  it("warcinfo の WARC-Filename が自分の名でなければ（別の名でも、無くても）、error", async () => {
    expect(await run(archive({ second: { warcinfoFilename: "data-000.warc.gz" } }))).toEqual([
      bad("filename", { entry: SECOND, found: "data-000.warc.gz" }, SECOND),
    ]);
    const { warcinfoFilename: _dropped, ...noName } = archive();
    void _dropped;
    expect(await run(noName)).toEqual([bad("filename", { entry: FIRST, found: "-" }, FIRST)]);
  });

  it("最後以外の本が maxWarcBytes 未満なら、error —— 次の本を始めるのは、いまの本が上限に達してから", async () => {
    const issues = await run(archive({ maxWarcBytes: 10_000_000 }));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.messageKey).toBe(`${RULE}.under-limit`);
    expect(issues[0]?.params?.["entry"]).toBe(FIRST);
    expect(issues[0]?.params?.["limit"]).toBe("10000000");
  });

  it("settings.limits.maxWarcBytes が無いか、正の整数でなければ、error", async () => {
    expect(await run(archive({ maxWarcBytes: undefined }))).toEqual([bad("max-warc-bytes", { found: "-" })]);
    expect(await run(archive({ maxWarcBytes: "1" }))).toEqual([bad("max-warc-bytes", { found: "string" })]);
    expect(await run(archive({ maxWarcBytes: 0 }))).toEqual([bad("max-warc-bytes", { found: "0" })]);
  });

  it("1.14.0 より前の profile を名乗る archive には当てない —— 1 本の data.warc.gz は古い形のまま正しい", async () => {
    const old: FixtureOptions = {
      software: "browserhive/20.0.0",
      conformsTo: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.13.0/",
      settings: { limits: { maxResponseBytes: 1, maxTaskBytes: 1 } },
    };
    expect(await run(old)).toEqual([]);
  });

  it("BrowserHive 21.0.0 より前を名乗る実行では走らず、skipped に残る", async () => {
    const report = await reportFor(tmpDir, archive({ second: { name: "extra.warc.gz", warcinfoFilename: "extra.warc.gz" } }), {
      name: "browserhive",
      version: { major: 20, minor: 0, patch: 0 },
    });
    expect(report.issues.some((i) => i.rule === RULE)).toBe(false);
    expect(report.skipped?.find((s) => s.rule === RULE)).toEqual({ rule: RULE, reason: "profile-version", range: ">=21.0.0" });
  });

  it("spec の profile では走らない（browserhive 固有の形）", async () => {
    expect(await run(archive({ second: { name: "extra.warc.gz", warcinfoFilename: "extra.warc.gz" } }), { name: "spec" })).toEqual([]);
  });
});
