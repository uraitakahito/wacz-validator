/**
 * コードから「事実」を取り出す唯一の入口。
 *
 * wacz-validator の docs は他リポジトリより「コードの写し」の比率が高い。rule の
 * severity / conformance / profile ごとの上書き / spec リンクはすべて
 * `packages/core/src/validate/` に定義があり、それを手で書き写した表を
 * 日英 2 言語ぶん維持するのは現実的でない。ここで読んで注入する。
 *
 * 人が書く価値があるもの（各 rule が何を・なぜ見るか）は docs 側に残す。
 * ここが扱うのは「機械が言える事実」だけ。
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

// wacz-validator ルート。docs-site は wacz-validator 直下にあり、astro dev/build は docs-site
// を cwd に実行されるので、その親がリポジトリルート。
// ※ import.meta.url は astro ビルド後の dist パスになるため使えない。
const ROOT = resolve(process.cwd(), "..");
const RULES_DIR = resolve(ROOT, "packages/core/src/validate/rules");

const read = (abs: string): string => readFileSync(abs, "utf8");

/** `key: "value"` を 1 つ取り出す。無ければ undefined。 */
/**
 * rule オブジェクト直下の文字列リテラルを 1 つ読む。
 *
 * **行頭 + 2 スペースに固定してある。** 緩い `\bkey:` にしていたときは、
 * ファイル内のどこかにある無関係な `name: "..."` —— 必須 member の一覧など ——
 * が先に当たり、`browserhive/settings-shape` が `signature` として、
 * `browserhive/dismissal-shape` が `selectors` として表に出ていた。
 * **一致してしまう誤りは throw しない**ので、表だけが静かに嘘をついていた。
 */
const literal = (source: string, key: string): string | undefined => {
  const hits = [
    ...source.matchAll(new RegExp(String.raw`^  ${key}: "([^"]+)",$`, "gm")),
  ];
  // 2 つ在るなら、どちらが rule のものか決められない。1 つに絞れないことを
  // 「読めなかった」として扱い、呼び出し側に throw させる。
  return hits.length === 1 ? hits[0]?.[1] : undefined;
};

/**
 * rule が依拠する spec へのリンク。rule 定義の `docs` 由来。
 *
 * `url` は locale ごとに持つ。WACZ には和訳があり ja では別 URL を指すので、
 * どちらを出すかは表示側 (RuleTable) が `lang` で選ぶ。
 */
export interface RuleLink {
  label: string;
  url: { en: string } & Partial<Record<"ja", string>>;
}

/** 1 つの rule について、コードから機械的に言えること。 */
export interface RuleFact {
  /** `wacz/required-files` のような rule 名。docs 本文の参照もこの文字列。 */
  name: string;
  /**
   * その rule が出しうる severity の**全部**（出現順、重複除去）。
   *
   * `ValidationRule` には severity field が無い。実体は `issues.push` が
   * 書く値なので、そこから集める。1 つの rule が状況によって別の severity
   * を出すことがあり（例: `datapackage/digest` は不在なら warning、hash
   * 不一致なら error）、その場合は 2 値になる。
   */
  severities: string[];
  /** spec 上の要求レベル（MUST / SHOULD / MAY / MUST NOT）。 */
  conformance: string;
  /**
   * profile 名 → その profile で書き換わる severity の集合。
   *
   * 宣言は messageKey 単位だが、表では「その profile でどう変わるか」の
   * 概観だけ示す（messageKey 単位の詳細は rule のソースを見る）。
   * **その rule の全 issue が変わるとは限らない** ので、件数を併記する。
   */
  severityByProfile: Record<string, { levels: string[]; count: number }>;
  /**
   * profile 別の producer 版の範囲 (`profileVersions`)。
   *
   * 範囲外の版を名乗った実行では rule が走らない。表に出さないと
   * 「この rule はいつ効くのか」が rule ソースを開くまで分からない。
   */
  profileVersions: Record<string, string>;
  /** 出典リンク。未登録の rule は空配列。 */
  links: RuleLink[];
}

/**
 * `rules/*.ts` を読んで全 rule の事実を返す。
 *
 * ファイル数と `rules/index.ts` の登録数が食い違えば throw する。rule は
 * 「ファイルを作る」と「index.ts に登録する」の 2 段階で有効になり、登録忘れは
 * *その rule が黙って動かない* という最悪の失敗になる。専用テストが無ければ
 * 誰も気付かないので、docs のビルドで落とす。
 */
export function rules(): RuleFact[] {

  const files = readdirSync(RULES_DIR).filter((f) => f.endsWith(".ts") && f !== "index.ts");
  const facts = files.map((file): RuleFact => {
    const source = read(resolve(RULES_DIR, file));
    const name = literal(source, "name");
    const conformance = literal(source, "conformance");
    if (name === undefined || conformance === undefined) {
      throw new Error(`rules/${file}: could not read name / conformance`);
    }

    // その rule が出しうる severity。三項演算子で決まるもの（1 件だけ:
    // warc/recording-complete）があるので、行ごとに両方の枝を拾う。
    const severities = [
      ...new Set(
        [...source.matchAll(/severity:\s*([^,\n]+)/g)].flatMap(([, expr]) =>
          [...expr.matchAll(/"(error|warning|info)"/g)].map(([, level]) => level),
        ),
      ),
    ];
    if (severities.length === 0) {
      throw new Error(`rules/${file}: no severity found in issues.push`);
    }

    // profile 上書きは messageKey 単位。表向けに profile ごとへ畳む。
    const byProfile: Record<string, { levels: string[]; count: number }> = {};
    const block = /severityByProfile:\s*\{([\s\S]*?)\n {2}\},/.exec(source)?.[1];
    for (const [, profile, body] of (block ?? "").matchAll(/(\w+):\s*\{([\s\S]*?)\}/g)) {
      const levels = [...body.matchAll(/:\s*"(error|warning|info)"/g)].map(([, level]) => level);
      byProfile[profile] = { levels: [...new Set(levels)], count: levels.length };
    }

    // 版の範囲。severityByProfile と同じく profile 名で引く。
    const profileVersions: Record<string, string> = {};
    const versionBlock = /profileVersions:\s*\{([^}]*)\}/.exec(source)?.[1];
    for (const [, profile, range] of (versionBlock ?? "").matchAll(/(\w+):\s*"([^"]+)"/g)) {
      profileVersions[profile] = range;
    }

    return {
      name,
      severities,
      conformance,
      severityByProfile: byProfile,
      profileVersions,
      links: parseDocs(source),
    };
  });

  // DEFAULT_RULES の配列要素だけを数える。import 行にも `…Rule,` が並ぶので
  // ファイル全体を対象にすると二重に数えてしまう。
  const registry = read(resolve(RULES_DIR, "index.ts"));
  const array = /DEFAULT_RULES[^=]*=\s*\[([\s\S]*?)\n\];/.exec(registry)?.[1] ?? "";
  const registered = (array.match(/^\s*\w+Rule,\s*$/gm) ?? []).length;
  if (facts.length !== registered) {
    throw new Error(
      `${String(facts.length)} rule files but ${String(registered)} registered in rules/index.ts — ` +
        "a rule that is not registered never runs",
    );
  }

  return facts.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * rule ソースから `docs: [...]` を読む。
 *
 * 別表 (旧 rule-docs.ts) が無くなり、出典は rule 定義が持つようになった。
 * ここは 1 ファイルぶんの source を受け取って、その rule のリンクを返す。
 */
function parseDocs(source: string): RuleLink[] {
  const block = /docs:\s*\[([\s\S]*?)\n {2}\],/.exec(source)?.[1];
  if (block === undefined) return [];
  const out: RuleLink[] = [];
  for (const [, label, urls] of block.matchAll(
    /label:\s*"([^"]+)",\s*url:\s*\{([\s\S]*?)\}/g,
  )) {
    const en = /\ben:\s*"([^"]+)"/.exec(urls)?.[1];
    if (en === undefined) continue; // 型で必須なので通常あり得ない
    const ja = /\bja:\s*"([^"]+)"/.exec(urls)?.[1];
    out.push({ label, url: { en, ...(ja !== undefined && { ja }) } });
  }
  return out;
}

/**
 * `// #region <name>` … `// #endregion` で囲まれた実ソース片を返す。
 * region が見つからなければ throw。これで build が落ちるかは頁の拡張子・Starlight の版・content cache 次第
 * (cold で 1、cache が温かいと 0 を測った)。build に守りを預けず scripts/check-doc-refs.mjs を通す。
 *
 * 名前は行末まで一致させる。`\b` だと `-` を単語境界とみなすので、
 * `#region report` が `#region report-summary` を掴んでしまい、
 * 「トップレベル」の節に ReportSummary が出る、という形で実際に壊れていた。
 * 掴んだ側の残り (`-summary`) がコード片の 1 行目として描画されるため、
 * 症状は「謎のハイフン」に見えて原因から遠い。
 */
export function sourceRegion(file: string, region: string): string {
  // 名前は正規表現ではなくリテラルとして扱う。
  const name = region.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  const re = new RegExp(String.raw`//\s*#region\s+${name}[ \t]*\r?\n([\s\S]*?)//\s*#endregion`);
  const m = re.exec(read(resolve(ROOT, file)));
  if (!m) throw new Error(`region '${region}' not found in ${file}`);
  return m[1].replace(/^\n/, "").replace(/\s+$/, "");
}
