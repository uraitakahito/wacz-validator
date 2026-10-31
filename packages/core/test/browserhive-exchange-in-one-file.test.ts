// @module-tag engine
/**
 * `browserhive/exchange-in-one-file` のテスト。
 *
 * 守っている主張は profile 1.14.0 の Archive files。1 つの交信の response・request・metadata は同じ本に在る。
 * 記録は互いを `WARC-Concurrent-To`・`WARC-Refers-To` で名指すので、名指した先が別の本なら交信がまたいでいる。
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

const RULE = "browserhive/exchange-in-one-file";
const PROFILE_1_14 = "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.14.0/";
const FIRST = "archive/data-000.warc.gz";
const SECOND = "archive/data-001.warc.gz";
const CSS = "https://site.test/app.css";
const RESPONSE_ID = "<urn:uuid:00000000-0000-0000-0000-000000000900>";
const REQUEST_ID = "<urn:uuid:00000000-0000-0000-0000-000000000901>";

const bad = (messageKey: string, params: Record<string, string>, entry: string): Issue => ({
  rule: RULE,
  severity: "error",
  messageKey: `${RULE}.${messageKey}`,
  params,
  location: { entry },
});

/** 1 本目に応答を持つ 2 本の archive。要求と metadata をどちらの本に置くかを選ぶ。 */
const archive = (where: { request?: "same" | "other"; metadata?: "same" | "other" } = {}): FixtureOptions => {
  const request = { uri: CSS, recordId: REQUEST_ID, concurrentTo: RESPONSE_ID };
  const metadata = { uri: CSS, refersTo: RESPONSE_ID, fields: { truncated: "too-large" } };
  return {
    software: "browserhive/21.0.0",
    conformsTo: PROFILE_1_14,
    warcName: "data-000.warc.gz",
    warcinfoFilename: "data-000.warc.gz",
    settings: { limits: { maxResponseBytes: 1, maxTaskBytes: 1, maxWarcBytes: 1 } },
    warcResponses: [{ uri: CSS, mime: "text/css", body: "a{}", recordId: RESPONSE_ID }],
    ...(where.request === "same" && { warcRequests: [request] }),
    ...(where.metadata === "same" && { warcMetadata: [metadata] }),
    extraWarcs: [
      {
        name: "data-001.warc.gz",
        warcinfoFilename: "data-001.warc.gz",
        ...(where.request === "other" && { requests: [request] }),
        ...(where.metadata === "other" && { metadata: [metadata] }),
      },
    ],
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

describe("browserhive/exchange-in-one-file", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "wacz-validator-exchange-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const run = async (options: FixtureOptions, selector: ProfileSelector = { name: "browserhive" }): Promise<Issue[]> =>
    (await reportFor(tmpDir, options, selector)).issues.filter((i) => i.rule === RULE);

  it("応答・要求・metadata が同じ本に在れば、何も言わない", async () => {
    expect(await run(archive({ request: "same", metadata: "same" }))).toEqual([]);
  });

  it("要求が応答と別の本に在れば、error", async () => {
    expect(await run(archive({ request: "other" }))).toEqual([bad("request", { url: CSS, entry: SECOND, other: FIRST }, SECOND)]);
  });

  it("metadata が指す応答と別の本に在れば、error", async () => {
    expect(await run(archive({ metadata: "other" }))).toEqual([bad("metadata", { url: CSS, entry: SECOND, other: FIRST }, SECOND)]);
  });

  it("1.14.0 より前の profile を名乗る archive には当てない", async () => {
    const old = { ...archive({ request: "other" }), conformsTo: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.13.0/" };
    expect(await run(old)).toEqual([]);
  });

  it("BrowserHive 21.0.0 より前を名乗る実行では走らず、skipped に残る", async () => {
    const report = await reportFor(tmpDir, archive({ request: "other" }), { name: "browserhive", version: { major: 20, minor: 0, patch: 0 } });
    expect(report.issues.some((i) => i.rule === RULE)).toBe(false);
    expect(report.skipped?.find((s) => s.rule === RULE)).toEqual({ rule: RULE, reason: "profile-version", range: ">=21.0.0" });
  });

  it("spec の profile では走らない", async () => {
    expect(await run(archive({ request: "other" }), { name: "spec" })).toEqual([]);
  });
});
