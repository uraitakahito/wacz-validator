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
 * Spec: https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.12.0/#windows
 */
import { ok } from "../../result.js";
import { getHeader, parseWarcRecord } from "../../wacz/warc-header.js";
import { iterateWarcMembers } from "../../wacz/warc-iter.js";
import type { Issue, ValidationRule } from "../domain.js";
import { parseWarcFields } from "../warc-fields.js";

const RULE = "browserhive/window-shape";
const WARC_ENTRY = "archive/data.warc.gz";

/** 頁がウィンドウを求める側。frame は別サイトの iframe で、browser が頁と別に走らせるもの。 */
const ASKERS: ReadonlySet<string> = new Set(["page", "iframe"]);

export const browserhiveWindowShapeRule: ValidationRule = {
  name: "browserhive/window-shape",
  descriptionKey: `${RULE}.desc`,
  conformance: "MUST",
  docs: [
    {
      label: "BrowserHive WACZ Profile §windows",
      url: {
        en: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.12.0/#windows",
        ja: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.12.0/ja/#windows",
      },
    },
  ],
  applicability: {
    excludeProfiles: ["spec", "lenient"],
  },
  run: async (wacz) => {
    const buf = await wacz.readEntry(WARC_ENTRY);
    if (buf === undefined) return ok([]);

    const issues: Issue[] = [];
    const issue = (messageKey: string, params: Record<string, string>): void => {
      issues.push({ rule: RULE, severity: "error", messageKey: `${RULE}.${messageKey}`, params, location: { entry: WARC_ENTRY } });
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
    return ok(issues);
  },
};
