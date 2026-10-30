// @module-tag engine
/**
 * `browserhive/unintercepted-listed` のテスト。
 *
 * 守っている主張は profile 1.13.0 の Records of bodies not kept。本文は wire を渡ったのにバイト列で読めなかった
 * 応答は、`truncated: not-intercepted` の metadata で記録し、URL を `completeness.uninterceptedUrls` に載せ、
 * その response のレコードに `WARC-Truncated: unspecified` を付ける。
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
import { buildWacz, responseRecordId, type FixtureOptions } from "./fixtures/generator.js";

const RULE = "browserhive/unintercepted-listed";
const WARC = "archive/data.warc.gz";

/** 頁が読んだ CSS。本文は届いたが、取り込みはバイト列で読めなかった。 */
const CSS = "https://example.com/app.css";

const bad = (messageKey: string, params: Record<string, string>, entry: string): Issue => ({
  rule: RULE,
  severity: "error",
  messageKey: `${RULE}.${messageKey}`,
  params,
  location: { entry },
});

/** 読めなかった本文を 1 つ持つ archive。`over` で一覧・見出し・記録を崩す。 */
const archive = (
  over: { listed?: string[]; truncated?: string | null; recorded?: boolean } = {},
): FixtureOptions => ({
  warcResponses: [
    {
      uri: CSS,
      mime: "text/css",
      body: "",
      ...(over.truncated !== null && { truncated: over.truncated ?? "unspecified" }),
    },
  ],
  warcMetadata:
    over.recorded === false
      ? []
      : [{ uri: CSS, refersTo: responseRecordId(0), fields: { truncated: "not-intercepted", encodedDataLength: "812" } }],
  completeness: {
    bodylessUrls: [],
    truncatedUrls: [],
    uninterceptedUrls: over.listed ?? [CSS],
    complete: false,
  },
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

describe("browserhive/unintercepted-listed", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "wacz-validator-unintercepted-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const run = async (options: FixtureOptions, selector: ProfileSelector = { name: "browserhive" }): Promise<Issue[]> =>
    (await reportFor(tmpDir, options, selector)).issues.filter((i) => i.rule === RULE);

  it("記録と一覧が一致し、response が WARC-Truncated: unspecified を持てば、何も言わない", async () => {
    expect(await run(archive())).toEqual([]);
  });

  it("記録が在るのに一覧に載っていなければ、error —— archive が本文の欠けを申告していない", async () => {
    expect(await run(archive({ listed: [] }))).toEqual([bad("unlisted", { url: CSS }, "datapackage.json")]);
  });

  it("一覧に載っているのに記録が無ければ、error", async () => {
    expect(await run(archive({ recorded: false }))).toEqual([bad("unrecorded", { url: CSS }, WARC)]);
  });

  it("response の WARC-Truncated が unspecified でなければ（無いか、別の値なら）、error", async () => {
    expect(await run(archive({ truncated: null }))).toEqual([
      bad("truncated-header", { url: CSS, value: "-" }, WARC),
    ]);
    expect(await run(archive({ truncated: "length" }))).toEqual([
      bad("truncated-header", { url: CSS, value: "length" }, WARC),
    ]);
  });

  it("BrowserHive 20.0.0 より前の archive では走らない —— 届かなかった本文は空の 200 で、記録が無い", async () => {
    const report = await reportFor(tmpDir, archive({ listed: [] }), {
      name: "browserhive",
      version: { major: 19, minor: 0, patch: 3 },
    });
    expect(report.issues.some((i) => i.rule === RULE)).toBe(false);
    expect(report.skipped?.find((s) => s.rule === RULE)).toEqual({ rule: RULE, reason: "profile-version", range: ">=20.0.0" });
  });

  it("spec の profile では走らない（browserhive 固有の記録）", async () => {
    expect(await run(archive({ listed: [] }), { name: "spec" })).toEqual([]);
  });
});
