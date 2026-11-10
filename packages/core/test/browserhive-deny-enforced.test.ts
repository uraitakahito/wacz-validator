// @module-tag engine
/**
 * `browserhive/deny-enforced` のテスト。
 *
 * 守っている主張は profile の `urlPolicies` の表にある「deny: Request sent — no」と、1.11.0 で
 * 足した「deny の記録は、どの部分の要求についても書く」。`deny` の当たった URL について archive が
 * 持ってよいのは、送らなかったことを言う metadata だけで、要求や応答の記録はそれを破る。
 *
 * 照合は URL 全体に当てる glob (ワイルドカードは `*` だけ、最初に当たったものだけ)。部分一致で
 * 照らす実装は「query の付いた URL」の行で赤になる —— Chrome の setBlockedURLs は前後を固定しない
 * 部分一致で、BrowserHive v17.0.0 までの部分資源の deny はそちらで止めていた。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProfileSelector } from "@wacz-validator/contract";
import { parseReportSource, type Issue, type Report, type RuleProfile } from "../src/validate/domain.js";
import { runValidation } from "../src/validate/engine.js";
import { DEFAULT_RULES } from "../src/validate/rules/index.js";
import { fileTransport } from "../src/wacz/transport.js";
import { WaczReader } from "../src/wacz/reader.js";
import { buildWacz, type FixtureOptions } from "./fixtures/generator.js";

const RULE = "browserhive/deny-enforced";
const WARC = "archive/data.warc.gz";

const TRACKER = "https://site.test/tracker.js";
/** 印付きの頁が読む画像。BrowserHive の e2e が deny の的にするのと同じ形の URL。 */
const PIXEL = "https://site.test/marked/asset/pixel.svg?from=secret&tag=t1";

/** 方針だけを差し替えた settings。他の member は形の rule の担当なので、最小で済ませる。 */
const settingsWith = (urlPolicies: { pattern: string; action: string }[]): Record<string, unknown> => ({
  signature: "none",
  viewport: { width: 1280, height: 800 },
  devicePixelRatios: [1],
  session: "isolated",
  behaviors: [],
  limits: { maxResponseBytes: 1000, maxTaskBytes: 100_000 },
  urlPolicies,
  contentTypePolicies: [],
});

const denyTracker = settingsWith([{ pattern: "*/tracker.js", action: "deny" }]);
const trackerResponse = { uri: TRACKER, mime: "text/javascript", body: "track()" };

/** この rule の error を 1 件。 */
const sent = (url: string, pattern: string, type: string): Issue => ({
  rule: RULE,
  severity: "error",
  messageKey: `${RULE}.sent`,
  params: { url, pattern, type },
  location: { entry: WARC },
});

/** fixture を 1 本作り、指定の selector で検査した report を返す。 */
const reportFor = async (tmpDir: string, options: FixtureOptions, selector: ProfileSelector): Promise<Report> => {
  const { bytes } = await buildWacz(options);
  const path = join(tmpDir, "fixture.wacz");
  await writeFile(path, bytes);
  const source = parseReportSource(path);
  if (!source.ok || source.value.kind !== "file") throw new Error("unreachable");
  const reader = await WaczReader.open(fileTransport(source.value.path));
  try {
    const result = await runValidation(reader, { validatorVersion: "0.0.0", rules: DEFAULT_RULES, profile: selector });
    if (!result.ok) throw new Error("runValidation returned err — unreachable");
    return result.value;
  } finally {
    await reader.close();
  }
};

describe("browserhive/deny-enforced", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "wacz-validator-deny-enforced-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const run = async (options: FixtureOptions, profile: RuleProfile = "browserhive"): Promise<Issue[]> =>
    (await reportFor(tmpDir, options, { name: profile })).issues.filter((i) => i.rule === RULE);

  it("deny の当たった URL に応答の記録があれば、error で落とす", async () => {
    expect(await run({ settings: denyTracker, warcResponses: [trackerResponse] })).toEqual([
      sent(TRACKER, "*/tracker.js", "response"),
    ]);
  });

  it("要求の記録だけでも落とす —— 送ったことの記録", async () => {
    expect(await run({ settings: denyTracker, warcRequests: [{ uri: TRACKER }] })).toEqual([
      sent(TRACKER, "*/tracker.js", "request"),
    ]);
  });

  it("同じ URL の要求と応答は、1 件にまとめる", async () => {
    expect(
      await run({ settings: denyTracker, warcResponses: [trackerResponse], warcRequests: [{ uri: TRACKER }] }),
    ).toEqual([sent(TRACKER, "*/tracker.js", "response")]);
  });

  it("送らなかったことを言う metadata だけなら、何も言わない", async () => {
    expect(
      await run({
        settings: denyTracker,
        warcMetadata: [{ uri: TRACKER, fields: { action: "deny", pattern: "*/tracker.js", method: "GET" } }],
      }),
    ).toEqual([]);
  });

  it("照合は URL 全体に当てる —— query の付いた URL に、query を見込まない pattern は当たらない", async () => {
    const settings = settingsWith([{ pattern: "*/marked/asset/pixel.svg", action: "deny" }]);
    expect(
      await run({ settings, warcResponses: [{ uri: PIXEL, mime: "image/svg+xml", body: "<svg/>" }] }),
    ).toEqual([]);
  });

  it("最初に当たった方針だけが効く —— 先に no-body が当たれば、deny は効かない", async () => {
    const settings = settingsWith([
      { pattern: "*/tracker.js", action: "no-body" },
      { pattern: "*/tracker.js", action: "deny" },
    ]);
    expect(await run({ settings, warcResponses: [trackerResponse] })).toEqual([]);
  });

  it("deny の無い方針なら、何も言わない", async () => {
    const settings = settingsWith([{ pattern: "*/tracker.js", action: "no-archive" }]);
    expect(await run({ settings, warcResponses: [trackerResponse] })).toEqual([]);
  });

  it("spec / lenient profile では走らない", async () => {
    for (const profile of ["spec", "lenient"] as const) {
      expect(await run({ settings: denyTracker, warcResponses: [trackerResponse] }, profile)).toEqual([]);
    }
  });

  describe("値を置き換えた URL（WACZ Profile 1.22.0 の urlPolicies）", () => {
    /**
     * 取り込みは置き換える前の URL（`https://site.test/tok-12345678/x`）に方針を照らし、先の no-body が当たって要求を
     * 送った。置き換えた後の URL には、後ろの deny が当たる。
     */
    const policies = [
      { pattern: "https://site.test/tok-*", action: "no-body" },
      { pattern: "https://site.test/*", action: "deny" },
    ];
    const REPLACED = "https://site.test/***/x";
    const PLAIN = "https://site.test/plain/x";
    const archive = (url: string, over: { conformsTo?: string; secrets?: string[] } = {}): FixtureOptions => ({
      conformsTo: over.conformsTo ?? "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.22.0/",
      settings: { ...settingsWith(policies), secrets: over.secrets ?? ["api_token"], secretArchive: {} },
      warcResponses: [{ uri: url, mime: "text/html", body: "" }],
    });

    it("シークレットを名乗る 1.22.0 の package では、*** を持つ URL に照らさない", async () => {
      expect(await run(archive(REPLACED))).toEqual([]);
    });

    it("対照: 同じ archive でも、*** の無い URL は今までどおり落とす", async () => {
      expect(await run(archive(PLAIN))).toEqual([sent(PLAIN, "https://site.test/*", "response")]);
    });

    it("1.21.0 を名乗る archive では、*** を持つ URL にも今までどおり照らす", async () => {
      expect(await run(archive(REPLACED, { conformsTo: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.21.0/" }))).toEqual([
        sent(REPLACED, "https://site.test/*", "response"),
      ]);
    });

    it("置き換えの印は *** の 3 字 —— * を 2 つだけ持つ URL は今までどおり照らす", async () => {
      const stars = "https://site.test/a**b/x";
      expect(await run(archive(stars))).toEqual([sent(stars, "https://site.test/*", "response")]);
    });

    it("シークレットを名乗らない package では、*** はオリジンの字なので照らす", async () => {
      expect(await run(archive(REPLACED, { secrets: [] }))).toEqual([sent(REPLACED, "https://site.test/*", "response")]);
    });
  });

  it("版で分けない —— 送らない約束は最初の版からある", async () => {
    const report = await reportFor(
      tmpDir,
      { settings: denyTracker, warcResponses: [trackerResponse] },
      { name: "browserhive", version: { major: 12, minor: 0, patch: 0 } },
    );
    expect(report.skipped?.some((s) => s.rule === RULE) ?? false).toBe(false);
    expect(report.issues.filter((i) => i.rule === RULE)).toEqual([sent(TRACKER, "*/tracker.js", "response")]);
  });
});
