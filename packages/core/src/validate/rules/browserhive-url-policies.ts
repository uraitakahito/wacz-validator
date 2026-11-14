/**
 * Rule: browserhive/url-policies(browserhive profile 限定 · >=8.0.0)
 *
 * `settings.urlPolicies` が、順序付きの policy の一覧として読める形をしているか。
 *
 * **不在と空は別々に意味を持つ**ところが、この member の要。BrowserHive WACZ Profile 1.3.0 は
 * 「一致が 1 件も無くても書く」と要求し、空の配列を「効いていた policy が無い」
 * という積極的な主張として定めた。書かなければ、読み手は「特別なものを何も
 * 要求しなかったページ」と「要求されたものを記録しないことにした取り込み」を
 * 区別できない。証憑として読むとき、この 2 つは同じパッケージについての別の主張になる。
 *
 * **`action` を見るのがもう 1 つの要。** これが述べているのは
 * 「リクエストが送られたかどうか」で、`deny` と `no-archive` の差は
 * 相手のサーバに痕跡が残ったかどうかそのもの。値が読めなければ、
 * archive は「何かを落とした」までしか言えなくなる。
 *
 * したがってこの rule は:
 *
 *   - 空の配列を **通す**(それが「濾していない」の綴り)
 *   - member ごと無いものを **落とす**(何も述べていない)
 *   - `pattern` が文字列でない項目を落とす —— 一致した metadata レコードの
 *     `pattern` はここに並ぶ原文と突き合わせる前提なので、綴りが読めないと
 *     突き合わせようがない
 *   - `action` がこの版の定める 3 つ以外の項目を落とす
 *
 * 在ることそのものは `settings-shape` も見ている。あちらは 1.3.0 の必須 member が
 * 揃っているかを一括で問い、こちらはこの member 固有の意味だけを持つ。
 *
 * Spec: https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.3.0/#policies
 */
import { ok } from "../../result.js";
import { isRecord, readCapture } from "../browserhive-storage.js";
import type { Issue, ValidationRule } from "../domain.js";

const RULE = "browserhive/url-policies";

/** WACZ Profile 1.3.0 が定める action。ここに無い値は、この版では読めない。 */
const ACTIONS = new Set(["deny", "no-archive", "no-body"]);

export const browserhiveUrlPoliciesRule: ValidationRule = {
  name: "browserhive/url-policies",
  descriptionKey: "browserhive/url-policies.desc",
  conformance: "MUST",
  docs: [
    {
      label: "BrowserHive WACZ Profile §URL and media type policies",
      url: {
        en: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.3.0/#policies",
        ja: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.3.0/ja/#policies",
      },
    },
  ],
  applicability: {
    excludeProfiles: ["spec", "lenient"],
    profileVersions: { browserhive: ">=8.0.0" },
  },
  run: async (wacz) => {
    const capture = await readCapture(wacz);
    if (capture === undefined) return ok([]);

    const settings = capture["settings"];
    if (!isRecord(settings)) return ok([]); // 形の不在は settings-shape の担当。

    const policies = settings["urlPolicies"];
    if (policies === undefined) {
      return ok([
        {
          rule: RULE,
          severity: "error",
          messageKey: `${RULE}.absent`,
          params: {},
        } satisfies Issue,
      ]);
    }
    if (!Array.isArray(policies)) {
      return ok([
        {
          rule: RULE,
          severity: "error",
          messageKey: `${RULE}.not-array`,
          params: { found: typeof policies },
        } satisfies Issue,
      ]);
    }

    // 空は通す。それが「濾していない」という主張の綴り。
    const issues: Issue[] = [];
    let badPattern = 0;
    const badActions = new Set<string>();
    for (const entry of policies) {
      if (!isRecord(entry) || typeof entry["pattern"] !== "string") {
        badPattern += 1;
        continue;
      }
      const action = entry["action"];
      if (typeof action !== "string" || !ACTIONS.has(action)) {
        badActions.add(typeof action === "string" ? action : String(action));
      }
    }
    if (badPattern > 0) {
      issues.push({
        rule: RULE,
        severity: "error",
        messageKey: `${RULE}.bad-pattern`,
        params: { count: String(badPattern) },
      });
    }
    // 種類ごとに 1 件へ畳む。同じ綴り違いが 100 件あっても、直すべき事実は 1 つ。
    if (badActions.size > 0) {
      issues.push({
        rule: RULE,
        severity: "error",
        messageKey: `${RULE}.unknown-action`,
        params: { found: [...badActions].sort().join(", ") },
      });
    }
    return ok(issues);
  },
};
