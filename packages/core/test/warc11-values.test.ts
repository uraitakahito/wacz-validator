// @module-tag warc
/**
 * WARC 1.1 の欄の値の形（`warc11-values.ts`）の試験。
 *
 * 各形について、通る値と、違反（shall に反する）・注意（推奨に反する・仕様が定義しない）に
 * なる値を並べる。境目（小数 9 桁と 10 桁、`+00:00` と `+09:00`、正規形の IPv6 とそうでないもの）
 * を両側から置き、片側だけ見る実装が通らないようにする。
 */
import { describe, expect, it } from "vitest";
import { checkFieldValue, parseMediaType, stripAngleBrackets } from "../src/validate/warc11-values.js";
import type { FieldValueKind } from "../src/validate/warc11-fields.js";

const verdictOf = (kind: FieldValueKind, value: string): string =>
  checkFieldValue(kind, value).violation ?? checkFieldValue(kind, value).advisory ?? "ok";

describe("checkFieldValue", () => {
  it.each([
    ["record-id", "<urn:uuid:0d8e7a8e-0b7e-4c1a-9f7d-2b7d0f0f0f0f>", "ok"],
    ["record-id", "<http://records.test/record/1>", "ok"],
    ["record-id", "urn:uuid:0d8e7a8e-0b7e-4c1a-9f7d-2b7d0f0f0f0f", "record-id-form"],
    ["record-id", "<urn:uuid:with space>", "record-id-form"],
    ["record-id", "<no-scheme>", "record-id-form"],
    ["uri", "https://site.test/path?q=1", "ok"],
    ["uri", "dns:site.test", "ok"],
    ["uri", "<https://site.test/>", "uri-angle-brackets"],
    ["uri", "/relative/path", "uri-form"],
    ["uri", "https://site.test/a b", "uri-form"],
    ["date", "2026-05-13T00:00:00Z", "ok"],
    ["date", "2026-05-13T00:00:00.1Z", "ok"],
    ["date", "2026-05-13T00:00:00.123456789Z", "ok"],
    ["date", "2026-05-13T00:00:00.1234567890Z", "date-fraction-digits"],
    ["date", "2026-05-13T00:00Z", "ok"],
    ["date", "2026-05-13", "ok"],
    ["date", "2026", "ok"],
    ["date", "2026-05-13T00:00:00+00:00", "ok"],
    ["date", "2026-05-13T09:00:00+09:00", "date-not-utc"],
    ["date", "2026-05-13T00:00:00", "date-form"],
    ["date", "2026-05-13 00:00:00Z", "date-form"],
    ["date", "2026-13-01T00:00:00Z", "date-form"],
    ["date", "2026-02-30T00:00:00Z", "date-form"],
    ["date", "2026-05-13T24:30:00Z", "date-form"],
    ["digits", "0", "ok"],
    ["digits", "1234", "ok"],
    ["digits", "12a", "digits-form"],
    ["digits", "-1", "digits-form"],
    ["record-type", "response", "ok"],
    ["record-type", "Response", "ok"],
    ["record-type", "x-custom", "unknown-record-type"],
    ["labelled-digest", "sha256:AKHYCAGIN35Z6VJCEI6PWPKOKV244246G6CMPBDKI4MEL7CU54NQ", "ok"],
    ["labelled-digest", "sha1:6B7FVAKWCPC2X3O4JNUCER5EYQWYVFO7", "ok"],
    ["labelled-digest", "sha1:ab/cd+ef==", "ok"],
    ["labelled-digest", "SHA1:6B7FVAKWCPC2X3O4JNUCER5EYQWYVFO7", "digest-label-uppercase"],
    ["labelled-digest", "sha1", "digest-form"],
    ["labelled-digest", "sha1:", "digest-form"],
    ["labelled-digest", ":abc", "digest-form"],
    ["ip-address", "192.0.2.1", "ok"],
    ["ip-address", "2001:db8::1", "ok"],
    ["ip-address", "::ffff:192.0.2.1", "ok"],
    ["ip-address", "2001:db8:0:1:1:1:1:1", "ok"],
    ["ip-address", "[2001:db8::1]", "ip-brackets"],
    ["ip-address", "2001:DB8::1", "ip-not-canonical"],
    ["ip-address", "2001:db8:0:0:0:0:0:1", "ip-not-canonical"],
    ["ip-address", "999.0.2.1", "ip-form"],
    ["ip-address", "site.test", "ip-form"],
    ["truncated-reason", "length", "ok"],
    ["truncated-reason", "DISCONNECT", "ok"],
    ["truncated-reason", "x-quota", "unknown-truncated-reason"],
    ["media-type", "application/http;msgtype=response", "ok"],
    ["media-type", "application/http; msgtype=response", "ok"],
    ["media-type", 'text/html; charset="utf-8"', "ok"],
    ["media-type", "application/warc-fields", "ok"],
    ["media-type", "text", "media-type-form"],
    ["media-type", "text/html;", "media-type-form"],
    ["text", "data-000.warc.gz", "ok"],
  ] as const)("%s の %s は %s", (kind, value, expected) => {
    expect(verdictOf(kind, value)).toBe(expected);
  });

  it("text 以外の空の値は empty", () => {
    for (const kind of ["record-id", "uri", "date", "digits", "record-type", "labelled-digest", "ip-address", "truncated-reason", "media-type"] as const) {
      expect(checkFieldValue(kind, "").violation, kind).toBe("empty");
    }
    expect(checkFieldValue("text", "")).toEqual({});
  });

  it("IPv6 の注意は正規形を運ぶ（RFC 5952: 小文字・最長の 0 の列を ::・1 group は縮めない）", () => {
    expect(checkFieldValue("ip-address", "2001:DB8:0:0:1:0:0:1").params).toEqual({ canonical: "2001:db8::1:0:0:1" });
    expect(checkFieldValue("ip-address", "2001:0db8::0001").params).toEqual({ canonical: "2001:db8::1" });
  });

  it("digest の label の注意は label を運ぶ", () => {
    expect(checkFieldValue("labelled-digest", "SHA256:ABC").params).toEqual({ label: "SHA256" });
  });
});

describe("parseMediaType", () => {
  it("type/subtype は小文字、parameter の名は小文字、値は引用符を外す", () => {
    expect(parseMediaType('Application/HTTP; MsgType="response"')).toEqual({
      type: "application/http",
      parameters: { msgtype: "response" },
    });
  });

  it("文法に合わなければ undefined", () => {
    expect(parseMediaType("not a media type")).toBeUndefined();
  });
});

describe("stripAngleBrackets", () => {
  it("両端の <> だけを外す", () => {
    expect(stripAngleBrackets("<urn:x>")).toBe("urn:x");
    expect(stripAngleBrackets("urn:x")).toBe("urn:x");
    expect(stripAngleBrackets("<urn:x")).toBe("<urn:x");
  });
});
