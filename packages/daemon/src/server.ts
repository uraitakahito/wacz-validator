/**
 * stateless な HTTP/WS サーバ。
 *
 * WS は相関 id つきの request/response(セッション/購読は持たない)。
 * REST は WS と**同じハンドラ**を指す —— 口が 2 つでも、答えを作るのは 1 か所。
 * どのリクエストもハンドラが open→処理→close するだけで、サーバは可変状態を持たない。
 *
 * REST の口:
 *   GET  /healthz       生存
 *   POST /validate      検証の報告
 *   POST /lines         行の窓          POST /line     1 行 (fields つき)
 *   POST /records       レコードの一覧  POST /record   1 レコード
 *   POST /record/body   画像の実体 (raster だけ bytes で。他は 415)
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocketServer, type RawData } from "ws";
import type {
  HealthStatus,
  ReadLineParams,
  ReadLinesParams,
  ReadRecordParams,
  ReadRecordsParams,
  RpcError,
  RpcRequest,
  RpcResponse,
  RpcResult,
  ValidateParams,
} from "@wacz-validator/protocol";
import { BUILD_INFO } from "./generated/build-info.js";
import { describeCause } from "@wacz-validator/contract";
import {
  DaemonError,
  NotRasterError,
  readLine,
  readLines,
  readRecord,
  readRecordBody,
  readRecords,
  validate,
} from "./handlers.js";

const healthStatus = (): HealthStatus => ({
  status: "ok",
  version: BUILD_INFO.version,
  gitSha: BUILD_INFO.gitSha,
  builtAt: BUILD_INFO.builtAt,
  uptimeSec: Math.round(process.uptime()),
});

const dispatch = async (method: string, params: unknown): Promise<RpcResult> => {
  switch (method) {
    case "wacz-validator/ping":
      return healthStatus();
    case "wacz-validator/validate":
      return validate(params as ValidateParams);
    case "wacz-validator/readLines":
      return readLines(params as ReadLinesParams);
    case "wacz-validator/readLine":
      return readLine(params as ReadLineParams);
    case "wacz-validator/readRecords":
      return readRecords(params as ReadRecordsParams);
    case "wacz-validator/readRecord":
      return readRecord(params as ReadRecordParams);
    default:
      throw new DaemonError("badRequest", `unknown method: ${method}`);
  }
};

/** REST の JSON の口。path → WS と同じハンドラ。 */
const JSON_ROUTES: Record<string, (params: never) => Promise<RpcResult>> = {
  "/validate": validate,
  "/lines": readLines,
  "/line": readLine,
  "/records": readRecords,
  "/record": readRecord,
};

const toError = (cause: unknown): RpcError =>
  cause instanceof DaemonError
    ? { code: cause.code, message: cause.message }
    : { code: "engineFailed", message: describeCause(cause) };

const rawToString = (raw: RawData): string =>
  Array.isArray(raw)
    ? Buffer.concat(raw).toString("utf8")
    : Buffer.isBuffer(raw)
      ? raw.toString("utf8")
      : Buffer.from(raw).toString("utf8");

/**
 * 本文はネットワーク越しに複数チャンクへ割れて届く。chunk ごとに toString せず、
 * Buffer.concat で連結してから一度だけ decode する。マルチバイト文字(UTF-8 で複数
 * バイト)がチャンク境界をまたぐと、半端なバイトが U+FFFD に化けて値が静かに壊れる
 * ため(JSON 構造文字は ASCII なので JSON.parse は素通りし、例外も出ない)。
 */
const readBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};

const replyError = (res: ServerResponse, status: number, cause: unknown): void => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(toError(cause)));
};

const handleRest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(healthStatus()));
    return;
  }
  const url = req.url ?? "";
  if (req.method !== "POST" || !(url === "/record/body" || Object.hasOwn(JSON_ROUTES, url))) {
    res.statusCode = 404;
    res.end();
    return;
  }
  const body = await readBody(req);
  if (url === "/record/body") {
    // 画像の実体だけを bytes で返す。raster 以外は 415 —— 撮った HTML や SVG を
    // そのまま返すと、受け取った画面のオリジンで動いてしまう。
    try {
      const { mime, bytes } = await readRecordBody(JSON.parse(body) as ReadRecordParams);
      res.writeHead(200, {
        "content-type": mime,
        "content-length": String(bytes.length),
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox",
        "cache-control": "no-store",
      });
      res.end(bytes);
    } catch (cause) {
      replyError(res, cause instanceof NotRasterError ? 415 : 400, cause);
    }
    return;
  }
  const handler = JSON_ROUTES[url];
  if (handler === undefined) {
    res.statusCode = 404;
    res.end();
    return;
  }
  try {
    const result = await handler(JSON.parse(body) as never);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(result));
  } catch (cause) {
    replyError(res, 400, cause);
  }
};

export const LOG_LEVELS = ["silent", "error", "debug"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface CreateDaemonOptions {
  /** stderr 診断ログの level(既定 "silent")。malformed frame は "error" 以上で出る。 */
  logLevel?: LogLevel;
}

/** level に応じて stderr に書く薄い logger。 */
const makeLogger = (level: LogLevel) => ({
  error: (msg: string) => {
    if (level !== "silent") process.stderr.write(`wacz-validator-daemon [error] ${msg}\n`);
  },
  debug: (msg: string) => {
    if (level === "debug") process.stderr.write(`wacz-validator-daemon [debug] ${msg}\n`);
  },
});

/** stateless な HTTP/WS サーバを組み立てて返す(listen は呼び出し側)。 */
export const createDaemon = (opts: CreateDaemonOptions = {}): Server => {
  const log = makeLogger(opts.logLevel ?? "silent");
  const server = createServer((req, res) => {
    void handleRest(req, res);
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket) => {
    socket.on("message", (raw: RawData) => {
      void (async () => {
        let request: RpcRequest;
        try {
          request = JSON.parse(rawToString(raw)) as RpcRequest;
        } catch (cause) {
          log.error(`ignored malformed frame: ${cause instanceof Error ? cause.message : String(cause)}`);
          return;
        }
        const response: RpcResponse = { id: request.id };
        try {
          response.result = await dispatch(request.method, request.params);
        } catch (cause) {
          response.error = toError(cause);
        }
        socket.send(JSON.stringify(response));
      })();
    });
  });
  return server;
};
