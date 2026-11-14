/**
 * Rule: browserhive/warc-files (error · browserhive profile 限定 · >=21.0.0)
 *
 * `archive/` の WARC が、BrowserHive WACZ Profile 1.14.0 の Archive files の形か。見るのは 5 つ:
 *
 *   - 名前: `archive/` に在るのは `data-NNN.browserhive.warc.gz` (1.24.0 までを名乗る archive は
 *     `data-NNN.warc.gz`) だけで、`000` から飛びなく並ぶ
 *   - 先頭: 各本の最初の member が `warcinfo` で、`WARC-Filename` がその本の名 (`archive/` 無し)
 *     (先頭の warcinfo の決まりは、WACZ Profile 1.16.0 から BrowserHive WARC Profile 1.0.0 の #warcinfo に在る。
 *     名前・連番・大きさは WACZ Profile の Archive files に残る)
 *   - 圧縮: 各本が GZIP (先頭 2 バイトが `1f 8b`)。WACZ Profile 1.25.0 から
 *   - 大きさ: 最後以外の本は `settings.limits.maxWarcBytes` 以上 (producer は、いまの本がその大きさに
 *     達してから次を始めるので、途中の本がそれ未満なら切り替えの決まりが守られていない)
 *   - `settings.limits.maxWarcBytes` が正の整数
 *
 * **archive 自身の宣言 (`conformsTo`) でも分ける。** 1.14.0 より前の WACZ Profile は WARC の名前も数も
 * 定めていないので、1 本の `data.warc.gz` を持つ古い archive に当てては誤り。呼び手が版を名乗らない
 * 実行 (`--profile browserhive`) でも、古い archive を一斉に落とさないため。名前は 1.25.0 で
 * `data-NNN.browserhive.warc.gz` に変わったが、それより前を名乗る archive は改名しないので、照らす名前も
 * 名乗りの版で選ぶ (1.24.0 を名乗る archive の新しい名前は誤り、1.25.0 を名乗る archive の古い名前も誤り)。
 *
 * **GZIP の決まり (1.25.0) は、ここで error として見る。** `warc/extension-gzip-match` も `.warc.gz` の名で
 * 中身が gzip でない本を言うが、それは WACZ 1.1.1 の拡張子の決まりで、warning (lenient では info)。
 * GZIP でない本は member に分けて読めないので、先頭の warcinfo は見ない (大きさは見る)。
 *
 * 出典は WACZ Profile 1.25.0 の Archive files を指す。同じ節の写しの索引の決まりを `browserhive/snapshots` が、
 * スクリーンショットの索引の決まり (1.24.0 から) を `browserhive/screenshots` が見るので、同じ節は同じ版で指す
 * (`rule-docs.test.ts`)。
 *
 * Spec: https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.25.0/#archive-files
 */
import { ok } from "../../result.js";
import { getHeader, parseWarcRecord } from "../../wacz/warc-header.js";
import { iterateWarcMembers } from "../../wacz/warc-iter.js";
import { isRecord, profileAtLeast, readCapture } from "../browserhive-storage.js";
import type { Issue, ValidationRule } from "../domain.js";

const RULE = "browserhive/warc-files";
/** 本の名の形。`shape` は報告に載せる形 (`data-NNN.…`)、`file` は連番から名を組む。NNN は 10 進 3 桁。 */
interface WarcNaming {
  pattern: RegExp;
  shape: string;
  file: (n: number) => string;
}

const seq = (n: number): string => String(n).padStart(3, "0");

/** WACZ Profile 1.25.0 から: `archive/data-NNN.browserhive.warc.gz`。 */
const NAMING_1_25: WarcNaming = {
  pattern: /^archive\/data-(\d{3})\.browserhive\.warc\.gz$/,
  shape: "data-NNN.browserhive.warc.gz",
  file: (n) => `archive/data-${seq(n)}.browserhive.warc.gz`,
};

/** WACZ Profile 1.14.0〜1.24.0: `archive/data-NNN.warc.gz`。 */
const NAMING_1_14: WarcNaming = {
  pattern: /^archive\/data-(\d{3})\.warc\.gz$/,
  shape: "data-NNN.warc.gz",
  file: (n) => `archive/data-${seq(n)}.warc.gz`,
};

/** 先頭 2 バイトが gzip のマジック (1f 8b) か。 */
const isGzip = (buf: Buffer): boolean => buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;

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
        en: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.25.0/#archive-files",
        ja: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.25.0/ja/#archive-files",
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
    const since125 = profileAtLeast(capture["conformsTo"], 1, 25);
    const naming = since125 ? NAMING_1_25 : NAMING_1_14;

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
      const match = naming.pattern.exec(entry);
      if (match === null) {
        issue("name", { entry, expected: naming.shape }, entry);
        continue;
      }
      const sequence = naming.file(expected);
      if (entry !== sequence) issue("gap", { expected: sequence, found: entry }, entry);
      expected = Number(match[1]) + 1;
    }

    // 先頭の warcinfo。GZIP でない本は member に分けて読めないので、呼ぶ前に除く。
    const firstRecord = (entry: string, buf: Buffer): void => {
      const member = iterateWarcMembers(buf, { loose: true }).next().value;
      const record = member === undefined ? null : parseWarcRecord(member.raw);
      const type = record === null ? "-" : (getHeader(record, "WARC-Type") ?? "-").toLowerCase();
      if (type !== "warcinfo") {
        issue("first-record", { entry, type }, entry);
        return;
      }
      const found = record === null ? undefined : getHeader(record, "WARC-Filename");
      if (found !== entry.slice("archive/".length)) issue("filename", { entry, found: found ?? "-" }, entry);
    };

    // GZIP (1.25.0 から)・先頭の warcinfo・最後以外の本の大きさ。
    const last = entries[entries.length - 1];
    for (const entry of entries) {
      const buf = await wacz.readEntry(entry);
      if (buf === undefined) continue;
      if (since125 && !isGzip(buf)) issue("not-gzip", { entry }, entry);
      else firstRecord(entry, buf);
      if (limit !== undefined && entry !== last && buf.byteLength < limit) {
        issue("under-limit", { entry, size: String(buf.byteLength), limit: String(limit) }, entry);
      }
    }
    return ok(issues);
  },
};
