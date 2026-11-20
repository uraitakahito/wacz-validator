// @module-tag tui
/**
 * `render/detail.ts`(Layout 右ペインの純関数)のテスト。
 * Ink に依存しないので文字列化・突合だけを決定的に検証する。
 */
import { describe, expect, it } from "vitest";
import type { AbsolutePath, WireReport } from "@wacz-validator/protocol";
import { codecName, entryIssues, expectedLabel } from "../src/render/detail.js";

describe("codecName", () => {
  it("0 → STORE / 8 → DEFLATE / それ以外 → ?", () => {
    expect(codecName(0)).toBe("STORE");
    expect(codecName(8)).toBe("DEFLATE");
    expect(codecName(99)).toBe("?");
    expect(codecName(undefined)).toBe("?");
  });
});

describe("expectedLabel", () => {
  it("datapackage / wacz-spec / 両方 / 空 を出し分ける(section は §X に反映)", () => {
    expect(expectedLabel(["datapackage"])).toBe("declared in datapackage");
    expect(expectedLabel(["wacz-spec"], "5.2.1")).toBe("required by §5.2.1");
    expect(expectedLabel(["wacz-spec"])).toBe("required by §5.2"); // section 無しは §5.2 fallback
    expect(expectedLabel(["datapackage", "wacz-spec"], "5.2.4")).toBe(
      "declared in datapackage, required by §5.2.4",
    );
    expect(expectedLabel([])).toBe("—");
  });
});

describe("entryIssues", () => {
  const report = {
    validatorVersion: "0.0.0",
    profile: { name: "spec" },
    source: { kind: "file", path: "/tmp/x.wacz" as AbsolutePath },
    summary: { passed: 0, failed: 2, warnings: 0, info: 0, durationMs: 1 },
    issues: [
      { rule: "a/one", severity: "error", messageKey: "a/one.x", message: "one", location: { entry: "pages/pages.jsonl" } },
      { rule: "b/two", severity: "warning", messageKey: "b/two.x", message: "two", location: { entry: "datapackage.json" } },
      { rule: "c/three", severity: "info", messageKey: "c/three.x", message: "three" }, // location 無し
    ],
    entries: [],
    rules: [],
  } satisfies WireReport;

  it("location.entry が一致する issue だけを返す", () => {
    expect(entryIssues(report, "pages/pages.jsonl").map((i) => i.rule)).toEqual(["a/one"]);
    expect(entryIssues(report, "datapackage.json").map((i) => i.rule)).toEqual(["b/two"]);
    expect(entryIssues(report, "archive/data.warc.gz")).toEqual([]); // 一致なし
  });
});
