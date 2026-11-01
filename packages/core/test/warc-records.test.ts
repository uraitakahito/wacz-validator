// @module-tag warc
/**
 * WARC の記録を区切って検める部分（`wacz/warc-records.ts`・`validate/warc11-scan.ts`）の試験。
 *
 * 記録の終わりは `Content-Length` で決まる。block の中に CRLF CRLF がある（HTTP の応答）、
 * 1 つの member や圧縮していない本に記録が並ぶ、`Content-Length` が壊れていて次の記録の頭から
 * 区切り直す、の 3 つを、壊れの種類ごとに確かめる。
 */
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { inspectWarcRecords } from "../src/wacz/warc-records.js";
import { scanWarcFile } from "../src/validate/warc11-scan.js";
import { metadataHeader, rawRecord } from "./fixtures/warc11.js";

const BLOCK = "software: test\r\n";
const good = (id = 1, block = BLOCK): Buffer => rawRecord(metadataHeader(id, Buffer.byteLength(block)), block);
const kinds = (buf: Buffer): string[][] => inspectWarcRecords(buf).map((r) => r.problems.map((p) => p.kind));

describe("inspectWarcRecords", () => {
  it("形の正しい記録は問題なし・欄は前後の空白を落として読む", () => {
    const [one] = inspectWarcRecords(good());
    expect(one?.problems).toEqual([]);
    expect(one?.sound).toBe(true);
    expect(one?.version).toBe("1.1");
    expect(one?.record?.headers.find((h) => h.name === "WARC-Type")?.value).toBe("metadata");
    expect(one?.record?.body.toString()).toBe(BLOCK);
  });

  it("block の中の CRLF CRLF では区切らない（Content-Length で区切る）", () => {
    const http = "HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok";
    const records = inspectWarcRecords(Buffer.concat([good(1, http), good(2)]));
    expect(records.map((r) => r.problems)).toEqual([[], []]);
    expect(records[0]?.record?.body.toString()).toBe(http);
  });

  it("圧縮していない本の記録を順に区切る", () => {
    const records = inspectWarcRecords(Buffer.concat([good(1), good(2), good(3)]));
    expect(records).toHaveLength(3);
    expect(records.every((r) => r.sound)).toBe(true);
  });

  it("WARC/1.0 は版の問題だけで、欄は信じてよい", () => {
    const lines = metadataHeader(1, BLOCK.length).map((l, i) => (i === 0 ? "WARC/1.0" : l));
    const [one] = inspectWarcRecords(rawRecord(lines, BLOCK));
    expect(one?.problems).toEqual([{ kind: "version-not-1-1", found: "WARC/1.0" }]);
    expect(one?.sound).toBe(true);
  });

  it("版の行が無ければ記録として読まない", () => {
    const lines = metadataHeader(1, BLOCK.length).map((l, i) => (i === 0 ? "ARC/1.1" : l));
    const [one] = inspectWarcRecords(rawRecord(lines, BLOCK));
    expect(one?.problems).toEqual([{ kind: "no-version-line", found: "ARC/1.1" }]);
    expect(one?.record).toBeNull();
  });

  it("空行が無ければ記録として読まない", () => {
    const [one] = inspectWarcRecords(Buffer.from("WARC/1.1\r\nWARC-Type: metadata\r\n"));
    expect(one?.problems.map((p) => p.kind)).toEqual(["no-blank-line"]);
    expect(one?.record).toBeNull();
  });

  it("LF だけの見出しは lf-line-ending で、欄は信じない", () => {
    const text = `${metadataHeader(1, BLOCK.length).join("\n")}\n\n${BLOCK}\n\n`;
    const [one] = inspectWarcRecords(Buffer.from(text));
    expect(one?.problems.map((p) => p.kind)).toEqual(["lf-line-ending"]);
    expect(one?.sound).toBe(false);
  });

  it("一部の行だけ LF で終わるのも lf-line-ending", () => {
    const lines = metadataHeader(1, BLOCK.length);
    const text = `${lines.slice(0, 2).join("\n")}\r\n${lines.slice(2).join("\r\n")}\r\n\r\n${BLOCK}\r\n\r\n`;
    expect(kinds(Buffer.from(text))).toEqual([["lf-line-ending"]]);
  });

  it("name: value でない行は行番号つきで bad-field-line", () => {
    const lines = [...metadataHeader(1, BLOCK.length), "Not A Field"];
    const [one] = inspectWarcRecords(rawRecord(lines, BLOCK));
    expect(one?.problems).toEqual([{ kind: "bad-field-line", line: lines.length, found: "Not A Field" }]);
  });

  it("折り返しは 1 つの値にまとめ、欄は信じてよい", () => {
    const lines = [...metadataHeader(1, BLOCK.length).filter((l) => !l.startsWith("Content-Type")), "Content-Type: application/http;", " msgtype=response"];
    const [one] = inspectWarcRecords(rawRecord(lines, BLOCK));
    expect(one?.problems).toEqual([{ kind: "folded-line", line: lines.length, found: "Content-Type" }]);
    expect(one?.sound).toBe(true);
    expect(one?.record?.headers.find((h) => h.name === "Content-Type")?.value).toBe("application/http; msgtype=response");
  });

  it("UTF-8 でない見出しは non-utf8", () => {
    const lines = [...metadataHeader(1, BLOCK.length), Buffer.concat([Buffer.from("X-Note: "), Buffer.from([0xff, 0xfe])])];
    expect(kinds(rawRecord(lines, BLOCK))).toEqual([["non-utf8"]]);
  });

  it("Content-Length が無ければ、次の記録の頭まで区切り直して続きを読む", () => {
    const lines = metadataHeader(1, BLOCK.length).filter((l) => !l.startsWith("Content-Length"));
    const records = inspectWarcRecords(Buffer.concat([rawRecord(lines, BLOCK), good(2)]));
    expect(records.map((r) => r.problems.map((p) => p.kind))).toEqual([["content-length-missing"], []]);
    expect(records[0]?.record?.body.toString()).toBe(BLOCK);
  });

  it("Content-Length が数でなければ content-length-form", () => {
    const lines = metadataHeader(1, BLOCK.length).map((l) => (l.startsWith("Content-Length") ? "Content-Length: 12a" : l));
    expect(inspectWarcRecords(rawRecord(lines, BLOCK))[0]?.problems).toEqual([{ kind: "content-length-form", found: "12a" }]);
  });

  it("Content-Length が実体より短い・長いと、実体の長さを添えて content-length-mismatch", () => {
    for (const declared of [5, BLOCK.length + 7]) {
      const lines = metadataHeader(1, declared);
      const records = inspectWarcRecords(Buffer.concat([rawRecord(lines, BLOCK), good(2)]));
      expect(records[0]?.problems).toEqual([{ kind: "content-length-mismatch", declared, actual: BLOCK.length }]);
      expect(records[1]?.problems).toEqual([]);
    }
  });

  it("記録を閉じる CRLF CRLF が無ければ no-terminator", () => {
    const lines = metadataHeader(1, BLOCK.length);
    expect(kinds(rawRecord(lines, BLOCK, ""))).toEqual([["no-terminator"]]);
  });
});

describe("scanWarcFile", () => {
  it("圧縮した本は member ごとに区切り、1 member に 2 記録でも読む。位置は member の頭", () => {
    const first = gzipSync(good(1));
    const second = gzipSync(Buffer.concat([good(2), good(3)]));
    const records = scanWarcFile("archive/data.warc.gz", Buffer.concat([first, second]));
    expect(records.map((r) => [r.index, r.offset, r.sound])).toEqual([
      [1, 0, true],
      [2, first.length, true],
      [3, first.length, true],
    ]);
  });

  it("圧縮していない本は記録の頭を位置にする", () => {
    const a = good(1);
    const records = scanWarcFile("archive/data.warc", Buffer.concat([a, good(2)]));
    expect(records.map((r) => r.offset)).toEqual([0, a.length]);
  });

  it("block の長さを覚え、block そのものは持たない", () => {
    const [one] = scanWarcFile("archive/data.warc", good());
    expect(one?.blockLength).toBe(BLOCK.length);
    expect(Object.keys(one ?? {})).not.toContain("body");
  });
});
