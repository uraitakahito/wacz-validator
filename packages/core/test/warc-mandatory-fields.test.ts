// @module-tag warc
/**
 * `warc/mandatory-fields` の試験。
 *
 * すべての記録に要る 3 つの欄と、type によって要る欄（Target-URI・Profile・分割の欄）を 1 つずつ
 * 消し、この rule だけが鳴ることを確かめる。type によっては要らない欄（metadata の Target-URI）を
 * 消しても鳴らないことも置く。最後に、同じ欠陥が本の中で繰り返すと 4 件に丸め、JSON の message に
 * 残りの件数が付くことを見る。
 */
import { describe, expect, it } from "vitest";
import { renderJson } from "../src/render/json.js";
import type { RuleProfile } from "../src/validate/domain.js";
import type { FixtureOptions } from "./fixtures/generator.js";
import { firedWarc11Rules, reportFor, warc11Issues } from "./fixtures/warc11.js";

const RULE = "warc/mandatory-fields";
const RESPONSE = { uri: "https://site.test/a", mime: "text/html", body: "<p>a</p>" };

const missingOf = async (options: FixtureOptions, profile: RuleProfile = "spec"): Promise<string[]> =>
  warc11Issues(await reportFor(options, profile))
    .filter((i) => i.rule === RULE)
    .map((i) => [i.severity, i.messageKey.slice(RULE.length + 1), i.params?.["field"], i.params?.["type"] ?? "-"].join(" "));

describe("warc/mandatory-fields", () => {
  it.each(["WARC-Record-ID", "WARC-Date", "WARC-Type"])("すべての記録に要る %s が無ければ鳴る（この rule だけ）", async (field) => {
    const options = { warcRecordPatches: [{ index: 0, set: { [field]: null } }] };
    expect(await missingOf(options)).toEqual([`warning missing ${field} -`]);
    expect(firedWarc11Rules(await reportFor(options))).toEqual([RULE]);
  });

  it("response と request の WARC-Target-URI は type つきで鳴る", async () => {
    const options = {
      warcResponses: [RESPONSE],
      warcRequests: [{ uri: RESPONSE.uri }],
      warcRecordPatches: [
        { index: 1, set: { "WARC-Target-URI": null } },
        { index: 2, set: { "WARC-Target-URI": null } },
      ],
    };
    expect(await missingOf(options)).toEqual([
      "warning missing-for-type WARC-Target-URI response",
      "warning missing-for-type WARC-Target-URI request",
    ]);
  });

  it("metadata の WARC-Target-URI は任意なので鳴らない", async () => {
    expect(await missingOf({ warcMetadata: [{ fields: { via: "https://site.test/" } }] })).toEqual([]);
  });

  it("WARC-Profile の無い revisit は鳴る", async () => {
    expect(await missingOf({ warcRevisits: [{ uri: RESPONSE.uri, profile: null }] })).toEqual([
      "warning missing-for-type WARC-Profile revisit",
    ]);
  });

  it("continuation に WARC-Segment-Origin-ID と WARC-Segment-Number が無ければ鳴る", async () => {
    // 並びは warcinfo (0)・分割の先頭 (1)・continuation (2)。
    const options: FixtureOptions = {
      warcSegmented: [{ uri: RESPONSE.uri, parts: ["first half ", "second half"] }],
      warcRecordPatches: [{ index: 2, set: { "WARC-Segment-Origin-ID": null, "WARC-Segment-Number": null } }],
    };
    expect(await missingOf(options)).toEqual([
      "warning missing-for-type WARC-Segment-Number continuation",
      "warning missing-for-type WARC-Segment-Origin-ID continuation",
    ]);
  });

  it("WARC-Type が無ければ、type によって要る欄は見ない", async () => {
    const options = { warcResponses: [RESPONSE], warcRecordPatches: [{ index: 1, set: { "WARC-Type": null, "WARC-Target-URI": null } }] };
    expect(await missingOf(options)).toEqual(["warning missing WARC-Type -"]);
  });

  it("8 つのどれでもない type（拡張）は、すべての記録に要る欄だけを見る", async () => {
    const options = { warcResponses: [RESPONSE], warcRecordPatches: [{ index: 1, set: { "WARC-Type": "x-custom", "WARC-Target-URI": null } }] };
    expect(await missingOf(options)).toEqual([]);
  });

  it("browserhive では error、lenient では info", async () => {
    const options = { warcRecordPatches: [{ index: 0, set: { "WARC-Date": null } }] };
    expect(await missingOf(options, "browserhive")).toEqual(["error missing WARC-Date -"]);
    expect(await missingOf(options, "lenient")).toEqual(["info missing WARC-Date -"]);
  });

  it("issue は欄の節への直のリンクを details に持つ", async () => {
    const [issue] = warc11Issues(await reportFor({ warcRecordPatches: [{ index: 0, set: { "WARC-Date": null } }] }));
    expect(issue?.details).toEqual({
      field: "WARC-Date",
      spec: "https://uraitakahito.github.io/warc-specifications/specifications/warc-format/warc-1.1-annotated/#warc-date-mandatory",
    });
  });

  it("同じ本の同じ欠陥は 4 件に丸め、最後の 1 件の message に残りの件数が付く", async () => {
    // 未完了の metadata を 6 件積み（並びの 1〜6）、全部の WARC-Date を消す。
    const report = await reportFor({
      warcIncompleteRecords: 6,
      warcRecordPatches: [1, 2, 3, 4, 5, 6].map((index) => ({ index, set: { "WARC-Date": null } })),
    });
    const issues = warc11Issues(report);
    expect(issues.map((i) => i.params?.["record"])).toEqual(["2", "3", "4", "5"]);
    expect(issues.map((i) => i.params?.["more"])).toEqual([undefined, undefined, undefined, 2]);

    const messages = (locale: "en" | "ja"): string[] =>
      (JSON.parse(renderJson(report, locale)) as { issues: { rule: string; message: string }[] }).issues
        .filter((i) => i.rule === RULE)
        .map((i) => i.message);
    expect(messages("en")[3]).toBe("WARC record #5 has no WARC-Date, which every record must have (and 2 more like this in the same file)");
    expect(messages("en")[0]).toBe("WARC record #2 has no WARC-Date, which every record must have");
    expect(messages("ja")[3]).toBe("WARC 記録 #5 に WARC-Date が無い —— すべての記録に要る欄（同じ本にほか 2 件）");
  });
});
