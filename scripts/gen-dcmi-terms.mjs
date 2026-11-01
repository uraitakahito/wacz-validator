#!/usr/bin/env node
/**
 * DCMI Metadata Terms の property の名前を、DCMI が配る N-Triples から抜いて
 * `packages/core/src/vocab/dcmi-terms.ts` に書く。
 *
 *   node scripts/gen-dcmi-terms.mjs          取りに行って書く
 *   node scripts/gen-dcmi-terms.mjs --check  取りに行き、書いてある一覧と違えば 1 で終わる
 *
 * 抜くのは `<http://purl.org/dc/terms/名前> rdf:type rdf:Property` の主語の名前だけ。定義や label は
 * 写さない（DCMI の文書の文は CC BY 4.0。名前と URI だけなら写す必要が無い）。
 *
 * 試験（`gen-dcmi-terms.test.mjs`）は手で書いた N-Triples で関数を確かめ、網には出ない。取りに行くのは、
 * 人がこの script を走らせたときだけ。
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SOURCE_URL = "https://www.dublincore.org/specifications/dublin-core/dcmi-terms/dublin_core_terms.nt";
export const NAMESPACE = "http://purl.org/dc/terms/";
const OUT = fileURLToPath(new URL("../packages/core/src/vocab/dcmi-terms.ts", import.meta.url));

const PROPERTY_LINE =
  /^<http:\/\/purl\.org\/dc\/terms\/([A-Za-z]+)> <http:\/\/www\.w3\.org\/1999\/02\/22-rdf-syntax-ns#type> <http:\/\/www\.w3\.org\/1999\/02\/22-rdf-syntax-ns#Property> \.$/;

/** N-Triples の本文から、`/terms/` の名前空間の property の名前を、重なりなく、文字コードの順に。 */
export const propertyNames = (ntriples) => {
  const names = new Set();
  for (const line of ntriples.split("\n")) {
    const name = PROPERTY_LINE.exec(line.trim())?.[1];
    if (name !== undefined) names.add(name);
  }
  return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
};

/** 名前の並びから、`dcmi-terms.ts` の中身を組む。日付を書かないので、同じ並びからは同じバイト列になる。 */
export const renderModule = (names) =>
  [
    "/**",
    " * DCMI Metadata Terms の property の名前（`http://purl.org/dc/terms/` の名前空間）。",
    " *",
    " * `scripts/gen-dcmi-terms.mjs` が、DCMI の配る N-Triples",
    ` * （${SOURCE_URL}）から、`,
    " * `rdf:type rdf:Property` の主語の名前を抜いて作った。手で直さない。直すときは script を走らせる。",
    " *",
    " * 持つのは名前だけで、URI は名前空間に名前を足したもの。定義や label は持たない（DCMI の文書の文は",
    " * CC BY 4.0 で、名前と URI だけなら写す必要が無い）。WARC 1.1 は warcinfo と metadata の本文に",
    " * 「DCMI のすべての語」を使ってよいとしている（[DCMI] は DCMI Metadata Terms）。",
    " */",
    `export const DCMI_TERMS_NAMESPACE = "${NAMESPACE}";`,
    "",
    "export const DCMI_TERM_NAMES: readonly string[] = [",
    ...names.map((n) => `  "${n}",`),
    "];",
    "",
  ].join("\n");

const main = async () => {
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`${SOURCE_URL}: HTTP ${res.status}`);
  const names = propertyNames(await res.text());
  if (names.length === 0) throw new Error("property が 1 つも見つからない —— 配る形が変わったかもしれない");
  const next = renderModule(names);
  if (process.argv.includes("--check")) {
    const current = await readFile(OUT, "utf-8").catch(() => "");
    if (current !== next) {
      console.error(`${OUT} は DCMI の一覧と違う。node scripts/gen-dcmi-terms.mjs で書き直す`);
      process.exit(1);
    }
    console.log(`✓ DCMI の property ${names.length} 個と一致`);
    return;
  }
  await writeFile(OUT, next);
  console.log(`${OUT} に property ${names.length} 個を書いた`);
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
