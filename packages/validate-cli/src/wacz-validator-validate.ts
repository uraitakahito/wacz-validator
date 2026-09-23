#!/usr/bin/env node
/**
 * `wacz-validator-validate` — validation engine の CLI。
 *
 * machine-readable な出力のみ
 *
 * この package が持つのは引数の解釈と出力の発火だけで、validation は
 * `@wacz-validator/core` が全部やる。
 *
 * Exit codes:
 *   0 — validation 成功 (error 重大度の issue なし)
 *   1 — validation 失敗 (error 重大度の issue が 1 件以上)
 *   2 — operational な失敗 (ファイルが開けない等)
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, InvalidArgumentError } from "commander";
import {
  DEFAULT_RULES,
  fileTransport,
  formatParseSourceError,
  parseReportSource,
  renderJson,
  resolveLocale,
  runValidation,
  httpTransport,
  s3Transport,
  SUPPORTED_LOCALES,
  WaczReader,
  type Locale,
  type Report,
  type ReportSource,
} from "@wacz-validator/core";
import {
  ALL_PROFILES,
  DEFAULT_PROFILE,
  DEFAULT_SELECTOR,
  describeCause,
  exitCodeFor,
  parseProfileSelector,
  type CliOutcome,
  type ProfileSelector,
} from "@wacz-validator/contract";

const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(here, "..", "package.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as { version: string };

const envS3ForcePathStyle = process.env["WACZ_VALIDATOR_S3_FORCE_PATH_STYLE"] === "true";

interface CliOptions {
  profile: ProfileSelector;
  s3ForcePathStyle: boolean;
  lang?: string;
}

const parseProfile = (raw: string): ProfileSelector => {
  const selector = parseProfileSelector(raw);
  if (selector !== null) return selector;
  throw new InvalidArgumentError(
    `Unknown profile "${raw}". Valid: ${ALL_PROFILES.join(", ")}, optionally @<x.y.z>.`,
  );
};

/**
 * **switch で書く。** ReportSource に variant が増えたとき、三項の連鎖は黙って
 * 「最後の枝」に落ちるが、switch は網羅性検査で止まる（http を足したとき、
 * ここが compile error になって見つかった）。
 */
const transportFor = (source: ReportSource, s3ForcePathStyle: boolean) => {
  switch (source.kind) {
    case "s3":
      return s3Transport({ ...source, forcePathStyle: s3ForcePathStyle });
    case "http":
      return httpTransport({ url: source.url });
    case "file":
      return fileTransport(source.path);
  }
};

const openWacz = (source: ReportSource, s3ForcePathStyle: boolean): Promise<WaczReader> =>
  WaczReader.open(transportFor(source, s3ForcePathStyle));

async function runCli(filePath: string, opts: CliOptions): Promise<CliOutcome<Report>> {
  const sourceResult = parseReportSource(filePath);
  if (!sourceResult.ok) {
    return {
      kind: "openFailed",
      filePath,
      cause: new Error(formatParseSourceError(sourceResult.error)),
    };
  }

  let reader: WaczReader;
  try {
    reader = await openWacz(sourceResult.value, opts.s3ForcePathStyle);
  } catch (cause) {
    return { kind: "openFailed", filePath, cause };
  }

  try {
    const result = await runValidation(reader, {
      validatorVersion: manifest.version,
      rules: DEFAULT_RULES,
      profile: opts.profile,
    });
    if (!result.ok) return { kind: "engineFailed" };
    const report = result.value;

    // `error` が 1 件も無ければ valid。派生値を report に持たせると summary と
    // ずれる余地ができるので、必要な側でその都度導く。
    return report.summary.failed === 0
      ? { kind: "valid", report }
      : { kind: "invalid", report };
  } finally {
    await reader.close();
  }
}

const program = new Command();
program
  .name("wacz-validator-validate")
  .description("WACZ validator — emits a machine-readable JSON report to stdout")
  .version(manifest.version)
  .argument(
    "<source>",
    "Local path or s3://bucket/key URI of the .wacz to validate",
  )
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
  .option("--lang <locale>", `Message language (${SUPPORTED_LOCALES.join(" | ")}). Defaults to LANG / en.`)
  .action(async (filePath: string, options: CliOptions) => {
    const outcome = await runCli(filePath, options);
    dispatch(outcome, resolveLocale(options.lang));
    // `process.exit(N)` ではなく `process.exitCode` をセットすることで、
    // stdout の同期 flush と `parseAsync` の Promise の clean な resolve
    // を保証しつつ、Node が event loop drain で自然終了するときに正しい
    // exit code を返す。`runCli` は `reader.close()` を `finally` で
    // await しているので、外側に lingering handle は残らない。
    //
    // 反面、event loop が drain しないと process は hang する (例: stdout
    // pipe を読まない consumer)。wacz-validator は timer / socket / watcher を
    // 持たず fd も finally で閉じるので drain 阻害経路は stdout のみで、
    // pathological consumer による hang は `process.exit(N)` に切り替え
    // ても output が truncate するだけで防げない — loud な hang の方が
    // silent truncation より望ましいので safety net は入れない。将来
    // timer / network / 子プロセスを伴う依存を足すときは
    // `setTimeout(...).unref()` 形式の hard-exit を検討する (cf.
    // `browserhive/bin/server.ts:HARD_EXIT_TIMEOUT_MS`)。
    process.exitCode = exitCodeFor(outcome);
  });

await program.parseAsync(process.argv);

/**
 * outcome に従って副作用 (stdout / stderr) を発火する。exit code は
 * 呼び出し側で `exitCodeFor` を使うので、ここでは触らない。
 *
 * `engineFailed` は `Result<Report, never>` から narrowing のためだけに
 * 生まれる variant で、論理的には到達不能。万一来たら silent (stderr
 * 出さない) のまま exit code 2 になる — 現状の挙動と同じ。
 */
function dispatch(outcome: CliOutcome<Report>, locale: Locale): void {
  switch (outcome.kind) {
    case "valid":
    case "invalid":
      process.stdout.write(renderJson(outcome.report, locale));
      return;
    case "openFailed":
      process.stderr.write(
        `wacz-validator-validate: cannot open "${outcome.filePath}": ${describeCause(outcome.cause)}\n`,
      );
      return;
    case "engineFailed":
      return;
  }
}
