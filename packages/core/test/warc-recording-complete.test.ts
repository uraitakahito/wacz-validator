// @module-tag warc
/**
 * `warc/recording-complete`(info/warning · browserhive profile 限定)のテスト。
 *
 * browserhive は失敗/未完了の HTTP やり取りを WARC の `WARC-Type: metadata`
 * レコード(`application/warc-fields` body: `incomplete: true` / `reason: ...`)
 * として記録する。本ルールはそれを数えて可視化する — ただし規格外の
 * producer 慣習なので `--profile browserhive` のときだけ走る(spec/lenient は
 * `excludeProfiles` で除外)。
 *
 * generator の `warcIncompleteRecords` で metadata レコードを n 件注入する。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProfileSelector } from "@wacz-validator/contract";
import {
  parseReportSource,
  type Issue,
  type Report,
  type SkippedRule,
  type RuleProfile,
} from "../src/validate/domain.js";
import { runValidation } from "../src/validate/engine.js";
import { DEFAULT_RULES } from "../src/validate/rules/index.js";
import { fileTransport } from "../src/wacz/transport.js";
import { WaczReader } from "../src/wacz/reader.js";
import { buildWacz, type FixtureOptions } from "./fixtures/generator.js";

const RULE = "warc/recording-complete";

const issuesFor = async (
  tmpDir: string,
  options: FixtureOptions = {},
  profile: RuleProfile = "browserhive",
): Promise<Issue[]> => {
  const { bytes } = await buildWacz(options);
  const path = join(tmpDir, "fixture.wacz");
  await writeFile(path, bytes);
  const sourceResult = parseReportSource(path);
  if (!sourceResult.ok) throw new Error("unreachable: test input is well-formed");
  if (sourceResult.value.kind !== "file") throw new Error("unreachable: local file");
  const reader = await WaczReader.open(fileTransport(sourceResult.value.path));
  try {
    const result = await runValidation(reader, {
      validatorVersion: "0.0.0",
      rules: DEFAULT_RULES,
      profile: { name: profile },
    });
    if (!result.ok) throw new Error("runValidation returned err — unreachable");
    return result.value.issues;
  } finally {
    await reader.close();
  }
};

describe("warc/recording-complete", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "wacz-validator-rec-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("browserhive profile: 未完了 metadata を warning で出し、件数を details に載せる", async () => {
    const issues = await issuesFor(tmpDir, { warcIncompleteRecords: 30 }, "browserhive");
    const hit = issues.find((i) => i.rule === RULE);
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe("warning"); // responses 0 / incomplete 30 → 100% > 10%
    const recording = (hit?.details as { recording?: { incomplete?: number } } | undefined)?.recording;
    expect(recording?.incomplete).toBe(30);
  });

  it("metadata が無ければ何も出さない", async () => {
    const issues = await issuesFor(tmpDir, {}, "browserhive");
    expect(issues.some((i) => i.rule === RULE)).toBe(false);
  });

  it("spec / lenient profile では除外され出ない", async () => {
    for (const profile of ["spec", "lenient"] as const) {
      const issues = await issuesFor(tmpDir, { warcIncompleteRecords: 30 }, profile);
      expect(issues.some((i) => i.rule === RULE)).toBe(false);
    }
  });

  it("resourceType / blockedReason を byResourceType / byBlockedReason に集計する", async () => {
    const issues = await issuesFor(
      tmpDir,
      {
        warcIncompleteSpec: [
          { resourceType: "Image" },
          { resourceType: "Image" },
          { resourceType: "Script", blockedReason: "inspector" },
        ],
      },
      "browserhive",
    );
    const recording = (
      issues.find((i) => i.rule === RULE)?.details as
        | {
            recording?: {
              byResourceType?: Record<string, number>;
              byBlockedReason?: Record<string, number>;
            };
          }
        | undefined
    )?.recording;
    expect(recording?.byResourceType).toEqual({ Image: 2, Script: 1 });
    expect(recording?.byBlockedReason).toEqual({ inspector: 1 });
  });

  it("本文を省いた理由 (truncated) と記録しなかった要求 (action) を byReason に分ける", async () => {
    // 欄の形は browserhive の recorder が書くものに揃えてある。以前の rule は `skipBodyReason`
    // という書かれたことの無い欄を読んでいて、下の 6 件をすべて incomplete に数えていた。
    const issues = await issuesFor(
      tmpDir,
      {
        warcMetadata: [
          { uri: "https://example.com/a.mp4", fields: { truncated: "too-large", encodedDataLength: "5013" } },
          { uri: "https://example.com/b.mp4", fields: { truncated: "task-cap" } },
          { uri: "https://example.com/c.mp4", fields: { truncated: "content-type" } },
          { uri: "https://example.com/d.mp4", fields: { truncated: "url-policy" } },
          { uri: "https://example.com/e.js", fields: { action: "deny", pattern: "*.js", method: "GET" } },
          { uri: "https://example.com/f.js", fields: { action: "no-archive", pattern: "*/f.js", method: "GET" } },
          {
            uri: "https://example.com/g",
            fields: { incomplete: "true", reason: "loadingFailed", errorText: "net::ERR_FAILED" },
          },
          { uri: "https://example.com/h", fields: { incomplete: "true", reason: "stop-while-pending" } },
        ],
      },
      "browserhive",
    );
    const recording = (
      issues.find((i) => i.rule === RULE)?.details as
        | { recording?: { incomplete?: number; byReason?: Record<string, number> } }
        | undefined
    )?.recording;
    expect(recording?.byReason).toEqual({ failed: 1, incomplete: 1, truncated: 2, blocked: 4 });
    // 方針で省いた 4 件 (blocked) は内訳に残るが、未完了には数えない。
    expect(recording?.incomplete).toBe(4);
  });

  it("方針で省いたものしか無い archive には何も出さない", async () => {
    // deny しか当たらない取り込みにも「未完了」の warning が出ていた (v13.0.0 の積み残しの 12 番)。
    const issues = await issuesFor(
      tmpDir,
      {
        warcMetadata: [
          { uri: "https://example.com/e.js", fields: { action: "deny", pattern: "*.js", method: "GET" } },
          { uri: "https://example.com/f.js", fields: { action: "no-archive", pattern: "*/f.js", method: "GET" } },
          { uri: "https://example.com/d.mp4", fields: { truncated: "url-policy" } },
        ],
      },
      "browserhive",
    );
    expect(issues.some((i) => i.rule === RULE)).toBe(false);
  });
});

describe("producer のバージョンによるゲート", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "wacz-validator-recording-version-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** fixture を 1 本作り、指定 selector で validate した report を返す。 */
  const reportFor = async (selector: ProfileSelector): Promise<Report> => {
    const { bytes } = await buildWacz({ warcIncompleteRecords: 30 });
    const path = join(tmpDir, "fixture.wacz");
    await writeFile(path, bytes);
    const parsed = parseReportSource(path);
    if (!parsed.ok || parsed.value.kind !== "file") throw new Error("unreachable");
    const reader = await WaczReader.open(fileTransport(parsed.value.path));
    try {
      const result = await runValidation(reader, {
        validatorVersion: "0.0.0",
        rules: DEFAULT_RULES,
        profile: selector,
      });
      if (!result.ok) throw new Error("unreachable");
      return result.value;
    } finally {
      await reader.close();
    }
  };

  /**
   * この rule が落とされたかだけを見る。`report.skipped` 全体を固定すると、
   * 版の条件を持つ rule が別に増えるたびにここが壊れる —— 見たいのは
   * 「`warc/recording-complete` が走ったか」であって、報告全体の形ではない。
   */
  const skippedHere = (report: Report): SkippedRule | undefined =>
    report.skipped?.find((s) => s.rule === RULE);

  it("バージョンを名乗らなければ従来どおり走る（skipped は key ごと出ない）", async () => {
    // 既定を「バージョンを問わない」に置いている根拠。ここが崩れると、バージョンを書かない
    // 既存の呼び出しの出力が変わる。
    const report = await reportFor({ name: "browserhive" });
    expect(report.skipped).toBeUndefined();
    expect(report.issues.some((i) => i.rule === RULE)).toBe(true);
  });

  it("範囲内のバージョンでも走る", async () => {
    const report = await reportFor({
      name: "browserhive",
      version: { major: 2, minor: 1, patch: 0 },
    });
    expect(skippedHere(report)).toBeUndefined();
    expect(report.issues.some((i) => i.rule === RULE)).toBe(true);
  });

  it("範囲外のバージョンでは走らず、落としたことが report に残る", async () => {
    // 黙って消さないのが要点 — 読者が「問題なし」と「見ていない」を
    // 区別できないと、報告が嘘に近づく。
    const report = await reportFor({
      name: "browserhive",
      version: { major: 1, minor: 10, patch: 0 },
    });
    expect(report.issues.some((i) => i.rule === RULE)).toBe(false);
    expect(skippedHere(report)).toEqual({
      rule: RULE,
      reason: "profile-version",
      range: ">=1.11.0",
    });
    // バージョンは skipped に複製せず、profile に 1 箇所だけ持つ。
    expect(report.profile).toEqual({ name: "browserhive", version: "1.10.0" });
  });

  it("下限そのものは範囲内", async () => {
    const report = await reportFor({
      name: "browserhive",
      version: { major: 1, minor: 11, patch: 0 },
    });
    expect(skippedHere(report)).toBeUndefined();
  });
});
