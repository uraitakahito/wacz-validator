/**
 * Rule: browserhive/storage-shape(browserhive profile 限定 · >=6.0.0)
 *
 * `storage/origins.jsonl` が在るときの中身と、目録との整合。
 *
 * ファイルの存在自体は違反ではない —— profile では MAY。だが**在ることと
 * `valuesRecorded` は必ず一致しなければならない**。読み手はその値だけを見て、
 * アーカイブ本体を開かずに「このパッケージは保存されていた値を運んでいるか」を
 * 判別する。片方だけ動くと、その判別が嘘になる。
 *
 * 「在るか」と「壊れていないか」はここでは見ない —— それぞれ
 * `datapackage/resources-complete`(ZIP の実体がすべて宣言されているか)と
 * `datapackage/resource-hashes`(宣言と実体の hash 一致)が既に見ている。
 *
 * 確かめるのは 6 つ:
 *
 *   1. `valuesRecorded` とファイルの有無が一致している (**両方向**)
 *   2. 各行が JSON オブジェクトで、必須の member を持っている
 *   3. profile と stage が目録と同じ綴りである
 *   4. 目録で `unreadable` と申告された origin が、ここに行を持っていない
 *   5. 目録で `valuesOversize` と申告された origin が、ここに行を持っていない
 *   6. 隠すシークレットのある package がファイルを持たない (WACZ Profile 1.22.0)。ファイルは各 area の値を
 *      そのまま持ち、ページは behavior が渡した値を保存できる。隠すシークレットは `settings.secrets` のうち
 *      `settings.secretArchive` が名指さない物で、`secretArchive` が読めなければ、どれも名指されていないと見る
 *
 * 4 が要るのは、両方に書くと「読めなかった」と「読んで値が在った」を同時に
 * 主張することになるため。5 は矛盾の中身が違う —— 「読めたが大きすぎるので
 * 運ばないと決めた」と「ここに在る」の同居で、producer が**上限の判定と行を
 * 書く判定を別々に書いた**ときに出る。直す先が違うので、報告も分ける。
 *
 * Spec: https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.22.0/#storage-directory
 */
import { ok } from "../../result.js";
import {
  EXPECTED_STORAGE_STAGE,
  isRecord,
  profileAtLeast,
  readCapture,
  readStorageValues,
  STORAGE_ENTRY,
  VALUE_LINE_MEMBERS,
} from "../browserhive-storage.js";
import type { Issue, ValidationRule } from "../domain.js";

const RULE = "browserhive/storage-shape";

/**
 * 目録が「行を持たない」と申告した origin を、**理由ごとに分けて**返す。
 *
 * 1 つの集合にまとめない —— 矛盾の中身が違うので、報告も分かれる。
 * `unreadable` は「読めなかったのに値が在る」、`oversize` は「読めたが運ばないと
 * 決めたのに値が在る」。同じ文言で報告すると、読み手はどちらを直せばよいか
 * 分からない (前者はアーカイブが壊れている、後者は上限の設定の話)。
 */
const withheldOrigins = (
  storage: unknown,
): { unreadable: ReadonlySet<string>; oversize: ReadonlySet<string> } => {
  const unreadable = new Set<string>();
  const oversize = new Set<string>();
  if (!isRecord(storage)) return { unreadable, oversize };
  const origins = storage["origins"];
  if (!Array.isArray(origins)) return { unreadable, oversize };
  for (const entry of origins) {
    if (!isRecord(entry)) continue;
    const origin = entry["origin"];
    if (typeof origin !== "string") continue;
    if (entry["unreadable"] === true) unreadable.add(origin);
    if (entry["valuesOversize"] === true) oversize.add(origin);
  }
  return { unreadable, oversize };
};

/**
 * 隠すシークレットの名前 (WACZ Profile 1.22.0)。`settings.secrets` のうち `settings.secretArchive` が名指さない物。
 * 1.22.0 より前を名乗る archive と、`settings.secrets` が読めない archive では空。
 */
const hiddenSecrets = (capture: Record<string, unknown>): string[] => {
  const settings = capture["settings"];
  if (!profileAtLeast(capture["conformsTo"], 1, 22) || !isRecord(settings)) return [];
  const secrets = settings["secrets"];
  const archive = settings["secretArchive"];
  const kept = new Set(isRecord(archive) ? Object.keys(archive) : []);
  return Array.isArray(secrets) ? secrets.filter((name): name is string => typeof name === "string" && !kept.has(name)) : [];
};

export const browserhiveStorageShapeRule: ValidationRule = {
  // docs-site/src/lib/extract.ts がソースを正規表現で読むので、
  // ここは定数ではなくリテラルで書く。
  name: "browserhive/storage-shape",
  descriptionKey: "browserhive/storage-shape.desc",
  conformance: "MUST",
  docs: [
    {
      label: "BrowserHive WACZ Profile §storage directory",
      url: {
        en: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.22.0/#storage-directory",
        ja: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.22.0/ja/#storage-directory",
      },
    },
  ],
  applicability: {
    excludeProfiles: ["spec", "lenient"],
    profileVersions: { browserhive: ">=6.0.0" },
  },

  run: async (wacz) => {
    const capture = await readCapture(wacz);
    if (capture === undefined) return ok([]);

    const issues: Issue[] = [];
    const push = (messageKey: string, params: Record<string, string>): void => {
      issues.push({ rule: RULE, severity: "error", messageKey, params });
    };

    const storage = capture["storage"];
    const declared = isRecord(storage) ? storage["valuesRecorded"] === true : false;
    const lines = await readStorageValues(wacz);
    const present = lines !== null;

    // 6. 隠すシークレットのある package は、値のファイルを持たない。
    const hidden = hiddenSecrets(capture);
    if (present && hidden.length > 0) {
      push(`${RULE}.hidden-secret`, { entry: STORAGE_ENTRY, names: hidden.join(", ") });
    }

    // **両方向。** 「言ったのに無い」も「あるのに言っていない」も、読み手の判別を
    // 嘘にする。片方だけ見る形にすると、その片方は必ず見落とされる。
    if (declared && !present) {
      push(`${RULE}.declared-but-absent`, { entry: STORAGE_ENTRY });
      return ok(issues);
    }
    if (!declared && present) {
      push(`${RULE}.present-but-undeclared`, { entry: STORAGE_ENTRY });
    }
    if (lines === null) return ok(issues);

    const withheld = withheldOrigins(storage);

    // 行の profile は**目録と同じ綴り**でなければならない。定数と比べていた頃は
    // 綴りが 1 つしかなく、一致は自動的だった。2 つ読めるようになった今、
    // ここを見ないと `/2` の目録に `/1` の行が並ぶアーカイブが素通りする。
    // 目録側が文字列ですらないときは黙る —— それは storage-inventory の持ち場で、
    // ここで重ねると 1 つの誤りが行数ぶんの issue になる。
    const inventoryProfile = isRecord(storage) ? storage["profile"] : undefined;
    const checkProfile = typeof inventoryProfile === "string";

    for (const { lineNumber, parsed } of lines) {
      const line = String(lineNumber);
      if (parsed === null) {
        push(`${RULE}.not-json`, { entry: STORAGE_ENTRY, line });
        continue;
      }

      const missing = VALUE_LINE_MEMBERS.filter((m) => !(m in parsed));
      if (missing.length > 0) push(`${RULE}.missing-member`, { line, members: missing.join(", ") });

      if (checkProfile && parsed["profile"] !== inventoryProfile) {
        push(`${RULE}.unknown-profile`, {
          line,
          found: JSON.stringify(parsed["profile"]),
          expected: inventoryProfile,
        });
      }
      if (parsed["stage"] !== EXPECTED_STORAGE_STAGE) {
        push(`${RULE}.unknown-stage`, {
          line,
          found: JSON.stringify(parsed["stage"]),
          expected: EXPECTED_STORAGE_STAGE,
        });
      }

      const areas = parsed["areas"];
      if (!isRecord(areas) || !isRecord(areas["local"]) || !isRecord(areas["session"])) {
        push(`${RULE}.areas-shape`, { line });
      }

      const origin = parsed["origin"];
      if (typeof origin === "string") {
        if (withheld.unreadable.has(origin)) {
          // 目録が「読めなかった」と言った origin の値が在る。どちらかが嘘。
          push(`${RULE}.unreadable-has-values`, { line, origin });
        }
        if (withheld.oversize.has(origin)) {
          // 目録が「大きすぎたので運ばなかった」と言った origin の値が在る。
          // 上限の判定と行を書く判定が**別々に書かれている**ときに出る形。
          push(`${RULE}.oversize-has-values`, { line, origin });
        }
      }
    }

    return ok(issues);
  },
};
