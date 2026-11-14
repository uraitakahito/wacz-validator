/**
 * Rule: cdxj/filename-archive-relative
 *
 * 各 CDXJ entry は `filename` field を持ち、これは (offset, length)
 * ペアが seek 先とする WARC ファイル名を指す。値は WACZ の `archive/`
 * ディレクトリからの **相対** な WARC ファイル名でなければならない
 * — 例えば `data.warc.gz`、`archive/data.warc.gz` ではない。wabac.js
 * はファイル解決時に `archive/` を自分で先頭に付けるため、フルパスを
 * 書くと `archive/archive/data.warc.gz` を探しに行って全 URL が 404
 * になる。
 *
 * Spec / 慣習: WACZ spec は相対パスを明示的には pin していないが、
 *       pywb / wacz-creator / browserhive のいずれも実際にはこの
 *       形で出力していて、wabac.js は `archive/` prefix を自前で
 *       入れている。
 * Replay engine: wabac.js の WACZ file resolver (`wacz/multiwacz.ts`
 *       の loadFileFromNamedWACZ 参照) は、ZIP から fetch する前に
 *       CDXJ の filename に `archive/` を付ける。
 * Reference producer: browserhive は CDXJ の filename に WARC の本の
 *       名前だけを書く (browserhive/src/storage/wacz/cdxj.ts の
 *       注記「`filename` の意味」。値は `RecordedResponse.filename`)。
 *
 * 何を報告するか:
 *   - `filename` が `archive/` で始まる CDXJ entry → error
 *   - `filename` が無い CDXJ entry → error (replay が seek できない)
 *
 * CDXJ の parse 妥当性そのもの(行が CDXJ として読めるか = §5.2.2
 * MUST contain CDXJ data)は `cdxj/index-valid-data` の専任に分離した。
 * ここでは parse 済み entry の `filename` だけを見る。`errors` は、parse
 * 失敗行を飛ばした後の entry の元行番号を復元するためだけに参照する。
 */
import { ok } from "../../result.js";
import { parseCdxj } from "../../wacz/cdxj-parser.js";
import type { Issue, ValidationRule } from "../domain.js";

const CDXJ_ENTRY = "indexes/index.cdxj";

export const cdxjFilenameRule: ValidationRule = {
  name: "cdxj/filename-archive-relative",
  descriptionKey: "cdxj/filename-archive-relative.desc",
  conformance: "MUST",
  docs: [
      {
        label: "WACZ §indexes",
        url: {
          en: "https://specs.webrecorder.net/wacz/1.1.1/#indexes",
          ja: "https://uraitakahito.github.io/specs/wacz/1.1.1/#indexes",
        },
      },
  ],
  applicability: {
    severityByProfile: {
      lenient: {
        "cdxj/filename-archive-relative.no-filename": "warning",
        "cdxj/filename-archive-relative.starts-with-archive": "warning",
      },
    },
  },

  run: async (wacz) => {
    const issues: Issue[] = [];
    const buf = await wacz.readEntry(CDXJ_ENTRY);
    if (!buf) {
      // WACZ が wabac.js 認識可能な index を 1 つでも持つかは
      // `cdxj/index-recognised-by-wabac` の責務。ここでは silent に
      // する。同じ "index 欠落" 状況に対して 2 つ別々の不満が出ない
      // ようにするため。新 rule が全 profile で正式な error を出す。
      return ok(issues);
    }

    const { entries, errors } = parseCdxj(buf.toString("utf-8"));

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry) continue;
      const filename = entry.fields["filename"];
      const lineNum = i + 1 + errors.filter((e) => e.line <= i + 1).length;

      if (typeof filename !== "string" || filename.length === 0) {
        issues.push({
          rule: "cdxj/filename-archive-relative",
          severity: "error",
          messageKey: "cdxj/filename-archive-relative.no-filename",
          params: { entry: CDXJ_ENTRY },
          location: { entry: CDXJ_ENTRY, line: lineNum },
          details: { surt: entry.surt, timestamp: entry.timestamp },
        });
        continue;
      }

      if (filename.startsWith("archive/")) {
        issues.push({
          rule: "cdxj/filename-archive-relative",
          severity: "error",
          messageKey: "cdxj/filename-archive-relative.starts-with-archive",
          params: { entry: CDXJ_ENTRY },
          location: { entry: CDXJ_ENTRY, line: lineNum },
          details: {
            surt: entry.surt,
            actual: filename,
            expected: filename.slice("archive/".length),
          },
        });
      }
    }

    return ok(issues);
  },
};
