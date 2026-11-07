/**
 * Rule: browserhive/crashed-targets-listed (error · browserhive profile 限定)
 *
 * `completeness.crashedTargets` (renderer が落ちた、主文書以外の target) が、profile の決まりどおりか。
 * WACZ Profile 1.21.0 は次を定める。
 *
 *   - 配列で必ず在る。各項目は `type` と `status` を文字列で持ち、`url` は在るなら文字列
 *   - `complete` は 4 つの配列がすべて空のときだけ `true`。一覧が空でないのに `true` なら、archive は
 *     ページの一部が取り込みの間に死んだことを、自分で打ち消している
 *   - `url`、`type`、`status` の順に整列し、`url` の無い項目を前に置く
 *   - `url` に最初に当たる方針が `no-archive` か `deny` のときと、`document` が `withheld` を持つときは、
 *     `url` を書かない。target の URL は頁から来るので、残さないでと頼まれた物を持ち出してしまう
 *
 * **落ちたこと自体は確かめられない。** renderer の crash は WARC に現れないので、見るのは archive の申告が
 * 自分自身と食い違っていないかまで。
 *
 * **archive 自身の宣言 (`conformsTo`) で分ける。** 1.21.0 より前の archive には `crashedTargets` が無い。
 *
 * Spec: https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.21.0/#completeness-crashed-targets
 */
import { ok } from "../../result.js";
import { firstUrlPolicy, policiesOf } from "../browserhive-policies.js";
import { isRecord, profileAtLeast, readCapture } from "../browserhive-storage.js";
import type { Issue, ValidationRule } from "../domain.js";

const RULE = "browserhive/crashed-targets-listed";

/** 形が正しい項目。 */
interface CrashedTarget {
  readonly type: string;
  readonly status: string;
  readonly url?: string;
}

const asCrashedTarget = (entry: unknown): CrashedTarget | undefined => {
  if (!isRecord(entry)) return undefined;
  const { type, status, url } = entry;
  if (typeof type !== "string" || typeof status !== "string") return undefined;
  if (url === undefined) return { type, status };
  return typeof url === "string" ? { type, status, url } : undefined;
};

/**
 * producer と同じ比べ方 (`localeCompare`)。`url` の無い項目は空の字として前に来る。
 * code point で比べると、大文字を含む URL の並びを誤って落とす。
 */
const compare = (a: CrashedTarget, b: CrashedTarget): number =>
  (a.url ?? "").localeCompare(b.url ?? "", "en") ||
  a.type.localeCompare(b.type, "en") ||
  a.status.localeCompare(b.status, "en");

export const browserhiveCrashedTargetsListedRule: ValidationRule = {
  name: "browserhive/crashed-targets-listed",
  descriptionKey: `${RULE}.desc`,
  conformance: "MUST",
  docs: [
    {
      label: "BrowserHive WACZ Profile §crashedTargets",
      url: {
        en: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.21.0/#completeness-crashed-targets",
        ja: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.21.0/ja/#completeness-crashed-targets",
      },
    },
  ],
  applicability: {
    excludeProfiles: ["spec", "lenient"],
  },
  run: async (wacz) => {
    const capture = await readCapture(wacz);
    if (capture === undefined || !profileAtLeast(capture["conformsTo"], 1, 21)) return ok([]);
    const completeness = capture["completeness"];
    if (!isRecord(completeness)) return ok([]);

    const issues: Issue[] = [];
    const issue = (messageKey: string, params: Record<string, string> = {}): void => {
      issues.push({
        rule: RULE,
        severity: "error",
        messageKey: `${RULE}.${messageKey}`,
        params,
        location: { entry: "datapackage.json" },
      });
    };

    const listed = completeness["crashedTargets"];
    if (!Array.isArray(listed)) {
      issue("missing");
      return ok(issues);
    }
    if (listed.length > 0 && completeness["complete"] === true) issue("complete-true");

    const settings = capture["settings"];
    const policies = policiesOf(isRecord(settings) ? settings : {});
    const document = capture["document"];
    const withheld = isRecord(document) ? document["withheld"] : undefined;

    let previous: CrashedTarget | undefined;
    for (const [index, entry] of listed.entries()) {
      const target = asCrashedTarget(entry);
      if (target === undefined) {
        issue("bad-entry", { index: String(index) });
        continue;
      }
      if (previous !== undefined && compare(previous, target) > 0) issue("unsorted", { index: String(index) });
      previous = target;

      if (target.url === undefined) continue;
      if (typeof withheld === "string") {
        issue("url-by-document", { url: target.url, withheld });
        continue;
      }
      const first = firstUrlPolicy(target.url, policies);
      if (first?.action === "no-archive" || first?.action === "deny") {
        issue("url-by-policy", { url: target.url, pattern: first.pattern, action: first.action });
      }
    }
    return ok(issues);
  },
};
