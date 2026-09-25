/**
 * Rule: browserhive/policy-not-truncated (error · browserhive profile 限定 · >=12.2.0)
 *
 * 方針で省いた本文が、上限で落とした本文として `completeness.truncatedUrls` に載っていないか。
 *
 * profile 1.9.0 の MUST NOT: 要求者が設定した方針 (`urlPolicies` の `no-body`、または
 * `contentTypePolicies` の項目) で省いた本文は、**大きさに関係なく** `truncatedUrls` に載せては
 * ならない。取り込みはその本文をそもそも取りに行っていないので、上限で落とされたはずがない。
 * content-type の方針の分は 1.8.0 から MUST NOT だった。
 *
 * BrowserHive は 12.2.0 より前、上限を超える大きさの本文でこれを取り違えていた —— 方針で
 * 省いた本文を `truncated: too-large` と記録し、`truncatedUrls` に載せていた。版の条件は
 * 規範が揃った 12.2.0 にしてあるが、版を渡さずに走らせれば古い archive にも当たるので、
 * 取り違えた archive を洗い出すのにも使える。
 *
 * 照らし方: `truncatedUrls` の各 URL を、`settings` に記録された方針に照らす。URL の方針は
 * 最初に当たったものだけが効き、それが `no-body` のときだけ本文を省く。content-type の方針は
 * CDXJ の `mime` (Chrome が報せた型で、recorder が照らしたのと同じもの) の前方一致で、大文字と
 * 小文字を区別する。照合の規則は profile ではなく BrowserHive の model が定める (glob の
 * ワイルドカードは `*` だけ)。
 *
 * Spec: https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.9.0/#completeness
 */
import { ok } from "../../result.js";
import {
  contentTypePolicyFor,
  firstUrlPolicy,
  mimesByUrl,
  policiesOf,
} from "../browserhive-policies.js";
import { isRecord, readCapture } from "../browserhive-storage.js";
import type { Issue, ValidationRule } from "../domain.js";

const RULE = "browserhive/policy-not-truncated";

export const browserhivePolicyNotTruncatedRule: ValidationRule = {
  name: "browserhive/policy-not-truncated",
  descriptionKey: `${RULE}.desc`,
  conformance: "MUST",
  docs: [
    {
      label: "BrowserHive WACZ Profile §completeness",
      url: {
        en: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.9.0/#completeness",
        ja: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.9.0/ja/#completeness",
      },
    },
  ],
  applicability: {
    excludeProfiles: ["spec", "lenient"],
    profileVersions: { browserhive: ">=12.2.0" },
  },
  run: async (wacz) => {
    const capture = await readCapture(wacz);
    if (capture === undefined) return ok([]);
    const completeness = capture["completeness"];
    const settings = capture["settings"];
    if (!isRecord(completeness) || !isRecord(settings)) return ok([]);
    const listed = completeness["truncatedUrls"];
    if (!Array.isArray(listed) || listed.length === 0) return ok([]);

    const policies = policiesOf(settings);
    const mimes = await mimesByUrl(wacz);

    const issues: Issue[] = [];
    for (const url of listed) {
      if (typeof url !== "string") continue;
      // URL の方針は最初に当たったものだけが効き、当たれば content-type の方針より先に決まる。
      // deny / no-archive が先に当たった URL は応答として記録されないので、何も言わない。
      const first = firstUrlPolicy(url, policies);
      if (first !== undefined) {
        if (first.action === "no-body") {
          issues.push({
            rule: RULE,
            severity: "error",
            messageKey: `${RULE}.url-policy`,
            params: { url, pattern: first.pattern },
            location: { entry: "datapackage.json" },
          });
        }
        continue;
      }
      const matched = contentTypePolicyFor(mimes.get(url) ?? [], policies);
      if (matched !== undefined) {
        issues.push({
          rule: RULE,
          severity: "error",
          messageKey: `${RULE}.content-type`,
          params: { url, prefix: matched.prefix },
          location: { entry: "datapackage.json" },
        });
      }
    }
    return ok(issues);
  },
};
