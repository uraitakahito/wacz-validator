// @module-tag engine
/**
 * 報告の `rules`（rule 1 本の結果）の試験。
 *
 * 結果の決め方は、指摘を決めて返す作り物の rule で確かめる（WACZ の中身に依らない）。
 * 登録の順・profile で外した rule・説明の辞書は、本物の `DEFAULT_RULES` で確かめる。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProfileSelector, type ProfileSelector } from "@wacz-validator/contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderJson } from "../src/render/json.js";
import { runValidation } from "../src/validate/engine.js";
import { DEFAULT_RULES } from "../src/validate/rules/index.js";
import type { Issue, Report, Severity, ValidationRule } from "../src/validate/domain.js";
import { ok } from "../src/result.js";
import { WaczReader } from "../src/wacz/reader.js";
import { fileTransport } from "../src/wacz/transport.js";
import { buildWacz } from "./fixtures/generator.js";

let dir: string;
let path: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "wacz-validator-rule-results-"));
  path = join(dir, "good.wacz");
  await writeFile(path, (await buildWacz()).bytes);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const selector = (raw: string): ProfileSelector => {
  const s = parseProfileSelector(raw);
  if (s === null) throw new Error(`bad selector: ${raw}`);
  return s;
};

const run = async (rules: readonly ValidationRule[], profile = "spec"): Promise<Report> => {
  const reader = await WaczReader.open(fileTransport(path as never));
  try {
    const result = await runValidation(reader, { validatorVersion: "0.0.0", rules, profile: selector(profile) });
    if (!result.ok) throw new Error("unreachable");
    return result.value;
  } finally {
    await reader.close();
  }
};

/** 決めた severity の指摘を 1 件ずつ返す作り物の rule。 */
const fake = (name: string, severities: Severity[], applicability?: ValidationRule["applicability"]): ValidationRule => ({
  name,
  descriptionKey: `${name}.desc`,
  conformance: "MUST",
  docs: [{ label: "spec", url: { en: `https://example.test/${name}` } }],
  ...(applicability !== undefined && { applicability }),
  run: () =>
    Promise.resolve(
      ok(severities.map((severity): Issue => ({ rule: name, severity, messageKey: `${name}.x` }))),
    ),
});

describe("rule ごとの結果の決め方", () => {
  it("一番重い指摘で結果が決まり、severity ごとに数える", async () => {
    const report = await run([
      fake("t/error", ["warning", "error", "error"]),
      fake("t/warning", ["info", "warning"]),
      fake("t/info", ["info"]),
      fake("t/none", []),
    ]);
    expect(report.rules.map((r) => [r.rule, r.outcome, r.counts])).toEqual([
      ["t/error", "failed", { error: 2, warning: 1, info: 0 }],
      ["t/warning", "warned", { error: 0, warning: 1, info: 1 }],
      ["t/info", "noted", { error: 0, warning: 0, info: 1 }],
      ["t/none", "passed", { error: 0, warning: 0, info: 0 }],
    ]);
  });

  it("数の合計は summary の指摘の数と合う", async () => {
    const report = await run([fake("t/a", ["error", "warning"]), fake("t/b", ["error", "info", "info"])]);
    const sum = (k: "error" | "warning" | "info"): number => report.rules.reduce((n, r) => n + r.counts[k], 0);
    expect([sum("error"), sum("warning"), sum("info")]).toEqual([
      report.summary.failed,
      report.summary.warnings,
      report.summary.info,
    ]);
  });

  it("profile の上書きで severity が下がれば、結果も下がる", async () => {
    const rule = fake("t/lowered", ["warning"], { severityByProfile: { lenient: { "t/lowered.x": "info" } } });
    expect((await run([rule], "spec")).rules[0]?.outcome).toBe("warned");
    expect((await run([rule], "lenient")).rules[0]?.outcome).toBe("noted");
  });

  it("profile で外した rule は excluded、版で外した rule は skipped と範囲を持つ", async () => {
    const report = await run(
      [
        fake("t/excluded", ["error"], { excludeProfiles: ["browserhive"] }),
        fake("t/skipped", ["error"], { profileVersions: { browserhive: ">=2.0.0" } }),
        fake("t/ran", []),
      ],
      "browserhive@1.0.0",
    );
    expect(report.rules.map((r) => [r.rule, r.outcome, r.range])).toEqual([
      ["t/excluded", "excluded", undefined],
      ["t/skipped", "skipped", ">=2.0.0"],
      ["t/ran", "passed", undefined],
    ]);
    expect(report.rules[0]?.counts).toEqual({ error: 0, warning: 0, info: 0 });
    // 版で外した rule は、いまの skipped にも同じく載る
    expect(report.skipped?.map((s) => s.rule)).toEqual(["t/skipped"]);
  });

  it("rule の宣言（MUST か・説明のキー・出典）をそのまま持つ", async () => {
    const [result] = (await run([fake("t/a", [])])).rules;
    expect(result).toMatchObject({
      conformance: "MUST",
      descriptionKey: "t/a.desc",
      docs: [{ label: "spec", url: { en: "https://example.test/t/a" } }],
    });
  });
});

describe("本物の rule の一覧", () => {
  it("登録した rule が、登録の順に 1 回ずつ載る", async () => {
    const report = await run(DEFAULT_RULES);
    expect(report.rules.map((r) => r.rule)).toEqual(DEFAULT_RULES.map((r) => r.name));
  });

  it("spec では、spec を外す rule が excluded になり、残りは走る", async () => {
    const report = await run(DEFAULT_RULES, "spec");
    const outOfSpec = DEFAULT_RULES.filter((r) => r.applicability?.excludeProfiles?.includes("spec") === true);
    expect(outOfSpec.length).toBeGreaterThan(0);
    expect(report.rules.filter((r) => r.outcome === "excluded").map((r) => r.rule)).toEqual(outOfSpec.map((r) => r.name));
    // 良い WACZ なので、走った rule は全部通る
    expect(report.rules.filter((r) => r.outcome !== "excluded").every((r) => r.outcome === "passed")).toBe(true);
  });

  it("JSON の rules は、説明を locale で解き、出典を 1 本の URL に畳む", async () => {
    const report = await run(DEFAULT_RULES);
    for (const locale of ["en", "ja"] as const) {
      const wire = JSON.parse(renderJson(report, locale)) as {
        rules: { rule: string; descriptionKey: string; description: string; docs: { label: string; url: string }[] }[];
      };
      expect(wire.rules).toHaveLength(DEFAULT_RULES.length);
      for (const r of wire.rules) {
        // 辞書に無いキーは、キーの字のまま返る
        expect(r.description, `${locale} ${r.rule}`).not.toBe(r.descriptionKey);
        expect(r.description.length).toBeGreaterThan(0);
        expect(r.docs.length).toBeGreaterThan(0);
        for (const d of r.docs) expect(typeof d.url).toBe("string");
      }
    }
  });
});
