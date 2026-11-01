/**
 * Rule: warc/revisit (warning · browserhive では error · lenient では info)
 *
 * revisit の記録が、WARC-Profile の決まり（§6.7）に従っているか:
 *
 *   - WARC-Profile が 1.1 の 2 つの URI（identical-payload-digest・server-not-modified）のどちらか。
 *     他の URI は、読む側がその記録の block を解釈しない（§6.7.1）だけで違反ではないので `info`。
 *     1.0 の URI（`http://netpreserve.org/warc/1.0/revisit/…`）は同じ意味として読み、1.1 の記録で
 *     使っていれば `info` で告げる
 *   - identical-payload-digest: WARC-Payload-Digest が在る（shall）。block を残すなら、重複を省いた
 *     切り詰めなので WARC-Truncated: length が在る（shall）
 *   - 勧める欄（recommended）: どちらの profile も WARC-Refers-To。identical-payload-digest では
 *     WARC-Refers-To-Target-URI と WARC-Refers-To-Date、server-not-modified では WARC-Refers-To-Date
 *
 * WARC-Profile が無い revisit は `warc/mandatory-fields` が言う。値に `<>` が付いていれば
 * `warc/field-values` が言い、ここでは外して読む（注釈は読む側に外すことを勧める）。
 *
 * Severity: shall に反するものは spec で `warning`（再生は壊れない）、browserhive で `error`、
 * lenient で `info`。勧める欄は `info`（browserhive で `warning`）。
 *
 * Spec: https://uraitakahito.github.io/warc-specifications/specifications/warc-format/warc-1.1-annotated/#revisit
 */
import { ok } from "../../result.js";
import type { ValidationRule } from "../domain.js";
import { WarcIssueBucket } from "../warc-issue-bucket.js";
import {
  REVISIT_PROFILE_IDENTICAL_PAYLOAD_DIGEST,
  REVISIT_PROFILE_SERVER_NOT_MODIFIED,
} from "../warc11-fields.js";
import { fieldValue, recordType, scanWarcFiles, shown, type ScannedRecord } from "../warc11-scan.js";
import { stripAngleBrackets } from "../warc11-values.js";

const RULE = "warc/revisit";

type Kind =
  | "unknown-profile"
  | "profile-uri-1-0"
  | "digest-missing"
  | "truncated-missing"
  | "truncated-not-length"
  | "recommended-missing";

/** shall に反するもの。それ以外は勧めか告げるだけ。 */
const MUST: ReadonlySet<Kind> = new Set(["digest-missing", "truncated-missing", "truncated-not-length"]);

const report = (bucket: WarcIssueBucket, record: ScannedRecord, kind: Kind, params: Record<string, string> = {}): void => {
  bucket.push({
    rule: RULE,
    severity: MUST.has(kind) ? "warning" : "info",
    messageKey: `${RULE}.${kind}`,
    params: { record: String(record.index), ...params },
    location: { entry: record.entry, offset: record.offset },
  });
};

/** 1.0 の profile の URI。1.1 の URI と同じ意味として読む。 */
const PROFILE_1_0: Readonly<Record<string, string>> = {
  "http://netpreserve.org/warc/1.0/revisit/identical-payload-digest": REVISIT_PROFILE_IDENTICAL_PAYLOAD_DIGEST,
  "http://netpreserve.org/warc/1.0/revisit/server-not-modified": REVISIT_PROFILE_SERVER_NOT_MODIFIED,
};

const RECOMMENDED: Readonly<Record<string, readonly string[]>> = {
  [REVISIT_PROFILE_IDENTICAL_PAYLOAD_DIGEST]: ["WARC-Refers-To", "WARC-Refers-To-Target-URI", "WARC-Refers-To-Date"],
  [REVISIT_PROFILE_SERVER_NOT_MODIFIED]: ["WARC-Refers-To", "WARC-Refers-To-Date"],
};

export const warcRevisitRule: ValidationRule = {
  name: "warc/revisit",
  descriptionKey: `${RULE}.desc`,
  conformance: "MUST",
  docs: [
    {
      label: "WARC 1.1 §revisit",
      url: {
        en: "https://uraitakahito.github.io/warc-specifications/specifications/warc-format/warc-1.1-annotated/#revisit",
      },
    },
    {
      label: "WARC 1.1 §Profile: Identical Payload Digest",
      url: {
        en: "https://uraitakahito.github.io/warc-specifications/specifications/warc-format/warc-1.1-annotated/#profile-identical-payload-digest",
      },
    },
    {
      label: "WARC 1.1 §Profile: Server Not Modified",
      url: {
        en: "https://uraitakahito.github.io/warc-specifications/specifications/warc-format/warc-1.1-annotated/#profile-server-not-modified",
      },
    },
  ],
  applicability: {
    severityByProfile: {
      browserhive: {
        "warc/revisit.digest-missing": "error",
        "warc/revisit.truncated-missing": "error",
        "warc/revisit.truncated-not-length": "error",
        "warc/revisit.recommended-missing": "warning",
      },
      lenient: {
        "warc/revisit.digest-missing": "info",
        "warc/revisit.truncated-missing": "info",
        "warc/revisit.truncated-not-length": "info",
      },
    },
  },
  run: async (wacz) => {
    const bucket = new WarcIssueBucket();
    for (const file of await scanWarcFiles(wacz)) {
      for (const record of file.records) {
        if (!record.sound || recordType(record) !== "revisit") continue;
        const written = fieldValue(record, "WARC-Profile");
        if (written === undefined) continue;
        const uri = stripAngleBrackets(written);
        const legacy = PROFILE_1_0[uri];
        const profile = legacy ?? uri;
        if (legacy !== undefined && record.version === "1.1") report(bucket, record, "profile-uri-1-0", { value: shown(uri) });
        const recommended = RECOMMENDED[profile];
        if (recommended === undefined) {
          report(bucket, record, "unknown-profile", { value: shown(uri) });
          continue;
        }
        if (profile === REVISIT_PROFILE_IDENTICAL_PAYLOAD_DIGEST) {
          if (fieldValue(record, "WARC-Payload-Digest") === undefined) report(bucket, record, "digest-missing");
          if (record.blockLength > 0) {
            const truncated = fieldValue(record, "WARC-Truncated");
            if (truncated === undefined) report(bucket, record, "truncated-missing");
            else if (truncated.toLowerCase() !== "length") report(bucket, record, "truncated-not-length", { found: shown(truncated) });
          }
        }
        const absent = recommended.filter((name) => fieldValue(record, name) === undefined);
        if (absent.length > 0) report(bucket, record, "recommended-missing", { fields: absent.join(", ") });
      }
    }
    return ok(bucket.drain());
  },
};
