// @module-tag engine
/**
 * `browserhive/policy-not-truncated` のテスト。
 *
 * 守っている主張は 1 つ: 方針 (`urlPolicies` の `no-body`、`contentTypePolicies`) で省いた
 * 本文を、上限で落とした本文として `completeness.truncatedUrls` に載せない (profile 1.9.0 の
 * MUST NOT)。BrowserHive は 12.2.0 より前、上限を超える大きさの本文でこれを取り違えていた。
 *
 * 照合の規則 (URL の方針は最初に当たったものだけが効く、content-type は CDXJ の `mime` の
 * 前方一致で大文字と小文字を区別する、2 つとも当たれば URL の方針が理由になる) は、1 つずつ
 * 別の入力で反証できるように置く。規則を 1 つ崩した実装は、そのうちのどれかで赤になる。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProfileSelector } from "@wacz-validator/contract";
import {
  parseReportSource,
  type Issue,
  type Report,
  type RuleProfile,
  type SkippedRule,
} from "../src/validate/domain.js";
import { runValidation } from "../src/validate/engine.js";
import { DEFAULT_RULES } from "../src/validate/rules/index.js";
import { fileTransport } from "../src/wacz/transport.js";
import { WaczReader } from "../src/wacz/reader.js";
import { buildWacz, type FixtureOptions } from "./fixtures/generator.js";

const RULE = "browserhive/policy-not-truncated";
const V12_2 = { major: 12, minor: 2, patch: 0 };

const VIDEO = "https://example.com/big/video.mp4";
const IMAGE = "https://example.com/big/photo.jpg";

/** 方針だけを差し替えた settings。他の member は形の rule の担当なので、最小で済ませる。 */
const settingsWith = (policies: {
  urlPolicies?: { pattern: string; action: string }[];
  contentTypePolicies?: { prefix: string; action: string }[];
}): Record<string, unknown> => ({
  signature: "none",
  viewport: { width: 1280, height: 800 },
  devicePixelRatios: [1],
  session: "isolated",
  behaviors: [],
  limits: { maxResponseBytes: 1000, maxTaskBytes: 100_000 },
  urlPolicies: policies.urlPolicies ?? [],
  contentTypePolicies: policies.contentTypePolicies ?? [],
});

/** `urls` を上限で落とした本文として載せた completeness。 */
const truncatedAs = (...urls: string[]): Record<string, unknown> => ({
  bodylessUrls: [],
  truncatedUrls: urls,
  complete: urls.length === 0,
});

/** 動画と画像の応答を 1 つずつ記録した archive。どちらも本文は空 (方針か上限で省いた形)。 */
const archive = (over: FixtureOptions): FixtureOptions => ({
  warcResponses: [
    { uri: VIDEO, mime: "video/mp4", body: "" },
    { uri: IMAGE, mime: "image/jpeg", body: "" },
  ],
  ...over,
});

/** fixture を 1 本作り、指定の selector で検査した report を返す。 */
const reportFor = async (
  tmpDir: string,
  options: FixtureOptions,
  selector: ProfileSelector,
): Promise<Report> => {
  const { bytes } = await buildWacz(options);
  const path = join(tmpDir, "fixture.wacz");
  await writeFile(path, bytes);
  const source = parseReportSource(path);
  if (!source.ok || source.value.kind !== "file") throw new Error("unreachable");
  const reader = await WaczReader.open(fileTransport(source.value.path));
  try {
    const result = await runValidation(reader, {
      validatorVersion: "0.0.0",
      rules: DEFAULT_RULES,
      profile: selector,
    });
    if (!result.ok) throw new Error("runValidation returned err — unreachable");
    return result.value;
  } finally {
    await reader.close();
  }
};

describe("browserhive/policy-not-truncated", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "wacz-validator-policy-truncated-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const run = async (options: FixtureOptions, profile: RuleProfile = "browserhive"): Promise<Issue[]> =>
    (await reportFor(tmpDir, options, { name: profile, version: V12_2 })).issues.filter(
      (i) => i.rule === RULE,
    );

  it("URL の no-body で省いた本文が truncatedUrls に載っていれば、error で落とす", async () => {
    // 12.2.0 より前の BrowserHive が書いていた形。上限を超える大きさの動画を URL の方針で省いたのに、
    // 上限で落としたものとして載せていた。
    const issues = await run(
      archive({
        settings: settingsWith({ urlPolicies: [{ pattern: "*.mp4", action: "no-body" }] }),
        completeness: truncatedAs(VIDEO),
      }),
    );
    expect(issues).toEqual([
      {
        rule: RULE,
        severity: "error",
        messageKey: `${RULE}.url-policy`,
        params: { url: VIDEO, pattern: "*.mp4" },
        location: { entry: "datapackage.json" },
      },
    ]);
  });

  it("content-type の方針で省いた本文が truncatedUrls に載っていれば、error で落とす", async () => {
    const issues = await run(
      archive({
        settings: settingsWith({ contentTypePolicies: [{ prefix: "video/", action: "no-body" }] }),
        completeness: truncatedAs(VIDEO),
      }),
    );
    expect(issues).toEqual([
      {
        rule: RULE,
        severity: "error",
        messageKey: `${RULE}.content-type`,
        params: { url: VIDEO, prefix: "video/" },
        location: { entry: "datapackage.json" },
      },
    ]);
  });

  it("方針に当たらない URL は本当に上限で落とした本文なので、載っていても何も言わない", async () => {
    // 方針は動画にだけ当たる。画像は上限で落としたもので、truncatedUrls に載るのが正しい。
    const issues = await run(
      archive({
        settings: settingsWith({
          urlPolicies: [{ pattern: "*.mp4", action: "no-body" }],
          contentTypePolicies: [{ prefix: "video/", action: "no-body" }],
        }),
        completeness: truncatedAs(IMAGE),
      }),
    );
    expect(issues).toEqual([]);
  });

  it("方針で省いた本文が truncatedUrls に無ければ (直った後の archive)、何も言わない", async () => {
    const issues = await run(
      archive({
        settings: settingsWith({ urlPolicies: [{ pattern: "*.mp4", action: "no-body" }] }),
        completeness: truncatedAs(),
      }),
    );
    expect(issues).toEqual([]);
  });

  it("URL の方針は最初に当たったものだけが効く", async () => {
    // 先に deny が当たる URL は要求ごと送られず、後ろの no-body は効かない。どれか 1 つでも
    // no-body に当たれば落とす実装は、ここで赤になる。
    const issues = await run(
      archive({
        settings: settingsWith({
          urlPolicies: [
            { pattern: "https://example.com/big/*", action: "deny" },
            { pattern: "*.mp4", action: "no-body" },
          ],
        }),
        completeness: truncatedAs(VIDEO),
      }),
    );
    expect(issues).toEqual([]);
  });

  it("URL の glob のワイルドカードは * だけで、URL 全体に当てる", async () => {
    // 1 本目は末尾が足りず、URL 全体には当たらない (部分一致で当てる実装はここで赤)。
    // 2 本目の `..` は文字どおりの 2 文字で、`video.mp4` の `o.` には当たらない (`.` を
    // 任意の 1 文字として効かせる実装はここで赤)。
    const issues = await run(
      archive({
        settings: settingsWith({
          urlPolicies: [
            { pattern: "https://example.com/big/video.mp", action: "no-body" },
            { pattern: "https://example.com/big/vide..mp4", action: "no-body" },
          ],
        }),
        completeness: truncatedAs(VIDEO),
      }),
    );
    expect(issues).toEqual([]);
  });

  it("content-type の前方一致は大文字と小文字を区別する", async () => {
    const issues = await run(
      archive({
        settings: settingsWith({ contentTypePolicies: [{ prefix: "Video/", action: "no-body" }] }),
        completeness: truncatedAs(VIDEO),
      }),
    );
    expect(issues).toEqual([]);
  });

  it("content-type は CDXJ の mime で照らす (URL の見た目では照らさない)", async () => {
    // 画像の URL に video/ の型は無い。URL の拡張子や文字列から型を推す実装は、ここで赤になる。
    const issues = await run(
      archive({
        settings: settingsWith({ contentTypePolicies: [{ prefix: "video/", action: "no-body" }] }),
        completeness: truncatedAs(IMAGE),
      }),
    );
    expect(issues).toEqual([]);
  });

  it("URL と content-type の両方に当たれば、先に決まる URL の方針を理由にして 1 件だけ出す", async () => {
    const issues = await run(
      archive({
        settings: settingsWith({
          urlPolicies: [{ pattern: "*.mp4", action: "no-body" }],
          contentTypePolicies: [{ prefix: "video/", action: "no-body" }],
        }),
        completeness: truncatedAs(VIDEO),
      }),
    );
    expect(issues.map((i) => i.messageKey)).toEqual([`${RULE}.url-policy`]);
  });

  it("spec / lenient profile では走らない", async () => {
    for (const profile of ["spec", "lenient"] as const) {
      const issues = await run(
        archive({
          settings: settingsWith({ urlPolicies: [{ pattern: "*.mp4", action: "no-body" }] }),
          completeness: truncatedAs(VIDEO),
        }),
        profile,
      );
      expect(issues).toEqual([]);
    }
  });
});

describe("browserhive/policy-not-truncated — producer の版の条件", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "wacz-validator-policy-truncated-version-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** 取り違えた archive を、指定の selector で検査する。 */
  const reportForBroken = (selector: ProfileSelector): Promise<Report> =>
    reportFor(
      tmpDir,
      archive({
        settings: settingsWith({ urlPolicies: [{ pattern: "*.mp4", action: "no-body" }] }),
        completeness: truncatedAs(VIDEO),
      }),
      selector,
    );

  /** この rule が落とされたかだけを見る。版の条件を持つ rule が増えても、ここは壊れない。 */
  const skippedHere = (report: Report): SkippedRule | undefined =>
    report.skipped?.find((s) => s.rule === RULE);

  it("12.2.0 より前の版では走らず、落としたことが report に残る", async () => {
    const report = await reportForBroken({
      name: "browserhive",
      version: { major: 12, minor: 1, patch: 0 },
    });
    expect(report.issues.some((i) => i.rule === RULE)).toBe(false);
    expect(skippedHere(report)).toEqual({ rule: RULE, reason: "profile-version", range: ">=12.2.0" });
  });

  it("12.2.0 そのものは範囲内", async () => {
    const report = await reportForBroken({ name: "browserhive", version: V12_2 });
    expect(skippedHere(report)).toBeUndefined();
    expect(report.issues.some((i) => i.rule === RULE)).toBe(true);
  });

  it("版を名乗らなければ走る —— 古い archive の取り違えを洗い出すのに使える", async () => {
    const report = await reportForBroken({ name: "browserhive" });
    expect(skippedHere(report)).toBeUndefined();
    expect(report.issues.some((i) => i.rule === RULE)).toBe(true);
  });
});
