// @module-tag engine
/**
 * `datapackage.json` の読み口。
 *
 * かつては 8 つの rule と 3 つの helper がそれぞれ読んでいた。この 2 件が守るのは
 * その統合が本当に効いているかで、どちらも **緑のまま完全に誤る** 形の失敗を捕まえる:
 *
 *   - キャッシュが効いていなければ、同じ zip を何度も解く（遅いだけで結果は同じ）
 *   - キャッシュが reader をまたいで共有されると、**2 つ目の WACZ の検証が
 *     1 つ目の datapackage を読む** —— 全 rule が別のアーカイブについて判定し、
 *     しかも一切赤くならない
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { datapackageOf } from "../src/validate/datapackage-source.js";
import { parseReportSource } from "../src/validate/domain.js";
import { fileTransport } from "../src/wacz/transport.js";
import { WaczReader } from "../src/wacz/reader.js";
import { buildWacz, type FixtureOptions } from "./fixtures/generator.js";

describe("datapackageOf", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "wacz-validator-dpsource-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const openFixture = async (
    name: string,
    options: FixtureOptions = {},
  ): Promise<WaczReader> => {
    const { bytes } = await buildWacz(options);
    const path = join(tmpDir, `${name}.wacz`);
    await writeFile(path, bytes);
    const source = parseReportSource(path);
    if (!source.ok || source.value.kind !== "file") throw new Error("unreachable");
    return WaczReader.open(fileTransport(source.value.path));
  };

  it("bytes と parsed の両方を返す", async () => {
    const reader = await openFixture("a");
    try {
      const { bytes, parsed } = await datapackageOf(reader);
      expect(bytes).toBeInstanceOf(Buffer);
      // digest rule はバイト列そのものを要る。
      expect(bytes?.toString("utf-8")).toContain("resources");
      expect(parsed?.resources).toBeInstanceOf(Array);
    } finally {
      await reader.close();
    }
  });

  // **この段の要。** 効いていなければ 11 か所を寄せた意味の半分が消える。
  it("同じ reader では zip を 1 度しか読まない", async () => {
    const reader = await openFixture("a");
    try {
      const spy = vi.spyOn(reader, "readEntry");
      await Promise.all([
        datapackageOf(reader),
        datapackageOf(reader),
        datapackageOf(reader),
      ]);
      await datapackageOf(reader);
      const dpReads = spy.mock.calls.filter((c) => c[0] === "datapackage.json");
      expect(dpReads).toHaveLength(1);
    } finally {
      await reader.close();
    }
  });

  // **いちばん危ない失敗。** reader をまたいで共有すると、2 つ目の WACZ の検証が
  // 1 つ目の datapackage について判定する —— 全 rule が緑のまま誤る。
  it("reader が違えば別の値を返す", async () => {
    const a = await openFixture("a", { pageUrl: "https://a.test/" });
    const b = await openFixture("b", { pageUrl: "https://b.test/" });
    try {
      const first = await datapackageOf(a);
      const second = await datapackageOf(b);
      expect(first.parsed?.mainPageURL).toBe("https://a.test/");
      expect(second.parsed?.mainPageURL).toBe("https://b.test/");
      expect(second.bytes).not.toEqual(first.bytes);
    } finally {
      await a.close();
      await b.close();
    }
  });
});
