// @module-tag warc
/**
 * `warc/segmentation` の試験。
 *
 * 3 つに分けた列（先頭・continuation 2 つ）を土台に、§7 の shall を 1 つずつ崩して鳴ることを
 * 確かめる。列の一部が WACZ の外に在る形（先頭が見つからない・continuation が無い）は、違反と
 * 言わず info で告げることも置く。
 *
 * 並びは warcinfo (0)・先頭 (1)・continuation (2, 3)。
 */
import { describe, expect, it } from "vitest";
import type { RuleProfile } from "../src/validate/domain.js";
import { segmentRecordId, type FixtureOptions, type WarcRecordPatch } from "./fixtures/generator.js";
import { firedWarc11Rules, reportFor, warc11Issues } from "./fixtures/warc11.js";

const RULE = "warc/segmentation";
const URI = "https://site.test/big";
const PARTS = ["first part, ", "second part, ", "last part"];

const series = (patches: WarcRecordPatch[] = [], parts = PARTS): FixtureOptions => ({
  warcSegmented: [{ uri: URI, parts }],
  warcRecordPatches: patches,
});

const found = async (options: FixtureOptions, profile: RuleProfile = "spec"): Promise<string[]> =>
  warc11Issues(await reportFor(options, profile))
    .filter((i) => i.rule === RULE)
    .map((i) => [i.severity, i.messageKey.slice(RULE.length + 1), i.params?.["record"]].join(" "));

describe("warc/segmentation", () => {
  it("正しい列には鳴らない", async () => {
    expect(await found(series())).toEqual([]);
    expect(await found(series([], ["only one continuation: ", "end"]))).toEqual([]);
  });

  it("先頭の番号が 1 でなければ鳴る（この rule だけ）", async () => {
    const options = series([{ index: 1, set: { "WARC-Segment-Number": "2" } }]);
    expect(await found(options)).toEqual(["warning origin-number 2"]);
    expect(firedWarc11Rules(await reportFor(options))).toEqual([RULE]);
  });

  it("continuation の番号が 2 から 1 ずつ増えなければ鳴る", async () => {
    const issues = warc11Issues(await reportFor(series([{ index: 3, set: { "WARC-Segment-Number": "4" } }])));
    expect(issues.map((i) => [i.messageKey, i.params?.["found"]])).toEqual([[`${RULE}.number-sequence`, "2, 4"]]);
  });

  it("Target-URI が列の先頭と違えば鳴る", async () => {
    expect(await found(series([{ index: 2, set: { "WARC-Target-URI": "https://site.test/other" } }]))).toEqual([
      "warning target-uri-differs 3",
    ]);
  });

  it("最後の continuation に合計が無い・最後でない continuation に在る・値が合わない", async () => {
    expect(await found(series([{ index: 3, set: { "WARC-Segment-Total-Length": null } }]))).toEqual(["warning total-length-missing 4"]);
    expect(await found(series([{ index: 2, set: { "WARC-Segment-Total-Length": "34" } }]))).toEqual(["warning total-length-not-last 3"]);
    expect(await found(series([{ index: 3, set: { "WARC-Segment-Total-Length": "999" } }]))).toEqual(["warning total-length-mismatch 4"]);
  });

  it("shall に反するものは browserhive で error、lenient で info", async () => {
    const options = series([{ index: 3, set: { "WARC-Segment-Total-Length": "999" } }]);
    expect(await found(options, "browserhive")).toEqual(["error total-length-mismatch 4"]);
    expect(await found(options, "lenient")).toEqual(["info total-length-mismatch 4"]);
  });

  it("先頭が WACZ に無い continuation と、continuation の無い先頭は info で告げ、数は照らさない", async () => {
    const missingOrigin = series([
      { index: 2, set: { "WARC-Segment-Origin-ID": segmentRecordId(900, 0) } },
      { index: 3, set: { "WARC-Segment-Origin-ID": segmentRecordId(900, 0) } },
    ]);
    // 先頭 (2) を指す continuation は無く、continuation (3, 4) の指す先頭は WACZ に無い。
    expect(await found(missingOrigin)).toEqual(["info no-continuation 2", "info origin-not-found 3"]);
    expect(await found(series([], ["alone"]))).toEqual(["info no-continuation 2"]);
  });

  it("continuation を先頭として指す continuation は鳴る", async () => {
    // 2 つ目の continuation (3) が、1 つ目の continuation (2) を先頭として指す。
    const options = series([{ index: 3, set: { "WARC-Segment-Origin-ID": segmentRecordId(600, 1) } }]);
    expect(await found(options)).toContain("warning origin-is-continuation 4");
  });

  it("先頭以外の記録が続きに要らない欄を持てば info（browserhive で warning）", async () => {
    const options = series([{ index: 2, set: { "Content-Type": "text/plain" } }]);
    expect(await found(options, "spec")).toEqual(["info extra-fields 3"]);
    expect(await found(options, "browserhive")).toEqual(["warning extra-fields 3"]);
  });
});
