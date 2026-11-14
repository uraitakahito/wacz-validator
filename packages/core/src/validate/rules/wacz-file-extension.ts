/**
 * Rule: wacz/file-extension
 *
 * WACZ 1.1.1 の Zip Format File Extension: この形式に従う ZIP ファイルは拡張子 `.wacz` を使う (MUST)。
 * 照らすのは検証する WACZ の名前 (`WaczReader.source` の最後の段。読み方は `package-name.ts`) で、
 * その名前が `.wacz` で終わらなければ言う。名前が分からない物 (最後の段に `.` の無い http の URL) には
 * 何も言わない。
 *
 * どの profile でも走る —— 拡張子は WACZ 1.1.1 の決まりで、作り手を問わない。severity は warning:
 * 名前は ZIP の外の事柄で、中身の読み方は変わらない (この rule の外の rule は名前を見ない)。lenient では info。
 *
 * Spec: https://specs.webrecorder.net/wacz/1.1.1/#zip-format-file-extension
 */
import { ok } from "../../result.js";
import { packageNameOf } from "../package-name.js";
import type { Issue, ValidationRule } from "../domain.js";

const RULE = "wacz/file-extension";

export const waczFileExtensionRule: ValidationRule = {
  name: "wacz/file-extension",
  descriptionKey: `${RULE}.desc`,
  conformance: "MUST",
  docs: [
    {
      label: "WACZ §Zip Format File Extension",
      url: {
        en: "https://specs.webrecorder.net/wacz/1.1.1/#zip-format-file-extension",
        ja: "https://uraitakahito.github.io/specs/wacz/1.1.1/#zip-format-file-extension",
      },
    },
  ],
  applicability: {
    severityByProfile: {
      lenient: { "wacz/file-extension.extension": "info" },
    },
  },
  // 名前は source から決まり、ZIP を読まないので async は付けない (require-await 回避)。
  run: (wacz) => {
    const name = packageNameOf(wacz.source);
    const issues: Issue[] =
      name === undefined || name.endsWith(".wacz")
        ? []
        : [{ rule: RULE, severity: "warning", messageKey: `${RULE}.extension`, params: { name } }];
    return Promise.resolve(ok(issues));
  },
};
