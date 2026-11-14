/**
 * Rule: browserhive/wacz-name (warning · browserhive profile 限定)
 *
 * BrowserHive WACZ Profile 1.25.0 の Package name: producer は BrowserHive WACZ に `.browserhive.wacz` で
 * 終わる名前を付ける (SHOULD)。照らすのは検証する WACZ の名前 (`WaczReader.source` の最後の段。読み方は
 * `package-name.ts`) で、名前が分かって `.browserhive.wacz` で終わらなければ言う。
 *
 * **名前から適合を推さない。** 印は手がかりで、宣言ではない —— 適合を言うのは `browserhive:capture.conformsTo`
 * だけで (WACZ Profile 1.25.0 の Conformance declaration)、印の無い名前に改めても適合は変わらない。だから
 * この rule は印の無いことを warning で見せるだけで、ほかの rule は名前で当て分けない。
 *
 * **archive 自身の宣言 (`conformsTo`) で分ける。** 印は WACZ Profile 1.25.0 で入ったので、それより前を名乗る
 * archive (BrowserHive v30 以前の WACZ。改名しない) と、名乗りが無いか読めない archive には当てない。
 * 拡張子 `.wacz` そのもの (WACZ 1.1.1 の MUST) は `wacz/file-extension` が言う。
 *
 * Spec: https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.25.0/#package-name
 */
import { ok } from "../../result.js";
import { profileAtLeast, readCapture } from "../browserhive-storage.js";
import { packageNameOf } from "../package-name.js";
import type { Issue, ValidationRule } from "../domain.js";

const RULE = "browserhive/wacz-name";

export const browserhiveWaczNameRule: ValidationRule = {
  name: "browserhive/wacz-name",
  descriptionKey: `${RULE}.desc`,
  conformance: "SHOULD",
  docs: [
    {
      label: "BrowserHive WACZ Profile §Package name",
      url: {
        en: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.25.0/#package-name",
        ja: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.25.0/ja/#package-name",
      },
    },
  ],
  applicability: {
    excludeProfiles: ["spec", "lenient"],
  },
  run: async (wacz) => {
    const name = packageNameOf(wacz.source);
    if (name === undefined || name.endsWith(".browserhive.wacz")) return ok([]);
    const capture = await readCapture(wacz);
    if (capture === undefined || !profileAtLeast(capture["conformsTo"], 1, 25)) return ok([]);
    const issue: Issue = { rule: RULE, severity: "warning", messageKey: `${RULE}.name`, params: { name } };
    return ok([issue]);
  },
};
