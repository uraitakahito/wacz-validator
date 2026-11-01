// @module-tag warc
/**
 * `warc/revisit` の試験。
 *
 * identical-payload-digest と server-not-modified の正しい形を土台に、shall（Payload-Digest・
 * block を残すときの WARC-Truncated: length）を 1 つずつ外して鳴ることと、勧めの欄・定義されない
 * profile・1.0 の profile の URI が info で告げられることを見る。
 */
import { describe, expect, it } from "vitest";
import type { RuleProfile } from "../src/validate/domain.js";
import { REVISIT_PROFILE_SERVER_NOT_MODIFIED } from "../src/validate/warc11-fields.js";
import type { FixtureOptions, WarcRevisitSpec } from "./fixtures/generator.js";
import { firedWarc11Rules, reportFor, warc11Issues } from "./fixtures/warc11.js";

const RULE = "warc/revisit";
const URI = "https://site.test/a";
const IDENTICAL: WarcRevisitSpec = {
  uri: URI,
  payloadDigest: "sha256:AKHYCAGIN35Z6VJCEI6PWPKOKV244246G6CMPBDKI4MEL7CU54NQ",
  refersTo: "<urn:uuid:00000000-0000-0000-0000-000000000200>",
  refersToTargetUri: URI,
  refersToDate: "2026-05-13T00:00:00Z",
};
const NOT_MODIFIED: WarcRevisitSpec = {
  uri: URI,
  profile: REVISIT_PROFILE_SERVER_NOT_MODIFIED,
  refersTo: "<urn:uuid:00000000-0000-0000-0000-000000000200>",
  refersToDate: "2026-05-13T00:00:00Z",
};
const HEADERS_ONLY = "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\n\r\n";

const found = async (revisit: WarcRevisitSpec, profile: RuleProfile = "spec", extra: FixtureOptions = {}): Promise<string[]> =>
  warc11Issues(await reportFor({ warcRevisits: [revisit], ...extra }, profile))
    .filter((i) => i.rule === RULE)
    .map((i) => [i.severity, i.messageKey.slice(RULE.length + 1), i.params?.["found"] ?? i.params?.["fields"] ?? i.params?.["value"] ?? "-"].join(" "));

describe("warc/revisit", () => {
  it("2 つの profile の正しい形には鳴らない", async () => {
    expect(await found(IDENTICAL)).toEqual([]);
    expect(await found({ ...IDENTICAL, block: HEADERS_ONLY, truncated: "length" })).toEqual([]);
    expect(await found(NOT_MODIFIED)).toEqual([]);
    expect(await found({ ...NOT_MODIFIED, block: "HTTP/1.1 304 Not Modified\r\n\r\n" })).toEqual([]);
  });

  it("identical-payload-digest に WARC-Payload-Digest が無ければ鳴る（この rule だけ）", async () => {
    const { payloadDigest: _drop, ...noDigest } = IDENTICAL;
    void _drop;
    expect(await found(noDigest)).toEqual(["warning digest-missing -"]);
    expect(firedWarc11Rules(await reportFor({ warcRevisits: [noDigest] }))).toEqual([RULE]);
  });

  it("identical-payload-digest で block を残すなら WARC-Truncated: length", async () => {
    expect(await found({ ...IDENTICAL, block: HEADERS_ONLY })).toEqual(["warning truncated-missing -"]);
    expect(await found({ ...IDENTICAL, block: HEADERS_ONLY, truncated: "time" })).toEqual(["warning truncated-not-length time"]);
  });

  it("shall に反するものは browserhive で error、lenient で info", async () => {
    expect(await found({ ...IDENTICAL, block: HEADERS_ONLY }, "browserhive")).toEqual(["error truncated-missing -"]);
    expect(await found({ ...IDENTICAL, block: HEADERS_ONLY }, "lenient")).toEqual(["info truncated-missing -"]);
  });

  it("勧めの欄が無ければ、足りない欄を並べて info（browserhive で warning）", async () => {
    const bare: WarcRevisitSpec = { uri: URI, payloadDigest: IDENTICAL.payloadDigest ?? "" };
    expect(await found(bare)).toEqual(["info recommended-missing WARC-Refers-To, WARC-Refers-To-Target-URI, WARC-Refers-To-Date"]);
    expect(await found({ uri: URI, profile: REVISIT_PROFILE_SERVER_NOT_MODIFIED }, "browserhive")).toEqual([
      "warning recommended-missing WARC-Refers-To, WARC-Refers-To-Date",
    ]);
  });

  it("定義されない profile は info で告げ、その先は見ない", async () => {
    expect(await found({ uri: URI, profile: "https://profiles.test/my-profile" }, "browserhive")).toEqual([
      "info unknown-profile https://profiles.test/my-profile",
    ]);
  });

  it("1.0 の profile の URI は同じ意味として読み、1.1 の記録なら info で告げる", async () => {
    const legacy = { ...IDENTICAL, profile: "http://netpreserve.org/warc/1.0/revisit/identical-payload-digest" };
    expect(await found(legacy)).toEqual(["info profile-uri-1-0 http://netpreserve.org/warc/1.0/revisit/identical-payload-digest"]);
    const { payloadDigest: _drop, ...noDigest } = legacy;
    void _drop;
    expect((await found(noDigest)).sort()).toEqual([
      "info profile-uri-1-0 http://netpreserve.org/warc/1.0/revisit/identical-payload-digest",
      "warning digest-missing -",
    ]);
  });

  it("山括弧で包んだ WARC-Profile は外して読む（包んだことは warc/field-values が言う）", async () => {
    const wrapped = { ...IDENTICAL, profile: "<http://netpreserve.org/warc/1.1/revisit/identical-payload-digest>" };
    expect(await found(wrapped)).toEqual([]);
    expect(firedWarc11Rules(await reportFor({ warcRevisits: [wrapped] }))).toEqual(["warc/field-values"]);
  });
});
