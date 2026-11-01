/**
 * Rule: warc/fields-by-type (warning · browserhive では error · lenient では info)
 *
 * 記録の type に書いてはいけない欄が書かれていないか、同じ欄が繰り返されていないか。欄と type の
 * 対応は `warc11-fields.ts` の目録に在り、ここはその「禁止」の列と「繰り返してよい」の印を読むだけ:
 *
 *   - 禁止（§5.6〜§5.21 の「shall not be used」）: warcinfo の Target-URI・Concurrent-To・
 *     IP-Address・Refers-To・Warcinfo-ID、warcinfo 以外の Filename、revisit 以外の
 *     Refers-To-Target-URI・Refers-To-Date、continuation 以外の Segment-Origin-ID・
 *     Segment-Total-Length など
 *   - payload の定義が無い記録（warcinfo・metadata）の Payload-Digest と Identified-Payload-Type
 *     （§5.9・§5.18）。§6 で payload を定義しているのは response・resource・revisit・conversion だけ
 *   - 繰り返し: 同じ記録に同じ欄は 1 つ（§5.1）。例外は WARC-Concurrent-To と、目録に無い拡張の欄
 *     （注釈 #95 は拡張の欄の繰り返しを認める）
 *   - revisit 以外の WARC-Profile は、仕様が「未定義」と言うだけで禁じてはいないので `info`
 *
 * type が 8 つのどれでもない記録（拡張）は、繰り返しだけを見る。読む側はその記録を無視する。
 *
 * Severity: 書いてはいけない欄が在っても wabac.js の再生はたいてい壊れないので、spec では
 * `warning`。BrowserHive は WARC 1.1 を名乗るので browserhive では `error`。lenient では `info`。
 *
 * Spec: https://uraitakahito.github.io/warc-specifications/specifications/warc-format/warc-1.1-annotated/#named-fields
 */
import { ok } from "../../result.js";
import type { ValidationRule } from "../domain.js";
import { WarcIssueBucket } from "../warc-issue-bucket.js";
import { fieldPresence, isWarcRecordType, warc11Url, warcFieldSpec, type WarcFieldSpec } from "../warc11-fields.js";
import { recordType, scanWarcFiles, shown, type ScannedRecord } from "../warc11-scan.js";

const RULE = "warc/fields-by-type";

type Kind = "forbidden" | "repeated" | "undefined-field";

const report = (
  bucket: WarcIssueBucket,
  record: ScannedRecord,
  kind: Kind,
  spec: WarcFieldSpec,
  params: Record<string, string>,
): void => {
  bucket.push({
    rule: RULE,
    severity: kind === "undefined-field" ? "info" : "warning",
    messageKey: `${RULE}.${kind}`,
    params: { record: String(record.index), field: spec.name, ...params },
    location: { entry: record.entry, offset: record.offset },
    details: { field: spec.name, spec: warc11Url(spec.anchor) },
  });
};

export const warcFieldsByTypeRule: ValidationRule = {
  name: "warc/fields-by-type",
  descriptionKey: `${RULE}.desc`,
  conformance: "MUST NOT",
  docs: [
    {
      label: "WARC 1.1 §Named fields",
      url: {
        en: "https://uraitakahito.github.io/warc-specifications/specifications/warc-format/warc-1.1-annotated/#named-fields",
      },
    },
    {
      label: "WARC 1.1 §WARC-Payload-Digest",
      url: {
        en: "https://uraitakahito.github.io/warc-specifications/specifications/warc-format/warc-1.1-annotated/#warc-payload-digest",
      },
    },
  ],
  applicability: {
    severityByProfile: {
      browserhive: {
        "warc/fields-by-type.forbidden": "error",
        "warc/fields-by-type.repeated": "error",
      },
      lenient: {
        "warc/fields-by-type.forbidden": "info",
        "warc/fields-by-type.repeated": "info",
      },
    },
  },
  run: async (wacz) => {
    const bucket = new WarcIssueBucket();
    for (const file of await scanWarcFiles(wacz)) {
      for (const record of file.records) {
        if (!record.sound) continue;
        // 欄の名（大小を無視）ごとの数。並びは最初に現れた順。
        const counts = new Map<string, { spec: WarcFieldSpec; count: number }>();
        for (const header of record.headers) {
          const spec = warcFieldSpec(header.name);
          if (spec === undefined) continue;
          const seen = counts.get(spec.name);
          counts.set(spec.name, { spec, count: (seen?.count ?? 0) + 1 });
        }
        const type = recordType(record);
        for (const { spec, count } of counts.values()) {
          if (count > 1 && spec.repeatable !== true) report(bucket, record, "repeated", spec, { count: String(count) });
          if (type === undefined || !isWarcRecordType(type)) continue;
          const presence = fieldPresence(spec, type);
          if (presence === "forbidden") report(bucket, record, "forbidden", spec, { type: shown(type) });
          else if (presence === "undefined") report(bucket, record, "undefined-field", spec, { type: shown(type) });
        }
      }
    }
    return ok(bucket.drain());
  },
};
