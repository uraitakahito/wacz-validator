// @module-tag remote
/**
 * http transport の「往復の数」と「止まること」のテスト。
 *
 * **fetch を mock しない。** `node:http` で本物のサーバを立て、Range を数え、
 * 本文を小さく刻んで送る —— 読み手が止めたことが、送った量に出る。
 *
 * 見るもの:
 *   1. 末尾を 1 往復で取り (`bytes=-65557`)、末尾の内側の読みは往復しない
 *      —— 64 KiB より大きい WACZ で、WARC を読み切るまで **3 往復**
 *   2. 末尾に収まる小さな WACZ は、検証まで含めて **1 往復**
 *   3. `openLines` を途中で止めたら、サーバが送り切る前に切れる —— そのあと閉じられる
 *   4. `member()` が STORE の WARC から 1 メンバを切り出し、DEFLATE では断る
 *   5. 末尾からの Range に 206 で答えない相手では開かない
 */
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setImmediate as pause, setTimeout as sleep } from "node:timers/promises";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { parseHttpUrl } from "../src/validate/domain.js";
import { runValidation } from "../src/validate/engine.js";
import { DEFAULT_RULES } from "../src/validate/rules/index.js";
import { TAIL_BYTES } from "../src/wacz/http-range-reader.js";
import { WaczReader } from "../src/wacz/reader.js";
import { httpTransport } from "../src/wacz/transport.js";
import { buildWacz, type WarcResponseSpec } from "./fixtures/generator.js";

const RANGE_RE = /^bytes=(?:(\d+)-(\d+)|-(\d+))$/;
/** 本文を刻む単位。小さいほど「どこで止まったか」が細かく分かる。 */
const CHUNK = 16 * 1024;
const WARC = "archive/data.warc.gz";

interface Served {
  url: string;
  /** 受けた Range ヘッダ、受けた順。 */
  ranges: string[];
  /** 各応答で送った本文のバイト数 (ranges と同じ順)。 */
  sent: number[];
  /** 終わった (送り切った・相手が切った) 応答の数。 */
  closed: number;
}

interface ServeOptions {
  /** false なら、末尾からの Range (bytes=-N) を無視して 200 で全部返す相手。 */
  suffix?: boolean;
  /** これより大きい範囲は、最初の CHUNK だけ送って**黙る** (終わらせない)。 */
  stallOver?: number;
}

let running: Server[] = [];

/**
 * bytes を Range つきで配る。本文は CHUNK ずつ、相手が切ったら止める。
 */
const serve = async (bytes: Buffer, opts: ServeOptions = {}): Promise<Served> => {
  const served: Served = { url: "", ranges: [], sent: [], closed: 0 };
  const server = createServer((request, reply) => {
    const header = request.headers.range ?? "";
    served.ranges.push(header);
    reply.once("close", () => {
      served.closed++;
    });
    const match = RANGE_RE.exec(header);
    const suffix = match?.[3];
    if (match === null || (suffix !== undefined && opts.suffix === false)) {
      served.sent.push(bytes.length);
      reply.writeHead(200, { "content-length": String(bytes.length) });
      reply.end(bytes);
      return;
    }
    const start = suffix === undefined ? Number(match[1] ?? "0") : Math.max(0, bytes.length - Number(suffix));
    const end = suffix === undefined ? Math.min(Number(match[2] ?? "0"), bytes.length - 1) : bytes.length - 1;
    const slice = bytes.subarray(start, end + 1);
    reply.writeHead(206, {
      "content-range": `bytes ${String(start)}-${String(end)}/${String(bytes.length)}`,
      "content-length": String(slice.length),
    });
    const index = served.sent.push(0) - 1;
    const stall = opts.stallOver !== undefined && slice.length > opts.stallOver;
    const peer = { gone: false };
    reply.once("close", () => {
      peer.gone = true;
    });
    void (async () => {
      for (let at = 0; at < slice.length && !peer.gone; at += CHUNK) {
        const piece = slice.subarray(at, Math.min(at + CHUNK, slice.length));
        const room = reply.write(piece);
        served.sent[index] = (served.sent[index] ?? 0) + piece.length;
        if (stall) return; // 黙る。相手が切るまで何もしない
        // 相手が読まなければ、こちらも進まない (socket の buffer を超えて送らない)。
        if (!room) await Promise.race([once(reply, "drain"), once(reply, "close")]);
        else await pause();
      }
      if (!peer.gone) reply.end();
    })();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  running.push(server);
  const { port } = server.address() as AddressInfo;
  served.url = `http://127.0.0.1:${String(port)}/fixture.wacz`;
  return served;
};

/** すべての応答が終わる (相手が切る・送り切る) まで、最長 1 秒待つ。 */
const settled = async (served: Served): Promise<boolean> => {
  for (let i = 0; i < 20 && served.closed < served.ranges.length; i++) await sleep(50);
  return served.closed === served.ranges.length;
};

const openAt = async (url: string): Promise<WaczReader> => {
  const parsed = parseHttpUrl(url);
  if (!parsed.ok) throw new Error("unreachable: test input is well-formed");
  return WaczReader.open(httpTransport({ url: parsed.value }));
};

/** 64 KiB の末尾に収まらない WACZ。乱数の本文は gzip で縮まないので、そのまま大きい。 */
const bigResponse = (size: number): WarcResponseSpec => ({
  uri: "https://example.com/big.bin",
  mime: "application/octet-stream",
  body: randomBytes(size),
});

afterEach(async () => {
  // 黙らせた応答が残っていても、server.close がそれを待って固まらないように。
  for (const server of running) server.closeAllConnections();
  await Promise.all(running.map((server) => new Promise((done) => server.close(done))));
  running = [];
});

describe("HttpRangeReader — 往復の数", () => {
  it("64 KiB より大きい WACZ で、WARC を読み切るまで 3 往復 (末尾・見出し・本体)", async () => {
    const { bytes } = await buildWacz({ warcResponses: [bigResponse(200 * 1024)] });
    expect(bytes.length).toBeGreaterThan(TAIL_BYTES);
    const served = await serve(bytes);

    const reader = await openAt(served.url);
    try {
      const warc = await reader.readEntry(WARC);
      expect(warc?.length).toBeGreaterThan(200 * 1024);
    } finally {
      await reader.close();
    }
    // 1: 末尾 (大きさもここで分かる)、2: WARC のローカル見出し、3: WARC の本体。
    // 中央ディレクトリの読みは 1 の内側で済んでいる (以前はここが entry ごとに 2 往復)。
    expect(served.ranges).toEqual([
      `bytes=-${String(TAIL_BYTES)}`,
      expect.stringMatching(/^bytes=\d+-\d+$/) as string,
      expect.stringMatching(/^bytes=\d+-\d+$/) as string,
    ]);
  });

  it("末尾に収まる小さな WACZ は、検証まで含めて 1 往復", async () => {
    const { bytes } = await buildWacz();
    expect(bytes.length).toBeLessThan(TAIL_BYTES);
    const served = await serve(bytes);

    const reader = await openAt(served.url);
    try {
      const result = await runValidation(reader, { validatorVersion: "0.0.0", rules: DEFAULT_RULES });
      expect(result.ok).toBe(true);
      expect(await reader.readEntry("datapackage.json")).toBeDefined();
    } finally {
      await reader.close();
    }
    expect(served.ranges).toEqual([`bytes=-${String(TAIL_BYTES)}`]);
  });

  it("末尾からの Range に 206 で答えない相手では開かない", async () => {
    const { bytes } = await buildWacz();
    const served = await serve(bytes, { suffix: false });
    await expect(openAt(served.url)).rejects.toThrow(/expected 206/);
  });
});

describe("WaczReader.openLines — 流す読み", () => {
  it("中身が gzip なら展開して行にし、DEFLATE の JSON はそのまま行にする", async () => {
    const { bytes } = await buildWacz();
    const served = await serve(bytes);
    const reader = await openAt(served.url);
    try {
      const warc = await reader.openLines(WARC, 2048);
      if (warc === undefined) throw new Error("unreachable: fixture has a WARC");
      expect(warc.gunzipped).toBe(true);
      const head: string[] = [];
      for await (const line of warc.lines) {
        head.push(line.text);
        if (head.length === 2) break;
      }
      expect(head).toEqual(["WARC/1.1", "WARC-Type: warcinfo"]);

      const dp = await reader.openLines("datapackage.json", 2048);
      if (dp === undefined) throw new Error("unreachable: fixture has datapackage.json");
      expect(dp.gunzipped).toBe(false);
      const all: string[] = [];
      for await (const line of dp.lines) all.push(line.text);
      expect(all.some((line) => line.includes('"profile"'))).toBe(true);

      expect(await reader.openLines("no/such.txt", 2048)).toBeUndefined();
    } finally {
      await reader.close();
    }
  });

  it("途中で止めたら、その場で GET が切れる —— 送り切る前に、reader を閉じる前に", async () => {
    const size = 4 * 1024 * 1024;
    const { bytes } = await buildWacz({ warcResponses: [bigResponse(size)] });
    const served = await serve(bytes);

    const reader = await openAt(served.url);
    try {
      const warc = await reader.openLines(WARC, 2048);
      if (warc === undefined) throw new Error("unreachable: fixture has a WARC");
      let seen = 0;
      for await (const line of warc.lines) {
        expect(line.binary).toBe(false);
        seen++;
        if (seen === 2) break;
      }
      // **閉じる前に**見る。止めた時点で GET が切れていること (close の後始末に頼らない)。
      expect(await settled(served)).toBe(true);
      expect(served.ranges.at(-1)).toMatch(/^bytes=\d+-\d+$/);
      expect(served.sent.at(-1)).toBeLessThan(size);
    } finally {
      // 読んでいる最中に閉じると yauzl は assert で止まる。止めた読みは戻っていること。
      await reader.close();
    }
  });

  it("DEFLATE の entry でも、止めた場で元の GET が切れる", async () => {
    // STORE なら止めた stream がそのまま yauzl の stream だが、DEFLATE では間に
    // inflate が挟まる。止めるときに**元の stream** を閉じないと、GET は開いたまま。
    //
    // 相手は最初の CHUNK のあと黙る。流し続ける相手だと、送り手と受け手が同じ
    // process に居るので、展開の段が 1 行目を出すまでに 1 MiB を socket の buffer へ
    // 送り切れてしまうことがある —— そうなると止めたかどうかに関係なく GET は
    // 「送り切って」終わり、送ったバイト数では区別が付かない (CI で 8 回中 4 回
    // 落ちた)。黙る相手なら、GET が終わるのは止めた側が切ったときだけ。
    const size = 1024 * 1024;
    const { bytes } = await buildWacz({ warcResponses: [bigResponse(size)], warcDeflate: true });
    const served = await serve(bytes, { stallOver: TAIL_BYTES });

    const reader = await openAt(served.url);
    try {
      const warc = await reader.openLines(WARC, 2048);
      if (warc === undefined) throw new Error("unreachable: fixture has a WARC");
      for await (const line of warc.lines) {
        expect(line.text).toBe("WARC/1.1");
        break;
      }
      expect(await settled(served)).toBe(true);
    } finally {
      await reader.close();
    }
  });

  it("相手が黙っていても、止めたら繋ぎっぱなしにしない", async () => {
    // 最初の CHUNK のあと黙るサーバ。次の chunk を待つ形で止めると、待ったまま
    // 戻らない —— destroy の場で abort しているから戻る。
    const size = 1024 * 1024;
    const { bytes } = await buildWacz({ warcResponses: [bigResponse(size)] });
    const served = await serve(bytes, { stallOver: TAIL_BYTES });

    const reader = await openAt(served.url);
    try {
      const warc = await reader.openLines(WARC, 2048);
      if (warc === undefined) throw new Error("unreachable: fixture has a WARC");
      for await (const line of warc.lines) {
        expect(line.text).toBe("WARC/1.1");
        break;
      }
      expect(await settled(served)).toBe(true);
    } finally {
      await reader.close();
    }
  });
});

describe("WaczReader.member — STORE から 1 メンバ", () => {
  const png: WarcResponseSpec = {
    uri: "https://example.com/a.png",
    mime: "image/png",
    body: Buffer.from("PNGDATA-not-really", "utf-8"),
  };

  it("索引の offset / length で切り出した 1 メンバが、その応答レコードになる", async () => {
    const { bytes, warcRecords } = await buildWacz({ warcResponses: [png] });
    const response = warcRecords.find((record) => record.type === "response");
    if (response === undefined) throw new Error("unreachable: fixture has a response");
    const served = await serve(bytes);
    const reader = await openAt(served.url);
    try {
      const member = await reader.member(WARC, response.offset, response.length);
      const text = gunzipSync(member).toString("utf-8");
      expect(text.startsWith("WARC/1.1\r\nWARC-Type: response")).toBe(true);
      expect(text).toContain("content-type: image/png");
      expect(text).toContain("PNGDATA-not-really");
    } finally {
      await reader.close();
    }
  });

  it("DEFLATE の entry からは切らない —— 名指しで断る", async () => {
    const { bytes, warcRecords } = await buildWacz({ warcResponses: [png], warcDeflate: true });
    const first = warcRecords[0];
    if (first === undefined) throw new Error("unreachable");
    const served = await serve(bytes);
    const reader = await openAt(served.url);
    try {
      await expect(reader.member(WARC, first.offset, first.length)).rejects.toThrow(/not STORE/);
    } finally {
      await reader.close();
    }
  });

  it("entry の外の範囲は断る", async () => {
    const { bytes } = await buildWacz();
    const served = await serve(bytes);
    const reader = await openAt(served.url);
    try {
      await expect(reader.member(WARC, 0, 10_000_000)).rejects.toThrow(/outside/);
      await expect(reader.member("no/such", 0, 1)).rejects.toThrow(/no entry/);
    } finally {
      await reader.close();
    }
  });
});
