/**
 * Rule: browserhive/unintercepted-listed (error · browserhive profile 限定 · >=20.0.0)
 *
 * 取り込めなかった本文の記録 (`truncated: not-intercepted`) と、`completeness.uninterceptedUrls` が
 * 食い違わないか。
 *
 * profile 1.13.0 は、本文が wire を渡ったのにバイト列として得られなかった応答を、文字から組み直さずに本文なしで
 * 記録し、body not kept の metadata (`truncated: not-intercepted`) を書き、URL を `completeness.uninterceptedUrls`
 * に載せ、その response のレコードに `WARC-Truncated: unspecified` を付けると定める。見るのは 3 つ:
 *
 *   - metadata に在る URL が、一覧に載っているか (載っていなければ、archive は本文の欠けを申告していない)
 *   - 一覧の URL に、metadata が在るか (在らなければ、一覧が記録に無いことを言っている)
 *   - metadata が指す response (`WARC-Refers-To`) が `WARC-Truncated: unspecified` を持つか
 *     (無ければ、WARC だけを読む読み手は空の本文を本物と取り違える)
 *
 * 版の条件は、これを書き始めた BrowserHive 20.0.0。それより前の archive は、届かなかった本文を空の 200 で
 * 残していた —— この rule では見つけられない (本文が空なのは、送る本文が無かったのと区別できない)。
 *
 * Spec: https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.13.0/#records-of-bodies-not-kept
 */
import { ok } from "../../result.js";
import { getHeader, parseWarcRecord } from "../../wacz/warc-header.js";
import { iterateWarcMembers } from "../../wacz/warc-iter.js";
import { isRecord, readCapture } from "../browserhive-storage.js";
import type { Issue, ValidationRule } from "../domain.js";
import { fieldRecord, parseWarcFieldsBody } from "../../wacz/named-fields.js";

const RULE = "browserhive/unintercepted-listed";

export const browserhiveUninterceptedListedRule: ValidationRule = {
  name: "browserhive/unintercepted-listed",
  descriptionKey: `${RULE}.desc`,
  conformance: "MUST",
  docs: [
    {
      label: "BrowserHive WACZ Profile §Records of bodies not kept",
      url: {
        en: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.13.0/#records-of-bodies-not-kept",
        ja: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.13.0/ja/#records-of-bodies-not-kept",
      },
    },
  ],
  applicability: {
    excludeProfiles: ["spec", "lenient"],
    profileVersions: { browserhive: ">=20.0.0" },
  },
  run: async (wacz) => {
    const entries = wacz.warcEntries();
    const [firstEntry] = entries;
    if (firstEntry === undefined) return ok([]);

    /** 取り込めなかった本文の URL (metadata の `WARC-Target-URI`)。 */
    const recorded = new Set<string>();
    /** metadata が指す response の `WARC-Record-ID` → その URL。 */
    const referred = new Map<string, string>();
    /** response の `WARC-Record-ID` → `WARC-Truncated` の値と、その記録の在る本。 */
    const truncatedById = new Map<string, { value: string | undefined; entry: string }>();
    for (const entry of entries) {
      const buf = await wacz.readEntry(entry);
      if (buf === undefined) continue;
      for (const member of iterateWarcMembers(buf, { loose: true })) {
        const record = parseWarcRecord(member.raw);
        if (record === null) continue;
        const type = (getHeader(record, "WARC-Type") ?? "").toLowerCase();
        if (type === "response") {
          const id = getHeader(record, "WARC-Record-ID");
          if (id !== undefined) truncatedById.set(id, { value: getHeader(record, "WARC-Truncated"), entry });
          continue;
        }
        if (type !== "metadata") continue;
        if (fieldRecord(parseWarcFieldsBody(record.body).fields)["truncated"] !== "not-intercepted") continue;
        const url = getHeader(record, "WARC-Target-URI") ?? "";
        recorded.add(url);
        const target = getHeader(record, "WARC-Refers-To");
        if (target !== undefined) referred.set(target, url);
      }
    }

    const capture = await readCapture(wacz);
    const completeness = capture?.["completeness"];
    const raw = isRecord(completeness) ? completeness["uninterceptedUrls"] : undefined;
    const listed = new Set(Array.isArray(raw) ? raw.filter((url): url is string => typeof url === "string") : []);

    const issues: Issue[] = [];
    const issue = (messageKey: string, params: Record<string, string>, entry: string): void => {
      issues.push({ rule: RULE, severity: "error", messageKey: `${RULE}.${messageKey}`, params, location: { entry } });
    };
    for (const url of [...recorded].sort()) {
      if (!listed.has(url)) issue("unlisted", { url }, "datapackage.json");
    }
    for (const url of [...listed].sort()) {
      if (!recorded.has(url)) issue("unrecorded", { url }, firstEntry);
    }
    for (const [id, url] of referred) {
      const found = truncatedById.get(id);
      if (found?.value !== "unspecified") issue("truncated-header", { url, value: found?.value ?? "-" }, found?.entry ?? firstEntry);
    }
    return ok(issues);
  },
};
