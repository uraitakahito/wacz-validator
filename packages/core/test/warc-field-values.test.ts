// @module-tag warc
/**
 * `warc/field-values` の試験。
 *
 * 値の形の照らし方そのものは `warc11-values.test.ts` が境目ごとに見る。ここは rule として、
 * 欄ごとに正しい形が当たること（欄と形の対応）、違反・推奨・仕様が定義しない値の 3 つで等級が
 * profile ごとに変わること、Content-Length をここでは見ないことを確かめる。
 */
import { describe, expect, it } from "vitest";
import type { RuleProfile } from "../src/validate/domain.js";
import type { FixtureOptions } from "./fixtures/generator.js";
import { firedWarc11Rules, reportFor, warc11Issues } from "./fixtures/warc11.js";

const RULE = "warc/field-values";
const URI = "https://site.test/a";
const RESPONSE = { uri: URI, mime: "text/html", body: "<p>a</p>" };

const found = async (options: FixtureOptions, profile: RuleProfile = "spec"): Promise<string[]> =>
  warc11Issues(await reportFor(options, profile))
    .filter((i) => i.rule === RULE)
    .map((i) => [i.severity, i.messageKey.slice(RULE.length + 1), i.params?.["field"]].join(" "));

/** 並びは warcinfo (0)・応答 (1)。 */
const onResponse = (set: Record<string, string>): FixtureOptions => ({
  warcResponses: [RESPONSE],
  warcRecordPatches: [{ index: 1, set }],
});

describe("warc/field-values", () => {
  it.each([
    [{ "WARC-Record-ID": "urn:uuid:00000000-0000-0000-0000-000000000200" }, "record-id-form WARC-Record-ID"],
    [{ "WARC-Concurrent-To": "urn:uuid:x" }, "record-id-form WARC-Concurrent-To"],
    [{ "WARC-Target-URI": `<${URI}>` }, "uri-angle-brackets WARC-Target-URI"],
    [{ "WARC-Target-URI": "/a" }, "uri-form WARC-Target-URI"],
    [{ "WARC-Date": "2026-05-13T00:00:00.1234567890Z" }, "date-fraction-digits WARC-Date"],
    [{ "WARC-Date": "2026-05-13T09:00:00+09:00" }, "date-not-utc WARC-Date"],
    [{ "WARC-Date": "13 May 2026" }, "date-form WARC-Date"],
    [{ "WARC-Date": "" }, "empty WARC-Date"],
    [{ "WARC-Payload-Digest": "sha256" }, "digest-form WARC-Payload-Digest"],
    [{ "WARC-Block-Digest": "AKHY" }, "digest-form WARC-Block-Digest"],
    [{ "WARC-IP-Address": "[2001:db8::1]" }, "ip-brackets WARC-IP-Address"],
    [{ "WARC-IP-Address": "site.test" }, "ip-form WARC-IP-Address"],
    [{ "Content-Type": "text" }, "media-type-form Content-Type"],
    [{ "WARC-Identified-Payload-Type": "html" }, "media-type-form WARC-Identified-Payload-Type"],
    [{ "WARC-Segment-Number": "one" }, "digits-form WARC-Segment-Number"],
  ])("%o は spec で warning の %s（この rule だけ）", async (set, expected) => {
    const options = onResponse(set);
    expect(await found(options)).toEqual([`warning ${expected}`]);
    expect(firedWarc11Rules(await reportFor(options))).toEqual([RULE]);
  });

  it("違反は browserhive で error、lenient で info", async () => {
    const options = onResponse({ "WARC-Target-URI": `<${URI}>` });
    expect(await found(options, "browserhive")).toEqual(["error uri-angle-brackets WARC-Target-URI"]);
    expect(await found(options, "lenient")).toEqual(["info uri-angle-brackets WARC-Target-URI"]);
  });

  it("推奨に反するものは spec で info・browserhive で warning", async () => {
    const options = onResponse({ "WARC-IP-Address": "2001:DB8::1", "WARC-Payload-Digest": "SHA256:AAAA" });
    expect((await found(options, "spec")).sort()).toEqual([
      "info digest-label-uppercase WARC-Payload-Digest",
      "info ip-not-canonical WARC-IP-Address",
    ]);
    expect((await found(options, "browserhive")).sort()).toEqual([
      "warning digest-label-uppercase WARC-Payload-Digest",
      "warning ip-not-canonical WARC-IP-Address",
    ]);
    const canonical = warc11Issues(await reportFor(options)).find((i) => i.messageKey.endsWith("ip-not-canonical"));
    expect(canonical?.params?.["canonical"]).toBe("2001:db8::1");
  });

  it("仕様が定義しない type と WARC-Truncated の理由は、どの profile でも info", async () => {
    const options = onResponse({ "WARC-Type": "x-custom", "WARC-Truncated": "x-quota" });
    for (const profile of ["spec", "browserhive", "lenient"] as const) {
      expect((await found(options, profile)).sort()).toEqual([
        "info unknown-record-type WARC-Type",
        "info unknown-truncated-reason WARC-Truncated",
      ]);
    }
  });

  it("Content-Length の形は見ない（warc/record-structure が言う）", async () => {
    const report = await reportFor({ warcRecordPatches: [{ index: 0, set: { "Content-Length": "12a" } }] });
    expect(firedWarc11Rules(report)).toEqual(["warc/record-structure"]);
  });
});
