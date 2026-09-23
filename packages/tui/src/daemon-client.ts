/**
 * daemon クライアント — daemon を spawn(or `--server` に接続)し、
 * WS で相関 id つき request/response を行う薄い層。
 *
 * tui はここを通して core(validation)を間接的に使う(直接 import しない)。
 * spawn した daemon は ephemeral で、validate を終えたら `close()` で kill する。
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { WebSocket, type RawData } from "ws";
import type {
  RpcError,
  RpcMethod,
  RpcParams,
  RpcRequest,
  RpcResponse,
} from "@wacz-validator/protocol";
import { ServerEndpoint } from "./server-url.js";

/** daemon が RpcError を返したときに reject する型つきエラー。 */
export class RpcCallError extends Error {
  readonly code: RpcError["code"];
  constructor(error: RpcError) {
    super(error.message);
    this.code = error.code;
    this.name = "RpcCallError";
  }
}

const DAEMON_START_TIMEOUT_MS = 8000;

/** daemon への接続セッション。spawn / attach で取得し、release で後始末する。 */
export class DaemonSession {
  readonly endpoint: ServerEndpoint;
  private readonly disposer: () => Promise<void>;

  private constructor(endpoint: ServerEndpoint, disposer: () => Promise<void>) {
    this.endpoint = endpoint;
    this.disposer = disposer;
  }

  /** 既に起動している daemon に接続する(spawn しない・release は no-op)。 */
  static attach(endpoint: ServerEndpoint): DaemonSession {
    return new DaemonSession(endpoint, () => Promise.resolve());
  }

  /** daemon bin を spawn して endpoint を得る(release で kill し exit を待つ)。 */
  static async spawn(): Promise<DaemonSession> {
    const cliPath = createRequire(import.meta.url).resolve("@wacz-validator/daemon/dist/cli.js");
    const child = spawn(process.execPath, [cliPath], {
      // spawn する ephemeral daemon は loopback に固定する(ambient な
      // WACZ_VALIDATOR_DAEMON_HOST が漏れて全 interface に晒されるのを防ぐ)。
      env: { ...process.env, WACZ_VALIDATOR_DAEMON_PORT: "0", WACZ_VALIDATOR_DAEMON_HOST: "127.0.0.1" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const endpoint = await new Promise<ServerEndpoint>((resolveEndpoint, rejectSpawn) => {
      const timer = setTimeout(() => {
        rejectSpawn(new Error("daemon did not become ready in time"));
      }, DAEMON_START_TIMEOUT_MS);
      // stdio: ["ignore","ignore","pipe"] により stderr は Readable(非 null)。
      child.stderr.on("data", (chunk: Buffer) => {
        const match = /(ws:\/\/127\.0\.0\.1:\d+)/.exec(chunk.toString("utf8"));
        if (match?.[1] !== undefined) {
          clearTimeout(timer);
          // 正規表現が ws://127.0.0.1:port を保証するので parse は必ず成功する。
          resolveEndpoint(ServerEndpoint.parse(match[1]));
        }
      });
      child.on("error", (cause) => {
        clearTimeout(timer);
        rejectSpawn(cause);
      });
      child.on("exit", () => {
        clearTimeout(timer);
        rejectSpawn(new Error("daemon exited before becoming ready"));
      });
    });
    // kill して child の exit を待つ。これを待たずに親が終了処理へ進むと、
    // 死にかけの child handle が event loop に残り、exit code が確定する前に
    // 親が抜けて 0 になるレースが起きる。
    return new DaemonSession(endpoint, () =>
      new Promise<void>((resolveRelease) => {
        child.once("exit", () => {
          resolveRelease();
        });
        child.kill();
      }),
    );
  }

  /** spawn した daemon を kill し exit を待つ(attach 時は no-op)。 */
  release(): Promise<void> {
    return this.disposer();
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

export interface DaemonClient {
  request: <R>(
    method: RpcMethod,
    params: RpcParams,
  ) => Promise<R>;
  close: () => void;
}

const rawToString = (raw: RawData): string =>
  Array.isArray(raw)
    ? Buffer.concat(raw).toString("utf8")
    : Buffer.isBuffer(raw)
      ? raw.toString("utf8")
      : Buffer.from(raw).toString("utf8");

/** ws を開き、相関 id つき request を提供するクライアントを返す。 */
export const connect = async (endpoint: ServerEndpoint): Promise<DaemonClient> => {
  const ws = new WebSocket(endpoint.url);
  await new Promise<void>((resolveOpen, rejectOpen) => {
    ws.once("open", () => {
      resolveOpen();
    });
    ws.once("error", rejectOpen);
  });

  let nextId = 1;
  const pending = new Map<number, Pending>();

  ws.on("message", (raw: RawData) => {
    let response: RpcResponse;
    try {
      response = JSON.parse(rawToString(raw)) as RpcResponse;
    } catch {
      return;
    }
    const entry = pending.get(response.id);
    if (!entry) return;
    pending.delete(response.id);
    if (response.error !== undefined) entry.reject(new RpcCallError(response.error));
    else entry.resolve(response.result);
  });

  return {
    request: <R>(
      method: RpcMethod,
      params: RpcParams,
    ): Promise<R> =>
      new Promise<R>((resolveReq, rejectReq) => {
        const id = nextId++;
        pending.set(id, { resolve: (value) => { resolveReq(value as R); }, reject: rejectReq });
        ws.send(JSON.stringify({ id, method, params } satisfies RpcRequest));
      }),
    close: () => {
      ws.close();
    },
  };
};
