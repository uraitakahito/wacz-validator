// @module-tag engine
/**
 * `archive/` に WARC が何本もあるとき、WARC を読む rule と stats が全部の本を読むか。
 *
 * BrowserHive 21.0.0 は WARC を大きさで切り替えて `data-000.warc.gz`・`data-001.warc.gz` と置く。
 * 1 本目だけを読む実装は、2 本目の壊れを見ず、2 本目の応答を指す索引の行を「当たらない」と言う。
 * ここでは本の名前に何も求めない (それは `browserhive/warc-files` の仕事)。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseReportSource, type Report } from "../src/validate/domain.js";
import { runValidation } from "../src/validate/engine.js";
import { DEFAULT_RULES } from "../src/validate/rules/index.js";
import { fileTransport } from "../src/wacz/transport.js";
import { WaczReader } from "../src/wacz/reader.js";
import { buildWacz, type FixtureOptions } from "./fixtures/generator.js";

const SECOND = "archive/data-001.warc.gz";

const reportFor = async (tmpDir: string, options: FixtureOptions): Promise<Report> => {
  const { bytes } = await buildWacz(options);
  const path = join(tmpDir, "fixture.wacz");
  await writeFile(path, bytes);
  const source = parseReportSource(path);
  if (!source.ok || source.value.kind !== "file") throw new Error("unreachable");
  const reader = await WaczReader.open(fileTransport(source.value.path));
  try {
    const result = await runValidation(reader, { validatorVersion: "0.0.0", rules: DEFAULT_RULES, profile: { name: "spec" } });
    if (!result.ok) throw new Error("runValidation returned err — unreachable");
    return result.value;
  } finally {
    await reader.close();
  }
};

const ofRule = (report: Report, rule: string) => report.issues.filter((i) => i.rule === rule);

describe("archive/ の WARC が何本もあるとき", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "wacz-validator-many-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("2 本目の member が壊れていれば、warc/members-independent が 2 本目の名で落ちる", async () => {
    const sound = await reportFor(tmpDir, { extraWarcs: [{ name: "data-001.warc.gz" }] });
    expect(ofRule(sound, "warc/members-independent")).toEqual([]);

    const broken = await reportFor(tmpDir, { extraWarcs: [{ name: "data-001.warc.gz", corruptAt: 30 }] });
    const issues = ofRule(broken, "warc/members-independent");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.location?.entry).toBe(SECOND);
  });

  it("索引の行は、filename の本の offset で照らす —— 2 本目の応答の行が通る", async () => {
    const report = await reportFor(tmpDir, {
      extraWarcs: [
        { name: "data-001.warc.gz", responses: [{ uri: "https://example.com/a.css", mime: "text/css", body: "a{}" }] },
      ],
    });
    expect(ofRule(report, "cdxj/warc-offsets")).toEqual([]);
    expect(ofRule(report, "warc/payload-digest")).toEqual([]);
  });

  it("索引が同梱しない本を指す行は、file-not-in-archive", async () => {
    const report = await reportFor(tmpDir, {
      extraWarcs: [
        {
          name: "data-001.warc.gz",
          cdxjFilename: "data-009.warc.gz",
          responses: [{ uri: "https://example.com/a.css", mime: "text/css", body: "a{}" }],
        },
      ],
    });
    const issues = ofRule(report, "cdxj/warc-offsets");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.messageKey).toBe("cdxj/warc-offsets.file-not-in-archive");
    expect(issues[0]?.params).toEqual({ line: "2", filename: "data-009.warc.gz" });
  });

  it("2 本目が DEFLATE なら、warc/storage-store が 2 本目を言う", async () => {
    const report = await reportFor(tmpDir, { extraWarcs: [{ name: "data-001.warc.gz", deflate: true }] });
    const issues = ofRule(report, "warc/storage-store");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.params?.["entry"]).toBe(SECOND);
  });

  it("stats は全部の本の和", async () => {
    const one = await reportFor(tmpDir, {});
    const two = await reportFor(tmpDir, {
      extraWarcs: [{ name: "data-001.warc.gz", responses: [{ uri: "https://example.com/a.css", mime: "text/css", body: "a{}" }] }],
    });
    expect(one.stats?.warcRecordCount).toBe(1);
    expect(two.stats?.warcRecordCount).toBe(3);
    expect(two.stats?.warcArchiveBytes ?? 0).toBeGreaterThan(one.stats?.warcArchiveBytes ?? 0);
  });
});
