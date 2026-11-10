/**
 * `browserhive:capture.settings` の方針を、URL と MIME に照らすための共有部分。
 *
 * rule ではないので `rules/` には置かない —— docs の抽出器は `rules/` 配下の
 * `.ts` をすべて rule と見なし、`name` と `conformance` を読めないファイルが
 * あると落ちる。
 *
 * 照合の規則は profile ではなく BrowserHive の model が定める。URL の方針は glob で、
 * ワイルドカードは `*` だけ、URL 全体に当て、上から見て最初に当たったものだけが効く。
 * content-type の方針は MIME の前方一致で、大文字と小文字を区別する。照らす MIME は CDXJ の
 * `mime` —— Chrome が報せた型で、recorder が照らしたのと同じもの。
 */
import { parseCdxj } from "../wacz/cdxj-parser.js";
import type { WaczReader } from "../wacz/reader.js";
import { isRecord, profileAtLeast } from "./browserhive-storage.js";

const CDXJ_ENTRY = "indexes/index.cdxj";

export interface UrlPolicyEntry {
  readonly pattern: string;
  readonly action: string;
}

export interface ContentTypePolicyEntry {
  readonly prefix: string;
  readonly action: string;
}

/** 効いていた方針の組。`settings.urlPolicies` と `settings.contentTypePolicies`。 */
export interface Policies {
  readonly urlPolicies: readonly UrlPolicyEntry[];
  readonly contentTypePolicies: readonly ContentTypePolicyEntry[];
}

/** 正規表現で意味を持つ文字を逃がす。`*` は glob の側で先に割ってあるので含めない。 */
const escapeRegExp = (s: string): string => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

/** glob を正規表現に。ワイルドカードは `*` だけで、URL 全体に当てる。 */
const globToRegExp = (glob: string): RegExp =>
  new RegExp(`^${glob.split("*").map(escapeRegExp).join(".*")}$`);

/** `settings` の一覧から、`key` と `action` を文字列で持つ項目だけを取り出す。 */
const entriesWith = (
  settings: Record<string, unknown>,
  member: string,
  key: string,
): { value: string; action: string }[] => {
  const list = settings[member];
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) =>
    isRecord(entry) && typeof entry[key] === "string" && typeof entry["action"] === "string"
      ? [{ value: entry[key], action: entry["action"] }]
      : [],
  );
};

/**
 * `settings` に記録された方針を読む。形の誤りは `browserhive/settings-shape` と
 * `browserhive/url-policies` の担当なので、読めない項目は黙って飛ばす。
 */
export const policiesOf = (settings: Record<string, unknown>): Policies => ({
  urlPolicies: entriesWith(settings, "urlPolicies", "pattern").map(({ value, action }) => ({
    pattern: value,
    action,
  })),
  contentTypePolicies: entriesWith(settings, "contentTypePolicies", "prefix").map(
    ({ value, action }) => ({ prefix: value, action }),
  ),
});

/** URL に最初に当たった URL の方針。当たらなければ `undefined`。 */
export const firstUrlPolicy = (url: string, policies: Policies): UrlPolicyEntry | undefined =>
  policies.urlPolicies.find((p) => globToRegExp(p.pattern).test(url));

/**
 * `url` が、シークレットの値を `***` に置き換えた URL かもしれないか。そうなら、方針に照らし直した答えも、
 * 別の場所の URL と字が違うことも、取り込みのしたことを言わない。
 *
 * WACZ Profile 1.22.0 の urlPolicies: 取り込みは値を置き換える前の URL に方針を照らすので、シークレットを名乗る
 * package で `***` を持つ URL は、取り込みが当てたのと別の方針に当たるか、どれにも当たらない。読み手はその答えを
 * 取り込みのしたことと取ってはならない (MUST NOT)。置き換えで 2 つの URL が 1 つになるので、索引の MIME も
 * どちらの URL の物か分からない。写しの URL と `document-uri` は残す値も置き換えるので、`document.url` と同じ字とは
 * 限らない。
 *
 * 1.21.0 以前を名乗る archive と、シークレットを名乗らない package では `false` —— `***` はオリジンの字で、
 * 今までどおり照らす。`settings.secrets` が読めなければ、名乗っていないと見る。URL は字のまま見る（`//` や host の
 * 形を仮定しない）。
 */
export const mayHoldReplacedValue = (url: string, capture: Record<string, unknown>): boolean => {
  if (!url.includes("***") || !profileAtLeast(capture["conformsTo"], 1, 22)) return false;
  const settings = capture["settings"];
  const secrets = isRecord(settings) ? settings["secrets"] : undefined;
  return Array.isArray(secrets) && secrets.length > 0;
};

/** MIME のどれかに前方一致する content-type の方針。空の MIME (型が分からない応答) には当てない。 */
export const contentTypePolicyFor = (
  mimes: readonly string[],
  policies: Policies,
): ContentTypePolicyEntry | undefined =>
  policies.contentTypePolicies.find((p) =>
    mimes.some((mime) => mime !== "" && mime.startsWith(p.prefix)),
  );

/** CDXJ の `url` ごとの `mime`。同じ URL の応答が複数あれば、どれも拾う。索引が無ければ空。 */
export const mimesByUrl = async (wacz: WaczReader): Promise<Map<string, string[]>> => {
  const buf = await wacz.readEntry(CDXJ_ENTRY);
  const byUrl = new Map<string, string[]>();
  if (buf === undefined) return byUrl;
  for (const entry of parseCdxj(buf.toString("utf-8")).entries) {
    const url = entry.fields["url"];
    const mime = entry.fields["mime"];
    if (typeof url !== "string" || typeof mime !== "string") continue;
    byUrl.set(url, [...(byUrl.get(url) ?? []), mime]);
  }
  return byUrl;
};
