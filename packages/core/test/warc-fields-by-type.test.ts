// @module-tag warc
/**
 * `warc/fields-by-type` の試験。
 *
 * type ごとに書いてはいけない欄を 1 つずつ足し、この rule だけが鳴ることを確かめる。値はどれも
 * 形の正しいものにして、`warc/field-values` が口を挟まないようにする。繰り返しは、繰り返してよい
 * 欄（WARC-Concurrent-To・目録に無い拡張の欄）では鳴らないことも置く。
 */
import { describe, expect, it } from "vitest";
import type { RuleProfile } from "../src/validate/domain.js";
import type { FixtureOptions } from "./fixtures/generator.js";
import { firedWarc11Rules, reportFor, warc11Issues } from "./fixtures/warc11.js";

const RULE = "warc/fields-by-type";
const URI = "https://site.test/a";
const RESPONSE = { uri: URI, mime: "text/html", body: "<p>a</p>" };
const RECORD_ID = "<urn:uuid:00000000-0000-0000-0000-000000000999>";
const DIGEST = "sha256:AKHYCAGIN35Z6VJCEI6PWPKOKV244246G6CMPBDKI4MEL7CU54NQ";

const found = async (options: FixtureOptions, profile: RuleProfile = "spec"): Promise<string[]> =>
  warc11Issues(await reportFor(options, profile))
    .filter((i) => i.rule === RULE)
    .map((i) => [i.severity, i.messageKey.slice(RULE.length + 1), i.params?.["field"], i.params?.["type"] ?? i.params?.["count"]].join(" "));

/** 並びは warcinfo (0)・応答 (1)・要求 (2)・未完了の metadata (3)。 */
const BASE: FixtureOptions = { warcResponses: [RESPONSE], warcRequests: [{ uri: URI }], warcIncompleteRecords: 1 };
const withField = (index: number, field: string, value: string): FixtureOptions => ({
  ...BASE,
  warcRecordPatches: [{ index, set: { [field]: value } }],
});

describe("warc/fields-by-type", () => {
  it.each([
    [0, "WARC-Target-URI", URI, "warcinfo"],
    [0, "WARC-Concurrent-To", RECORD_ID, "warcinfo"],
    [0, "WARC-IP-Address", "192.0.2.1", "warcinfo"],
    [0, "WARC-Warcinfo-ID", RECORD_ID, "warcinfo"],
    [0, "WARC-Payload-Digest", DIGEST, "warcinfo"],
    [0, "WARC-Identified-Payload-Type", "text/plain", "warcinfo"],
    [1, "WARC-Filename", "data.warc.gz", "response"],
    [1, "WARC-Refers-To", RECORD_ID, "response"],
    [1, "WARC-Segment-Origin-ID", RECORD_ID, "response"],
    [1, "WARC-Segment-Total-Length", "10", "response"],
    [2, "WARC-Refers-To-Date", "2026-05-13T00:00:00Z", "request"],
    [3, "WARC-Payload-Digest", DIGEST, "metadata"],
    [3, "WARC-Refers-To-Target-URI", URI, "metadata"],
  ] as const)("記録 %i に %s を書くと、%s の記録には書かない欄として鳴る（この rule だけ）", async (index, field, value, type) => {
    const options = withField(index, field, value);
    expect(await found(options)).toEqual([`warning forbidden ${field} ${type}`]);
    expect(firedWarc11Rules(await reportFor(options))).toEqual([RULE]);
  });

  it("revisit 以外の WARC-Profile は「未定義」として info", async () => {
    const options = withField(1, "WARC-Profile", "http://netpreserve.org/warc/1.1/revisit/server-not-modified");
    expect(await found(options, "spec")).toEqual(["info undefined-field WARC-Profile response"]);
    expect(await found(options, "browserhive")).toEqual(["info undefined-field WARC-Profile response"]);
  });

  it("同じ欄の繰り返しは鳴る。WARC-Concurrent-To と拡張の欄は繰り返してよい", async () => {
    expect(await found({ warcRecordPatches: [{ index: 0, add: { "WARC-Date": "2026-05-13T00:00:01Z" } }] })).toEqual([
      "warning repeated WARC-Date 2",
    ]);
    // add の鍵は 1 つの object なので、2 行目は名の綴りを変えて足す（照合は大小を無視する）。
    const concurrent = { ...BASE, warcRecordPatches: [{ index: 2, add: { "WARC-Concurrent-To": RECORD_ID, "warc-concurrent-to": RECORD_ID } }] };
    expect(await found(concurrent)).toEqual([]);
    const extension = { warcRecordPatches: [{ index: 0, add: { "X-Note": "a", "x-note": "b" } }] };
    expect(await found(extension)).toEqual([]);
  });

  it("browserhive では error、lenient では info", async () => {
    const options = withField(0, "WARC-Target-URI", URI);
    expect(await found(options, "browserhive")).toEqual(["error forbidden WARC-Target-URI warcinfo"]);
    expect(await found(options, "lenient")).toEqual(["info forbidden WARC-Target-URI warcinfo"]);
  });

  it("8 つのどれでもない type の記録は、書いてはいけない欄を見ない", async () => {
    const options = { ...BASE, warcRecordPatches: [{ index: 1, set: { "WARC-Type": "x-custom", "WARC-Filename": "a.warc.gz" } }] };
    expect(await found(options)).toEqual([]);
  });
});
