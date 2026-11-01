// @module-tag engine
/**
 * `browserhive/warcinfo-declares-profile` のテスト。
 *
 * 守っている主張は WACZ Profile 1.16.0 の Archive files と BrowserHive WARC Profile 1.0.0 の warcinfo。
 * archive/ の WARC の本は、どれも先頭の warcinfo の `conformsTo` 1 つで BrowserHive WARC Profile の版を
 * 名乗り、1 つの archive の本はどれも同じ版を名乗る。
 *
 * 落とす標本と通す標本は、名乗りの 1 行か archive の版だけが違う —— rule が見ているのがその 1 行で
 * あることを、区別できる入力で確かめるため。
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

const RULE = "browserhive/warcinfo-declares-profile";
const WACZ_1_15 = "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.15.0/";
const WACZ_1_16 = "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.16.0/";
const WARC_1_0 = "https://uraitakahito.github.io/browserhive-warc-spec/1.0.0/";
const WARC_1_1 = "https://uraitakahito.github.io/browserhive-warc-spec/1.1.0/";
/** BrowserHive 22.0.0 までの warcinfo が名乗っていた、WARC 1.1 そのものの頁。 */
const IIPC = "http://iipc.github.io/warc-specifications/specifications/warc-format/warc-1.1/";
const FIRST = "archive/data-000.warc.gz";
const SECOND = "archive/data-001.warc.gz";

const bad = (messageKey: string, params: Record<string, string>, entry: string): Issue => ({
  rule: RULE,
  severity: "error",
  messageKey: `${RULE}.${messageKey}`,
  params,
  location: { entry },
});

/** 2 本の本を持つ archive。どちらの warcinfo も `lines` を名乗る。`over` で崩す。 */
const archive = (
  over: { conformsTo?: string; first?: string[]; second?: Partial<ExtraWarcSpec> } = {},
): FixtureOptions => ({
  software: "browserhive/22.1.0",
  conformsTo: over.conformsTo ?? WACZ_1_16,
  warcName: "data-000.warc.gz",
  warcinfoFilename: "data-000.warc.gz",
  warcinfoLines: over.first ?? [`conformsTo: ${WARC_1_0}`],
  settings: { limits: { maxResponseBytes: 1, maxTaskBytes: 1, maxWarcBytes: 1 } },
  extraWarcs: [
    {
      name: "data-001.warc.gz",
      warcinfoFilename: "data-001.warc.gz",
      warcinfoLines: [`conformsTo: ${WARC_1_0}`],
      ...over.second,
    },
  ],
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

describe("browserhive/warcinfo-declares-profile", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "wacz-validator-warcinfo-profile-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const run = async (options: FixtureOptions, selector: ProfileSelector = { name: "browserhive" }): Promise<Issue[]> =>
    (await reportFor(tmpDir, options, selector)).issues.filter((i) => i.rule === RULE);

  it("どの本も同じ WARC Profile の版を 1 つだけ名乗っていれば、何も言わない", async () => {
    expect(await run(archive())).toEqual([]);
  });

  it("1 本だけが WARC 1.1 そのもの（IIPC の頁）を名乗れば、その本の error", async () => {
    expect(await run(archive({ second: { warcinfoLines: [`conformsTo: ${IIPC}`] } }))).toEqual([
      bad("value", { entry: SECOND, found: IIPC }, SECOND),
    ]);
  });

  it("版でない latest/ を名乗っても error —— 名乗りは、書いたときの版を指さなければ辿れない", async () => {
    const latest = "https://uraitakahito.github.io/browserhive-warc-spec/latest/";
    expect(await run(archive({ first: [`conformsTo: ${latest}`] }))).toEqual([bad("value", { entry: FIRST, found: latest }, FIRST)]);
  });

  it("本ごとに版が違えば、後の本の error", async () => {
    expect(await run(archive({ second: { warcinfoLines: [`conformsTo: ${WARC_1_1}`] } }))).toEqual([
      bad("mismatch", { entry: SECOND, found: WARC_1_1, first: FIRST, expected: WARC_1_0 }, SECOND),
    ]);
  });

  it("conformsTo が 2 つ在れば error —— WARC Profile と WARC 1.1 を並べても、どちらが正か決まらない", async () => {
    expect(await run(archive({ first: [`conformsTo: ${WARC_1_0}`, `conformsTo: ${IIPC}`] }))).toEqual([
      bad("repeated", { entry: FIRST, count: "2", found: `${WARC_1_0}, ${IIPC}` }, FIRST),
    ]);
  });

  it("conformsTo が無ければ error", async () => {
    expect(await run(archive({ second: { warcinfoLines: [] } }))).toEqual([bad("missing", { entry: SECOND }, SECOND)]);
  });

  it("WACZ Profile 1.15.0 を名乗る archive には当てない —— そのころの本は WARC 1.1 を名乗るのが決まりどおり", async () => {
    const old = archive({ conformsTo: WACZ_1_15, first: [`conformsTo: ${IIPC}`], second: { warcinfoLines: [`conformsTo: ${IIPC}`] } });
    expect(await run(old)).toEqual([]);
    // 同じ本でも、1.16.0 を名乗れば落ちる。黙ったのは archive の版のせいで、本の形のせいではない。
    expect(await run({ ...old, conformsTo: WACZ_1_16 })).toHaveLength(2);
  });

  it("archive が版を名乗らなければ当てない", async () => {
    const { conformsTo: _dropped, ...unnamed } = archive({ first: [`conformsTo: ${IIPC}`] });
    void _dropped;
    expect(await run(unnamed)).toEqual([]);
  });

  it("先頭が warcinfo でない本は言わない —— それは browserhive/warc-files が言う", async () => {
    const second: Partial<ExtraWarcSpec> = {
      omitWarcinfo: true,
      responses: [{ uri: "https://site.test/a.css", mime: "text/css", body: "a{}" }],
    };
    const report = await reportFor(tmpDir, archive({ second }), { name: "browserhive" });
    expect(report.issues.filter((i) => i.rule === RULE)).toEqual([]);
    expect(report.issues.some((i) => i.messageKey === "browserhive/warc-files.first-record")).toBe(true);
  });

  it("spec の profile では走らない（browserhive 固有の形）", async () => {
    expect(await run(archive({ second: { warcinfoLines: [`conformsTo: ${IIPC}`] } }), { name: "spec" })).toEqual([]);
  });
});
