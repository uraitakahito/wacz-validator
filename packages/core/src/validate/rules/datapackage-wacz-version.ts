/**
 * Rule: datapackage/wacz-version-required
 *
 * `datapackage.json` は空でない `wacz_version` 文字列を必ず持つ必要が
 * ある。値も制約しており、公表されている WACZ spec rev (1.0.0 /
 * 1.1.0 / 1.1.1) を受け入れる。それ以外は `warning` を発火する
 * (field は認識されているが replay 挙動は未検証); 欠落の場合は
 * `error`。
 *
 * Spec: WACZ 1.1.1 §datapackage.json (`wacz_version` は producer が
 *       どの feature set を emit したかを宣言する spec-rev タグ)。
 * Reference producer: browserhive は "1.1.1" を出力する。
 */
import { ok } from "../../result.js";
import { datapackageOf, DATAPACKAGE_ENTRY } from "../datapackage-source.js";
import type { Issue, ValidationRule } from "../domain.js";

/**
 * Known-good な WACZ バージョン。browserhive や他のサポート対象
 * producer が新しい spec rev を出したら拡張する。末尾の `as const`
 * によって、配列の型が literal union に narrow される。
 */
const KNOWN_VERSIONS = ["1.0.0", "1.1.0", "1.1.1"] as const;

export const datapackageWaczVersionRule: ValidationRule = {
  name: "datapackage/wacz-version-required",
  descriptionKey: "datapackage/wacz-version-required.desc",
  conformance: "MUST",
  docs: [
      {
        label: "WACZ §datapackage.json",
        url: {
          en: "https://specs.webrecorder.net/wacz/1.1.1/#datapackage-json",
          ja: "https://uraitakahito.github.io/specs/wacz/1.1.1/#datapackage-json",
        },
      },
  ],
  applicability: {
    severityByProfile: {
      // 欠落・型違いは lenient では warning へ。
      // `.unknown-version` は列挙しない — もともと warning で出しており、
      // 下げる先も warning なので書いても意味がない。
      lenient: {
        "datapackage/wacz-version-required.missing-field": "warning",
        "datapackage/wacz-version-required.not-string": "warning",
      },
    },
  },

  run: async (wacz) => {
    const issues: Issue[] = [];
    // 不在は `wacz/required-files` が、壊れた JSON は `datapackage/profile-required` が
    // 報告する。同じ状況に対して 2 つの near-duplicate issue を出さないよう、
    // ここでは silent に skip する。
    const { parsed: pkg } = await datapackageOf(wacz);
    if (pkg === null) return ok(issues);

    const version = pkg.wacz_version;

    if (version === undefined) {
      issues.push({
        rule: "datapackage/wacz-version-required",
        severity: "error",
        messageKey: "datapackage/wacz-version-required.missing-field",
        params: { entry: DATAPACKAGE_ENTRY },
        location: { entry: DATAPACKAGE_ENTRY },
        details: { knownVersions: KNOWN_VERSIONS },
      });
      return ok(issues);
    }

    if (typeof version !== "string" || version.length === 0) {
      issues.push({
        rule: "datapackage/wacz-version-required",
        severity: "error",
        messageKey: "datapackage/wacz-version-required.not-string",
        params: { entry: DATAPACKAGE_ENTRY },
        location: { entry: DATAPACKAGE_ENTRY },
        details: { actual: version, knownVersions: KNOWN_VERSIONS },
      });
      return ok(issues);
    }

    if (!(KNOWN_VERSIONS as readonly string[]).includes(version)) {
      issues.push({
        rule: "datapackage/wacz-version-required",
        severity: "warning",
        messageKey: "datapackage/wacz-version-required.unknown-version",
        params: { entry: DATAPACKAGE_ENTRY, version },
        location: { entry: DATAPACKAGE_ENTRY },
        details: { actual: version, knownVersions: KNOWN_VERSIONS },
      });
    }

    return ok(issues);
  },
};
