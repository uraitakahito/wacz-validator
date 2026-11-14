/**
 * Rule: browserhive/behaviors-shape(browserhive profile 限定 · >=8.6.0)
 *
 * `behaviors/custom.jsonl` の中身と、`settings.behaviors` との対応。
 *
 * 「在るか」と「壊れていないか」はここでは見ない —— それぞれ
 * `datapackage/resources-complete`(ZIP の実体がすべて宣言されているか)と
 * `datapackage/resource-hashes`(宣言と実体の hash 一致)が既に見ている。
 *
 * 確かめるのは 3 つ:
 *
 *   1. 各行が JSON として読め、版を名乗り、必須 member を持っている
 *   2. `settings.behaviors` が `origin: "custom"` と述べた id は、すべてここに行がある
 *   3. 逆は求めない —— **行は対応する項目を持たなくてよい**
 *
 * 3 が要点。持ち込まれた source は runtime のバンドルに連結され
 * `register(<class 式>)` として評価されるので、そのあと `isMatch()` が false を
 * 返して `run()` が呼ばれなくても、**class 式そのものはページ上で走っている**。
 * 1 対 1 を求めると、実行されたコードを記録した archive を不適合にしてしまう。
 *
 * `behaviors/` の不在は違反ではない。behavior を注入しなかった取り込みでは
 * エントリごと無いのが正しい形で、在ることを求めるのはこの rule の仕事ではない。
 *
 * 版の条件があるのは、このディレクトリが browserhive 8.6.0 で入ったため。
 * それ未満では無くて当然で、走らせなかったことは `Report.skipped` に残る。
 *
 * Spec: https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.5.0/#behaviors-directory
 */
import { ok } from "../../result.js";
import { readCapture } from "../browserhive-storage.js";
import {
  customIdsFromSettings,
  EXPECTED_PROFILE,
  readCustomBehaviors,
  REQUIRED_MEMBERS,
} from "../browserhive-behaviors.js";
import type { Issue, ValidationRule } from "../domain.js";

const RULE = "browserhive/behaviors-shape";

export const browserhiveBehaviorsShapeRule: ValidationRule = {
  // docs の抽出器はソースを文字列として読むので、ここは定数ではなく
  // リテラルで書く (他の rule も同じ)。
  name: "browserhive/behaviors-shape",
  descriptionKey: `${RULE}.desc`,
  conformance: "MUST",
  docs: [
    {
      label: "BrowserHive WACZ Profile §behaviors",
      url: {
        en: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.5.0/#behaviors-directory",
        ja: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.5.0/ja/#behaviors-directory",
      },
    },
  ],
  applicability: {
    excludeProfiles: ["spec", "lenient"],
    profileVersions: { browserhive: ">=8.6.0" },
  },
  run: async (wacz) => {
    const capture = await readCapture(wacz);
    // BrowserHive WACZ ではない / datapackage が読めない。
    if (capture === undefined) return ok([]);

    const declared = customIdsFromSettings(capture);
    const lines = await readCustomBehaviors(wacz);

    // エントリが無いのは「持ち込みを置かなかった」。それ自体は正しい形だが、
    // settings が持ち込みを申告しているなら食い違っている。
    if (lines === null) {
      return ok(
        declared.map(
          (id) =>
            ({
              rule: RULE,
              severity: "error",
              messageKey: `${RULE}.missing-entry`,
              params: { id },
            }) satisfies Issue,
        ),
      );
    }

    const issues: Issue[] = [];
    const present = new Set<string>();

    for (const { lineNumber, parsed } of lines) {
      const where = String(lineNumber);
      if (parsed === null) {
        issues.push({
          rule: RULE,
          severity: "error",
          messageKey: `${RULE}.not-json`,
          params: { line: where },
        });
        continue;
      }
      if (parsed["profile"] !== EXPECTED_PROFILE) {
        // 版が違えば、下の member 検査は別の規則を当てていることになる。
        // 判断の材料が無いので、この行はここで打ち切る。
        issues.push({
          rule: RULE,
          severity: "error",
          messageKey: `${RULE}.unknown-profile`,
          params: { line: where, found: String(parsed["profile"]) },
        });
        continue;
      }
      const missing = REQUIRED_MEMBERS.filter((m) => typeof parsed[m] !== "string");
      if (missing.length > 0) {
        issues.push({
          rule: RULE,
          severity: "error",
          messageKey: `${RULE}.missing-member`,
          params: { line: where, members: missing.join(", ") },
        });
        continue;
      }
      present.add(parsed["id"] as string);
    }

    // settings が申告した持ち込みは、すべて中身が在らねばならない。
    // **逆は見ない** —— 置かれたが何もしなかった behavior は行だけが残る。
    for (const id of declared) {
      if (!present.has(id)) {
        issues.push({
          rule: RULE,
          severity: "error",
          messageKey: `${RULE}.source-missing`,
          params: { id },
        });
      }
    }

    return ok(issues);
  },
};
