/**
 * Rule: browserhive/axtree-shape(browserhive profile 限定 · >=3.8.0)
 *
 * `accessibility/axtree.jsonl` の中身が、BrowserHive WACZ Profile の定める形に従っているか。
 *
 * 「在るか」と「壊れていないか」はここでは見ない —— それぞれ
 * `datapackage/resources-complete`(ZIP の実体がすべて宣言されているか)と
 * `datapackage/resource-hashes`(宣言と実体の hash 一致)が既に見ている。
 * この rule に残るのは**中身**だけ。
 *
 * 確かめるのは 4 つ:
 *
 *   1. 各行が JSON として読め、profile を名乗っている
 *   2. スナップショットが必須の member を持っている
 *   3. ノードに、この版で許されない property が付いていない
 *   4. 畳まれているはずの role が残っていない
 *
 * 3 と 4 は「刈り込みが宣言どおりに働いたか」を問う検査。producer が規則を
 * 変えたのに profile の版を上げなければ、ここが鳴る。
 *
 * 版の条件があるのは、このディレクトリが browserhive 3.8.0 で入ったため。
 * それ未満では無くて当然で、走らせなかったことは `Report.skipped` に残る。
 *
 * Spec: https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.1.0/#accessibility
 */
import { ok } from "../../result.js";
import {
  ALLOWED_NODE_KEYS,
  AXTREE_ENTRY,
  COLLAPSED_ROLES,
  EXPECTED_PROFILE,
  readAxtree,
  REQUIRED_MEMBERS,
  walkTree,
} from "../browserhive-axtree.js";
import type { Issue, ValidationRule } from "../domain.js";

export const browserhiveAxtreeShapeRule: ValidationRule = {
  name: "browserhive/axtree-shape",
  descriptionKey: "browserhive/axtree-shape.desc",
  conformance: "MUST",
  docs: [
    {
      label: "BrowserHive WACZ Profile §accessibility",
      url: {
        en: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.1.0/#accessibility",
        ja: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.1.0/ja/#accessibility",
      },
    },
  ],
  applicability: {
    excludeProfiles: ["spec", "lenient"],
    profileVersions: { browserhive: ">=3.8.0" },
  },

  run: async (wacz) => {
    const lines = await readAxtree(wacz);
    // エントリが無いのは「撮っていない」。在ることを求めるのはこの rule の仕事ではない。
    if (lines === null) return ok([]);

    const issues: Issue[] = [];

    for (const { lineNumber, parsed } of lines) {
      if (parsed === null) {
        issues.push({
          rule: "browserhive/axtree-shape",
          severity: "error",
          messageKey: "browserhive/axtree-shape.not-json",
          params: { entry: AXTREE_ENTRY, line: String(lineNumber) },
        });
        continue;
      }

      const profile = parsed["profile"];
      if (profile !== EXPECTED_PROFILE) {
        // 版が違えば、下の property 検査は別の規則を当てていることになる。
        // 判断の材料が無いので、この行はここで打ち切る。
        issues.push({
          rule: "browserhive/axtree-shape",
          severity: "error",
          messageKey: "browserhive/axtree-shape.unknown-profile",
          params: {
            line: String(lineNumber),
            found: typeof profile === "string" ? profile : String(profile),
            expected: EXPECTED_PROFILE,
          },
        });
        continue;
      }

      const missing = REQUIRED_MEMBERS.filter((m) => parsed[m] === undefined);
      if (missing.length > 0) {
        issues.push({
          rule: "browserhive/axtree-shape",
          severity: "error",
          messageKey: "browserhive/axtree-shape.missing-member",
          params: { line: String(lineNumber), members: missing.join(", ") },
        });
      }

      const unknownKeys = new Set<string>();
      const collapsedRoles = new Set<string>();

      walkTree(parsed["tree"], (node) => {
        for (const key of Object.keys(node)) {
          if (!ALLOWED_NODE_KEYS.has(key)) unknownKeys.add(key);
        }
        const role = node["role"];
        if (typeof role === "string" && COLLAPSED_ROLES.has(role)) {
          collapsedRoles.add(role);
        }
      });

      // 種類ごとに 1 件へ畳む。1 ページに数百ノードあるので、ノードごとに出すと
      // 報告が読めなくなる —— 直すべき事実は「その key が在る」で 1 つ。
      if (unknownKeys.size > 0) {
        issues.push({
          rule: "browserhive/axtree-shape",
          severity: "error",
          messageKey: "browserhive/axtree-shape.unknown-property",
          params: { line: String(lineNumber), keys: [...unknownKeys].sort().join(", ") },
        });
      }

      if (collapsedRoles.size > 0) {
        issues.push({
          rule: "browserhive/axtree-shape",
          severity: "error",
          messageKey: "browserhive/axtree-shape.collapsed-role",
          params: { line: String(lineNumber), roles: [...collapsedRoles].sort().join(", ") },
        });
      }
    }

    return ok(issues);
  },
};
