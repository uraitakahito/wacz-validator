/**
 * Rule: browserhive/settings-shape(browserhive profile 限定 · >=8.0.0)
 *
 * `browserhive:capture.settings` が、profile 1.3.0 が定める必須 member を
 * すべて持っているか。
 *
 * **この rule が無かったせいで、仕様と実装が 1 つずれたまま何版か流れた。**
 * 1.1.0 は `cache` を必須と書いていたが、実装はそれを `session` に畳んだあと
 * 仕様を直しておらず、どの producer も `cache` を書いていなかった。適合を
 * 名乗るアーカイブが必須 member を欠いていても、誰も気づけない状態だった。
 * 1.2.0 で `cache` は `session` に置き換えられ、この rule がその種のずれを
 * これからは捕まえる。
 *
 * 見るのは **member が在るか** と、値がその型かどうかだけ。値の中身
 * (viewport が何ピクセルか、どの behavior が走ったか) は producer が決めることで、
 * profile も綴りを定めていない。
 *
 * `acceptLanguage` は任意なので見ない —— 不在は「設定しなかった」で、違反ではない。
 *
 * `userAgent` は profile 1.20.0 で、`secretArchive` は profile 1.22.0 で必須になった。**archive 自身の宣言
 * (`conformsTo`) で分ける** —— それより前の版を名乗る archive には、その member を書く決まりが無い。
 *
 * `secretArchive` は、値を残すと頼まれたシークレットの名前 → `"keep"`。名前は要求が渡したシークレットのどれかなので、
 * 鍵が `settings.secrets` の部分集合で、値が `keep` であることも見る。文には名前だけを書き、欄の値は報告へ写さない
 * —— `keep` でない値が何なのかは分からず、シークレットの値かもしれない。
 *
 * 版の条件があるのは、`urlPolicies` が browserhive 8.0.0 で入ったため。
 * それ未満のアーカイブに 1.2.0 の MUST を当てて落とすのは、検証器として誤り。
 *
 * Spec: https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.22.0/#settings
 */
import { ok } from "../../result.js";
import { isRecord, profileAtLeast, readCapture } from "../browserhive-storage.js";
import type { Issue, ValidationRule } from "../domain.js";

const RULE = "browserhive/settings-shape";

interface Member {
  readonly name: string;
  readonly check: (v: unknown) => boolean;
}

/** どの型を期待するか。profile 1.3.0 §settings の表がそのまま並ぶ。 */
const REQUIRED: readonly Member[] = [
  { name: "signature", check: (v) => typeof v === "string" },
  { name: "viewport", check: isRecord },
  { name: "devicePixelRatios", check: Array.isArray },
  { name: "session", check: (v) => typeof v === "string" },
  { name: "behaviors", check: Array.isArray },
  { name: "limits", check: isRecord },
  { name: "urlPolicies", check: Array.isArray },
  { name: "contentTypePolicies", check: Array.isArray },
];

/** profile 1.20.0 で必須になった member。 */
const REQUIRED_SINCE_1_20: readonly Member[] = [{ name: "userAgent", check: (v) => typeof v === "string" }];

/** profile 1.22.0 で必須になった member。 */
const REQUIRED_SINCE_1_22: readonly Member[] = [{ name: "secretArchive", check: isRecord }];

export const browserhiveSettingsShapeRule: ValidationRule = {
  name: "browserhive/settings-shape",
  descriptionKey: "browserhive/settings-shape.desc",
  conformance: "MUST",
  docs: [
    {
      label: "BrowserHive WACZ Profile §settings",
      url: {
        en: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.22.0/#settings",
        ja: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.22.0/ja/#settings",
      },
    },
  ],
  applicability: {
    excludeProfiles: ["spec", "lenient"],
    profileVersions: { browserhive: ">=8.0.0" },
  },
  run: async (wacz) => {
    const capture = await readCapture(wacz);
    // browserhive のアーカイブではない / datapackage が読めない。
    // その場合、この profile の MUST を当てる相手がそもそも居ない。
    if (capture === undefined) return ok([]);

    const settings = capture["settings"];
    if (!isRecord(settings)) {
      return ok([
        {
          rule: RULE,
          severity: "error",
          messageKey: `${RULE}.missing`,
          params: {},
        } satisfies Issue,
      ]);
    }

    const issues: Issue[] = [];
    const required = [
      ...REQUIRED,
      ...(profileAtLeast(capture["conformsTo"], 1, 20) ? REQUIRED_SINCE_1_20 : []),
      ...(profileAtLeast(capture["conformsTo"], 1, 22) ? REQUIRED_SINCE_1_22 : []),
    ];
    for (const { name, check } of required) {
      const value = settings[name];
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

    // 版は上の member の一覧と同じ線で切る。名前は要求が渡したシークレットのどれかで、値は keep だけ。
    const secretArchive = settings["secretArchive"];
    if (profileAtLeast(capture["conformsTo"], 1, 22) && isRecord(secretArchive)) {
      const secrets = settings["secrets"];
      const names: readonly unknown[] = Array.isArray(secrets) ? secrets : [];
      for (const [name, value] of Object.entries(secretArchive)) {
        if (!names.includes(name)) {
          issues.push({ rule: RULE, severity: "error", messageKey: `${RULE}.secret-archive-name`, params: { name } });
        }
        if (value !== "keep") {
          issues.push({ rule: RULE, severity: "error", messageKey: `${RULE}.secret-archive-value`, params: { name } });
        }
      }
    }
    return ok(issues);
  },
};
