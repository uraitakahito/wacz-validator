/**
 * Rule: browserhive/exchange-in-one-file (error · browserhive profile 限定 · >=21.0.0)
 *
 * 1 つの交信の記録が、同じ WARC の本に在るか。profile 1.14.0 は、`response`・`request`・`metadata` の
 * 3 つを同じ本に置くと定める (producer は組を書く前にだけ本を切り替える)。記録は互いを
 * `WARC-Concurrent-To` (応答と要求) と `WARC-Refers-To` (metadata が指す応答) で名指すので、
 * 名指した先が別の本に在れば、交信が本をまたいでいる。
 *
 * 名指した先がどの本にも無い記録は、この rule では言わない。それは参照の切れで、別の問題。
 *
 * **archive 自身の宣言 (`conformsTo`) でも分ける。** 1.14.0 より前の archive は 1 本なので、
 * またぎようがないが、読む量を減らすために同じ線で切る。
 *
 * WACZ Profile 1.16.0 から、この決まりは BrowserHive WARC Profile へ移った (1.0.0 の Records and files)。
 *
 * Spec: https://uraitakahito.github.io/browserhive-warc-spec/1.0.0/#files
 */
import { ok } from "../../result.js";
import { getHeader, parseWarcRecord } from "../../wacz/warc-header.js";
import { iterateWarcMembers } from "../../wacz/warc-iter.js";
import { profileAtLeast, readCapture } from "../browserhive-storage.js";
import type { Issue, ValidationRule } from "../domain.js";

const RULE = "browserhive/exchange-in-one-file";

/** 記録が別の記録を名指す見出しと、落ちたときの message key。 */
const LINKS: readonly { readonly header: string; readonly messageKey: string }[] = [
  { header: "WARC-Concurrent-To", messageKey: "request" },
  { header: "WARC-Refers-To", messageKey: "metadata" },
];

export const browserhiveExchangeInOneFileRule: ValidationRule = {
  name: "browserhive/exchange-in-one-file",
  descriptionKey: `${RULE}.desc`,
  conformance: "MUST",
  docs: [
    {
      label: "BrowserHive WARC Profile §Records and files",
      url: {
        en: "https://uraitakahito.github.io/browserhive-warc-spec/1.0.0/#files",
        ja: "https://uraitakahito.github.io/browserhive-warc-spec/1.0.0/ja/#files",
      },
    },
  ],
  applicability: {
    excludeProfiles: ["spec", "lenient"],
    profileVersions: { browserhive: ">=21.0.0" },
  },
  run: async (wacz) => {
    const capture = await readCapture(wacz);
    if (capture === undefined || !profileAtLeast(capture["conformsTo"], 1, 14)) return ok([]);

    const entries = wacz.warcEntries();
    if (entries.length < 2) return ok([]);

    /** `WARC-Record-ID` → その記録の在る本。 */
    const fileOf = new Map<string, string>();
    /** 他の記録を名指す記録。本を全部読んでから照らす (名指した先が後ろの本に在ることもある)。 */
    const links: { entry: string; url: string; target: string; messageKey: string }[] = [];
    for (const entry of entries) {
      const buf = await wacz.readEntry(entry);
      if (buf === undefined) continue;
      for (const member of iterateWarcMembers(buf, { loose: true })) {
        const record = parseWarcRecord(member.raw);
        if (record === null) continue;
        const id = getHeader(record, "WARC-Record-ID");
        if (id !== undefined) fileOf.set(id, entry);
        const url = getHeader(record, "WARC-Target-URI") ?? "?";
        for (const { header, messageKey } of LINKS) {
          const target = getHeader(record, header);
          if (target !== undefined) links.push({ entry, url, target, messageKey });
        }
      }
    }

    const issues: Issue[] = [];
    for (const { entry, url, target, messageKey } of links) {
      const other = fileOf.get(target);
      if (other === undefined || other === entry) continue;
      issues.push({
        rule: RULE,
        severity: "error",
        messageKey: `${RULE}.${messageKey}`,
        params: { url, entry, other },
        location: { entry },
      });
    }
    return ok(issues);
  },
};
