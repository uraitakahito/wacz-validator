// @module-tag engine
/**
 * `browserhive/document-withheld` のテスト。
 *
 * 守っている主張は profile 1.10.0 の `document` の節にある 3 つ (1.11.0 で `deny` が加わった):
 *
 * 1. `withheld` は、`document.url` に方針を照らし直した答えと一致する (両向き)。方針が当たったのに
 *    伏せていない archive も、当たっていないのに伏せた archive も落とす
 * 2. `withheld` があれば、ページから作ったもの (`pages.jsonl` の文字と題、アクセシビリティツリー) は無い
 * 3. 無ければ、ツリーの `url` は `document.url` と等しい —— 要求の URL ではない
 *
 * 場面はどれもサーバのリダイレクトを経た形にしてある。要求の URL (`PAGE`) と読んだ文書 (`DOC`) が
 * 違うので、身元の代わりに要求の URL で照らす実装は、どこかの行で赤になる。
 *
 * 照合の規則 (URL の方針は最初に当たったものだけ、glob のワイルドカードは `*` だけで URL 全体に、
 * content-type は文書の URL の記録の MIME の前方一致で大文字と小文字を区別) は
 * `browserhive/policy-not-truncated` と同じで、1 つずつ別の入力で反証できるように置く。
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

const RULE = "browserhive/document-withheld";
const V13 = { major: 13, minor: 0, patch: 0 };

/** 要求の URL。302 で `DOC` へ送る。 */
const PAGE = "https://example.com/start";
/** 読んだ文書。リダイレクトの先。 */
const DOC = "https://example.com/landed";
/** archive が適合を名乗る profile の版。`deny` の扱いがこれで変わる。 */
const CONFORMS_1_10 = "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.10.0/";
const CONFORMS_1_11 = "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.11.0/";
/** 文書に deny が当たる方針。 */
const DENY_DOC: Policies = { urlPolicies: [{ pattern: "*/landed", action: "deny" }] };
/** 文書を送らなかった形。中継の 302 と、送らなかったことを言う metadata だけ。 */
const DENIED: Partial<FixtureOptions> = {
  warcResponses: [{ uri: PAGE, mime: "", status: 302, body: "" }],
  warcMetadata: [{ uri: DOC, fields: { action: "deny", pattern: "*/landed", method: "GET" } }],
};

/** 文書とは別の応答 (画像)。content-type の照合を文書の記録に限ることを見るため。 */
const IMAGE = "https://example.com/logo.png";

interface Policies {
  urlPolicies?: { pattern: string; action: string }[];
  contentTypePolicies?: { prefix: string; action: string }[];
}

/** 方針だけを差し替えた settings。他の member は形の rule の担当なので、最小で済ませる。 */
const settingsWith = (policies: Policies): Record<string, unknown> => ({
  signature: "none",
  viewport: { width: 1280, height: 800 },
  devicePixelRatios: [1],
  session: "isolated",
  behaviors: [],
  limits: { maxResponseBytes: 1000, maxTaskBytes: 100_000 },
  urlPolicies: policies.urlPolicies ?? [],
  contentTypePolicies: policies.contentTypePolicies ?? [],
});

const noBody = (pattern: string): Policies => ({ urlPolicies: [{ pattern, action: "no-body" }] });

/** ツリーのスナップショット 1 行。 */
const snapshot = (url: string): Record<string, unknown> => ({
  profile: "browserhive:axtree/1",
  url,
  takenAt: "2026-09-25T00:00:00.000Z",
  stage: "after-behaviors",
  tree: [{ role: "RootWebArea", name: "Landed" }],
});

/** 伏せなかったページ行: 文字と題がある。 */
const shown = (entry: Record<string, unknown>): Record<string, unknown> => ({
  ...entry,
  title: "Landed",
  text: "landed text",
});

/** 伏せたページ行: 文字と題が無く、理由がある。 */
const hidden =
  (reason: string) =>
  (entry: Record<string, unknown>): Record<string, unknown> => ({
    id: entry["id"],
    url: entry["url"],
    ts: entry["ts"],
    textWithheld: reason,
  });

/** リダイレクトの 2 応答。中継の 302 と、着いた文書の HTML。 */
const RESPONSES = [
  { uri: PAGE, mime: "", status: 302, body: "" },
  { uri: DOC, mime: "text/html", body: "<title>Landed</title>landed text" },
];

/** 着いた文書の応答を記録しなかった (no-archive の) 形。中継の 302 と、文書の metadata だけ。 */
const NOT_ARCHIVED: Partial<FixtureOptions> = {
  warcResponses: [{ uri: PAGE, mime: "", status: 302, body: "" }],
  warcMetadata: [{ uri: DOC, fields: { action: "no-archive", pattern: "*/landed", method: "GET" } }],
};

/** 3 つとも書いた archive。 */
const written = (policies: Policies, over: Partial<FixtureOptions> = {}): FixtureOptions => ({
  pageUrl: PAGE,
  warcResponses: RESPONSES,
  settings: settingsWith(policies),
  document: { url: DOC },
  mutatePageEntry: shown,
  axtree: snapshot(DOC),
  ...over,
});

/** 3 つとも伏せた archive。 */
const withheldAs = (
  reason: string,
  policies: Policies,
  over: Partial<FixtureOptions> = {},
): FixtureOptions => ({
  pageUrl: PAGE,
  warcResponses: RESPONSES,
  settings: settingsWith(policies),
  document: { url: DOC, withheld: reason },
  mutatePageEntry: hidden(reason),
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

/** この rule の error を 1 件。差し込む値が無ければ `params` ごと持たない。 */
const error = (messageKey: string, params: Record<string, string>, entry: string): Issue => ({
  rule: RULE,
  severity: "error",
  messageKey: `${RULE}.${messageKey}`,
  ...(Object.keys(params).length > 0 && { params }),
  location: { entry },
});

describe("browserhive/document-withheld", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "wacz-validator-document-withheld-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const run = async (options: FixtureOptions, profile: RuleProfile = "browserhive"): Promise<Issue[]> =>
    (await reportFor(tmpDir, options, { name: profile, version: V13 })).issues.filter(
      (i) => i.rule === RULE,
    );

  describe("方針に照らし直す（両向き）", () => {
    it("方針が何も当たらず、3 つとも書いた archive には何も言わない", async () => {
      expect(await run(written({}))).toEqual([]);
    });

    it("文書に URL の no-body が当たり、3 つとも伏せた archive には何も言わない", async () => {
      expect(await run(withheldAs("url-policy", noBody("*/landed")))).toEqual([]);
    });

    it("文書に URL の no-body が当たるのに伏せていなければ、error で落とす", async () => {
      // 12.x の BrowserHive が書いていた形。リダイレクトの先だけが方針に当たり、文字も題もツリーも残った。
      expect(await run(written(noBody("*/landed")))).toEqual([
        error("should-withhold", { url: DOC, expected: "url-policy" }, "datapackage.json"),
      ]);
    });

    it("文書の型に content-type の方針が当たるのに伏せていなければ、error で落とす", async () => {
      expect(
        await run(written({ contentTypePolicies: [{ prefix: "text/", action: "no-body" }] })),
      ).toEqual([error("should-withhold", { url: DOC, expected: "content-type" }, "datapackage.json")]);
    });

    it("文書に no-archive が当たるのに伏せていなければ、error で落とす", async () => {
      const issues = await run(
        written({ urlPolicies: [{ pattern: "*/landed", action: "no-archive" }] }, NOT_ARCHIVED),
      );
      expect(issues).toEqual([
        error("should-withhold", { url: DOC, expected: "no-archive" }, "datapackage.json"),
      ]);
    });

    it("文書に no-archive が当たり、3 つとも伏せた archive には何も言わない", async () => {
      const issues = await run(
        withheldAs("no-archive", { urlPolicies: [{ pattern: "*/landed", action: "no-archive" }] }, NOT_ARCHIVED),
      );
      expect(issues).toEqual([]);
    });

    it("方針がリダイレクトの中継にだけ当たるのに伏せていれば、error で落とす（伏せすぎ）", async () => {
      // 要求の URL で照らす実装は、中継の 302 に当たった方針を文書に当ててしまう。
      expect(await run(withheldAs("url-policy", noBody("*/start")))).toEqual([
        error("should-not-withhold", { url: DOC, declared: "url-policy" }, "datapackage.json"),
      ]);
    });

    it("伏せた理由が方針と違えば、error で落とす", async () => {
      expect(await run(withheldAs("no-archive", noBody("*/landed")))).toEqual([
        error("wrong-reason", { url: DOC, declared: "no-archive", expected: "url-policy" }, "datapackage.json"),
      ]);
    });

    it("URL の方針は最初に当たったものだけが効く", async () => {
      // 先に当たるのは no-archive。後ろの no-body を拾う実装は、理由を url-policy と答えて赤になる。
      const issues = await run(
        withheldAs(
          "no-archive",
          {
            urlPolicies: [
              { pattern: "https://example.com/*", action: "no-archive" },
              { pattern: "*/landed", action: "no-body" },
            ],
          },
          NOT_ARCHIVED,
        ),
      );
      expect(issues).toEqual([]);
    });

    it("URL の glob のワイルドカードは * だけで、URL 全体に当てる", async () => {
      // 1 本目は末尾が足りず、URL 全体には当たらない (部分一致で当てる実装はここで赤)。
      // 2 本目の `.` は文字どおりの 1 文字で、`landed` の `d` には当たらない (`.` を任意の
      // 1 文字として効かせる実装はここで赤)。
      const issues = await run(
        written({
          urlPolicies: [
            { pattern: "https://example.com/land", action: "no-body" },
            { pattern: "https://example.com/lande.", action: "no-body" },
          ],
        }),
      );
      expect(issues).toEqual([]);
    });

    it("content-type の前方一致は大文字と小文字を区別する", async () => {
      expect(
        await run(written({ contentTypePolicies: [{ prefix: "Text/", action: "no-body" }] })),
      ).toEqual([]);
    });

    it("content-type は文書の URL の記録の型で照らす（ほかの応答の型では照らさない）", async () => {
      // 画像の型に当たる方針。archive のどこかに当たる型があれば伏せる、と読む実装はここで赤。
      const issues = await run(
        written(
          { contentTypePolicies: [{ prefix: "image/", action: "no-body" }] },
          { warcResponses: [...RESPONSES, { uri: IMAGE, mime: "image/png", body: "png" }] },
        ),
      );
      expect(issues).toEqual([]);
    });

    it("URL と content-type の両方に当たれば、先に決まる URL の方針が理由になる", async () => {
      const issues = await run(
        withheldAs("content-type", {
          urlPolicies: [{ pattern: "*/landed", action: "no-body" }],
          contentTypePolicies: [{ prefix: "text/", action: "no-body" }],
        }),
      );
      expect(issues).toEqual([
        error("wrong-reason", { url: DOC, declared: "content-type", expected: "url-policy" }, "datapackage.json"),
      ]);
    });
  });

  describe("伏せたなら、ページから作ったものは無い", () => {
    it("ページ行に文字があれば、error で落とす", async () => {
      const issues = await run(
        withheldAs("url-policy", noBody("*/landed"), {
          mutatePageEntry: (e) => ({ ...hidden("url-policy")(e), text: "landed text" }),
        }),
      );
      expect(issues).toEqual([error("text-present", { withheld: "url-policy" }, "pages/pages.jsonl")]);
    });

    it("ページ行に題があれば、error で落とす", async () => {
      const issues = await run(
        withheldAs("url-policy", noBody("*/landed"), {
          mutatePageEntry: (e) => ({ ...hidden("url-policy")(e), title: "Landed" }),
        }),
      );
      expect(issues).toEqual([error("title-present", { withheld: "url-policy" }, "pages/pages.jsonl")]);
    });

    it("アクセシビリティツリーがあれば、error で落とす", async () => {
      const issues = await run(withheldAs("url-policy", noBody("*/landed"), { axtree: snapshot(DOC) }));
      expect(issues).toEqual([
        error("axtree-present", { withheld: "url-policy" }, "accessibility/axtree.jsonl"),
      ]);
    });

    it("textWithheld が withheld と違えば、error で落とす", async () => {
      const issues = await run(
        withheldAs("url-policy", noBody("*/landed"), { mutatePageEntry: hidden("content-type") }),
      );
      expect(issues).toEqual([
        error("text-withheld-mismatch", { textWithheld: "content-type", withheld: "url-policy" }, "pages/pages.jsonl"),
      ]);
    });

    it("textWithheld は省いてよい（MAY）", async () => {
      const issues = await run(
        withheldAs("url-policy", noBody("*/landed"), {
          mutatePageEntry: (e) => ({ id: e["id"], url: e["url"], ts: e["ts"] }),
        }),
      );
      expect(issues).toEqual([]);
    });

    it("どの文書から読んだか言えない（unattributed）なら、url が無くても方針には照らさず、何も言わない", async () => {
      const issues = await run(
        withheldAs("unattributed", noBody("*/landed"), { document: { withheld: "unattributed" } }),
      );
      expect(issues).toEqual([]);
    });

    it("unattributed でも、ページ行に文字があれば落とす", async () => {
      const issues = await run(
        withheldAs("unattributed", {}, {
          document: { withheld: "unattributed" },
          mutatePageEntry: (e) => ({ ...hidden("unattributed")(e), text: "landed text" }),
        }),
      );
      expect(issues).toEqual([error("text-present", { withheld: "unattributed" }, "pages/pages.jsonl")]);
    });
  });

  describe("伏せていないなら、ツリーは読んだ文書を名乗る", () => {
    it("ツリーの url が要求の URL なら、error で落とす", async () => {
      // 12.x の BrowserHive が書いていた形。ツリーは読んだ文書ではなく、要求の URL を名乗っていた。
      expect(await run(written({}, { axtree: snapshot(PAGE) }))).toEqual([
        error("tree-url", { line: "1", treeUrl: PAGE, url: DOC }, "accessibility/axtree.jsonl"),
      ]);
    });

    it("伏せていないのにページ行に textWithheld があれば、error で落とす", async () => {
      // 12.x の BrowserHive が書いていた、伏せすぎの形。中継に当たった方針で文字だけを伏せていた。
      const issues = await run(
        written({}, { mutatePageEntry: (e) => ({ ...shown(e), textWithheld: "url-policy" }) }),
      );
      expect(issues).toEqual([
        error("text-withheld-unexpected", { textWithheld: "url-policy" }, "pages/pages.jsonl"),
      ]);
    });
  });

  describe("身元の形", () => {
    it("document がオブジェクトでなければ、error で落とす", async () => {
      expect(await run(written({}, { document: "https://example.com/landed" as unknown as Record<string, unknown> }))).toEqual([
        error("not-object", { found: "string" }, "datapackage.json"),
      ]);
    });

    it("unattributed でないのに url が無ければ、error で落とす", async () => {
      expect(await run(written({}, { document: {} }))).toEqual([
        error("missing-url", {}, "datapackage.json"),
      ]);
    });

    it("withheld が profile の定めない値なら、error で落とす", async () => {
      expect(await run(withheldAs("robots", {}))).toEqual([
        error("unknown-reason", { found: "robots" }, "datapackage.json"),
      ]);
    });
  });

  describe("身元は archive の中を指す（warning）", () => {
    it("document.url が索引にも no-archive の記録にも無ければ、warning を出す", async () => {
      const issues = await run(
        written({}, { warcResponses: [{ uri: PAGE, mime: "", status: 302, body: "" }] }),
      );
      expect(issues).toEqual([
        {
          rule: RULE,
          severity: "warning",
          messageKey: `${RULE}.not-in-archive`,
          params: { url: DOC },
          location: { entry: "datapackage.json" },
        },
      ]);
    });

    it("1.10.0 の archive では、deny の記録は身元の在り処にならない", async () => {
      // BrowserHive v13.0.0〜v17.0.0 は主文書への deny で要求を止められず、ページを読んでいた。
      // archive には `action: deny`（送らなかった）の記録しか無く、読んだ文書は archive のどこにも無い。
      // 1.10.0 に deny の理由は無いので伏せないのが正しく、漏れはこの warning が言う。
      const issues = await run(written(DENY_DOC, { ...DENIED, conformsTo: CONFORMS_1_10 }));
      expect(issues.map((i) => `${i.severity} ${i.messageKey}`)).toEqual([`warning ${RULE}.not-in-archive`]);
    });
  });

  describe("deny は文書を伏せる（profile 1.11.0 から）", () => {
    it("文書に deny が当たり、deny で伏せた archive には何も言わない", async () => {
      // 送らなかった文書の身元は、送らなかったことを言う記録が指す。
      for (const conformsTo of [CONFORMS_1_11, undefined]) {
        const over = conformsTo === undefined ? DENIED : { ...DENIED, conformsTo };
        expect(await run(withheldAs("deny", DENY_DOC, over))).toEqual([]);
      }
    });

    it("文書に deny が当たるのに伏せていなければ、error で落とす", async () => {
      expect(await run(written(DENY_DOC, { ...DENIED, conformsTo: CONFORMS_1_11 }))).toEqual([
        error("should-withhold", { url: DOC, expected: "deny" }, "datapackage.json"),
      ]);
    });

    it("適合を名乗らない archive は、いまの版（1.11.0）の決まりで照らす", async () => {
      expect(await run(written(DENY_DOC, DENIED))).toEqual([
        error("should-withhold", { url: DOC, expected: "deny" }, "datapackage.json"),
      ]);
    });

    it("1.10.0 の archive の deny は、profile の定めない値", async () => {
      // 1.10.0 では deny の記録も身元の在り処にならないので、身元が archive に無い warning も並ぶ。
      expect(
        (await run(withheldAs("deny", DENY_DOC, { ...DENIED, conformsTo: CONFORMS_1_10 }))).map(
          (i) => `${i.severity} ${i.messageKey}`,
        ),
      ).toEqual([`error ${RULE}.unknown-reason`, `warning ${RULE}.not-in-archive`]);
    });

    it("deny が文書に当たらないのに deny で伏せれば、error で落とす（伏せすぎ）", async () => {
      // 両向きの決まりの deny 版。deny は部分資源 (画像) にだけ当たり、読んだ文書には当たらない。
      const policies: Policies = { urlPolicies: [{ pattern: "*/logo.png", action: "deny" }] };
      expect(await run(withheldAs("deny", policies, { conformsTo: CONFORMS_1_11 }))).toEqual([
        error("should-not-withhold", { url: DOC, declared: "deny" }, "datapackage.json"),
      ]);
    });
  });

  describe("走る範囲", () => {
    it("document の無い archive（1.9.0 以前）は見ない", async () => {
      // 方針に当たった文書の文字が残る、12.x の形。身元が無いので照らしようがない。
      const options = written(noBody("*/landed"));
      delete options.document;
      expect(await run(options)).toEqual([]);
    });

    it("spec / lenient profile では走らない", async () => {
      for (const profile of ["spec", "lenient"] as const) {
        expect(await run(written(noBody("*/landed")), profile)).toEqual([]);
      }
    });
  });
});

describe("browserhive/document-withheld — producer の版の条件", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "wacz-validator-document-withheld-version-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** 方針に当たったのに伏せていない archive を、指定の selector で検査する。 */
  const reportForLeak = (selector: ProfileSelector): Promise<Report> =>
    reportFor(tmpDir, written(noBody("*/landed")), selector);

  /** この rule が落とされたかだけを見る。版の条件を持つ rule が増えても、ここは壊れない。 */
  const skippedHere = (report: Report): SkippedRule | undefined =>
    report.skipped?.find((s) => s.rule === RULE);

  it("13.0.0 より前の版では走らず、落としたことが report に残る", async () => {
    const report = await reportForLeak({ name: "browserhive", version: { major: 12, minor: 2, patch: 0 } });
    expect(report.issues.some((i) => i.rule === RULE)).toBe(false);
    expect(skippedHere(report)).toEqual({ rule: RULE, reason: "profile-version", range: ">=13.0.0" });
  });

  it("13.0.0 そのものは範囲内", async () => {
    const report = await reportForLeak({ name: "browserhive", version: V13 });
    expect(skippedHere(report)).toBeUndefined();
    expect(report.issues.some((i) => i.rule === RULE)).toBe(true);
  });

  it("版を名乗らなければ走る", async () => {
    const report = await reportForLeak({ name: "browserhive" });
    expect(skippedHere(report)).toBeUndefined();
    expect(report.issues.some((i) => i.rule === RULE)).toBe(true);
  });
});
