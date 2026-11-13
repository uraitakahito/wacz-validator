/**
 * Rule: datapackage/profile-required
 *
 * `datapackage.json` は `profile: "data-package"` を必ず指定する必要
 * がある。この field は WACZ が埋め込む Frictionless Data Package
 * descriptor で定義されていて、これが無いと wabac.js / ReplayWeb.page
 * は WACZ を silent に invalid と判定し CDX lookup が走らない —
 * 他がすべて正しくても "Archived Page Not Found" という分かりにくい
 * エラーになる。
 *
 * Spec: WACZ 1.1.1 §datapackage.json (`profile` literal は Frictionless
 *       Data marker として必須と定められている)。
 *       https://specs.webrecorder.net/wacz/1.1.1/#datapackage-json
 * Reference producer: browserhive/src/storage/wacz/datapackage.ts:42-49
 *       に silent-fail trap がコメントで直接書かれている。
 *       https://github.com/uraitakahito/browserhive/blob/343a041bd4e4f4286c0834f90ab1bfb3de0cec15/src/storage/wacz/datapackage.ts#L42-L49
 */
import { ok } from "../../result.js";
import { datapackageOf, DATAPACKAGE_ENTRY } from "../datapackage-source.js";
import type { Issue, ValidationRule } from "../domain.js";

const EXPECTED_PROFILE = "data-package";

export const datapackageProfileRule: ValidationRule = {
  name: "datapackage/profile-required",
  descriptionKey: "datapackage/profile-required.desc",
  conformance: "MUST",
  docs: [
      {
        label: "WACZ §datapackage.json",
        url: {
          en: "https://specs.webrecorder.net/wacz/1.1.1/#datapackage-json",
          ja: "https://uraitakahito.github.io/specs/wacz/1.1.1/#datapackage-json",
        },
      },
      {
        label: "Frictionless Data Package",
        url: {
          en: "https://specs.frictionlessdata.io/data-package/",
        },
      },
  ],

  run: async (wacz) => {
    const issues: Issue[] = [];
    // datapackage.json の「不在」は wacz/required-files (§5.2.4) が報告する。
    // この rule は datapackage が在るときの profile *値* の正しさに専念し、
    // 不在を二重報告しない。**壊れた JSON はここが報告する** —— 下の invalid-json。
    const { bytes: buf, parsed: pkg } = await datapackageOf(wacz);
    if (buf === undefined) return ok(issues);
    if (!pkg) {
      issues.push({
        rule: "datapackage/profile-required",
        severity: "error",
        messageKey: "datapackage/profile-required.invalid-json",
        params: { entry: DATAPACKAGE_ENTRY },
        location: { entry: DATAPACKAGE_ENTRY },
      });
      return ok(issues);
    }

    if (pkg.profile === undefined) {
      issues.push({
        rule: "datapackage/profile-required",
        severity: "error",
        messageKey: "datapackage/profile-required.missing-field",
        params: { entry: DATAPACKAGE_ENTRY },
        location: { entry: DATAPACKAGE_ENTRY },
        details: { expected: EXPECTED_PROFILE },
      });
      return ok(issues);
    }

    if (pkg.profile !== EXPECTED_PROFILE) {
      // `String(...)` ではなく `JSON.stringify` を使う。profile field
      // の型が `unknown` のため、非文字列の値は `String(...)` だと
      // "[object Object]" になってメッセージから実際の中身が
      // 失われてしまう。
      issues.push({
        rule: "datapackage/profile-required",
        severity: "error",
        messageKey: "datapackage/profile-required.mismatch",
        params: {
          entry: DATAPACKAGE_ENTRY,
          actual: JSON.stringify(pkg.profile),
          expected: EXPECTED_PROFILE,
        },
        location: { entry: DATAPACKAGE_ENTRY },
        details: { expected: EXPECTED_PROFILE, actual: pkg.profile },
      });
    }

    return ok(issues);
  },
};
