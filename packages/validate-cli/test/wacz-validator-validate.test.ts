// @module-tag cli
/**
 * CLI integration テスト。
 *
 * 生成された fixture に対してビルド済みの `dist/wacz-validator-validate.js` を spawn し、
 * 以下を assert する:
 *   - exit code     — valid なら 0、invalid なら 1、operational な失敗なら 2
 *   - JSON shape    — snapshot ベース。非決定的な field は scrub する
 *
 * CLI module を直接 import するのではなく spawn にしている理由:
 * shebang / bin script の配線 (`#!/usr/bin/env node`、`chmod +x`、
 * `package.json#bin`) を含めて end-to-end に検証したいため。これは
 * CI の pack-smoke ワークフローと同じ assertion を走らせていて、
 * ここで失敗すれば同じ根本原因を指してくれる。in-process import
 * では module 副作用 (commander の `parseAsync`、`process.exitCode`
 * 経由の終了) が test runner と相互作用するのも避けたい。
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// fixture generator は core の test/ に居る (core の 12 test が共有して
// いるので複製しない)。package 境界をまたぐ相対 import で、ambient な
// archiver shim は tsconfig.json の include が拾う。
import { buildWacz, type FixtureOptions } from "../../core/test/fixtures/generator.js";
import { BUILD_INFO } from "../src/generated/build-info.js";

const execFileAsync = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = resolve(HERE, "..", "dist", "wacz-validator-validate.js");

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * ビルド済み CLI を実行する。`dist/wacz-validator-validate.js` は `node` 経由で起動して
 * いるので、この test の session で chmod が走っているかどうかに
 * 依存しない (test スイートが test 走行前に `pnpm build` 自体を
 * 駆動する)。
 */
const runCli = async (args: string[]): Promise<RunResult> => {
  // snapshot を locale 非依存にするため、メッセージ言語を en に固定する
  // (マシンの LANG が ja でも JSON 出力が決定的になる)。
  const env = { ...process.env, WACZ_VALIDATOR_LANG: "en" };
  try {
    const { stdout, stderr } = await execFileAsync("node", [CLI_PATH, ...args], { env });
    return { stdout, stderr, code: 0 };
  } catch (e) {
    // execFile は非ゼロ exit で reject する。reject 値は `code`、
    // `stdout`、`stderr` を持つ — TS では `Error & {...}` 型として扱う。
    const err = e as Error & { code?: number; stdout?: string; stderr?: string };
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      code: err.code ?? -1,
    };
  }
};

const writeFixture = async (
  tmpDir: string,
  filename: string,
  options: FixtureOptions = {},
): Promise<string> => {
  const { bytes } = await buildWacz(options);
  const path = join(tmpDir, filename);
  await writeFile(path, bytes);
  return path;
};

/**
 * JSON 出力には絶対ファイルパスと elapsed-ms duration が含まれる —
 * どちらもマシンや実行ごとに変わるので snapshot が脆くなる。安定した
 * placeholder に置換してから snapshot を取る。
 *
 * `validatorVersion` も checkout で変わる (タグからの隔たり、未コミットの変更、
 * CI の浅い clone では `unknown`)。何を名乗るべきかは「cli — 版」が見る。
 */
const stabiliseJson = (text: string): unknown => {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  parsed["validatorVersion"] = "<version>";
  const source = parsed["source"] as
    | { kind?: string; path?: string; uri?: string }
    | undefined;
  if (source?.kind === "file" && typeof source.path === "string") {
    source.path = "<tmp>/fixture.wacz";
  }
  const summary = parsed["summary"] as Record<string, unknown> | undefined;
  if (summary && typeof summary["durationMs"] === "number") {
    summary["durationMs"] = 0;
  }
  return parsed;
};

describe("cli — exit codes", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "wacz-validator-cli-test-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("valid WACZ → exit 0", async () => {
    const path = await writeFixture(tmpDir, "good.wacz");
    const result = await runCli([path]);
    expect(result.code).toBe(0);
  });

  it("missing profile → exit 1", async () => {
    const path = await writeFixture(tmpDir, "no-profile.wacz", { profile: null });
    const result = await runCli([path]);
    expect(result.code).toBe(1);
  });

  it("non-existent file → exit 2 (operational failure)", async () => {
    const result = await runCli([join(tmpDir, "does-not-exist.wacz")]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("cannot open");
    // `describeCause` は fs のエラーを素通しする(message にすべて書いてあり、
    // 触ると悪化する)。ここが `Error:` などで飾られ始めたら退行。
    expect(result.stderr).toContain("ENOENT");
    expect(result.stderr).not.toContain("HTTP");
  });
});

describe("cli — 版", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "wacz-validator-cli-test-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // 2026-09-26 まで、報告の validatorVersion も --version も package.json の "0.0.0" を
  // 名乗っていた。この repo の版はタグにしか無いので、どの build でも "0.0.0" だった。
  it("報告の validatorVersion と --version は、build したときにタグから決めた版を名乗る", async () => {
    const path = await writeFixture(tmpDir, "good.wacz");
    const report = JSON.parse((await runCli([path])).stdout) as { validatorVersion: string };
    const named = (await runCli(["--version"])).stdout.trim();
    expect(report.validatorVersion).toBe(BUILD_INFO.version);
    expect(named).toBe(BUILD_INFO.version);
  });
});

describe("cli — JSON output shape (default)", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "wacz-validator-cli-test-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("valid WACZ JSON snapshot", async () => {
    const path = await writeFixture(tmpDir, "good.wacz");
    const result = await runCli([path]);
    expect(result.code).toBe(0);
    expect(stabiliseJson(result.stdout)).toMatchSnapshot();
  });

  it("missing-profile JSON snapshot", async () => {
    const path = await writeFixture(tmpDir, "no-profile.wacz", { profile: null });
    const result = await runCli([path]);
    expect(result.code).toBe(1);
    expect(stabiliseJson(result.stdout)).toMatchSnapshot();
  });

  it("--lang ja localises issue messages (key/params stable)", async () => {
    const path = await writeFixture(tmpDir, "ja.wacz", { omitPages: true });
    const ja = await runCli([path, "--lang", "ja"]);
    // messageKey/params は locale 非依存、message だけ訳される。
    expect(ja.stdout).toContain('"messageKey": "wacz/required-files.missing-pages"');
    expect(ja.stdout).toContain("pages/pages.jsonl がありません");
    const en = await runCli([path, "--lang", "en"]);
    expect(en.stdout).toContain("pages/pages.jsonl is missing");
  });

  it("section を持つ issue は specUrl を同梱する(locale 非依存)", async () => {
    const path = await writeFixture(tmpDir, "spec.wacz", { omitArchive: true });
    const out = await runCli([path]).then((r) => r.stdout);
    expect(out).toContain('"section": "5.2.1"');
    expect(out).toContain('"specUrl": "https://specs.webrecorder.net/wacz/1.1.1/#archive"');
  });

  it("gzipped CDXJ JSON snapshot", async () => {
    const path = await writeFixture(tmpDir, "gz-cdxj.wacz", { cdxjGzipped: true });
    const result = await runCli([path]);
    expect(result.code).toBe(1);
    expect(stabiliseJson(result.stdout)).toMatchSnapshot();
  });
});
