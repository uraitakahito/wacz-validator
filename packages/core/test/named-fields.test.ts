// @module-tag warc
/**
 * `wacz/named-fields.ts` の試験。記録の見出しと `application/warc-fields` の本文が共有する、
 * WARC 1.1 の「名前: 値」の行の読み方を固定する。
 *
 * どの試験も、古い読み方（改行で割って `": "` を探し、同じ鍵は後勝ち）とは結果が違う入力を使う。
 * 読み方を古い形へ戻すと、どれかが赤になる。
 */
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  fieldRecord,
  fieldValues,
  parseWarcFieldsBody,
  readNamedFields,
  splitBodyLines,
} from "../src/wacz/named-fields.js";

const CRLF = "\r\n";
const body = (lines: string[]): string => lines.map((l) => `${l}${CRLF}`).join("");

describe("parseWarcFieldsBody", () => {
  /**
   * WARC 1.1 の見本 B.1 の warcinfo と同じ形（9 欄。うち 2 欄は値を次の行へ折り返す）。
   * 値はこの試験のために組んだもので、仕様の本文は写していない。
   */
  const sampleB1Shape = body([
    "software: Fixture-Crawler/1.0 https://crawler.site.test",
    "hostname: crawl01.site.test",
    "ip: 192.0.2.10",
    "isPartOf: example-crawl-2026",
    "description: test crawl with WARC output",
    "operator: Example Operator",
    "http-header-user-agent:",
    " Mozilla/5.0 (compatible; fixture-crawler/1.0 +https://crawler.site.test)",
    "format: WARC file version 1.1",
    "conformsTo:",
    " https://iipc.github.io/warc-specifications/specifications/warc-format/warc-1.1/",
  ]);

  it("見本 B.1 と同じ形の本文で、折り返した 2 欄を含む 9 欄を読む", () => {
    const { fields, problems } = parseWarcFieldsBody(sampleB1Shape);
    expect(fields.map((f) => f.name)).toEqual([
      "software",
      "hostname",
      "ip",
      "isPartOf",
      "description",
      "operator",
      "http-header-user-agent",
      "format",
      "conformsTo",
    ]);
    expect(fieldValues(fields, "http-header-user-agent")).toEqual([
      "Mozilla/5.0 (compatible; fixture-crawler/1.0 +https://crawler.site.test)",
    ]);
    expect(fieldValues(fields, "conformsTo")).toEqual([
      "https://iipc.github.io/warc-specifications/specifications/warc-format/warc-1.1/",
    ]);
    expect(problems).toEqual([
      { kind: "folded-line", line: 8, found: "http-header-user-agent" },
      { kind: "folded-line", line: 11, found: "conformsTo" },
    ]);
  });

  it("コロンの後に空白が無くても読む", () => {
    expect(parseWarcFieldsBody(body(["robots:obey"])).fields).toEqual([{ name: "robots", value: "obey" }]);
  });

  it("同じ名前の欄を、書かれた順に全部残す", () => {
    const { fields } = parseWarcFieldsBody(body(["creator: A", "title: T", "creator: B"]));
    expect(fieldValues(fields, "creator")).toEqual(["A", "B"]);
  });

  it("token でない名前と、続ける前の欄が無い継続行は bad-field-line", () => {
    const { fields, problems } = parseWarcFieldsBody(body([" orphan", "bad name: x", "no colon here", "ok: 1"]));
    expect(fields).toEqual([{ name: "ok", value: "1" }]);
    expect(problems).toEqual([
      { kind: "bad-field-line", line: 1, found: "orphan" },
      { kind: "bad-field-line", line: 2, found: "bad name: x" },
      { kind: "bad-field-line", line: 3, found: "no colon here" },
    ]);
  });

  it("空の行で止まらず、改行で終わらない最後の行も読む。行の番号は空の行も数える", () => {
    const { fields, problems } = parseWarcFieldsBody("a: 1\r\n\r\nb: 2\r\n continued\r\nc: 3");
    expect(fields).toEqual([
      { name: "a", value: "1" },
      { name: "b", value: "2 continued" },
      { name: "c", value: "3" },
    ]);
    expect(problems).toEqual([{ kind: "folded-line", line: 4, found: "b" }]);
  });

  it("LF だけで区切った本文も、CRLF の本文と同じに読む", () => {
    expect(parseWarcFieldsBody("a: 1\nb: 2\n").fields).toEqual(parseWarcFieldsBody("a: 1\r\nb: 2\r\n").fields);
  });

  it("Buffer の本文も、文字列の本文と同じに読む", () => {
    const text = body(["format: WARC File Format 1.1", "conformsTo: https://spec.site.test/warc/"]);
    expect(parseWarcFieldsBody(Buffer.from(text, "utf-8"))).toEqual(parseWarcFieldsBody(text));
  });
});

describe("fieldValues・fieldRecord", () => {
  const { fields } = parseWarcFieldsBody(body(["conformsTo: A", "ConformsTo: B", "window: not-opened", "window: x"]));

  it("fieldValues は名前の大文字小文字を区別しない（WARC 1.1）", () => {
    expect(fieldValues(fields, "conformsTo")).toEqual(["A", "B"]);
    expect(fieldValues(fields, "CONFORMSTO")).toEqual(["A", "B"]);
  });

  it("fieldRecord は綴りをそのまま鍵にし、同じ綴りは後の値が勝つ", () => {
    expect(fieldRecord(fields)).toEqual({ conformsTo: "A", ConformsTo: "B", window: "x" });
  });
});

describe("readNamedFields", () => {
  it("firstLine で行の番号の数え始めを決める（見出しは版の行の次の 2 行目から）", () => {
    expect(readNamedFields(["WARC-Type: warcinfo", " folded"], 2).problems).toEqual([
      { kind: "folded-line", line: 3, found: "WARC-Type" },
    ]);
  });

  it("splitBodyLines は行末の CR を外し、空の行も並びに残す", () => {
    expect(splitBodyLines("a: 1\r\n\r\nb: 2")).toEqual(["a: 1", "", "b: 2"]);
  });
});
