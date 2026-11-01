// @module-tag docs
/**
 * rule が持つ出典リンクの健全性チェック。
 *
 * 「全 rule が出典を持つ」は `ValidationRule.docs` を必須にしたので**型の仕事**に
 * なった。ここが見るのは型で表せないもの:
 *   - URL が https(リンクとして妥当)
 *   - 同じアンカーを指すリンクは同じ URL の組を持つ
 *   - 複数 spec を跨ぐ rule は複数リンクを持つ
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { DEFAULT_RULES, docsForRule } from "../src/validate/rules/index.js";
import { WARC11_SPEC_BASE } from "../src/validate/warc11-fields.js";

const allLinks = DEFAULT_RULES.flatMap((rule) => rule.docs.map((doc) => ({ rule: rule.name, doc })));

/** 注釈つき WARC 1.1 の頁の見出しの id（2026-11-01 に頁から取った）。 */
const WARC11_PAGE_ANCHORS = new Set([
  "scope", "normative-references", "terms-definitions-and-abbreviated-terms", "file-and-record-model",
  "named-fields", "general", "warc-record-id-mandatory", "content-length-mandatory", "warc-date-mandatory",
  "warc-type-mandatory", "content-type", "warc-concurrent-to", "warc-block-digest", "warc-payload-digest",
  "warc-ip-address", "warc-refers-to", "warc-refers-to-target-uri", "warc-refers-to-date", "warc-target-uri",
  "warc-truncated", "warc-warcinfo-id", "warc-filename", "warc-profile", "warc-identified-payload-type",
  "warc-segment-number", "warc-segment-origin-id", "warc-segment-total-length", "warc-record-types", "warcinfo",
  "response", "http-and-https-schemes", "resource", "request", "metadata", "revisit",
  "profile-identical-payload-digest", "profile-server-not-modified", "other-profiles", "conversion", "continuation",
  "record-segmentation", "warc-file-name-size-and-compression", "annex-d-informative-compression-recommendations",
  "record-at-time-compression", "gzip-warc-file-name-suffix",
]);

describe("rule docs", () => {
  it("全 URL は https", () => {
    for (const { rule, doc } of allLinks) {
      for (const [locale, url] of Object.entries(doc.url)) {
        expect(url, `${rule} / ${locale}`).toMatch(/^https:\/\//);
      }
    }
  });

  it("同じ仕様書の同じ節には同じ URL の組が使われている", () => {
    // 出典を rule 側に直書きする形なので、同じ節を指す rule が複数ある
    // (`#indexes` は 5 rule、`#datapackage-json` は 4 rule)。1 つだけ版を
    // 上げると静かに食い違うので、節で束ねて突き合わせる。
    //
    // 束ねる鍵は「版の段を除いた URL ＋ アンカー」。アンカーだけで束ねると、別の仕様書の
    // 同じ名の節 (BrowserHive WARC Profile の `#warcinfo` と WARC 1.1 の `#warcinfo`) が
    // 同じ節に見える。版の段 (`/1.1.1/`) を除くので、版だけ違う URL は同じ鍵に入って落ちる。
    const sectionOf = (url: string): string | undefined => {
      const parsed = new URL(url);
      if (parsed.hash === "") return undefined; // アンカー無しの URL は対象外
      const path = parsed.pathname
        .split("/")
        .filter((segment) => !/^\d+(\.\d+)*$/.test(segment))
        .join("/");
      return `${parsed.host}${path}${parsed.hash}`;
    };
    const bySection = new Map<string, { rule: string; url: string }[]>();
    for (const { rule, doc } of allLinks) {
      const section = sectionOf(doc.url.en);
      if (section === undefined) continue;
      const seen = bySection.get(section) ?? [];
      seen.push({ rule, url: JSON.stringify(doc.url) });
      bySection.set(section, seen);
    }
    for (const [section, entries] of bySection) {
      const distinct = new Set(entries.map((e) => e.url));
      expect(
        [...distinct],
        `${section} を指す ${String(entries.length)} 件で URL が食い違う: ` +
          entries.map((e) => e.rule).join(", "),
      ).toHaveLength(1);
    }
  });

  it("WACZ を指すリンクは和訳の URL も持つ", () => {
    // 和訳があるのは WACZ だけ(17 本)で、WARC 3 / data-package 3 /
    // data-resource 2 は本家しか無い。アンカーは本家と同じなので ja を足す
    // のは URL の前半を差し替えるだけ — 逆に言えば書き忘れても何も壊れず、
    // 日本語の読者だけが黙って英語の spec に飛ばされる。
    for (const { rule, doc } of allLinks) {
      if (!doc.url.en.includes("/wacz/")) continue;
      expect(doc.url.ja, `${rule}: ${doc.label}`).toBeDefined();
    }
  });

  it("WARC 1.1 を指すリンクは注釈つき 1.1 の頁の見出しを指す", () => {
    // rule の `docs` は docs の抽出器がソースの文字列として読むので、基底を定数から組めず、
    // 各 rule に文字列で書いてある。基底の揃いと、アンカーが頁に在ることをここで見る。
    const warcLinks = allLinks.filter(({ doc }) => doc.url.en.includes("warc-specifications"));
    expect(warcLinks.length).toBeGreaterThan(0);
    for (const { rule, doc } of warcLinks) {
      const [base, anchor] = doc.url.en.split("#");
      expect(base, `${rule}: ${doc.label}`).toBe(WARC11_SPEC_BASE);
      expect(WARC11_PAGE_ANCHORS.has(anchor ?? ""), `${rule}: #${String(anchor)}`).toBe(true);
    }
  });

  it("frictionless-structure は 2 spec を持つ", () => {
    expect(docsForRule("datapackage/frictionless-structure")).toHaveLength(2);
  });
});

/**
 * docs の rule 表は `rules/*.ts` を **ソース文字列として** 読んで作られる
 * (`docs-site/src/lib/extract.ts`)。コンパイルしないので、抽出器が読むのは
 * ファイルの見た目であって値ではない。
 *
 * **緩い正規表現が黙って別の値を拾っていた。** `\bname:\s*"..."` は
 * ファイル内のどこかにある無関係な `name: "..."` —— 必須 member の一覧など ——
 * に先に当たり、`browserhive/settings-shape` は `signature` として、
 * `browserhive/dismissal-shape` は `selectors` として表に出ていた。
 * **一致してしまう誤りは throw しない**ので、表だけが静かに嘘をついていた。
 *
 * ここが固定するのは抽出器が依拠する **書き方の約束** —— rule の `name` と
 * `conformance` は、オブジェクト直下に 2 スペース字下げの文字列リテラルで書く。
 * 定数 (`name: RULE`) にすると抽出器から見えなくなる。
 */
const RULES_DIR = fileURLToPath(new URL("../src/validate/rules", import.meta.url));

describe("rule 定義の書き方", () => {
  const files = readdirSync(RULES_DIR).filter((f) => f.endsWith(".ts") && f !== "index.ts");

  it("ファイル数と登録数が一致する", () => {
    expect(files.length).toBe(DEFAULT_RULES.length);
  });

  it.each(files)("%s は name / conformance をリテラルで書いている", (file) => {
    const source = readFileSync(join(RULES_DIR, file), "utf8");
    const names = [...source.matchAll(/^ {2}name: "([^"]+)",$/gm)];
    const conformances = [...source.matchAll(/^ {2}conformance: "([^"]+)",$/gm)];

    // **ちょうど 1 つ。** 0 なら抽出器から見えず、2 つ以上ならどちらが rule の
    // ものか決められない —— どちらも表が黙って別の値を出す経路になる。
    expect(names.length, `${file}: name のリテラルは 1 つ`).toBe(1);
    expect(conformances.length, `${file}: conformance のリテラルは 1 つ`).toBe(1);
    const name = names[0]?.[1];
    const conformance = conformances[0]?.[1];

    // **抽出した名前が、実際に登録されている rule と同じであること。**
    // 別の `name: "..."` を拾っていれば、ここで落ちる。
    const registered = DEFAULT_RULES.find((r) => r.name === name);
    expect(registered, `${file}: 抽出した name "${String(name)}" が DEFAULT_RULES に無い`).toBeDefined();
    expect(registered?.conformance).toBe(conformance);
  });
});
