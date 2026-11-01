/**
 * Rule: warc/segmentation (warning · browserhive では error · lenient では info)
 *
 * 分割した記録（§7 Record segmentation）の列が、WARC 1.1 の決まりに従っているか。列は、先頭の記録
 * （元の type で `WARC-Segment-Number: 1`）と、その `WARC-Record-ID` を `WARC-Segment-Origin-ID` で
 * 指す continuation の記録でできる。WACZ の中の全部の本を跨いで組む（列は本を跨いでよい）:
 *
 *   - 先頭の記録の Segment-Number は "1"（shall）。Origin-ID の指す先は continuation でない（shall）
 *   - continuation の番号は 2 から 1 ずつ増える（shall。§5.19 の「increasing by 1」）
 *   - 列の全部の記録の Target-URI が同じ（shall）
 *   - 最後の continuation に Segment-Total-Length が在り（shall）、それ以外の continuation には無い
 *     （shall not）。列が全部揃っていれば、値は block の長さの合計と同じ
 *   - 先頭以外の記録には、分割の続きに要る欄の他の任意の欄を載せない（should）
 *
 * 列の一部が WACZ の外に在ることもある（分割は本を跨ぐ）。先頭が見つからない continuation と、
 * continuation の見つからない先頭は、違反と言わず `info` で告げ、数の照らし合わせはしない。
 * continuation の必須の欄が無いことは `warc/mandatory-fields`、continuation 以外の
 * Segment-Origin-ID と Segment-Total-Length は `warc/fields-by-type` が言う。
 *
 * Severity: shall に反するものは spec で `warning`（再生は壊れないことが多い）、browserhive で
 * `error`、lenient で `info`。勧めは `info`（browserhive で `warning`）。
 *
 * Spec: https://uraitakahito.github.io/warc-specifications/specifications/warc-format/warc-1.1-annotated/#record-segmentation
 */
import { ok } from "../../result.js";
import type { ValidationRule } from "../domain.js";
import { WarcIssueBucket } from "../warc-issue-bucket.js";
import { warcFieldSpec } from "../warc11-fields.js";
import { fieldValue, recordType, scanWarcFiles, shown, type ScannedRecord } from "../warc11-scan.js";
import { stripAngleBrackets } from "../warc11-values.js";

const RULE = "warc/segmentation";

type Kind =
  | "origin-number"
  | "origin-is-continuation"
  | "number-sequence"
  | "target-uri-differs"
  | "total-length-missing"
  | "total-length-not-last"
  | "total-length-mismatch"
  | "origin-not-found"
  | "no-continuation"
  | "extra-fields";

/** shall に反するもの。それ以外は勧めか告げるだけ。 */
const MUST: ReadonlySet<Kind> = new Set([
  "origin-number",
  "origin-is-continuation",
  "number-sequence",
  "target-uri-differs",
  "total-length-missing",
  "total-length-not-last",
  "total-length-mismatch",
]);

/** continuation が持ってよい欄。分割の続きに要るものと、block を確かめる欄（§7 は各 segment の Block-Digest を認める）。 */
const CONTINUATION_FIELDS: ReadonlySet<string> = new Set([
  "WARC-Type",
  "WARC-Record-ID",
  "WARC-Date",
  "Content-Length",
  "WARC-Target-URI",
  "WARC-Segment-Origin-ID",
  "WARC-Segment-Number",
  "WARC-Segment-Total-Length",
  "WARC-Block-Digest",
  "WARC-Payload-Digest",
  "WARC-Truncated",
]);

const DIGITS = /^\d+$/;

const report = (bucket: WarcIssueBucket, record: ScannedRecord, kind: Kind, params: Record<string, string> = {}): void => {
  bucket.push({
    rule: RULE,
    severity: MUST.has(kind) ? "warning" : "info",
    messageKey: `${RULE}.${kind}`,
    params: { record: String(record.index), ...params },
    location: { entry: record.entry, offset: record.offset },
  });
};

const idOf = (record: ScannedRecord, field: string): string | undefined => {
  const value = fieldValue(record, field);
  return value === undefined ? undefined : stripAngleBrackets(value);
};

/** 先頭の記録と continuation の列を照らす。 */
const checkSeries = (bucket: WarcIssueBucket, origin: ScannedRecord, continuations: readonly ScannedRecord[]): void => {
  // 番号を読めた continuation を番号順に。番号が無い・数でないものは他の rule が言う。
  const numbered = continuations
    .map((record) => ({ record, n: fieldValue(record, "WARC-Segment-Number") ?? "" }))
    .filter(({ n }) => DIGITS.test(n))
    .map(({ record, n }) => ({ record, n: Number(n) }))
    .sort((a, b) => a.n - b.n);
  const first = continuations[0];
  const allNumbered = numbered.length === continuations.length;
  const consecutive = numbered.every(({ n }, i) => n === i + 2);
  if (first !== undefined && allNumbered && !consecutive) {
    report(bucket, first, "number-sequence", { found: numbered.map(({ n }) => String(n)).join(", ") });
  }

  const expected = fieldValue(origin, "WARC-Target-URI");
  for (const record of continuations) {
    const found = fieldValue(record, "WARC-Target-URI");
    if (expected !== undefined && found !== undefined && found !== expected) {
      report(bucket, record, "target-uri-differs", { expected: shown(expected), found: shown(found) });
    }
  }

  const last = numbered.at(-1)?.record ?? continuations.at(-1);
  if (last === undefined) return;
  for (const record of continuations) {
    if (record !== last && fieldValue(record, "WARC-Segment-Total-Length") !== undefined) report(bucket, record, "total-length-not-last");
  }
  const total = fieldValue(last, "WARC-Segment-Total-Length");
  if (total === undefined) {
    report(bucket, last, "total-length-missing");
    return;
  }
  // 合計を照らすのは、列が揃っている（番号が 2 から飛ばずに並ぶ）ときだけ。
  if (!DIGITS.test(total) || !allNumbered || !consecutive) return;
  const actual = continuations.reduce((sum, record) => sum + record.blockLength, origin.blockLength);
  if (Number(total) !== actual) report(bucket, last, "total-length-mismatch", { declared: total, actual: String(actual) });
};

export const warcSegmentationRule: ValidationRule = {
  name: "warc/segmentation",
  descriptionKey: `${RULE}.desc`,
  conformance: "MUST",
  docs: [
    {
      label: "WARC 1.1 §Record segmentation",
      url: {
        en: "https://uraitakahito.github.io/warc-specifications/specifications/warc-format/warc-1.1-annotated/#record-segmentation",
      },
    },
    {
      label: "WARC 1.1 §continuation",
      url: {
        en: "https://uraitakahito.github.io/warc-specifications/specifications/warc-format/warc-1.1-annotated/#continuation",
      },
    },
  ],
  applicability: {
    severityByProfile: {
      browserhive: {
        "warc/segmentation.origin-number": "error",
        "warc/segmentation.origin-is-continuation": "error",
        "warc/segmentation.number-sequence": "error",
        "warc/segmentation.target-uri-differs": "error",
        "warc/segmentation.total-length-missing": "error",
        "warc/segmentation.total-length-not-last": "error",
        "warc/segmentation.total-length-mismatch": "error",
        "warc/segmentation.extra-fields": "warning",
      },
      lenient: {
        "warc/segmentation.origin-number": "info",
        "warc/segmentation.origin-is-continuation": "info",
        "warc/segmentation.number-sequence": "info",
        "warc/segmentation.target-uri-differs": "info",
        "warc/segmentation.total-length-missing": "info",
        "warc/segmentation.total-length-not-last": "info",
        "warc/segmentation.total-length-mismatch": "info",
      },
    },
  },
  run: async (wacz) => {
    const bucket = new WarcIssueBucket();
    const records = (await scanWarcFiles(wacz)).flatMap((file) => file.records).filter((record) => record.sound);

    const byId = new Map<string, ScannedRecord>();
    for (const record of records) {
      const id = idOf(record, "WARC-Record-ID");
      if (id !== undefined) byId.set(id, record);
    }

    // continuation を、指している先頭ごとに束ねる。
    const series = new Map<string, ScannedRecord[]>();
    for (const record of records) {
      if (recordType(record) !== "continuation") continue;
      const extras = [
        ...new Set(
          record.headers
            .map((header) => warcFieldSpec(header.name)?.name)
            .filter((name): name is string => name !== undefined && !CONTINUATION_FIELDS.has(name)),
        ),
      ];
      if (extras.length > 0) report(bucket, record, "extra-fields", { fields: extras.join(", ") });
      const origin = idOf(record, "WARC-Segment-Origin-ID");
      if (origin === undefined) continue;
      series.set(origin, [...(series.get(origin) ?? []), record]);
    }

    // 番号を持つ continuation 以外の記録は、列の先頭。番号が数でなければ `warc/field-values` が言う。
    for (const record of records) {
      if (recordType(record) === "continuation") continue;
      const n = fieldValue(record, "WARC-Segment-Number");
      if (n === undefined || !DIGITS.test(n)) continue;
      if (n !== "1") report(bucket, record, "origin-number", { found: shown(n) });
      const id = idOf(record, "WARC-Record-ID");
      if (id === undefined || !series.has(id)) report(bucket, record, "no-continuation");
    }

    for (const [originId, continuations] of series) {
      const origin = byId.get(originId);
      const first = continuations[0];
      if (first === undefined) continue;
      if (origin === undefined) {
        report(bucket, first, "origin-not-found", { origin: shown(originId) });
        continue;
      }
      if (recordType(origin) === "continuation") {
        report(bucket, first, "origin-is-continuation", { origin: shown(originId) });
        continue;
      }
      checkSeries(bucket, origin, continuations);
    }
    return ok(bucket.drain());
  },
};
