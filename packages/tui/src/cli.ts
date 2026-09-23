#!/usr/bin/env node
/**
 * `wacz-validator` — WACZ validation のための Ink TUI(daemon クライアント)。
 *
 * validation は自前で行わず、stateless な `@wacz-validator/daemon` を spawn
 * (or `--server URL` に接続)し、WS で `wacz-validator/validate` を呼ぶ。daemon が
 * core を所有し、`renderJson(report, locale)` で解決済みの `WireReport` を返す
 * ので、tui はそれを interactive に render する。Layout で enter すると窓の口
 * (`wacz-validator/readLines` / `readLine` / `readRecords` / `readRecord`)でファイルの
 * 中身を取り、全幅で表示する。wacz-validator は対話 TUI
 * 専用で、stdout / stdin が TTY でない(パイプ / CI 等)場合は描画できないので、
 * daemon を起動する前に `wacz-validator-validate`(core の bin)を案内して exit 2 で終わる。
 * 非対話・機械可読な出力は `wacz-validator-validate` の領分。
 *
 * tui は `@wacz-validator/core` を import しない — 型 / 定数 / exitCodeFor はすべて
 * `@wacz-validator/protocol` 由来で、validation engine も i18n カタログも読み込まない。
 *
 * daemon の寿命は action が所有する: spawn → validate → (TUI の間は接続維持で
 * 窓の読み) → waitUntilExit → client.close → daemon.close(child の exit を待つ)
 * → `process.exitCode`。child を待ってから exitCode を確定するので、死にかけの
 * child handle と event loop が競合して exit code が 0 に化けるレースを避ける。
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Command, InvalidArgumentError } from "commander";
import {
  ALL_PROFILES,
  DEFAULT_PROFILE,
  DEFAULT_SELECTOR,
  exitCodeFor,
  formatProfileSelector,
  parseProfileSelector,
  SUPPORTED_LOCALES,
  describeCause,
  type CliOutcome,
  type HealthStatus,
  type ReadLineResult,
  type ReadLinesResult,
  type ReadRecordResult,
  type ReadRecordsResult,
  type ProfileSelector,
  type WireReport,
} from "@wacz-validator/protocol";
import {
  connect,
  DaemonSession,
  RpcCallError,
  type DaemonClient,
} from "./daemon-client.js";
import { BUILD_INFO } from "./generated/build-info.js";
import { ServerEndpoint } from "./server-url.js";
import type { BuildPair, ContentBridge } from "./app.js";

/** 描画(tui)と検証(daemon)の双方のビルド識別。Header の SHA 表示・不一致警告に使う。 */
interface BuildInfo {
  tui: BuildPair;
  daemon: BuildPair;
}

const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(here, "..", "package.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as { version: string };

const envS3ForcePathStyle = process.env["WACZ_VALIDATOR_S3_FORCE_PATH_STYLE"] === "true";

interface CliOptions {
  profile: ProfileSelector;
  s3ForcePathStyle: boolean;
  lang?: string;
  server?: ServerEndpoint;
}

/**
 * 窓の口への橋。どれも同じ source を運ぶ (daemon は状態を持たないので、毎回言う)。
 */
const bridgeFor = (client: DaemonClient, uri: string): ContentBridge => {
  const source = { kind: "uri" as const, uri };
  return {
    lines: (path, from, count) =>
      client.request<ReadLinesResult>("wacz-validator/readLines", { source, path, from, count }),
    line: (path, n) => client.request<ReadLineResult>("wacz-validator/readLine", { source, path, n }),
    records: (path, from, count) =>
      client.request<ReadRecordsResult>("wacz-validator/readRecords", { source, path, from, count }),
    record: (path, offset, length) =>
      client.request<ReadRecordResult>("wacz-validator/readRecord", { source, path, offset, length }),
  };
};

/**
 * CLI 引数を daemon に渡す source URI に正規化する。`s3://` はそのまま、
 * ローカルパスは絶対化して `file://` URI にする(daemon は cwd 非共有でも開ける)。
 */
const toUri = (source: string): string =>
  source.startsWith("s3://") ? source : pathToFileURL(resolve(source)).href;

const parseProfile = (raw: string): ProfileSelector => {
  const selector = parseProfileSelector(raw);
  if (selector !== null) return selector;
  throw new InvalidArgumentError(
    `Unknown profile "${raw}". Valid: ${ALL_PROFILES.join(", ")}, optionally @<x.y.z>.`,
  );
};

const program = new Command();
program
  .name("wacz-validator")
  .description("Interactive TUI for WACZ validation (use wacz-validator-validate for JSON output)")
  .version(`${manifest.version} (${BUILD_INFO.gitSha})`)
  .argument("<source>", "Local path or s3://bucket/key URI of the .wacz to validate")
  .option(
    "--profile <name>",
    `Rule profile (${ALL_PROFILES.join(" | ")}), optionally @<x.y.z> for a producer version ` +
      `(e.g. browserhive@2.1.0). Defaults to "${DEFAULT_PROFILE}".`,
    parseProfile,
    DEFAULT_SELECTOR,
  )
  .option(
    "--s3-force-path-style",
    "Force path-style S3 addressing for bundled SeaweedFS / MinIO 等 (also via WACZ_VALIDATOR_S3_FORCE_PATH_STYLE=true)",
    envS3ForcePathStyle,
  )
  .option(
    "--lang <locale>",
    `Message language (${SUPPORTED_LOCALES.join(" | ")}). Defaults to LANG / en.`,
  )
  .option(
    "--server <url>",
    "Connect to a running wacz-validator-daemon (e.g. ws://127.0.0.1:7333) instead of spawning one",
    (raw: string) => ServerEndpoint.parse(raw),
  )
  .action(async (filePath: string, options: CliOptions) => {
    // wacz-validator は対話 TUI 専用。非 TTY(パイプ / CI 等)では描画できないので、daemon を
    // 起動する前に fail-fast し、非対話・機械可読な出力は wacz-validator-validate に委ねる。
    if (!process.stdout.isTTY || !process.stdin.isTTY) {
      process.stderr.write(
        "wacz-validator: interactive TUI only. Use wacz-validator-validate for non-interactive or machine-readable output.\n",
      );
      process.exitCode = 2;
      return;
    }
    const uri = toUri(filePath);
    let session: DaemonSession | undefined;
    try {
      session =
        options.server !== undefined
          ? DaemonSession.attach(options.server)
          : await DaemonSession.spawn();
      const client = await connect(session.endpoint);
      try {
        // 起動直後に daemon のバージョンを問い合わせる。tui 自身のバージョン(BUILD_INFO)と
        // 突き合わせ、Header で SHA を出し・不一致(古いプロセス)を警告する。
        const health = await client.request<HealthStatus>("wacz-validator/ping", {});
        const build: BuildInfo = {
          tui: { version: BUILD_INFO.version, gitSha: BUILD_INFO.gitSha },
          daemon: { version: health.version, gitSha: health.gitSha },
        };
        const outcome = await validateOnce(client, uri, filePath, options);
        await dispatch(outcome, bridgeFor(client, uri), build);
        // session は finally で release し(spawn 時は kill + exit 待ち)、その後に
        // process が終わる(exitCode を確定後に child が残らないようにするため)。
        process.exitCode = exitCodeFor(outcome);
      } finally {
        client.close();
      }
    } catch (cause) {
      // spawn / 接続 / 想定外の失敗 → operational failure。
      process.stderr.write(`wacz-validator: ${describeCause(cause)}\n`);
      process.exitCode = 2;
    } finally {
      await session?.release();
    }
  });

await program.parseAsync(process.argv);

/** WS で validate し、WireReport を CliOutcome に map する(RpcError は分類)。 */
async function validateOnce(
  client: DaemonClient,
  uri: string,
  filePath: string,
  opts: CliOptions,
): Promise<CliOutcome<WireReport>> {
  try {
    const report = await client.request<WireReport>("wacz-validator/validate", {
      source: { kind: "uri", uri },
      profile: formatProfileSelector(opts.profile),
      locale: opts.lang ?? "",
      ...(opts.s3ForcePathStyle && { s3ForcePathStyle: true }),
    });
    // `error` が 1 件も無ければ valid。派生値を report に持たせると summary と
    // ずれる余地ができるので、必要な側でその都度導く。
    return report.summary.failed === 0
      ? { kind: "valid", report }
      : { kind: "invalid", report };
  } catch (cause) {
    if (cause instanceof RpcCallError && cause.code === "openFailed") {
      return { kind: "openFailed", filePath, cause };
    }
    if (cause instanceof RpcCallError && cause.code === "engineFailed") {
      return { kind: "engineFailed" };
    }
    throw cause; // 想定外(接続切れ等)→ action の catch で exit 2
  }
}

/** outcome に従って TUI / stderr を発火する。TUI には窓の橋とバージョン情報を渡す。 */
async function dispatch(
  outcome: CliOutcome<WireReport>,
  bridge: ContentBridge,
  build: BuildInfo,
): Promise<void> {
  switch (outcome.kind) {
    case "valid":
    case "invalid":
      await runTui(outcome.report, bridge, build);
      return;
    case "openFailed": {
      // **ここでは `describeCause` を通さない。** ここに来る cause は
      // `RpcCallError` で、その `message` は daemon が `describeCause` で作った
      // 説明そのもの。もう一度通すと `RpcCallError` という name が前に付いて
      // `RpcCallError: NotFound (HTTP 404)` になる。整形は wire に載せる側の
      // 責務で、こちらは運ばれてきた文をそのまま出す。
      const message =
        outcome.cause instanceof RpcCallError
          ? outcome.cause.message
          : describeCause(outcome.cause);
      process.stderr.write(`wacz-validator: cannot open "${outcome.filePath}": ${message}\n`);
      return;
    }
    case "engineFailed":
      return;
  }
}

async function runTui(
  report: WireReport,
  bridge: ContentBridge,
  build: BuildInfo,
): Promise<void> {
  const [{ render }, { createElement }, { App }] = await Promise.all([
    import("ink"),
    import("react"),
    import("./app.js"),
  ]);
  const instance = render(createElement(App, { report, bridge, build }));
  await instance.waitUntilExit();
}
