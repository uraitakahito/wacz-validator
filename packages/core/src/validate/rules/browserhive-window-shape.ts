/**
 * Rule: browserhive/window-shape (error · browserhive profile 限定)
 *
 * 開かせなかったウィンドウの記録（`window` の欄を持つ metadata）の形。
 * profile 1.12.0 は、取り込みにウィンドウを開かせず、頁が求めた 1 回ごとに `window: not-opened` の
 * metadata を書くと定める。見るのは 4 つ。`window` の値が `not-opened` であること、
 * `WARC-Target-URI` が在ること、`target` が在るなら `page` か `iframe` であること、
 * `action` を持たないこと（送らなかった要求の記録ではない）。
 *
 * **版で分けない。** 1.12.0 より前の archive に `window` の欄は無いので、見るものが無い。
 *
 * WACZ Profile 1.16.0 から、記録の形は BrowserHive WARC Profile へ移った (1.0.0 の Records of windows not
 * opened)。ウィンドウを開かせないこと自体は、WACZ Profile の windows に残る。
 *
 * Spec: https://uraitakahito.github.io/browserhive-warc-spec/1.0.0/#records-of-windows-not-opened
 */
import { ok } from "../../result.js";
import { getHeader, parseWarcRecord } from "../../wacz/warc-header.js";
import { iterateWarcMembers } from "../../wacz/warc-iter.js";
import type { Issue, ValidationRule } from "../domain.js";
import { parseWarcFields } from "../warc-fields.js";

const RULE = "browserhive/window-shape";

/** 頁がウィンドウを求める側。frame は別サイトの iframe で、browser が頁と別に走らせるもの。 */
const ASKERS: ReadonlySet<string> = new Set(["page", "iframe"]);

export const browserhiveWindowShapeRule: ValidationRule = {
  name: "browserhive/window-shape",
  descriptionKey: `${RULE}.desc`,
  conformance: "MUST",
  docs: [
    {
      label: "BrowserHive WARC Profile §Records of windows not opened",
      url: {
        en: "https://uraitakahito.github.io/browserhive-warc-spec/1.0.0/#records-of-windows-not-opened",
        ja: "https://uraitakahito.github.io/browserhive-warc-spec/1.0.0/ja/#records-of-windows-not-opened",
      },
    },
  ],
  applicability: {
    excludeProfiles: ["spec", "lenient"],
  },
  run: async (wacz) => {
    const issues: Issue[] = [];
    for (const entry of wacz.warcEntries()) {
      const buf = await wacz.readEntry(entry);
      if (buf === undefined) continue;
      const issue = (messageKey: string, params: Record<string, string>): void => {
        issues.push({ rule: RULE, severity: "error", messageKey: `${RULE}.${messageKey}`, params, location: { entry } });
      };
      for (const member of iterateWarcMembers(buf, { loose: true })) {
        const record = parseWarcRecord(member.raw);
        if (record === null) continue;
        if ((getHeader(record, "WARC-Type") ?? "").toLowerCase() !== "metadata") continue;
        const fields = parseWarcFields(record.body);
        const value = fields["window"];
        if (value === undefined) continue;
        const url = getHeader(record, "WARC-Target-URI");
        if (url === undefined) {
          issue("uri", { value });
          continue;
        }
        if (value !== "not-opened") issue("value", { url, value });
        const target = fields["target"];
        if (target !== undefined && !ASKERS.has(target)) issue("target", { url, target });
        const action = fields["action"];
        if (action !== undefined) issue("action", { url, action });
      }
    }
    return ok(issues);
  },
};
