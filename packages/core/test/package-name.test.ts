// @module-tag engine
/**
 * WACZ の名前を照らす 2 本の rule と、名前の読み方 (`packageNameOf`) のテスト。
 *
 *   - `wacz/file-extension`: WACZ 1.1.1 の Zip Format File Extension (MUST)。名前が `.wacz` で終わる。
 *     どの profile でも走り、warning (lenient では info)
 *   - `browserhive/wacz-name`: BrowserHive WACZ Profile 1.25.0 の Package name (SHOULD)。1.25.0 以上を名乗る
 *     archive の名前が `.browserhive.wacz` で終わる。browserhive profile だけで走る
 *
 * 名前は `WaczReader.source` の最後の段。最後の段に `.` の無い http の URL は名前が分からないので、どちらも
 * 何も言わない。http の source は、手元のファイルを開いた reader の `source` だけを差し替えて作る (rule は名前を
 * source からしか読まない)。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProfileSelector } from "@wacz-validator/contract";
import {
  parseReportSource,
  type AbsolutePath,
  type HttpUrl,
  type Issue,
  type ReportSource,
  type S3Uri,
} from "../src/validate/domain.js";
import { runValidation } from "../src/validate/engine.js";
import { packageNameOf } from "../src/validate/package-name.js";
import { DEFAULT_RULES } from "../src/validate/rules/index.js";
import { fileTransport } from "../src/wacz/transport.js";
import { WaczReader } from "../src/wacz/reader.js";
import { buildWacz, type FixtureOptions } from "./fixtures/generator.js";

const EXTENSION = "wacz/file-extension";
const MARK = "browserhive/wacz-name";
const NAME_RULES = new Set([EXTENSION, MARK]);
const profileUrl = (version: string): string =>
  `https://uraitakahito.github.io/browserhive-specs/wacz-profile/${version}/`;

/** 名乗る版だけを決めた BrowserHive WACZ。名前の rule は中身を名乗りしか見ない。 */
const declaring = (version: string): FixtureOptions => ({ software: "browserhive/31.0.0", conformsTo: profileUrl(version) });

const http = (url: string): ReportSource => ({ kind: "http", url: url as HttpUrl });

describe("packageNameOf", () => {
  it("file はパスの、s3 は鍵の最後の段", () => {
    expect(packageNameOf({ kind: "file", path: "/tmp/a/x.browserhive.wacz" as AbsolutePath })).toBe("x.browserhive.wacz");
    expect(packageNameOf({ kind: "file", path: "/tmp/a/x" as AbsolutePath })).toBe("x");
    expect(packageNameOf({ kind: "s3", uri: "s3://bucket/dir/x.zip" as S3Uri })).toBe("x.zip");
  });

  it("http は URL のパスの最後の段。`.` が無ければ名前が分からない", () => {
    expect(packageNameOf(http("https://host.test/dir/x.wacz"))).toBe("x.wacz");
    expect(packageNameOf(http("https://host.test/captures/42"))).toBeUndefined();
    expect(packageNameOf(http("https://host.test/dir/"))).toBeUndefined();
  });
});

describe("名前の rule", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "wacz-validator-package-name-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /**
   * `name` の名で書いた WACZ を検証し、名前の rule の指摘だけを返す。`source` を渡せば、開いた reader の
   * `source` をそれに差し替える。
   */
  const run = async (
    options: FixtureOptions,
    name: string,
    selector: ProfileSelector,
    source?: ReportSource,
  ): Promise<Issue[]> => {
    const { bytes } = await buildWacz(options);
    const path = join(tmpDir, name);
    await writeFile(path, bytes);
    const parsed = parseReportSource(path);
    if (!parsed.ok || parsed.value.kind !== "file") throw new Error("unreachable");
    const reader = await WaczReader.open(fileTransport(parsed.value.path));
    const subject: WaczReader =
      source === undefined ? reader : (Object.create(reader, { source: { value: source } }) as WaczReader);
    try {
      const result = await runValidation(subject, { validatorVersion: "0.0.0", rules: DEFAULT_RULES, profile: selector });
      if (!result.ok) throw new Error("runValidation returned err — unreachable");
      return result.value.issues.filter((i) => NAME_RULES.has(i.rule));
    } finally {
      await reader.close();
    }
  };

  const extension = (name: string, severity: Issue["severity"] = "warning"): Issue => ({
    rule: EXTENSION,
    severity,
    messageKey: `${EXTENSION}.extension`,
    params: { name },
  });
  const mark = (name: string): Issue => ({ rule: MARK, severity: "warning", messageKey: `${MARK}.name`, params: { name } });

  describe("wacz/file-extension", () => {
    it(".wacz で終わる名前には何も言わない（印の有無を問わない）", async () => {
      expect(await run({}, "x.wacz", { name: "spec" })).toEqual([]);
      expect(await run({}, "x.browserhive.wacz", { name: "spec" })).toEqual([]);
    });

    it(".wacz で終わらない名前は、どの profile でも言う —— spec と browserhive は warning、lenient は info", async () => {
      expect(await run({}, "x.zip", { name: "spec" })).toEqual([extension("x.zip")]);
      expect(await run({}, "x.zip", { name: "lenient" })).toEqual([extension("x.zip", "info")]);
      const issues = await run(declaring("1.24.0"), "x.zip", { name: "browserhive" });
      expect(issues).toEqual([extension("x.zip")]);
    });

    it("最後の段に . の無い http の URL は、名前が分からないので見ない", async () => {
      expect(await run({}, "x.zip", { name: "spec" }, http("https://host.test/captures/42"))).toEqual([]);
      expect(await run({}, "x.zip", { name: "spec" }, http("https://host.test/dir/x.zip"))).toEqual([extension("x.zip")]);
    });
  });

  describe("browserhive/wacz-name", () => {
    it("1.25.0 を名乗る archive の名前が .browserhive.wacz で終わらなければ、warning", async () => {
      expect(await run(declaring("1.25.0"), "x.wacz", { name: "browserhive" })).toEqual([mark("x.wacz")]);
      expect(await run(declaring("1.26.0"), "x.wacz", { name: "browserhive" })).toEqual([mark("x.wacz")]);
    });

    it("1.25.0 を名乗り .browserhive.wacz で終わる名前には、何も言わない", async () => {
      expect(await run(declaring("1.25.0"), "x.browserhive.wacz", { name: "browserhive" })).toEqual([]);
    });

    it("1.24.0 を名乗る x.wacz には何も言わない —— 印は 1.25.0 から、古い WACZ は改名しない", async () => {
      expect(await run(declaring("1.24.0"), "x.wacz", { name: "browserhive" })).toEqual([]);
    });

    it("名乗りの無い WACZ と、spec・lenient の profile には当てない", async () => {
      expect(await run({}, "x.wacz", { name: "browserhive" })).toEqual([]);
      expect(await run(declaring("1.25.0"), "x.wacz", { name: "spec" })).toEqual([]);
      expect(await run(declaring("1.25.0"), "x.wacz", { name: "lenient" })).toEqual([]);
    });

    it("名前が .wacz で終わらなければ、wacz/file-extension と並んで、印の無いことも言う", async () => {
      expect(await run(declaring("1.25.0"), "x.zip", { name: "browserhive" })).toEqual([extension("x.zip"), mark("x.zip")]);
    });

    it("最後の段に . の無い http の URL は、名前が分からないので見ない", async () => {
      const source = http("https://host.test/captures/42");
      expect(await run(declaring("1.25.0"), "x.wacz", { name: "browserhive" }, source)).toEqual([]);
    });
  });
});
