// @module-tag warc
/**
 * `warc/content-type` の試験。
 *
 * 鳴る 4 通り（block があるのに無い・HTTP の記録が application/http でない・msgtype が type と
 * 違う・warcinfo が application/warc-fields でない）と、鳴らない境目（block の無い revisit・
 * continuation・metadata の他の型・HTTP でない URI の応答・msgtype を書かない application/http）を置く。
 */
import { describe, expect, it } from "vitest";
import type { RuleProfile } from "../src/validate/domain.js";
import type { FixtureOptions } from "./fixtures/generator.js";
import { firedWarc11Rules, reportFor, warc11Issues } from "./fixtures/warc11.js";

const RULE = "warc/content-type";
const URI = "https://site.test/a";
const RESPONSE = { uri: URI, mime: "text/html", body: "<p>a</p>" };

const found = async (options: FixtureOptions, profile: RuleProfile = "spec"): Promise<string[]> =>
  warc11Issues(await reportFor(options, profile))
    .filter((i) => i.rule === RULE)
    .map((i) => `${i.severity} ${i.messageKey.slice(RULE.length + 1)}`);

/** 並びは warcinfo (0)・応答 (1)・要求 (2)・未完了の metadata (3)。 */
const patched = (index: number, set: Record<string, string | null>): FixtureOptions => ({
  warcResponses: [RESPONSE],
  warcRequests: [{ uri: URI }],
  warcIncompleteRecords: 1,
  warcRecordPatches: [{ index, set }],
});

describe("warc/content-type", () => {
  it("block のある応答に Content-Type が無ければ、spec で info・browserhive で warning（この rule だけ）", async () => {
    const options = patched(1, { "Content-Type": null });
    expect(await found(options, "spec")).toEqual(["info missing"]);
    expect(await found(options, "browserhive")).toEqual(["warning missing"]);
    expect(firedWarc11Rules(await reportFor(options))).toEqual([RULE]);
  });

  it("HTTP の応答と要求は application/http。msgtype を書くなら type と同じ", async () => {
    expect(await found(patched(1, { "Content-Type": "text/html" }))).toEqual(["info not-application-http"]);
    expect(await found(patched(1, { "Content-Type": "application/http;msgtype=request" }))).toEqual(["info msgtype-mismatch"]);
    expect(await found(patched(2, { "Content-Type": "application/http" }))).toEqual([]);
    expect(await found(patched(2, { "Content-Type": "application/http; msgtype=request" }))).toEqual([]);
  });

  it("HTTP でない URI の応答は型を問わない", async () => {
    expect(await found(patched(1, { "WARC-Target-URI": "dns:site.test", "Content-Type": "text/dns" }))).toEqual([]);
  });

  it("warcinfo は application/warc-fields を勧める。metadata の型は問わない", async () => {
    expect(await found(patched(0, { "Content-Type": "text/plain" }))).toEqual(["info warcinfo-not-warc-fields"]);
    expect(await found(patched(3, { "Content-Type": "text/plain" }))).toEqual([]);
  });

  it("block の無い revisit と continuation は Content-Type が無くてよい", async () => {
    const options: FixtureOptions = {
      warcRevisits: [{ uri: URI, payloadDigest: "sha256:AAAA", refersTo: "<urn:uuid:x>", refersToTargetUri: URI, refersToDate: "2026-05-13T00:00:00Z" }],
      warcSegmented: [{ uri: URI, parts: ["one ", "two"] }],
    };
    expect(await found(options)).toEqual([]);
  });

  it("値が media type の形でなければ、ここでは見ない（warc/field-values が言う）", async () => {
    expect(firedWarc11Rules(await reportFor(patched(1, { "Content-Type": "html" })))).toEqual(["warc/field-values"]);
  });
});
