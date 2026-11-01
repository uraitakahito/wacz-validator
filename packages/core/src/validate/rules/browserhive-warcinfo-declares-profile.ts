/**
 * Rule: browserhive/warcinfo-declares-profile (error · browserhive profile 限定)
 *
 * archive/ の WARC の本が、適合する BrowserHive WARC Profile の版を自分で名乗っているか。
 * WACZ Profile 1.16.0 は、archive/ の WARC がどれも BrowserHive WARC Profile に適合し、その版を
 * 先頭の warcinfo の `conformsTo` で名乗ると定める。見るのは 3 つ:
 *
 *   - 各本の warcinfo に `conformsTo` がちょうど 1 つ在る。2 つ並ぶと、読み手はどちらを正とすればよいか
 *     決められない (`parseWarcFields` は後の値で上書きするので、数えるのに `warcFieldValues` を使う)
 *   - 値が BrowserHive WARC Profile の版の URL (`https://uraitakahito.github.io/browserhive-warc-spec/N.N.N/`)。
 *     WARC 1.1 そのもの (IIPC の頁) を名乗る本は、BrowserHive の決まりに辿り着けない
 *   - 全部の本で同じ値。1 つの取り込みは 1 つの producer が書くので、版が違えば、別の取り込みの本が
 *     混ざったか、取り込みの途中で書き手が変わった
 *
 * 先頭が warcinfo でない本は、この rule では言わない。それは `browserhive/warc-files` の
 * first-record が言う。
 *
 * **archive 自身の宣言 (`conformsTo`) で分ける。** WACZ Profile 1.15.0 までの archive の WARC は、
 * WARC 1.1 の頁を名乗っていた。それは当時の決まりどおりなので、1.16.0 より前を名乗る archive と、
 * 名乗りが無いか読めない archive には当てない。
 *
 * Spec: https://uraitakahito.github.io/browserhive-warc-spec/1.0.0/#warcinfo
 */
import { ok } from "../../result.js";
import { getHeader, parseWarcRecord, type ParsedWarcRecord } from "../../wacz/warc-header.js";
import { iterateWarcMembers } from "../../wacz/warc-iter.js";
import { profileAtLeast, readCapture } from "../browserhive-storage.js";
import type { Issue, ValidationRule } from "../domain.js";
import { warcFieldValues } from "../warc-fields.js";

const RULE = "browserhive/warcinfo-declares-profile";

/** BrowserHive WARC Profile の版の URL。版ごとの文書を指し、`latest/` は版ではないので通さない。 */
const WARC_PROFILE_URL = /^https:\/\/uraitakahito\.github\.io\/browserhive-warc-spec\/\d+\.\d+\.\d+\/$/;

/** 本の最初のレコード。読めなければ `null`。 */
const firstRecord = (buf: Buffer): ParsedWarcRecord | null => {
  for (const member of iterateWarcMembers(buf, { loose: true })) return parseWarcRecord(member.raw);
  return null;
};

export const browserhiveWarcinfoDeclaresProfileRule: ValidationRule = {
  name: "browserhive/warcinfo-declares-profile",
  descriptionKey: `${RULE}.desc`,
  conformance: "MUST",
  docs: [
    {
      label: "BrowserHive WARC Profile §The warcinfo record",
      url: {
        en: "https://uraitakahito.github.io/browserhive-warc-spec/1.0.0/#warcinfo",
        ja: "https://uraitakahito.github.io/browserhive-warc-spec/1.0.0/ja/#warcinfo",
      },
    },
  ],
  applicability: {
    excludeProfiles: ["spec", "lenient"],
  },
  run: async (wacz) => {
    const capture = await readCapture(wacz);
    if (capture === undefined || !profileAtLeast(capture["conformsTo"], 1, 16)) return ok([]);

    const issues: Issue[] = [];
    const issue = (messageKey: string, params: Record<string, string>, entry: string): void => {
      issues.push({ rule: RULE, severity: "error", messageKey: `${RULE}.${messageKey}`, params, location: { entry } });
    };

    // 最初に正しく名乗った本の値。ほかの本はこれと照らす。
    let first: { entry: string; value: string } | undefined;
    for (const entry of wacz.warcEntries()) {
      const buf = await wacz.readEntry(entry);
      if (buf === undefined) continue;
      const record = firstRecord(buf);
      if (record === null || (getHeader(record, "WARC-Type") ?? "").toLowerCase() !== "warcinfo") continue;

      const values = warcFieldValues(record.body, "conformsTo");
      const [value] = values;
      if (value === undefined) {
        issue("missing", { entry }, entry);
        continue;
      }
      if (values.length > 1) {
        issue("repeated", { entry, count: String(values.length), found: values.join(", ") }, entry);
        continue;
      }
      if (!WARC_PROFILE_URL.test(value)) {
        issue("value", { entry, found: value }, entry);
        continue;
      }
      if (first === undefined) first = { entry, value };
      else if (value !== first.value) issue("mismatch", { entry, found: value, first: first.entry, expected: first.value }, entry);
    }
    return ok(issues);
  },
};
