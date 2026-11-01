/**
 * Rule: browserhive/warc-files (error · browserhive profile 限定 · >=21.0.0)
 *
 * `archive/` の WARC が、profile 1.14.0 の Archive files の形か。見るのは 4 つ:
 *
 *   - 名前: `archive/` に在るのは `data-NNN.warc.gz` だけで、`000` から飛びなく並ぶ
 *   - 先頭: 各本の最初の member が `warcinfo` で、`WARC-Filename` がその本の名 (`archive/` 無し)
 *     (先頭の warcinfo の決まりは、WACZ Profile 1.16.0 から BrowserHive WARC Profile 1.0.0 の #warcinfo に在る。
 *     名前・連番・大きさは WACZ Profile の Archive files に残る)
 *   - 大きさ: 最後以外の本は `settings.limits.maxWarcBytes` 以上 (producer は、いまの本がその大きさに
 *     達してから次を始めるので、途中の本がそれ未満なら切り替えの決まりが守られていない)
 *   - `settings.limits.maxWarcBytes` が正の整数
 *
 * **archive 自身の宣言 (`conformsTo`) でも分ける。** 1.14.0 より前の profile は WARC の名前も数も
 * 定めていないので、1 本の `data.warc.gz` を持つ古い archive に当てては誤り。呼び手が版を名乗らない
 * 実行 (`--profile browserhive`) でも、古い archive を一斉に落とさないため。
 *
 * Spec: https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.14.0/#archive-files
 */
import { ok } from "../../result.js";
import { getHeader, parseWarcRecord } from "../../wacz/warc-header.js";
import { iterateWarcMembers } from "../../wacz/warc-iter.js";
import { isRecord, profileAtLeast, readCapture } from "../browserhive-storage.js";
import type { Issue, ValidationRule } from "../domain.js";

const RULE = "browserhive/warc-files";
/** `archive/data-NNN.warc.gz`。NNN は 10 進 3 桁。 */
const SEQUENCE_NAME = /^archive\/data-(\d{3})\.warc\.gz$/;

/** 型か値の名。落ちたときに何が在ったかを言うため。 */
const describe = (v: unknown): string =>
  v === undefined ? "-" : typeof v === "number" ? String(v) : Array.isArray(v) ? "array" : typeof v;

export const browserhiveWarcFilesRule: ValidationRule = {
  name: "browserhive/warc-files",
  descriptionKey: `${RULE}.desc`,
  conformance: "MUST",
  docs: [
    {
      label: "BrowserHive WACZ Profile §Archive files",
      url: {
        en: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.14.0/#archive-files",
        ja: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.14.0/ja/#archive-files",
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

    const issues: Issue[] = [];
    const issue = (messageKey: string, params: Record<string, string>, entry?: string): void => {
      issues.push({
        rule: RULE,
        severity: "error",
        messageKey: `${RULE}.${messageKey}`,
        params,
        ...(entry !== undefined && { location: { entry } }),
      });
    };

    // 上限。無いか正の整数でなければ、大きさは照らせない。
    const settings = capture["settings"];
    const limits = isRecord(settings) ? settings["limits"] : undefined;
    const maxWarcBytes = isRecord(limits) ? limits["maxWarcBytes"] : undefined;
    const limit =
      typeof maxWarcBytes === "number" && Number.isInteger(maxWarcBytes) && maxWarcBytes > 0 ? maxWarcBytes : undefined;
    if (limit === undefined) issue("max-warc-bytes", { found: describe(maxWarcBytes) });

    // 名前と連番。`warcEntries` は名前順なので、連番なら添字と一致する。
    const entries = wacz.warcEntries();
    let expected = 0;
    for (const entry of entries) {
      const match = SEQUENCE_NAME.exec(entry);
      if (match === null) {
        issue("name", { entry }, entry);
        continue;
      }
      const sequence = `archive/data-${String(expected).padStart(3, "0")}.warc.gz`;
      if (entry !== sequence) issue("gap", { expected: sequence, found: entry }, entry);
      expected = Number(match[1]) + 1;
    }

    // 先頭の warcinfo と、最後以外の本の大きさ。
    const last = entries[entries.length - 1];
    for (const entry of entries) {
      const buf = await wacz.readEntry(entry);
      if (buf === undefined) continue;
      let first = true;
      for (const member of iterateWarcMembers(buf, { loose: true })) {
        if (!first) break;
        first = false;
        const record = parseWarcRecord(member.raw);
        const type = record === null ? "-" : (getHeader(record, "WARC-Type") ?? "-").toLowerCase();
        if (type !== "warcinfo") {
          issue("first-record", { entry, type }, entry);
          break;
        }
        const found = record === null ? undefined : getHeader(record, "WARC-Filename");
        if (found !== entry.slice("archive/".length)) issue("filename", { entry, found: found ?? "-" }, entry);
      }
      if (first) issue("first-record", { entry, type: "-" }, entry);
      if (limit !== undefined && entry !== last && buf.byteLength < limit) {
        issue("under-limit", { entry, size: String(buf.byteLength), limit: String(limit) }, entry);
      }
    }
    return ok(issues);
  },
};
