// @module-tag warc
/**
 * `warc/record-structure` の試験。
 *
 * 記録の形を 1 か所ずつ壊し、この rule だけが鳴ることを確かめる（欄の rule は形の壊れた記録を
 * 見ない）。版の違いと折り返しだけは欄を信じてよい問題なので、他の rule も記録を見続ける。
 */
import { describe, expect, it } from "vitest";
import type { RuleProfile } from "../src/validate/domain.js";
import type { FixtureOptions } from "./fixtures/generator.js";
import { firedWarc11Rules, metadataHeader, rawRecord, reportFor, warc11Issues } from "./fixtures/warc11.js";

const RULE = "warc/record-structure";
const RESPONSE = { uri: "https://site.test/a", mime: "text/html", body: "<p>a</p>" };

const messagesOf = async (options: FixtureOptions, profile: RuleProfile = "spec"): Promise<string[]> =>
  warc11Issues(await reportFor(options, profile))
    .filter((i) => i.rule === RULE)
    .map((i) => `${i.severity} ${i.messageKey.slice(RULE.length + 1)}`);

describe("warc/record-structure", () => {
  it("既定の標本と、応答・要求・metadata を足した標本では鳴らない", async () => {
    expect(warc11Issues(await reportFor())).toEqual([]);
    const rich = await reportFor({
      warcResponses: [RESPONSE],
      warcRequests: [{ uri: RESPONSE.uri, concurrentTo: "<urn:uuid:00000000-0000-0000-0000-000000000200>" }],
      warcIncompleteRecords: 1,
      warcMetadata: [{ uri: RESPONSE.uri, fields: { via: "https://site.test/" } }],
    });
    expect(warc11Issues(rich)).toEqual([]);
  });

  it("WARC/1.0 は spec で warning・browserhive で error・lenient で info", async () => {
    const options = { warcVersion: "WARC/1.0" };
    expect(await messagesOf(options, "spec")).toEqual(["warning version-not-1-1"]);
    expect(await messagesOf(options, "browserhive")).toEqual(["error version-not-1-1"]);
    expect(await messagesOf(options, "lenient")).toEqual(["info version-not-1-1"]);
  });

  it("版の行の無い member は no-version-line で、記録として読まない", async () => {
    const report = await reportFor({ warcRawMembers: [Buffer.from("this is not a WARC record\r\n\r\n")] });
    expect(warc11Issues(report).map((i) => [i.messageKey, i.params?.["found"]])).toEqual([
      ["warc/record-structure.no-version-line", "this is not a WARC record"],
    ]);
  });

  it("LF だけの見出しは error で、欄の rule は黙る", async () => {
    const report = await reportFor({ warcHeaderLineEnding: "lf" });
    expect(await messagesOf({ warcHeaderLineEnding: "lf" })).toEqual(["error lf-line-ending"]);
    expect(firedWarc11Rules(report)).toEqual([RULE]);
  });

  it("空行の無い member は no-blank-line", async () => {
    expect(await messagesOf({ warcRawMembers: [Buffer.from("WARC/1.1\r\nWARC-Type: metadata\r\n")] })).toEqual([
      "error no-blank-line",
    ]);
  });

  it("name: value でない行は行番号つきの bad-field-line", async () => {
    const report = await reportFor({ warcRecordPatches: [{ index: 0, set: { "Not A Field": "x" } }] });
    const [issue] = warc11Issues(report);
    expect(issue?.messageKey).toBe(`${RULE}.bad-field-line`);
    expect(issue?.params?.["found"]).toBe("Not A Field: x");
    expect(firedWarc11Rules(report)).toEqual([RULE]);
  });

  it("折り返しは spec で info・browserhive で warning。欄の rule は記録を見続ける", async () => {
    const options = { warcResponses: [RESPONSE], warcRecordPatches: [{ index: 1, fold: "Content-Type" }] };
    expect(await messagesOf(options, "spec")).toEqual(["info folded-line"]);
    expect(await messagesOf(options, "browserhive")).toEqual(["warning folded-line"]);
    // 折り返しの次の行で Target-URI を消すと、欄の rule がそれを言う（記録を見続けている）。
    const both = await reportFor({
      warcResponses: [RESPONSE],
      warcRecordPatches: [{ index: 1, fold: "Content-Type", set: { "WARC-Target-URI": null } }],
    });
    expect(firedWarc11Rules(both)).toEqual(["warc/mandatory-fields", RULE]);
  });

  it("UTF-8 でない見出しは non-utf8", async () => {
    const block = "a: b\r\n";
    const lines = [...metadataHeader(990, block.length), Buffer.concat([Buffer.from("X-Note: "), Buffer.from([0xff])])];
    expect(await messagesOf({ warcRawMembers: [rawRecord(lines, block)] })).toEqual(["error non-utf8"]);
  });

  it("Content-Length が実体と合わない・無い・数でない", async () => {
    const mismatch = warc11Issues(await reportFor({ warcRecordPatches: [{ index: 0, contentLength: 5 }] }));
    expect(mismatch.map((i) => [i.messageKey, i.params?.["declared"]])).toEqual([[`${RULE}.content-length-mismatch`, 5]]);
    expect(Number(mismatch[0]?.params?.["actual"])).toBeGreaterThan(5);
    expect(await messagesOf({ warcRecordPatches: [{ index: 0, set: { "Content-Length": null } }] })).toEqual([
      "error content-length-missing",
    ]);
    expect(await messagesOf({ warcRecordPatches: [{ index: 0, set: { "Content-Length": "12a" } }] })).toEqual([
      "error content-length-form",
    ]);
  });

  it("記録を閉じる CRLF CRLF が無ければ no-terminator", async () => {
    expect(await messagesOf({ warcRecordPatches: [{ index: 0, dropTerminator: true }] })).toEqual(["error no-terminator"]);
  });

  it("1 つの member に記録が 2 つ入っていても鳴らない", async () => {
    const block = "a: b\r\n";
    const two = Buffer.concat([rawRecord(metadataHeader(991, block.length), block), rawRecord(metadataHeader(992, block.length), block)]);
    expect(warc11Issues(await reportFor({ warcRawMembers: [two] }))).toEqual([]);
  });

  it("warcinfo で始まらない本は、どの profile でも info", async () => {
    const options: FixtureOptions = {
      extraWarcs: [{ name: "data-001.warc.gz", omitWarcinfo: true, responses: [{ ...RESPONSE, uri: "https://site.test/b" }] }],
    };
    for (const profile of ["spec", "browserhive", "lenient"] as const) {
      const issues = warc11Issues(await reportFor(options, profile));
      expect(issues.map((i) => [i.severity, i.messageKey, i.location?.entry, i.params?.["type"]])).toEqual([
        ["info", `${RULE}.first-record-not-warcinfo`, "archive/data-001.warc.gz", "response"],
      ]);
    }
  });

  it("1 つの member の中で長さの合わない記録があっても、次の記録から読み直す", async () => {
    const block = "a: b\r\n";
    const records = [990, 991, 992].map((id) => rawRecord(metadataHeader(id, block.length), block));
    records[1] = rawRecord(metadataHeader(991, 3), block);
    const report = await reportFor({ warcRawMembers: [Buffer.concat(records)] });
    // 本の 1 番目は warcinfo なので、member の 2 つ目の記録は本の 3 番目。
    expect(warc11Issues(report).map((i) => [i.messageKey, i.params?.["record"]])).toEqual([
      [`${RULE}.content-length-mismatch`, "3"],
    ]);
  });
});
