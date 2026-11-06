/**
 * Rule: cdxj/pages-mainpage
 *
 * `datapackage.json#mainPageURL` が名乗る最初のページが、WACZ の中に実際に在るか。
 * 見るのは 2 つ:
 *
 *   1. `pages/pages.jsonl` に `url` が一致する entry がある
 *   2. `indexes/index.cdxj` に少なくとも 1 件、その URL を cover する
 *      レコードがある (無いと、その URL を開く読み手は何も出せない)
 *
 * どちらかの gap でも、WACZ の "構造" は壊れない — 他の構造 check だけでは全 pass
 * してしまうため、wacz-validator が個別に捕まえる。
 *
 * 綴りは `mainPageURL` だけを読む。WACZ 1.1.1 の綴りは `mainPageUrl` だが、
 * Webrecorder の py-wacz も BrowserHive も `mainPageURL` と書く。ReplayWeb.page 2.5.0 は
 * どちらの綴りも読まないので、ここが食い違っても、その replay の開き方は変わらない。
 * この欄を最初に開く読み手のための検査。
 *
 * Severity は `warning`: その WACZ は他 URL に対する部分的な replay
 * (index に登録されている URL への deep-link) には使える可能性が
 * あるので、mainPage 参照の欠落だけで validation を fail させないように
 * している。
 */
import { ok } from "../../result.js";
import { parseCdxj } from "../../wacz/cdxj-parser.js";
import { datapackageOf } from "../datapackage-source.js";
import { parsePagesJsonl } from "../../wacz/pages.js";
import type { Issue, ValidationRule } from "../domain.js";

const PAGES_ENTRY = "pages/pages.jsonl";
const CDXJ_ENTRY = "indexes/index.cdxj";

export const cdxjPagesMainpageRule: ValidationRule = {
  name: "cdxj/pages-mainpage",
  descriptionKey: "cdxj/pages-mainpage.desc",
  conformance: "SHOULD",
  docs: [
      {
        label: "WACZ §pages",
        url: {
          en: "https://specs.webrecorder.net/wacz/1.1.1/#pages",
          ja: "https://uraitakahito.github.io/specs/wacz/1.1.1/#pages",
        },
      },
  ],
  applicability: {
    severityByProfile: {
      lenient: {
        "cdxj/pages-mainpage.not-in-pages": "info",
        "cdxj/pages-mainpage.no-cdxj-record": "info",
      },
    },
  },

  run: async (wacz) => {
    const issues: Issue[] = [];

    // 不在は `wacz/required-files` が、壊れた JSON は `datapackage/profile-required` が
    // 報告する。ここは二重報告を避け、値の正しさに専念する。
    const { parsed: pkg } = await datapackageOf(wacz);
    if (pkg === null) return ok(issues);

    const mainPageURL = pkg.mainPageURL;
    if (typeof mainPageURL !== "string" || mainPageURL.length === 0) {
      // mainPageURL の不在自体は別の producer バグだが、WACZ spec は
      // 厳密には必須としていない (Webrecorder の spec は "optional but
      // recommended" と書いている)。ここでは coverage gap だけを表面化
      // して、不在そのものは追わない。
      return ok(issues);
    }

    // Pages 側 ----------------------------------------------------------
    const pagesBuf = await wacz.readEntry(PAGES_ENTRY);
    if (pagesBuf) {
      const pages = parsePagesJsonl(pagesBuf.toString("utf-8"));
      const found = pages.entries.some((entry) => entry.url === mainPageURL);
      if (!found) {
        issues.push({
          rule: "cdxj/pages-mainpage",
          severity: "warning",
          messageKey: "cdxj/pages-mainpage.not-in-pages",
          params: { url: mainPageURL },
          location: { entry: PAGES_ENTRY },
          details: {
            mainPageURL,
            pagesUrls: pages.entries.map((e) => e.url),
          },
        });
      }
    }
    // (`pages.jsonl` 不在 → resource-hashes / file-presence 系の rule
    // が表面化する。重複ノイズを避けるためここは silent にしておく。)

    // CDXJ 側 -----------------------------------------------------------
    const cdxjBuf = await wacz.readEntry(CDXJ_ENTRY);
    if (cdxjBuf) {
      const { entries } = parseCdxj(cdxjBuf.toString("utf-8"));
      const found = entries.some((e) => e.fields["url"] === mainPageURL);
      if (!found) {
        issues.push({
          rule: "cdxj/pages-mainpage",
          severity: "warning",
          messageKey: "cdxj/pages-mainpage.no-cdxj-record",
          params: { url: mainPageURL },
          location: { entry: CDXJ_ENTRY },
          details: {
            mainPageURL,
            cdxjUrlSample: entries.slice(0, 10).map((e) => e.fields["url"]),
          },
        });
      }
    }

    return ok(issues);
  },
};
