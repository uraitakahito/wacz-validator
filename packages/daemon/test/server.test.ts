// @module-tag daemon
/**
 * daemon の HTTP/WS サーバ(dispatch + 相関 id 枠 + REST の口)のテスト。
 *
 * createDaemon() を in-process で listen(port 0)し、ws クライアントと fetch で叩く。
 * 未知メソッド・不正 URI のエラー枠は hermetic に常時走る。happy path は実 WACZ を
 * 要するので CORPUS_DIR 未設定なら skip(handlers.test と同様)。
 */
import type { Server } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { RpcRequest, RpcResponse } from "@wacz-validator/protocol";
import { createDaemon } from "../src/server.js";
import { PNG, buildTinyWacz, removeTinyWacz, type TinyWacz } from "./fixtures/tiny-wacz.js";

const corpusDir = process.env["CORPUS_DIR"];
const fixtureUri = (rel: string): string => pathToFileURL(resolve(corpusDir ?? "", rel)).href;
const missing = { kind: "uri" as const, uri: "file:///wacz-validator/no-such.wacz" };

let server: Server;
let port: number;

beforeEach(async () => {
  server = createDaemon();
  await new Promise<void>((res) => {
    server.listen(0, "127.0.0.1", () => {
      res();
    });
  });
  const addr = server.address();
  port = typeof addr === "object" && addr !== null ? addr.port : 0;
});

afterEach(async () => {
  await new Promise<void>((res) => {
    server.close(() => {
      res();
    });
  });
});

const call = (message: RpcRequest): Promise<RpcResponse> =>
  new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${String(port)}`);
    ws.on("open", () => {
      ws.send(JSON.stringify(message));
    });
    ws.on("message", (raw: Buffer) => {
      res(JSON.parse(raw.toString("utf8")) as RpcResponse);
      ws.close();
    });
    ws.on("error", rej);
  });

const post = (path: string, body: unknown): Promise<Response> =>
  fetch(`http://127.0.0.1:${String(port)}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("daemon server (WS)", () => {
  it("開けない URI は openFailed エラーを相関 id つきで返す", async () => {
    const res = await call({
      id: 7,
      method: "wacz-validator/validate",
      params: { source: missing, locale: "en" },
    });
    expect(res.id).toBe(7);
    expect(res.error?.code).toBe("openFailed");
  });

  it("未知メソッドは badRequest", async () => {
    const res = await call({
      id: 8,
      method: "wacz-validator/readEntry" as never,
      params: { source: missing, locale: "en" },
    });
    expect(res.error?.code).toBe("badRequest");
    expect(res.error?.message).toContain("unknown method");
  });

  it("不正な source(s3:// にキー無し)は openFailed を返す", async () => {
    const res = await call({
      id: 9,
      method: "wacz-validator/readLines",
      params: { source: { kind: "uri", uri: "s3://nokey" }, path: "datapackage.json", from: 0, count: 1 },
    });
    expect(res.error?.code).toBe("openFailed");
  });

  it("logLevel error のとき壊れたフレームを stderr に記録する", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const logged = createDaemon({ logLevel: "error" });
    await new Promise<void>((res) => {
      logged.listen(0, "127.0.0.1", () => {
        res();
      });
    });
    const a = logged.address();
    const p = typeof a === "object" && a !== null ? a.port : 0;
    await new Promise<void>((res) => {
      const ws = new WebSocket(`ws://127.0.0.1:${String(p)}`);
      ws.on("open", () => {
        ws.send("{ not json");
        setTimeout(() => {
          ws.close();
          res();
        }, 60);
      });
    });
    const wrote = spy.mock.calls.some((c) => String(c[0]).includes("malformed frame"));
    spy.mockRestore();
    await new Promise<void>((res) => {
      logged.close(() => {
        res();
      });
    });
    expect(wrote).toBe(true);
  });

  it("wacz-validator/ping は healthStatus を返す", async () => {
    const res = await call({ id: 10, method: "wacz-validator/ping", params: {} });
    expect(res.error).toBeUndefined();
    expect(res.result && "status" in res.result ? res.result.status : null).toBe("ok");
  });
});

describe("daemon server (REST)", () => {
  it("GET /healthz は 200 で healthStatus を返す", async () => {
    const res = await fetch(`http://127.0.0.1:${String(port)}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  it("窓の口は WS と同じ答え(開けない URI は 400 の openFailed)", async () => {
    for (const [path, params] of [
      ["/validate", { source: missing, locale: "en" }],
      ["/lines", { source: missing, path: "datapackage.json", from: 0, count: 1 }],
      ["/line", { source: missing, path: "datapackage.json", n: 0 }],
      ["/records", { source: missing, path: "archive/data.warc.gz", from: 0, count: 1 }],
      ["/record", { source: missing, path: "archive/data.warc.gz", offset: 0, length: 1 }],
      ["/record/body", { source: missing, path: "archive/data.warc.gz", offset: 0, length: 1 }],
    ] as const) {
      const res = await post(path, params);
      expect(res.status, path).toBe(400);
      const body = (await res.json()) as { code: string };
      expect(body.code, path).toBe("openFailed");
    }
  });

  it("無い口と GET は 404", async () => {
    expect((await post("/entry", {})).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${String(port)}/lines`)).status).toBe(404);
  });

  describe("with a tiny WACZ (hermetic)", () => {
    let wacz: TinyWacz;
    const WARC = "archive/data.warc.gz";
    beforeAll(async () => {
      wacz = await buildTinyWacz();
    });
    afterAll(async () => {
      await removeTinyWacz(wacz);
    });

    it("POST /record/body: raster の画像は bytes で、動かない印 (nosniff · sandbox) つき", async () => {
      const png = wacz.members[1];
      if (png === undefined) throw new Error("unreachable");
      const res = await post("/record/body", { source: { kind: "uri", uri: wacz.uri }, path: WARC, offset: png.offset, length: png.length });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("content-security-policy")).toBe("sandbox");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
    });

    it("POST /record/body: raster でない本文は 415", async () => {
      const meta = wacz.members[2];
      if (meta === undefined) throw new Error("unreachable");
      const res = await post("/record/body", { source: { kind: "uri", uri: wacz.uri }, path: WARC, offset: meta.offset, length: meta.length });
      expect(res.status).toBe(415);
      const body = (await res.json()) as { code: string; message: string };
      expect(body.message).toContain("not a raster image");
    });

    it("POST /records と WS の readRecords は同じ答え", async () => {
      const params = { source: { kind: "uri" as const, uri: wacz.uri }, path: WARC, from: 0, count: 10 };
      const ws = await call({ id: 3, method: "wacz-validator/readRecords", params });
      const rest = (await (await post("/records", params)).json()) as unknown;
      expect(ws.error).toBeUndefined();
      expect(rest).toEqual(ws.result);
    });
  });

  describe.skipIf(corpusDir === undefined || corpusDir === "")("with corpus fixtures", () => {
    const good = { kind: "uri" as const, uri: fixtureUri("fixtures/good.wacz") };
    const WARC = "archive/data.warc.gz";

    it("validate: good.wacz は valid な WireReport を返す", async () => {
      const res = await call({
        id: 1,
        method: "wacz-validator/validate",
        params: { source: good, locale: "en" },
      });
      expect(res.error).toBeUndefined();
      expect(res.result && "summary" in res.result ? res.result.summary.failed : null).toBe(0);
    });

    it("readLines (WS) と POST /lines は同じ行を返す", async () => {
      const params = { source: good, path: "datapackage.json", from: 0, count: 3 };
      const ws = await call({ id: 2, method: "wacz-validator/readLines", params });
      const rest = (await (await post("/lines", params)).json()) as unknown;
      expect(ws.error).toBeUndefined();
      expect(rest).toEqual(ws.result);
    });

    it("POST /record/body: raster でない本文は 415", async () => {
      const first = (await (await post("/records", { source: good, path: WARC, from: 0, count: 1 })).json()) as {
        records: { offset: number; length: number }[];
      };
      const record = first.records[0];
      if (record === undefined) throw new Error("unreachable: the WARC has a warcinfo");
      const res = await post("/record/body", { source: good, path: WARC, offset: record.offset, length: record.length });
      expect(res.status).toBe(415);
    });
  });
});
