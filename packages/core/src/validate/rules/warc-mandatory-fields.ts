/**
 * Rule: warc/mandatory-fields (warning · browserhive では error · lenient では info)
 *
 * WARC 1.1 が記録に必ず書けと定める欄が在るか。欄と type の対応は `warc11-fields.ts` の目録に在り、
 * ここはその「必須」の列を読むだけ:
 *
 *   - すべての記録: `WARC-Record-ID`・`WARC-Date`・`WARC-Type`（§5.2〜§5.5）。`Content-Length` も
 *     必須だが、無ければ block の終わりが決まらないので `warc/record-structure` が言う
 *   - response・resource・request・revisit・conversion・continuation: `WARC-Target-URI`（§5.12）
 *   - revisit: `WARC-Profile`（§5.15）
 *   - continuation: `WARC-Segment-Number` と `WARC-Segment-Origin-ID`（§5.19・§5.20）
 *
 * 分割の先頭の `WARC-Segment-Number: 1` と、最後の continuation の `WARC-Segment-Total-Length` は、
 * 記録を並べて見ないと要るかどうかが決まらないので `warc/segmentation` が言う。type が 8 つの
 * どれでもない記録（拡張）は、すべての記録に要る 3 つだけを見る。読む側はその記録を無視する
 * （`warc/field-values` が告げる）。
 *
 * Severity: 欄が欠けても wabac.js の再生はたいてい壊れないので、spec では `warning`。
 * BrowserHive は WARC 1.1 を名乗るので browserhive では `error`。lenient では `info`。
 *
 * Spec: https://uraitakahito.github.io/warc-specifications/specifications/warc-format/warc-1.1-annotated/#named-fields
 */
import { ok } from "../../result.js";
import type { ValidationRule } from "../domain.js";
import { WarcIssueBucket } from "../warc-issue-bucket.js";
import {
  fieldPresence,
  isWarcRecordType,
  WARC11_FIELDS,
  WARC_RECORD_TYPES,
  warc11Url,
  type WarcFieldSpec,
} from "../warc11-fields.js";
import { fieldValues, recordType, scanWarcFiles, shown, type ScannedRecord } from "../warc11-scan.js";

const RULE = "warc/mandatory-fields";

/** すべての type に必須の欄。`Content-Length` は `warc/record-structure` が持つ。 */
const UNIVERSAL = WARC11_FIELDS.filter(
  (spec) => spec.name !== "Content-Length" && WARC_RECORD_TYPES.every((type) => spec.mandatoryOn?.includes(type)),
);

/** type ごとに必須になる欄（すべての type に必須のものを除く）。 */
const BY_TYPE = WARC11_FIELDS.filter((spec) => spec.name !== "Content-Length" && !UNIVERSAL.includes(spec));

const absent = (record: ScannedRecord, spec: WarcFieldSpec): boolean => fieldValues(record, spec.name).length === 0;

export const warcMandatoryFieldsRule: ValidationRule = {
  name: "warc/mandatory-fields",
  descriptionKey: `${RULE}.desc`,
  conformance: "MUST",
  docs: [
    {
      label: "WARC 1.1 §Named fields",
      url: {
        en: "https://uraitakahito.github.io/warc-specifications/specifications/warc-format/warc-1.1-annotated/#named-fields",
      },
    },
    {
      label: "WARC 1.1 §WARC-Target-URI",
      url: {
        en: "https://uraitakahito.github.io/warc-specifications/specifications/warc-format/warc-1.1-annotated/#warc-target-uri",
      },
    },
  ],
  applicability: {
    severityByProfile: {
      browserhive: {
        "warc/mandatory-fields.missing": "error",
        "warc/mandatory-fields.missing-for-type": "error",
      },
      lenient: {
        "warc/mandatory-fields.missing": "info",
        "warc/mandatory-fields.missing-for-type": "info",
      },
    },
  },
  run: async (wacz) => {
    const bucket = new WarcIssueBucket();
    for (const file of await scanWarcFiles(wacz)) {
      for (const record of file.records) {
        if (!record.sound) continue;
        const missing = (spec: WarcFieldSpec, type?: string): void => {
          bucket.push({
            rule: RULE,
            severity: "warning",
            messageKey: type === undefined ? `${RULE}.missing` : `${RULE}.missing-for-type`,
            params: { record: String(record.index), field: spec.name, ...(type !== undefined && { type: shown(type) }) },
            location: { entry: record.entry, offset: record.offset },
            details: { field: spec.name, spec: warc11Url(spec.anchor) },
          });
        };
        for (const spec of UNIVERSAL) if (absent(record, spec)) missing(spec);
        const type = recordType(record);
        if (type === undefined || !isWarcRecordType(type)) continue;
        for (const spec of BY_TYPE) {
          if (fieldPresence(spec, type) === "mandatory" && absent(record, spec)) missing(spec, type);
        }
      }
    }
    return ok(bucket.drain());
  },
};
