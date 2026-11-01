/**
 * Rule: warc/record-structure (error · 全 profile)
 *
 * WARC の各記録が、WARC 1.1 の記録の形（§4 File and record model）をしているか。見るのは:
 *
 *   - 版の行: 記録の先頭が `WARC/1.1`。`WARC/<版>` で始まらなければ記録として読まない。1.1 以外の
 *     版（`WARC/1.0` など）は、記録を 1.1 の決まりで見続けた上で、そのことを告げる
 *   - 行: 見出しの行が CRLF で終わり、`name: value` の形をしている。見出しは UTF-8 で読める。
 *     値の折り返し（次の行を空白で始めて続ける）は文法上は合法だが、注釈（#74）は書かないことを勧める
 *   - 区切り: 見出しの後の空行、`Content-Length`（数）ぶんの block、記録を閉じる CRLF CRLF
 *   - 本の先頭: WARC-Type の節は、本を warcinfo の記録で始めることを勧める
 *
 * **ここが言った記録は、他の WARC 1.1 の rule が見ない。** 欄の行が壊れていれば欄が欠けて見え、
 * 長さが合わなければ欄も block も信じられない。同じ欠陥を別の rule が別の言い方で繰り返さない
 * ように、構造に問題のある記録は `warc11-scan.ts` の `sound` で外す。版と折り返しだけは、欄を
 * 信じてよい問題として残す。`Content-Length` が無い・数でないこともここが言う（block の終わりが
 * 決まらないため）。
 *
 * Severity: 記録の形が崩れると、読み手は記録の境目を見失い、索引からの読み出しも replay も
 * 壊れるので、どの profile でも `error`。版が 1.1 でないことは spec で `warning`（BrowserHive は
 * WARC 1.1 を名乗るので browserhive で `error`、lenient で `info`）。折り返しは推奨なので `info`
 * （browserhive で `warning`）。本の先頭が warcinfo でないことは、どの profile でも `info`。
 * BrowserHive の本については `browserhive/warc-files` が producer の約束として `error` で言う。
 *
 * Spec: https://uraitakahito.github.io/warc-specifications/specifications/warc-format/warc-1.1-annotated/#file-and-record-model
 */
import { ok } from "../../result.js";
import type { WarcStructureProblem } from "../../wacz/warc-records.js";
import type { ValidationRule } from "../domain.js";
import { WarcIssueBucket } from "../warc-issue-bucket.js";
import { recordType, scanWarcFiles, shown, type ScannedRecord } from "../warc11-scan.js";

const RULE = "warc/record-structure";

const reportProblem = (bucket: WarcIssueBucket, record: ScannedRecord, problem: WarcStructureProblem): void => {
  const { kind } = problem;
  bucket.push({
    rule: RULE,
    severity: kind === "version-not-1-1" ? "warning" : kind === "folded-line" ? "info" : "error",
    messageKey: `${RULE}.${kind}`,
    // 記録の番号と行の番号は文字列で渡す（数で渡すと message が「#1,234」と桁を区切る）。
    params: {
      record: String(record.index),
      ...(problem.line !== undefined && { line: String(problem.line) }),
      ...(problem.found !== undefined && { found: shown(problem.found) }),
      ...(problem.declared !== undefined && { declared: problem.declared }),
      ...(problem.actual !== undefined && { actual: problem.actual }),
    },
    location: { entry: record.entry, offset: record.offset },
  });
};

export const warcRecordStructureRule: ValidationRule = {
  name: "warc/record-structure",
  descriptionKey: `${RULE}.desc`,
  conformance: "MUST",
  docs: [
    {
      label: "WARC 1.1 §File and record model",
      url: {
        en: "https://uraitakahito.github.io/warc-specifications/specifications/warc-format/warc-1.1-annotated/#file-and-record-model",
      },
    },
    {
      label: "WARC 1.1 §Content-Length",
      url: {
        en: "https://uraitakahito.github.io/warc-specifications/specifications/warc-format/warc-1.1-annotated/#content-length-mandatory",
      },
    },
    {
      label: "WARC 1.1 §WARC-Type",
      url: {
        en: "https://uraitakahito.github.io/warc-specifications/specifications/warc-format/warc-1.1-annotated/#warc-type-mandatory",
      },
    },
  ],
  applicability: {
    severityByProfile: {
      browserhive: {
        "warc/record-structure.version-not-1-1": "error",
        "warc/record-structure.folded-line": "warning",
      },
      lenient: {
        "warc/record-structure.version-not-1-1": "info",
      },
    },
  },
  run: async (wacz) => {
    const bucket = new WarcIssueBucket();
    for (const file of await scanWarcFiles(wacz)) {
      for (const record of file.records) {
        for (const problem of record.problems) reportProblem(bucket, record, problem);
      }
      // 本の先頭。type が無い記録は `warc/mandatory-fields` が言う。
      const first = file.records[0];
      const type = first?.sound === true ? recordType(first) : undefined;
      if (first !== undefined && type !== undefined && type !== "warcinfo") {
        bucket.push({
          rule: RULE,
          severity: "info",
          messageKey: `${RULE}.first-record-not-warcinfo`,
          params: { type: shown(type) },
          location: { entry: file.entry, offset: first.offset },
        });
      }
    }
    return ok(bucket.drain());
  },
};
