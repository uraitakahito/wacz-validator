/**
 * Rule: browserhive/dismissal-shape (browserhive profile 限定 · >=8.5.0)
 *
 * `browserhive:capture.dismissal` が在るとき、その形が BrowserHive WACZ Profile 1.4.0 の定めどおりか。
 *
 * **見るのは 2 つの主張だけで、どちらも「結果が反証できるか」に関わる。**
 *
 * ① `selectors` と `heuristic` が在ること。当たりが 0 でも書く member なので、
 *    無ければ結果が検証できない —— 空の `removedSelectors` は、20 本探した場合でも
 *    1 本も探さなかった場合でも同じに読める。`urlPolicies` を一致 0 でも必須に
 *    しているのと同じ理屈。
 *
 * ② `unreadable: true` と結果が同居していないこと。遂行できなかった除去は何も
 *    観測していないので、その隣に空の結果を書くことは「ページはバナーを持たなかった」
 *    という、その取り込みが稼いでいない主張になる。`storage` の
 *    「両方の area を持つか `unreadable: true` のどちらか」と同じ形。
 *
 * **値の中身は見ない。** どのセレクタが効いていたか、いくつ消したかは producer が
 * 決めることで、WACZ Profile も綴りを定めていない。
 *
 * `dismissal` の不在は違反ではない —— 除去を試みなかった取り込みでは member ごと
 * 書かないのが正しい。不在が「配信されたままのページを保存した」を意味する以上、
 * 在ることを必須にはできない。
 *
 * 版の条件があるのは、`dismissal` が browserhive 8.5.0 で入ったため。それ未満の
 * アーカイブに 1.4.0 の MUST を当てて落とすのは、検証器として誤り。
 *
 * Spec: https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.4.0/#dismissal
 */
import { ok } from "../../result.js";
import { isRecord, readCapture } from "../browserhive-storage.js";
import type { Issue, ValidationRule } from "../domain.js";

const RULE = "browserhive/dismissal-shape";

/** 在ることが必須な入力。WACZ Profile 1.4.0 §dismissal の「Required: yes」の行。 */
const REQUIRED: readonly { readonly name: string; readonly check: (v: unknown) => boolean }[] = [
  { name: "selectors", check: Array.isArray },
  { name: "heuristic", check: isRecord },
];

/** 観測の member。`unreadable` と並べてはならないもの。 */
const OUTCOME = [
  "framework",
  "removedSelectors",
  "unusableSelectors",
  "removedOverlays",
] as const;

export const browserhiveDismissalShapeRule: ValidationRule = {
  // docs の抽出器はソースを文字列として読むので、ここは定数ではなく
  // リテラルで書く (他の rule も同じ)。
  name: "browserhive/dismissal-shape",
  descriptionKey: `${RULE}.desc`,
  conformance: "MUST",
  docs: [
    {
      label: "BrowserHive WACZ Profile §dismissal",
      url: {
        en: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.4.0/#dismissal",
        ja: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.4.0/ja/#dismissal",
      },
    },
  ],
  applicability: {
    excludeProfiles: ["spec", "lenient"],
    profileVersions: { browserhive: ">=8.5.0" },
  },
  run: async (wacz) => {
    const capture = await readCapture(wacz);
    if (capture === undefined) return ok([]);

    const dismissal = capture["dismissal"];
    // 除去を試みなかった取り込み。member ごと不在なのが正しい形。
    if (dismissal === undefined) return ok([]);

    if (!isRecord(dismissal)) {
      return ok([
        {
          rule: RULE,
          severity: "error",
          messageKey: `${RULE}.not-object`,
          params: { found: Array.isArray(dismissal) ? "array" : typeof dismissal },
        } satisfies Issue,
      ]);
    }

    const issues: Issue[] = [];
    for (const { name, check } of REQUIRED) {
      const value = dismissal[name];
      if (value === undefined) {
        issues.push({
          rule: RULE,
          severity: "error",
          messageKey: `${RULE}.missing-member`,
          params: { member: name },
        });
      } else if (!check(value)) {
        issues.push({
          rule: RULE,
          severity: "error",
          messageKey: `${RULE}.wrong-type`,
          params: { member: name, found: Array.isArray(value) ? "array" : typeof value },
        });
      }
    }

    if (dismissal["unreadable"] !== undefined) {
      const stated = OUTCOME.filter((member) => dismissal[member] !== undefined);
      if (stated.length > 0) {
        issues.push({
          rule: RULE,
          severity: "error",
          messageKey: `${RULE}.unreadable-with-outcome`,
          params: { members: stated.join(", ") },
        });
      }
    }

    return ok(issues);
  },
};
