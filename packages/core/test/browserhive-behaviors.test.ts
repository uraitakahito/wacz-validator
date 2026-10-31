// @module-tag engine
/**
 * `browserhive/behaviors-shape` のテスト。
 *
 * この rule が守っているのは 1 つの向きだけの主張:
 *
 *   `settings.behaviors` が **リクエスト由来** と述べた behavior は、すべて
 *   `behaviors/custom.jsonl` に source を持つ。
 *
 * **逆は求めない。** ここが要点で、対応する項目を持たない行が在ってよい ——
 * 持ち込まれた source は runtime のバンドルに連結され `register(<class 式>)` として
 * 評価されるので、そのあと `isMatch()` が false を返して `run()` が呼ばれなくても、
 * class 式そのものはページ上で走っている。1 対 1 を求めると、**実行されたコードを
 * 記録したアーカイブを不適合にしてしまう**。
 *
 * `behaviors/` の不在も違反ではない。behavior を注入しなかった取り込みでは
 * エントリごと無いのが正しい形。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseReportSource, type Issue, type RuleProfile } from "../src/validate/domain.js";
import { runValidation } from "../src/validate/engine.js";
import { DEFAULT_RULES } from "../src/validate/rules/index.js";
import { fileTransport } from "../src/wacz/transport.js";
import { WaczReader } from "../src/wacz/reader.js";
import { buildWacz, type FixtureOptions } from "./fixtures/generator.js";

const RULE = "browserhive/behaviors-shape";
const V86 = { major: 8, minor: 6, patch: 0 };

/** browserhive のアーカイブであることを示すだけの最小の目録。 */
const minimalInventory: Record<string, unknown> = {
  profile: "browserhive:storage/1",
  stage: "after-behaviors",
  valuesRecorded: false,
  origins: [],
};

const settingsWith = (
  behaviors: { id: string; origin: string }[],
): Record<string, unknown> => ({
  signature: "none",
  viewport: { width: 1280, height: 800 },
  devicePixelRatios: [1],
  session: "isolated",
  behaviors,
  limits: { maxResponseBytes: 20_971_520, maxTaskBytes: 209_715_200 },
  urlPolicies: [],
  contentTypePolicies: [],
});

const line = (id: string): Record<string, unknown> => ({
  profile: "browserhive:behaviors/1",
  id,
  source: `class { static id = '${id}'; }`,
});

const runFor = async (
  tmpDir: string,
  options: FixtureOptions,
  profile: RuleProfile = "browserhive",
  version: { major: number; minor: number; patch: number } = V86,
): Promise<Issue[]> => {
  const { bytes } = await buildWacz({ storage: minimalInventory, ...options });
  const path = join(tmpDir, "fixture.wacz");
  await writeFile(path, bytes);
  const source = parseReportSource(path);
  if (!source.ok || source.value.kind !== "file") throw new Error("unreachable");
  const reader = await WaczReader.open(fileTransport(source.value.path));
  try {
    const result = await runValidation(reader, {
      validatorVersion: "0.0.0",
      rules: DEFAULT_RULES,
      profile: { name: profile, version },
    });
    if (!result.ok) throw new Error("runValidation returned err — unreachable");
    return result.value.issues.filter((i) => i.rule === RULE);
  } finally {
    await reader.close();
  }
};

describe("browserhive/behaviors-shape", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "wacz-validator-behaviors-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const run = (options: FixtureOptions, version?: typeof V86): Promise<Issue[]> =>
    runFor(tmpDir, options, "browserhive", version);

  it("持ち込みを置かなかったアーカイブには何も言わない", async () => {
    expect(
      await run({ settings: settingsWith([{ id: "autoscroll", origin: "builtin" }]) }),
    ).toEqual([]);
  });

  it("申告した持ち込みに source が在れば通す", async () => {
    expect(
      await run({
        settings: settingsWith([
          { id: "autoscroll", origin: "builtin" },
          { id: "x.test:one", origin: "custom" },
        ]),
        behaviorsCustom: [line("x.test:one")],
      }),
    ).toEqual([]);
  });

  /**
   * **これがこの rule の存在理由。** source はリクエストと共に届いたもので、
   * 応答を捨てた時点で他のどこからも取り出せない。settings が「リクエスト由来の
   * コードが走った」と述べながら中身を持たないアーカイブは、辿れない主張をしている。
   */
  it("申告した持ち込みの source が無ければ落とす", async () => {
    const issues = await run({
      settings: settingsWith([{ id: "x.test:one", origin: "custom" }]),
      behaviorsCustom: [line("y.test:two")],
    });
    expect(issues.map((i) => i.messageKey)).toEqual([`${RULE}.source-missing`]);
    expect(issues[0]?.params?.["id"]).toBe("x.test:one");
  });

  it("エントリごと無ければ、申告のぶんだけ落とす", async () => {
    const issues = await run({
      settings: settingsWith([{ id: "x.test:one", origin: "custom" }]),
    });
    expect(issues.map((i) => i.messageKey)).toEqual([`${RULE}.missing-entry`]);
  });

  /**
   * **逆は求めない。** 対応する項目を持たない行は正しい ——
   * ページに置かれ、`isMatch()` が断り、`run()` は呼ばれなかった behavior。
   * class 式そのものは走っているので、記録するのが正しい。
   *
   * `browserhive-behaviors-shape.ts` に「present の各 id が declared に在ること」を
   * 足すと、ここが赤くなる。
   */
  it("走らなかった持ち込みの行だけが在っても通す", async () => {
    expect(
      await run({
        settings: settingsWith([{ id: "autoscroll", origin: "builtin" }]),
        behaviorsCustom: [line("never-matched:one")],
      }),
    ).toEqual([]);
  });

  it("JSON として読めない行を落とす", async () => {
    const issues = await run({
      settings: settingsWith([]),
      behaviorsCustom: "not json at all\n",
    });
    expect(issues.map((i) => i.messageKey)).toEqual([`${RULE}.not-json`]);
  });

  /**
   * 版が違えば、下の member 検査は別の規則を当てていることになる。
   * 判断の材料が無いので打ち切る —— member 不足としては報告しない。
   */
  it("知らない版を名乗る行は、そこで打ち切る", async () => {
    const issues = await run({
      settings: settingsWith([]),
      behaviorsCustom: [{ profile: "browserhive:behaviors/9", id: "a" }],
    });
    expect(issues.map((i) => i.messageKey)).toEqual([`${RULE}.unknown-profile`]);
  });

  it.each(["profile", "id", "source"])("必須 member %s を落としたら落とす", async (member) => {
    const full = line("x.test:one");
    const partial = Object.fromEntries(Object.entries(full).filter(([k]) => k !== member));
    const issues = await run({ settings: settingsWith([]), behaviorsCustom: [partial] });
    // profile を落とした行は unknown-profile で打ち切る。それ以外は member 不足。
    expect(issues.map((i) => i.messageKey)).toContain(
      member === "profile" ? `${RULE}.unknown-profile` : `${RULE}.missing-member`,
    );
  });

  /**
   * 版の下限。`behaviors/` は browserhive 8.6.0 で入ったので、それ未満の
   * アーカイブに 1.5.0 の MUST を当てて落とすのは検証器として誤り。
   */
  it("8.6.0 未満のアーカイブには当てない", async () => {
    const broken: FixtureOptions = {
      settings: settingsWith([{ id: "x.test:one", origin: "custom" }]),
    };
    // 8.6.0 なら落ちる形であることを先に確かめる。落ちない形で版だけ下げても、
    // 「見ていない」と「問題なし」が区別できない。
    expect((await run(broken)).length).toBeGreaterThan(0);
    expect(await run(broken, { major: 8, minor: 5, patch: 0 })).toEqual([]);
  });
});
