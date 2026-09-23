// @module-tag warc
/**
 * `records.ts` — WARC のメンバを一覧の 1 行と、開いた 1 件に整える純関数のテスト。
 * 標本は generator で作り、メモリ上の ZIP から WARC を取り出す (I/O 無し)。
 */
import { Buffer } from "node:buffer";
import { fromBuffer } from "yauzl-promise";
import { describe, expect, it } from "vitest";
import type { AbsolutePath } from "../src/validate/domain.js";
import { WaczReader } from "../src/wacz/reader.js";
import { httpHeader, mimeOf, parseRecord, summarizeMember } from "../src/wacz/records.js";
import { iterateWarcMembers, type WarcMember } from "../src/wacz/warc-iter.js";
import { buildWacz, type FixtureOptions } from "./fixtures/generator.js";

const WARC = "archive/data.warc.gz";

/** 標本を組み立て、WARC のメンバを順に返す。 */
const membersOf = async (options: FixtureOptions): Promise<WarcMember[]> => {
  const { bytes } = await buildWacz(options);
  const reader = await WaczReader.open({
    source: { kind: "file", path: "/fixture.wacz" as AbsolutePath },
    openZip: () => fromBuffer(bytes),
  });
  try {
    const warc = await reader.readEntry(WARC);
    if (warc === undefined) throw new Error("unreachable: fixture has a WARC");
    return [...iterateWarcMembers(warc)];
  } finally {
    await reader.close();
  }
};

const png = {
  uri: "https://example.com/a.png",
  mime: "image/png",
  body: Buffer.from("PNGDATA-not-really", "utf-8"),
};
const html = {
  uri: "https://example.com/missing",
  mime: "text/html; charset=utf-8",
  body: "<p>not here</p>",
  status: 404,
};

describe("summarizeMember", () => {
  it("warcinfo・応答・metadata を、種別と位置と HTTP の要点に整える", async () => {
    const members = await membersOf({ warcResponses: [png, html], warcIncompleteRecords: 1 });
    const rows = members.map(summarizeMember);
    expect(rows.map((row) => row.type)).toEqual(["warcinfo", "response", "response", "metadata"]);
    // 位置はメンバの実位置。連続していて、隙間が無い。
    expect(rows[0]?.offset).toBe(0);
    expect(rows[1]?.offset).toBe(rows[0]?.length);
    expect(rows[1]).toMatchObject({ uri: png.uri, status: 200, mime: "image/png" });
    // content-type の parameters は落とし、状態コードは数に。
    expect(rows[2]).toMatchObject({ uri: html.uri, status: 404, mime: "text/html" });
    expect(rows[3]).toMatchObject({ type: "metadata", contentType: "application/warc-fields" });
    expect(rows[3]?.uri).toMatch(/^https:\/\/tracker\.example\//);
    // warcinfo に URI は無い。無いものを空文字で埋めない。
    expect(rows[0]?.uri).toBeUndefined();
    expect(rows[0]?.status).toBeUndefined();
  });

  it("見出しの区切りが無いメンバは、位置と `?` だけ", () => {
    const junk: WarcMember = { offset: 7, length: 3, gzipped: Buffer.alloc(0), raw: Buffer.from("garbage") };
    expect(summarizeMember(junk)).toEqual({ offset: 7, length: 3, type: "?" });
  });
});

describe("parseRecord", () => {
  it("応答レコードを WARC の見出し・HTTP の見出し・entity body に割る", async () => {
    const [, member] = await membersOf({ warcResponses: [png] });
    if (member === undefined) throw new Error("unreachable");
    const record = parseRecord(member.raw);
    if (record === undefined) throw new Error("unreachable: a response record");
    expect(record.protocol).toBe("WARC/1.1");
    expect(record.warc.find((h) => h.name === "WARC-Type")?.value).toBe("response");
    expect(record.http?.status).toBe("HTTP/1.1 200 OK");
    expect(httpHeader(record.http ?? { status: "", headers: [] }, "Content-Type")).toBe("image/png");
    expect(record.body.equals(png.body)).toBe(true);
  });

  it("warcinfo には HTTP の見出しが無く、本文はそのまま", async () => {
    const [member] = await membersOf({});
    if (member === undefined) throw new Error("unreachable");
    const record = parseRecord(member.raw);
    expect(record?.http).toBeUndefined();
    expect(record?.body.toString("utf-8")).toMatch(/^software: /);
  });

  it("レコードでないバイト列は undefined", () => {
    expect(parseRecord(Buffer.from("no separator here"))).toBeUndefined();
  });
});

describe("mimeOf", () => {
  it("parameters を落として小文字にし、空なら undefined", () => {
    expect(mimeOf("Text/HTML; charset=utf-8")).toBe("text/html");
    expect(mimeOf("image/png")).toBe("image/png");
    expect(mimeOf("")).toBeUndefined();
    expect(mimeOf(undefined)).toBeUndefined();
  });
});
