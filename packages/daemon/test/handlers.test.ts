// @module-tag daemon
/**
 * daemon ハンドラのテスト。
 *
 * 不正 URI・不正な引数の DaemonError は常時走る。実 WACZ を要する happy path は
 * corpus fixtures を使い `CORPUS_DIR` 未設定なら skip(corpus-driven と同じ規約)。
 * 各呼び出しは独立(stateless)。
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DaemonError,
  NotRasterError,
  readLine,
  readLines,
  readRecord,
  readRecordBody,
  readRecords,
  validate,
} from "../src/handlers.js";
import { PNG, buildTinyWacz, removeTinyWacz, type TinyWacz } from "./fixtures/tiny-wacz.js";

const corpusDir = process.env["CORPUS_DIR"];
const fixtureUri = (rel: string): string => pathToFileURL(resolve(corpusDir ?? "", rel)).href;
const missing = { kind: "uri" as const, uri: "file:///wacz-validator/no-such-file.wacz" };

describe("daemon handlers", () => {
  it("開けない URI は、どの口でも openFailed の DaemonError", async () => {
    const calls = [
      validate({ source: missing, locale: "en" }),
      readLines({ source: missing, path: "datapackage.json", from: 0, count: 10 }),
      readLine({ source: missing, path: "datapackage.json", n: 0 }),
      readRecords({ source: missing, path: "archive/data.warc.gz", from: 0, count: 10 }),
      readRecord({ source: missing, path: "archive/data.warc.gz", offset: 0, length: 1 }),
    ];
    for (const call of calls) {
      await expect(call).rejects.toMatchObject({ name: "DaemonError", code: "openFailed" });
    }
  });

  it("引数の型が違えば、開く前に badRequest", async () => {
    // JSON で来るので信じない。path が無い / count が 0 / n が負。
    await expect(
      readLines({ source: missing, path: "", from: 0, count: 10 }),
    ).rejects.toMatchObject({ code: "badRequest" });
    await expect(
      readLines({ source: missing, path: "x", from: 0, count: 0 }),
    ).rejects.toMatchObject({ code: "badRequest" });
    await expect(readLine({ source: missing, path: "x", n: -1 })).rejects.toMatchObject({
      code: "badRequest",
    });
    await expect(
      readRecord({ source: missing, path: "x", offset: 1.5, length: 1 }),
    ).rejects.toBeInstanceOf(DaemonError);
  });

  describe("with a tiny WACZ (hermetic)", () => {
    let wacz: TinyWacz;
    let source: { kind: "uri"; uri: string };
    const WARC = "archive/data.warc.gz";
    beforeAll(async () => {
      wacz = await buildTinyWacz();
      source = { kind: "uri", uri: wacz.uri };
    });
    afterAll(async () => {
      await removeTinyWacz(wacz);
    });

    it("readLines: 長い行は先頭だけで cut、NUL の行は binary、本来の長さは残る", async () => {
      const page = await readLines({ source, path: "lines.txt", from: 0, count: 10 });
      expect(page.next).toBeNull();
      expect(page.lines.map((line) => [line.n, line.cut, line.binary, line.bytes])).toEqual([
        [0, false, false, 10],
        [1, true, false, 5 * 1024 * 1024],
        [2, false, true, 7],
      ]);
      expect(page.lines[1]?.text.length).toBe(2 * 1024); // LINE_CAP
      expect(page.lines[2]?.text).toBe("");
    });

    it("readLine: 4 MiB を超える行は cut で、割らない (fields は空)", async () => {
      const line = await readLine({ source, path: "lines.txt", n: 1 });
      expect(line.cut).toBe(true);
      expect(line.text.length).toBe(4 * 1024 * 1024); // LINE_MAX
      expect(line.fields).toEqual([]);
    });

    it("readLine: binary の行も割らない", async () => {
      const line = await readLine({ source, path: "lines.txt", n: 2 });
      expect(line.binary).toBe(true);
      expect(line.fields).toEqual([]);
    });

    it("readLine: 索引の行を割り、offset / length / filename が取れる", async () => {
      const line = await readLine({ source, path: "indexes/index.cdxj", n: 0 });
      const value = (label: string): string | undefined => line.fields.find((f) => f.label === label)?.value;
      expect(value("key")).toBe("com,example)/a.png");
      expect(value("filename")).toBe("data.warc.gz");
      expect(value("offset")).toBe(String(wacz.members[1]?.offset));
    });

    it("readRecords: 索引の印は、この WARC を指す行だけから付く", async () => {
      const page = await readRecords({ source, path: WARC, from: 0, count: 10 });
      expect(page.total).toBe(3);
      expect(page.records.map((r) => [r.type, r.indexed])).toEqual([
        ["warcinfo", false], // 索引に無い
        ["response", true], // 索引が data.warc.gz を指す
        ["metadata", false], // 索引は在るが other.warc.gz を指す
      ]);
      expect(page.records[1]).toMatchObject({ status: 200, mime: "image/png", uri: "https://example.com/a.png" });
    });

    it("readRecords: 窓を送ると next が続きを言う", async () => {
      const first = await readRecords({ source, path: WARC, from: 0, count: 2 });
      expect(first.records).toHaveLength(2);
      expect(first.next).toBe(2);
      const rest = await readRecords({ source, path: WARC, from: 2, count: 2 });
      expect(rest.records.map((r) => r.type)).toEqual(["metadata"]);
      expect(rest.next).toBeNull();
    });

    it("readRecord: 画像の応答は HTTP の見出しと、大きさだけの body", async () => {
      const png = wacz.members[1];
      if (png === undefined) throw new Error("unreachable");
      const record = await readRecord({ source, path: WARC, offset: png.offset, length: png.length });
      expect(record.http?.status).toBe("HTTP/1.1 200 OK");
      expect(record.body).toEqual({ kind: "image", mime: "image/png", byteLength: PNG.length });
    });

    it("readRecordBody: 画像の実体をそのまま返す。撮らなかった記録は NotRasterError", async () => {
      const [, png, meta] = wacz.members;
      if (png === undefined || meta === undefined) throw new Error("unreachable");
      const body = await readRecordBody({ source, path: WARC, offset: png.offset, length: png.length });
      expect(body.mime).toBe("image/png");
      expect(body.bytes.equals(PNG)).toBe(true);
      await expect(
        readRecordBody({ source, path: WARC, offset: meta.offset, length: meta.length }),
      ).rejects.toBeInstanceOf(NotRasterError);
      const record = await readRecord({ source, path: WARC, offset: meta.offset, length: meta.length });
      expect(record.body).toMatchObject({ kind: "text" });
      if (record.body.kind === "text") expect(record.body.content).toContain("action: no-archive");
    });

    it("readRecord: 範囲が entry の外なら badRequest", async () => {
      await expect(
        readRecord({ source, path: WARC, offset: 0, length: 100_000_000 }),
      ).rejects.toMatchObject({ code: "badRequest" });
    });
  });

  describe.skipIf(corpusDir === undefined || corpusDir === "")("with corpus fixtures", () => {
    const good = { kind: "uri" as const, uri: fixtureUri("fixtures/good.wacz") };
    const WARC = "archive/data.warc.gz";

    it("validate: good.wacz は valid な WireReport(解決済み message)", async () => {
      const report = await validate({ source: good, locale: "en", profile: "spec" });
      expect(report.summary.failed).toBe(0);
    });

    it("validate: locale=ja で issue message が日本語に解決される", async () => {
      const report = await validate({
        source: { kind: "uri", uri: fixtureUri("fixtures/wacz-missing-archive.wacz") },
        locale: "ja",
      });
      expect(report.summary.failed).toBeGreaterThan(0);
      expect(report.issues.some((i) => i.message.includes("ありません"))).toBe(true);
    });

    it("readLines: datapackage.json を行で返し、窓の続きは next で言う", async () => {
      const all = await readLines({ source: good, path: "datapackage.json", from: 0, count: 500 });
      expect(all.lines.some((line) => line.text.includes('"profile"'))).toBe(true);
      expect(all.next).toBeNull();
      expect(all.gunzipped).toBe(false);
      const first = await readLines({ source: good, path: "datapackage.json", from: 0, count: 1 });
      expect(first.lines).toHaveLength(1);
      expect(first.next).toBe(1);
      const rest = await readLines({ source: good, path: "datapackage.json", from: 1, count: 500 });
      expect(rest.lines[0]?.n).toBe(1);
      expect(rest.lines).toHaveLength(all.lines.length - 1);
    });

    it("readLines: .warc.gz は展開して行にする", async () => {
      const head = await readLines({ source: good, path: WARC, from: 0, count: 2 });
      expect(head.gunzipped).toBe(true);
      expect(head.lines.map((line) => line.text)).toEqual(["WARC/1.1", "WARC-Type: warcinfo"]);
    });

    it("readLine: 索引の 1 行を fields に割る", async () => {
      const line = await readLine({ source: good, path: "indexes/index.cdxj", n: 0 });
      expect(line.cut).toBe(false);
      const labels = line.fields.map((f) => f.label);
      expect(labels.slice(0, 2)).toEqual(["key", "timestamp"]);
      expect(labels).toEqual(expect.arrayContaining(["offset", "length", "filename"]));
    });

    it("readLine: 末尾を超えた行は badRequest", async () => {
      await expect(
        readLine({ source: good, path: "indexes/index.cdxj", n: 10_000 }),
      ).rejects.toMatchObject({ code: "badRequest" });
    });

    it("readRecords: WARC を頭から歩き、索引が指すレコードに印を付ける", async () => {
      const page = await readRecords({ source: good, path: WARC, from: 0, count: 100 });
      expect(page.total).toBeGreaterThanOrEqual(1);
      expect(page.next).toBeNull();
      expect(page.records[0]).toMatchObject({ offset: 0, type: "warcinfo", indexed: true });
    });

    it("readRecord: warcinfo の見出しと本文(text)を返す", async () => {
      const [first] = (await readRecords({ source: good, path: WARC, from: 0, count: 1 })).records;
      if (first === undefined) throw new Error("unreachable: the WARC has a warcinfo");
      const record = await readRecord({ source: good, path: WARC, offset: first.offset, length: first.length });
      expect(record.warc.find((h) => h.name === "WARC-Type")?.value).toBe("warcinfo");
      expect(record.http).toBeUndefined();
      expect(record.body).toMatchObject({ kind: "text", truncated: false });
      if (record.body.kind === "text") expect(record.body.content).toMatch(/^software: /);
    });

    it("readRecordBody: raster でない本文は NotRasterError", async () => {
      const [first] = (await readRecords({ source: good, path: WARC, from: 0, count: 1 })).records;
      if (first === undefined) throw new Error("unreachable");
      await expect(
        readRecordBody({ source: good, path: WARC, offset: first.offset, length: first.length }),
      ).rejects.toBeInstanceOf(NotRasterError);
    });
  });
});
