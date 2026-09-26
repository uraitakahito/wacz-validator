/**
 * Rule: browserhive/deny-enforced (error · browserhive profile 限定)
 *
 * URL の方針の `deny` が守られたか。最初に当たる方針が `deny` の URL に、送った要求の記録
 * (`request`) か、届いた応答の記録 (`response`・`revisit`) があれば落とす。
 *
 * profile は `deny` を「要求を送らない」と定める。1.11.0 からは、取り込みが起こすすべての要求
 * (遷移・フレーム・worker・service worker・ページが開くウィンドウ) に届くと明記した。`deny` の
 * 当たった URL について archive が持ってよいのは、送らなかったことを言う metadata の記録
 * (`action: deny`) だけで、要求や応答の記録は、その URL が取り込みの機械を出た証拠になる。
 *
 * 照合は `browserhive/document-withheld` と同じ共有部分を使う。URL 全体に当てる glob で、
 * ワイルドカードは `*` だけ、最初に当たった方針だけが効く。だから `?from=…` の付いた URL に、
 * query を見込まない pattern は当たらない。
 *
 * **版で分けない。** 送らない約束は profile の最初の版からある。ただし BrowserHive v17.0.0 までは
 * 主文書への `deny` で要求を止められず、そのとき記録器は応答を捨てて `action: deny` の記録だけを
 * 書いたので、その漏れはこの rule には見えない (身元が archive に無いという document-withheld の
 * warning が言う)。
 *
 * Spec: https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.11.0/#urlpolicies
 */
import { ok } from "../../result.js";
import { getHeader, parseWarcRecord } from "../../wacz/warc-header.js";
import { iterateWarcMembers } from "../../wacz/warc-iter.js";
import { firstUrlPolicy, policiesOf } from "../browserhive-policies.js";
import { isRecord, readCapture } from "../browserhive-storage.js";
import type { Issue, ValidationRule } from "../domain.js";

const RULE = "browserhive/deny-enforced";
const WARC_ENTRY = "archive/data.warc.gz";

/** 要求が取り込みの機械を出たことを言う記録の型。 */
const SENT_TYPES: ReadonlySet<string> = new Set(["request", "response", "revisit"]);

export const browserhiveDenyEnforcedRule: ValidationRule = {
  name: "browserhive/deny-enforced",
  descriptionKey: `${RULE}.desc`,
  conformance: "MUST",
  docs: [
    {
      label: "BrowserHive WACZ Profile §urlPolicies",
      url: {
        en: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.11.0/#urlpolicies",
        ja: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.11.0/ja/#urlpolicies",
      },
    },
  ],
  applicability: {
    excludeProfiles: ["spec", "lenient"],
  },
  run: async (wacz) => {
    const capture = await readCapture(wacz);
    const settings = capture?.["settings"];
    // 方針が読めなければ照らさない。settings の不在や形は別の rule が言う。
    if (!isRecord(settings)) return ok([]);
    const policies = policiesOf(settings);
    if (!policies.urlPolicies.some((policy) => policy.action === "deny")) return ok([]);

    const buf = await wacz.readEntry(WARC_ENTRY);
    if (buf === undefined) return ok([]);

    const issues: Issue[] = [];
    // 同じ URL の要求と応答は 1 件にまとめる。何度送ったかではなく、送ったかが問い。
    const reported = new Set<string>();
    for (const member of iterateWarcMembers(buf, { loose: true })) {
      const record = parseWarcRecord(member.raw);
      if (record === null) continue;
      const type = (getHeader(record, "WARC-Type") ?? "").toLowerCase();
      if (!SENT_TYPES.has(type)) continue;
      const url = getHeader(record, "WARC-Target-URI");
      if (url === undefined || reported.has(url)) continue;
      const first = firstUrlPolicy(url, policies);
      if (first?.action !== "deny") continue;
      reported.add(url);
      issues.push({
        rule: RULE,
        severity: "error",
        messageKey: `${RULE}.sent`,
        params: { url, pattern: first.pattern, type },
        location: { entry: WARC_ENTRY },
      });
    }
    return ok(issues);
  },
};
