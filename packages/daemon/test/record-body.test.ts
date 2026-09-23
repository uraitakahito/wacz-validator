// @module-tag daemon
/**
 * record-body の純ロジック(gzip 展開・raster の判定・テキスト/バイナリ判定・cap)のテスト。
 * 実 WACZ を要さず zlib で作った Buffer で完結するので常時走る(corpus 不要)。
 */
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { RASTER, classifyBody, gunzipCapped, isGzip, isTextUtf8 } from "../src/record-body.js";

const CAP = 64 * 1024;

describe("record-body", () => {
  it("isGzip: gzip マジックを検出する", () => {
    expect(isGzip(gzipSync(Buffer.from("hello")))).toBe(true);
    expect(isGzip(Buffer.from("hello"))).toBe(false);
  });

  it("gunzipCapped: 展開して元に戻る(multibyte 込み)", async () => {
    const { data, truncated } = await gunzipCapped(gzipSync(Buffer.from("あいうえお WARC")), CAP);
    expect(data.toString("utf-8")).toBe("あいうえお WARC");
    expect(truncated).toBe(false);
  });

  it("gunzipCapped: cap を超えたら truncated で打ち切る", async () => {
    const big = Buffer.alloc(10_000, 0x61);
    const { data, truncated } = await gunzipCapped(gzipSync(big), 1000);
    expect(data.length).toBe(1000);
    expect(truncated).toBe(true);
  });

  it("gunzipCapped: 壊れた gzip は reject", async () => {
    await expect(gunzipCapped(Buffer.from("not gzip"), CAP)).rejects.toThrow();
  });

  it("isTextUtf8: 末尾で割れた多バイト文字は許し、内部の不正バイトは許さない", () => {
    const whole = Buffer.from("あい", "utf-8");
    expect(isTextUtf8(whole.subarray(0, 4))).toBe(true); // 「い」の途中で切れている
    // 末尾 3 バイトまでは「割れた文字」として許すので、不正バイトは内側に置く。
    const inside = Buffer.concat([Buffer.from("hello "), Buffer.from([0xff]), Buffer.from(" world")]);
    expect(isTextUtf8(inside)).toBe(false);
  });
});

describe("classifyBody", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

  it("raster の画像は mime で決め、大きさだけ返す(バイトは見ない)", () => {
    expect(classifyBody("image/jpeg", jpeg, CAP, false)).toEqual({
      kind: "image",
      mime: "image/jpeg",
      byteLength: jpeg.length,
    });
    for (const mime of RASTER) {
      expect(classifyBody(mime, jpeg, CAP, false).kind).toBe("image");
    }
  });

  it("SVG は image にしない —— XML として text で見せる", () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>');
    const body = classifyBody("image/svg+xml", svg, CAP, false);
    expect(body.kind).toBe("text");
    expect(RASTER.has("image/svg+xml")).toBe(false);
  });

  it("テキストは content に、warc-fields も text", () => {
    const fields = Buffer.from("action: no-archive\r\npattern: *://*.example/*\r\n");
    expect(classifyBody("application/warc-fields", fields, CAP, false)).toEqual({
      kind: "text",
      content: fields.toString("utf-8"),
      truncated: false,
    });
  });

  it("NUL を含む・UTF-8 でない本文は binary で、mime と大きさだけ", () => {
    const body = classifyBody("application/octet-stream", jpeg, CAP, false);
    expect(body).toEqual({ kind: "binary", mime: "application/octet-stream", byteLength: jpeg.length });
    expect(classifyBody(undefined, Buffer.from([0x00, 0x01, 0x02]), CAP, false)).toEqual({
      kind: "binary",
      byteLength: 3,
    });
  });

  it("text は cap で切り、展開の打ち切りも truncated に伝える", () => {
    const long = Buffer.alloc(100, 0x61);
    expect(classifyBody("text/plain", long, 10, false)).toEqual({
      kind: "text",
      content: "aaaaaaaaaa",
      truncated: true,
    });
    expect(classifyBody("text/plain", Buffer.from("short"), CAP, true).kind === "text").toBe(true);
    expect(classifyBody("text/plain", Buffer.from("short"), CAP, true)).toMatchObject({ truncated: true });
  });
});
