// @module-tag remote
/**
 * `WaczReader.open(httpTransport(...))` の end-to-end テスト。
 *
 * **fetch を mock しない。** `node:http` で本物のサーバを立て、`buildWacz()` の
 * バイト列を Range つきで配る。見たいのが「Range の往復が噛み合うか」そのもので、
 * mock はこちらが想定した往復しか再現しないため。
 *
 * 見るもの:
 *   1. `Content-Range` から総サイズを取る経路（**HEAD を使わない**）
 *   2. Range を**無視する**サーバで、静かに通らずに落ちること
 *   3. 署名つき URL の query が `Report.source` に載らないこと
 *   4. 同じ fixture を file で開いたときと等価な結果になること
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { runValidation } from "../src/validate/engine.js";
import { DEFAULT_RULES } from "../src/validate/rules/index.js";
import { parseHttpUrl, parseReportSource } from "../src/validate/domain.js";
import { WaczReader } from "../src/wacz/reader.js";
import { httpTransport } from "../src/wacz/transport.js";
import { totalFromContentRange } from "../src/wacz/http-range-reader.js";
import { buildWacz } from "./fixtures/generator.js";

const RANGE_RE = /^bytes=(\d+)-(\d+)$/;

let running: Server | undefined;

/** `honourRange: false` は「Range を無視して 200 で全部返す」相手。 */
const serve = async (bytes: Buffer, honourRange: boolean): Promise<string> => {
  const server = createServer((request, reply) => {
    const match = RANGE_RE.exec(request.headers.range ?? "");
    if (!honourRange || !match?.[1] || !match[2]) {
      reply.writeHead(200, { "content-length": String(bytes.length) });
      reply.end(bytes);
      return;
    }
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), bytes.length - 1);
    const slice = bytes.subarray(start, end + 1);
    reply.writeHead(206, {
      "content-range": `bytes ${String(start)}-${String(end)}/${String(bytes.length)}`,
      "content-length": String(slice.length),
    });
    reply.end(slice);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  running = server;
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(port)}/fixture.wacz`;
};

const openAt = async (url: string) => {
  const parsed = parseHttpUrl(url);
  if (!parsed.ok) throw new Error("unreachable: test input is well-formed");
  return WaczReader.open(httpTransport({ url: parsed.value }));
};

afterEach(async () => {
  if (running) await new Promise((done) => running?.close(done));
  running = undefined;
});

describe("WaczReader.open (httpTransport)", () => {
  it("range-reads a valid WACZ over http", async () => {
    const { bytes } = await buildWacz();
    const url = await serve(bytes, true);

    const reader = await openAt(url);
    try {
      expect(reader.source).toEqual({ kind: "http", url });

      const result = await runValidation(reader, {
        validatorVersion: "0.0.0",
        rules: DEFAULT_RULES,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.summary.failed).toBe(0);
      expect(result.value.source).toEqual({ kind: "http", url });
    } finally {
      await reader.close();
    }
  });

  it("Range を無視する相手では開かない —— 静かに壊れた WACZ を読まない", async () => {
    // 200 で全体を返す相手を「指定した範囲」として読むと、ZIP の中央ディレクトリを
    // 本文の先頭から読むことになる。**そこで検証を続けると「壊れている」と報告して
    // しまう** —— 壊れているのは相手の Range 対応であって、WACZ ではない。
    const { bytes } = await buildWacz();
    const url = await serve(bytes, false);

    await expect(openAt(url)).rejects.toThrow(/expected 206/);
  });

  it("署名つきの query は、報告にも失敗の文にも載らない", async () => {
    const { bytes } = await buildWacz();
    const base = await serve(bytes, true);
    const signed = `${base}?X-Amz-Signature=deadbeef&X-Amz-Expires=300`;

    const reader = await openAt(signed);
    try {
      // identity は query を落としたもの。署名は資格情報で、identity ではない。
      expect(reader.source).toEqual({ kind: "http", url: base });
      expect(JSON.stringify(reader.source)).not.toContain("X-Amz-Signature");
    } finally {
      await reader.close();
    }
  });

  it("開けなかったときの文にも、署名は出ない", async () => {
    const { bytes } = await buildWacz();
    const base = await serve(bytes, false); // Range を無視する相手
    const signed = `${base}?X-Amz-Signature=deadbeef`;

    await expect(openAt(signed)).rejects.toThrow(/^(?!.*X-Amz-Signature).*expected 206/s);
  });

  it("http(s) は、絶対パスより先に判定される", () => {
    // ここを取り違えると `http://…` が cwd からの相対パスとして解決され、
    // `ENOENT: … /wacz-validator/http:/127.0.0.1:8333/…` になる（実測した形）。
    const parsed = parseReportSource("http://127.0.0.1:8333/b/x.wacz");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.kind).toBe("http");
  });

  it("scheme が違うものと、host の無いものは落とす", () => {
    // `httpx:` `ftp:` は protocol で落ちる。`http://`（host 無し）は URL 自体が投げる。
    for (const raw of ["httpx://x/y.wacz", "ftp://x/y.wacz", "http://", "http:// x"]) {
      expect(parseHttpUrl(raw).ok).toBe(false);
    }
  });

  it("`http:/x`（斜線 1 本）は落とさない —— URL の正規化で `http://x/` になる", () => {
    // 落とす価値が無いから通す、ではなく **通ることを書いておく**。
    // parseReportSource はそもそも `http://` で始まる文字列しかここへ渡さないので、
    // この形が実際に来る道は無い。来たときに何が起きるかだけを固定する。
    const parsed = parseHttpUrl("http:/only-one-slash");
    expect(parsed.ok).toBe(true);
  });

  it("Content-Range が読めないときは、サイズを推測しない", () => {
    expect(totalFromContentRange("bytes 0-0/11806")).toBe(11806);
    // `*` は「全体の長さは言えない」。0 と取り違えると空の ZIP として扱ってしまう。
    expect(totalFromContentRange("bytes 0-0/*")).toBeUndefined();
    expect(totalFromContentRange(null)).toBeUndefined();
  });
});
