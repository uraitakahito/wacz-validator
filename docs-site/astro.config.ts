import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import mermaid from "astro-mermaid";
import { satteri } from "@astrojs/markdown-satteri";
import mdastCodeRegion from "./src/plugins/mdast-code-region";
import hastRebaseLinks from "./src/plugins/hast-rebase-links";

const BASE = "/wacz-validator";

// WACZ 1.1.1 の日本語訳(別リポジトリで公開済み)。用語ページから参照する。
const SPEC_JA = "https://uraitakahito.github.io/specs/wacz/1.1.1/";
const SPEC_EN = "https://specs.webrecorder.net/wacz/1.1.1/";


export default defineConfig({
  site: "https://uraitakahito.github.io",
  base: BASE,
  integrations: [
    // 配置は dagre、flowchart の折り返しの幅は 200 に固定する。mermaid 12 で既定が ELK と 120 に変わり、
    // `@wacz-validator/core` のような名前が語の途中で折れた。この 2 つで mermaid 11 の配置に戻る
    // (図 4 枚を light と dark で描いて見比べた)。
    mermaid({ theme: "neutral", mermaidConfig: { layout: "dagre", flowchart: { wrappingWidth: 200 } } }),
    starlight({
      title: "wacz-validator Docs",
      customCss: ["./src/styles/tables.css"],
      defaultLocale: "root",
      locales: {
        root: { label: "English", lang: "en" },
        ja: { label: "日本語", lang: "ja" },
      },
      // 各項目に `ja` 訳を持たせる。Starlight はページを翻訳するが
      // ナビゲーションは翻訳しないので、これが無いと日本語ドキュメントは
      // 翻訳済みのページが英語の目次にぶら下がった状態になる。
      sidebar: [
        { label: "Quickstart", translations: { ja: "クイックスタート" }, slug: "quickstart" },
        {
          label: "Reference",
          translations: { ja: "リファレンス" },
          items: [
            { label: "Rules", translations: { ja: "Rules" }, slug: "rules" },
            { label: "Profiles", translations: { ja: "プロファイル" }, slug: "profiles" },
            { label: "JSON report", translations: { ja: "JSON レポート" }, slug: "json-report" },
          ],
        },
        {
          label: "Guides",
          translations: { ja: "ガイド" },
          items: [
            { label: "Architecture", translations: { ja: "アーキテクチャ" }, slug: "architecture" },
            {
              label: "Apple Container stack",
              translations: { ja: "Apple Container スタック" },
              slug: "container",
            },
            // corpus のドキュメントは corpus repo 側に移した。標本の一覧が標本と
            // 別 repo にある状態を解消するため。カタログの生成先も CORPUS_DIR 配下。
            {
              label: "Corpus ↗",
              translations: { ja: "Corpus ↗" },
              link: "https://uraitakahito.github.io/wacz-validator-corpus/",
            },
            { label: "Terminology", translations: { ja: "用語" }, slug: "terminology" },
          ],
        },
        {
          // wacz-validator そのものを開発する人向け。使う側の Guides とは読者が違う。
          label: "For developers",
          translations: { ja: "開発者向け" },
          items: [
            {
              label: "Running the tests",
              translations: { ja: "テストの実行" },
              slug: "running-tests",
            },
            {
              label: "Break it on purpose",
              translations: { ja: "壊して確かめる" },
              slug: "breaking",
            },
          ],
        },
        // 絶対 URL は意図的。root-relative にすると Starlight が日本語ページ上で
        // /ja/ を注入し 404 になる。
        // 仕様書そのものの名前なので訳さない。
        { label: "WACZ 1.1.1 ↗", translations: { ja: "WACZ 1.1.1 ↗" }, link: SPEC_EN },
        {
          label: "WACZ 1.1.1 (日本語訳) ↗",
          translations: { ja: "WACZ 1.1.1 (日本語訳) ↗" },
          link: SPEC_JA,
        },
      ],
    }),
  ],
  markdown: {
    // Astro 7.2 の既定プロセッサ。legacy の remarkPlugins/rehypePlugins は
    // @astrojs/markdown-remark(unified) を要求するので、そちらは使わない。
    processor: satteri({
      mdastPlugins: [mdastCodeRegion],
      hastPlugins: [hastRebaseLinks],
    }),
  },
});
