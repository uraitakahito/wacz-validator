// @module-tag engine
/**
 * `browserhive/window-shape` のテスト。
 *
 * 守っている主張は profile 1.12.0 の `windows` の節。開かせなかったウィンドウの記録は、
 * `window: not-opened` と書き、ウィンドウが読み込むはずだった URL を `WARC-Target-URI` に持ち、
 * `target` が在るなら `page` か `iframe` で、`action` を持たない（送らなかった要求の記録ではない）。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProfileSelector } from "@wacz-validator/contract";
import { parseReportSource, type Issue, type Report, type RuleProfile } from "../src/validate/domain.js";
import { runValidation } from "../src/validate/engine.js";
import { DEFAULT_RULES } from "../src/validate/rules/index.js";
import { fileTransport } from "../src/wacz/transport.js";
import { WaczReader } from "../src/wacz/reader.js";
import { buildWacz, type FixtureOptions } from "./fixtures/generator.js";

const RULE = "browserhive/window-shape";
const WARC = "archive/data.warc.gz";

/** 頁が開こうとした先。要求は送っていないので、ほかの記録は無い。 */
const CAMPAIGN = "https://shop.example/campaign?from=top";

/** この rule の error を 1 件。 */
const bad = (messageKey: string, params: Record<string, string>): Issue => ({
  rule: RULE,
  severity: "error",
  messageKey: `${RULE}.${messageKey}`,
  params,
  location: { entry: WARC },
});

/** fixture を 1 本作り、指定の selector で検査した report を返す。 */
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

describe("browserhive/window-shape", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "wacz-validator-window-shape-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const run = async (options: FixtureOptions, profile: RuleProfile = "browserhive"): Promise<Issue[]> =>
    (await reportFor(tmpDir, options, { name: profile })).issues.filter((i) => i.rule === RULE);

  it("正しい記録には、何も言わない（windowName と target が在っても、無くても）", async () => {
    expect(
      await run({
        warcMetadata: [
          { uri: CAMPAIGN, fields: { window: "not-opened", windowName: "_blank", target: "page" } },
          { uri: "about:blank", fields: { window: "not-opened" } },
          { uri: CAMPAIGN, fields: { window: "not-opened", target: "iframe" } },
        ],
      }),
    ).toEqual([]);
  });

  it("window の値が not-opened でなければ、error で落とす", async () => {
    expect(await run({ warcMetadata: [{ uri: CAMPAIGN, fields: { window: "opened" } }] })).toEqual([
      bad("value", { url: CAMPAIGN, value: "opened" }),
    ]);
  });

  it("WARC-Target-URI の無い記録は、error で落とす", async () => {
    expect(await run({ warcMetadata: [{ fields: { window: "not-opened" } }] })).toEqual([
      bad("uri", { value: "not-opened" }),
    ]);
  });

  it("target が page でも iframe でもなければ、error で落とす", async () => {
    expect(await run({ warcMetadata: [{ uri: CAMPAIGN, fields: { window: "not-opened", target: "worker" } }] })).toEqual([
      bad("target", { url: CAMPAIGN, target: "worker" }),
    ]);
  });

  it("action を持つ記録は、error で落とす —— 送らなかった要求の記録と混ぜている", async () => {
    expect(
      await run({
        warcMetadata: [{ uri: CAMPAIGN, fields: { window: "not-opened", action: "deny", pattern: "*/campaign*" } }],
      }),
    ).toEqual([bad("action", { url: CAMPAIGN, action: "deny" })]);
  });

  it("window の欄を持たない metadata は見ない（送らなかった要求・終わらなかった取得）", async () => {
    expect(
      await run({
        warcMetadata: [
          { uri: CAMPAIGN, fields: { action: "deny", pattern: "*/campaign*", method: "GET" } },
          { uri: CAMPAIGN, fields: { incomplete: "true", reason: "loadingFailed" } },
        ],
      }),
    ).toEqual([]);
  });

  it("spec / lenient profile では走らない", async () => {
    for (const profile of ["spec", "lenient"] as const) {
      expect(await run({ warcMetadata: [{ uri: CAMPAIGN, fields: { window: "opened" } }] }, profile)).toEqual([]);
    }
  });
});
