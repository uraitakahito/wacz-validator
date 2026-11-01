// @module-tag warc
/**
 * WARC 1.1 の rule 7 本が、形の正しい標本に何も言わないことの試験。
 *
 * 個々の rule の試験は「壊した 1 か所を狙った rule だけが言う」を見る。ここはその裏で、生成器が
 * 組める記録を全部（warcinfo・応答・要求・metadata・revisit・分割の列）入れた標本が、どの profile でも
 * 7 本の誰にも引っかからないことを見る。どれかの rule が正しい記録を誤って咎めると、ここが落ちる。
 */
import { describe, expect, it } from "vitest";
import { REVISIT_PROFILE_SERVER_NOT_MODIFIED } from "../src/validate/warc11-fields.js";
import { responseRecordId, type FixtureOptions } from "./fixtures/generator.js";
import { reportFor, warc11Issues } from "./fixtures/warc11.js";

const URI = "https://site.test/a";

/** 生成器が組める記録を全部入れた標本。 */
const RICH: FixtureOptions = {
  warcinfoFilename: "data.warc.gz",
  warcResponses: [{ uri: URI, mime: "text/html", body: "<p>a</p>", truncated: "length" }],
  warcRequests: [{ uri: URI, concurrentTo: responseRecordId(0) }],
  warcIncompleteRecords: 1,
  warcMetadata: [{ uri: URI, refersTo: responseRecordId(0), fields: { via: "https://site.test/" } }],
  warcRevisits: [
    {
      uri: URI,
      payloadDigest: "sha256:AKHYCAGIN35Z6VJCEI6PWPKOKV244246G6CMPBDKI4MEL7CU54NQ",
      refersTo: responseRecordId(0),
      refersToTargetUri: URI,
      refersToDate: "2026-05-13T00:00:00Z",
    },
    {
      uri: URI,
      profile: REVISIT_PROFILE_SERVER_NOT_MODIFIED,
      refersTo: responseRecordId(0),
      refersToDate: "2026-05-13T00:00:00Z",
      block: "HTTP/1.1 304 Not Modified\r\n\r\n",
    },
  ],
  warcSegmented: [{ uri: "https://site.test/big", parts: ["first part, ", "second part, ", "last part"] }],
};

describe("WARC 1.1 の rule は形の正しい標本に何も言わない", () => {
  it.each(["spec", "browserhive", "lenient"] as const)("既定の標本（%s）", async (profile) => {
    expect(warc11Issues(await reportFor({}, profile))).toEqual([]);
  });

  it.each(["spec", "browserhive", "lenient"] as const)("記録を全部入れた標本（%s）", async (profile) => {
    expect(warc11Issues(await reportFor(RICH, profile))).toEqual([]);
  });
});
