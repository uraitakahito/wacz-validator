/**
 * Rule: datapackage/resources-complete
 *
 * WACZ「Other files and directories」: 追加ファイルは Frictionless 準拠の
 * ため `datapackage.json` の resources セクションに列挙されなければならない
 * (MUST)。`datapackage/resource-hashes` が「宣言 → 実体」(宣言したリソースが
 * 実在し hash 一致)を見るのに対し、この rule は逆方向「実体 → 宣言」
 * (ZIP 内の実ファイルがすべて宣言されているか)を見る。未宣言の孤児を warning。
 *
 * マニフェスト自身(`datapackage.json` / `datapackage-digest.json`)は
 * resources に自己列挙しないため対象外。ZIP のディレクトリエントリも除外。
 *
 * Spec: https://specs.webrecorder.net/wacz/1.1.1/ の「Other files and directories」の節
 *   （「Directories and Files」の節の外に在る）。下の `docs` の URL が指す `datapackage.json` の
 *   節も、`resources` を WACZ の中のすべてのファイルの一覧と定める。
 */
import { ok } from "../../result.js";
import { datapackageOf } from "../datapackage-source.js";
import type { Issue, ValidationRule } from "../domain.js";

/** resources に列挙されないマニフェスト系ファイル。 */
const MANIFEST_FILES: ReadonlySet<string> = new Set([
  "datapackage.json",
  "datapackage-digest.json",
]);

export const datapackageResourcesCompleteRule: ValidationRule = {
  name: "datapackage/resources-complete",
  descriptionKey: "datapackage/resources-complete.desc",
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
      lenient: { "datapackage/resources-complete.orphan": "info" },
    },
  },

  run: async (wacz) => {
    const issues: Issue[] = [];
    // 不在は `wacz/required-files` が、壊れた JSON は `datapackage/profile-required` が
    // 報告する。ここは二重報告を避け、値の正しさに専念する。
    const { parsed: pkg } = await datapackageOf(wacz);
    // resources が配列でない場合は resource-hashes が報告する。
    if (pkg === null || !Array.isArray(pkg.resources)) return ok(issues);

    const declared = new Set<string>();
    for (const res of pkg.resources) {
      if (typeof res.path === "string") declared.add(res.path);
    }

    for (const name of wacz.entryNames()) {
      if (name.endsWith("/")) continue; // ディレクトリエントリ
      if (MANIFEST_FILES.has(name)) continue; // マニフェスト自身
      if (!declared.has(name)) {
        issues.push({
          rule: "datapackage/resources-complete",
          severity: "warning",
          messageKey: "datapackage/resources-complete.orphan",
          params: { entry: name },
          location: { entry: name },
        });
      }
    }

    return ok(issues);
  },
};
