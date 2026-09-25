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
import { isRecord } from "./browserhive-storage.js";

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
