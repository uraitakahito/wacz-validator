/**
 * Rule: warc/field-values (warning · browserhive では error · lenient では info)
 *
 * WARC 1.1 が定める欄の値が、その欄の形をしているか。形は `warc11-fields.ts` の目録が欄ごとに
 * 決め、照らし方は `warc11-values.ts` に在る:
 *
 *   - `<uri>`: Record-ID・Concurrent-To・Refers-To・Warcinfo-ID・Segment-Origin-ID（§5.2 ほか）
 *   - `<>` を付けない URI: Target-URI・Refers-To-Target-URI・Profile。1.1 で `uri` の文法から
 *     `<>` が外れた。読む側は外して読む（注釈）が、書く側は付けない
 *   - W3CDTF の UTC・小数は 1〜9 桁: Date・Refers-To-Date（§5.4）
 *   - 数: Segment-Number・Segment-Total-Length。Content-Length は `warc/record-structure` が見る
 *   - `algorithm:value`: Block-Digest・Payload-Digest。値に `=` と `/` を許す（errata #48）
 *   - IPv4 の dotted quad か RFC 4291 の IPv6（角括弧は付けない）: IP-Address
 *   - media-type（`;` の前後の空白を許す。errata #38）: Content-Type・Identified-Payload-Type
 *
 * 推奨に反するもの（digest の label の大文字・注釈 #80、RFC 5952 の正規形でない IPv6・注釈 #100）は
 * `info`。仕様が定義しない値（8 つ以外の WARC-Type、4 つ以外の WARC-Truncated）は拡張として
 * 認められているので、どの profile でも `info`。
 *
 * Severity: 値の形が崩れていても wabac.js の再生はたいてい壊れないので、spec では `warning`。
 * BrowserHive は WARC 1.1 を名乗るので browserhive では `error`（推奨は `warning`）。
 * lenient では `info`。
 *
 * Spec: https://uraitakahito.github.io/warc-specifications/specifications/warc-format/warc-1.1-annotated/#named-fields
 */
import { ok } from "../../result.js";
import type { ValidationRule } from "../domain.js";
import { WarcIssueBucket } from "../warc-issue-bucket.js";
import { warc11Url, warcFieldSpec } from "../warc11-fields.js";
import { scanWarcFiles, shown } from "../warc11-scan.js";
import { checkFieldValue } from "../warc11-values.js";

const RULE = "warc/field-values";

export const warcFieldValuesRule: ValidationRule = {
  name: "warc/field-values",
  descriptionKey: `${RULE}.desc`,
  conformance: "MUST",
  docs: [
    {
      label: "WARC 1.1 §Named fields",
      url: {
        en: "https://uraitakahito.github.io/warc-specifications/specifications/warc-format/warc-1.1-annotated/#named-fields",
      },
    },
  ],
  applicability: {
    severityByProfile: {
      browserhive: {
        "warc/field-values.empty": "error",
        "warc/field-values.record-id-form": "error",
        "warc/field-values.uri-angle-brackets": "error",
        "warc/field-values.uri-form": "error",
        "warc/field-values.date-form": "error",
        "warc/field-values.date-fraction-digits": "error",
        "warc/field-values.date-not-utc": "error",
        "warc/field-values.digits-form": "error",
        "warc/field-values.digest-form": "error",
        "warc/field-values.ip-brackets": "error",
        "warc/field-values.ip-form": "error",
        "warc/field-values.media-type-form": "error",
        "warc/field-values.digest-label-uppercase": "warning",
        "warc/field-values.ip-not-canonical": "warning",
      },
      lenient: {
        "warc/field-values.empty": "info",
        "warc/field-values.record-id-form": "info",
        "warc/field-values.uri-angle-brackets": "info",
        "warc/field-values.uri-form": "info",
        "warc/field-values.date-form": "info",
        "warc/field-values.date-fraction-digits": "info",
        "warc/field-values.date-not-utc": "info",
        "warc/field-values.digits-form": "info",
        "warc/field-values.digest-form": "info",
        "warc/field-values.ip-brackets": "info",
        "warc/field-values.ip-form": "info",
        "warc/field-values.media-type-form": "info",
      },
    },
  },
  run: async (wacz) => {
    const bucket = new WarcIssueBucket();
    for (const file of await scanWarcFiles(wacz)) {
      for (const record of file.records) {
        if (!record.sound) continue;
        for (const header of record.headers) {
          const spec = warcFieldSpec(header.name);
          // 目録に無い欄（拡張）は形を知らない。Content-Length は `warc/record-structure` が見る。
          if (spec === undefined || spec.name === "Content-Length") continue;
          const verdict = checkFieldValue(spec.value, header.value);
          const kind = verdict.violation ?? verdict.advisory;
          if (kind === undefined) continue;
          bucket.push({
            rule: RULE,
            severity: verdict.violation !== undefined ? "warning" : "info",
            messageKey: `${RULE}.${kind}`,
            params: { record: String(record.index), field: spec.name, value: shown(header.value), ...verdict.params },
            location: { entry: record.entry, offset: record.offset },
            details: { field: spec.name, spec: warc11Url(spec.anchor) },
          });
        }
      }
    }
    return ok(bucket.drain());
  },
};
