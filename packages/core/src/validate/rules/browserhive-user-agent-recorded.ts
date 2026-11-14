/**
 * Rule: browserhive/user-agent-recorded (error · browserhive profile 限定)
 *
 * `settings.userAgent` が、主文書の要求で実際に送った字と同じか。BrowserHive WACZ Profile 1.20.0 は、`WARC-Target-URI` が
 * `mainPageURL` である `request` レコードは、どれも `settings.userAgent` を `User-Agent` ヘッダに持つと定める。
 *
 * **見るのは主文書の要求だけ。** 部品の要求まで比べると、頁のスクリプトが自分で別の字を送ったときに誤って落ちる
 * (それは producer の誤りではない)。主文書の要求は頁のスクリプトより先に出るので、頁は手を出せない。
 *
 * 主文書の `request` レコードが 1 つも無い archive には何も言わない。方針や上限で記録しなかったことは別の話で、
 * 別の rule が見る。`settings.userAgent` が無い・文字列でないことは `browserhive/settings-shape` が言う。
 *
 * **archive 自身の宣言 (`conformsTo`) で分ける。** 1.20.0 より前の archive には `settings.userAgent` が無く、
 * この決まりも無い。
 *
 * Spec: https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.22.0/#settings
 */
import { ok } from "../../result.js";
import { httpHeader, parseRecord } from "../../wacz/records.js";
import { getHeader, parseWarcRecord } from "../../wacz/warc-header.js";
import { iterateWarcMembers } from "../../wacz/warc-iter.js";
import { isRecord, profileAtLeast, readCapture } from "../browserhive-storage.js";
import { datapackageOf } from "../datapackage-source.js";
import type { Issue, ValidationRule } from "../domain.js";

const RULE = "browserhive/user-agent-recorded";

export const browserhiveUserAgentRecordedRule: ValidationRule = {
  name: "browserhive/user-agent-recorded",
  descriptionKey: `${RULE}.desc`,
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
  },
  run: async (wacz) => {
    const capture = await readCapture(wacz);
    if (capture === undefined || !profileAtLeast(capture["conformsTo"], 1, 20)) return ok([]);

    const recorded = isRecord(capture["settings"]) ? capture["settings"]["userAgent"] : undefined;
    if (typeof recorded !== "string") return ok([]);

    const mainPageURL = (await datapackageOf(wacz)).parsed?.mainPageURL;
    if (typeof mainPageURL !== "string") return ok([]);

    const issues: Issue[] = [];
    for (const entry of wacz.warcEntries()) {
      const buf = await wacz.readEntry(entry);
      if (buf === undefined) continue;
      for (const member of iterateWarcMembers(buf, { loose: true })) {
        const record = parseWarcRecord(member.raw);
        if (record === null) continue;
        if (getHeader(record, "WARC-Type") !== "request" || getHeader(record, "WARC-Target-URI") !== mainPageURL) continue;
        const http = parseRecord(member.raw)?.http;
        const sent = http === undefined ? undefined : httpHeader(http, "User-Agent");
        if (sent === recorded) continue;
        issues.push({
          rule: RULE,
          severity: "error",
          messageKey: sent === undefined ? `${RULE}.absent` : `${RULE}.mismatch`,
          params: { url: mainPageURL, recorded, ...(sent !== undefined && { sent }) },
          location: { entry },
        });
      }
    }
    return ok(issues);
  },
};
