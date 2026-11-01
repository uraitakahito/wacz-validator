/**
 * Rule: warc/content-type (info · browserhive では warning)
 *
 * 記録の Content-Type が、WARC 1.1 の勧める値か:
 *
 *   - block が空でない記録（continuation を除く）は Content-Type を持つ（§5.6 の should）
 *   - Target-URI が http・https の response と request は `application/http`（§6.3.2・§6.5.2 の
 *     should）。`msgtype` を書くなら、記録の type と同じ（response なら response）
 *   - warcinfo は `application/warc-fields`（§6.2 の recommended）。§8 は warcinfo と metadata の型を
 *     shall で決めているように読めるが、注釈（errata #50）は §6.2・§6.6 と食い違うとして他の型も
 *     認めると読む。ここもそれに従って勧めとして扱う。metadata は §6.6 が may と言うだけなので見ない
 *
 * 値が media-type の文法に合わないときは `warc/field-values` が言うので、ここでは見ない。
 *
 * Severity: どれも should なので spec では `info`。BrowserHive は WARC 1.1 を名乗るので
 * browserhive では `warning`。
 *
 * Spec: https://uraitakahito.github.io/warc-specifications/specifications/warc-format/warc-1.1-annotated/#content-type
 */
import { ok } from "../../result.js";
import type { ValidationRule } from "../domain.js";
import { WarcIssueBucket } from "../warc-issue-bucket.js";
import { isWarcRecordType } from "../warc11-fields.js";
import { fieldValue, recordType, scanWarcFiles, shown, type ScannedRecord } from "../warc11-scan.js";
import { parseMediaType, stripAngleBrackets } from "../warc11-values.js";

const RULE = "warc/content-type";

type Kind = "missing" | "not-application-http" | "msgtype-mismatch" | "warcinfo-not-warc-fields";

const report = (bucket: WarcIssueBucket, record: ScannedRecord, kind: Kind, params: Record<string, string>): void => {
  bucket.push({
    rule: RULE,
    severity: "info",
    messageKey: `${RULE}.${kind}`,
    params: { record: String(record.index), ...params },
    location: { entry: record.entry, offset: record.offset },
  });
};

export const warcContentTypeRule: ValidationRule = {
  name: "warc/content-type",
  descriptionKey: `${RULE}.desc`,
  conformance: "SHOULD",
  docs: [
    {
      label: "WARC 1.1 §Content-Type",
      url: {
        en: "https://uraitakahito.github.io/warc-specifications/specifications/warc-format/warc-1.1-annotated/#content-type",
      },
    },
    {
      label: "WARC 1.1 §response",
      url: {
        en: "https://uraitakahito.github.io/warc-specifications/specifications/warc-format/warc-1.1-annotated/#http-and-https-schemes",
      },
    },
    {
      label: "WARC 1.1 §warcinfo",
      url: {
        en: "https://uraitakahito.github.io/warc-specifications/specifications/warc-format/warc-1.1-annotated/#warcinfo",
      },
    },
  ],
  applicability: {
    severityByProfile: {
      browserhive: {
        "warc/content-type.missing": "warning",
        "warc/content-type.not-application-http": "warning",
        "warc/content-type.msgtype-mismatch": "warning",
        "warc/content-type.warcinfo-not-warc-fields": "warning",
      },
    },
  },
  run: async (wacz) => {
    const bucket = new WarcIssueBucket();
    for (const file of await scanWarcFiles(wacz)) {
      for (const record of file.records) {
        if (!record.sound) continue;
        const type = recordType(record);
        if (type === undefined || !isWarcRecordType(type) || type === "continuation") continue;
        const value = fieldValue(record, "Content-Type");
        if (value === undefined) {
          if (record.blockLength > 0) report(bucket, record, "missing", { type });
          continue;
        }
        const media = parseMediaType(value);
        if (media === undefined) continue;
        if (type === "warcinfo") {
          if (media.type !== "application/warc-fields") report(bucket, record, "warcinfo-not-warc-fields", { value: shown(value) });
          continue;
        }
        if (type !== "response" && type !== "request") continue;
        const target = stripAngleBrackets(fieldValue(record, "WARC-Target-URI") ?? "");
        if (!/^https?:/i.test(target)) continue;
        if (media.type !== "application/http") {
          report(bucket, record, "not-application-http", { type, value: shown(value) });
          continue;
        }
        const msgtype = media.parameters["msgtype"];
        if (msgtype !== undefined && msgtype.toLowerCase() !== type) {
          report(bucket, record, "msgtype-mismatch", { type, msgtype: shown(msgtype) });
        }
      }
    }
    return ok(bucket.drain());
  },
};
