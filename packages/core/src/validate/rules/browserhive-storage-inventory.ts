/**
 * Rule: browserhive/storage-inventory(browserhive profile 限定 · >=6.0.0)
 *
 * `browserhive:capture.storage` が在り、BrowserHive WACZ Profile の定める形をしているか。
 *
 * **不在が違反である** ところが `tls` 系の rule と違う。WACZ Profile 1.1.0 で目録は
 * MUST になった —— 目録が無いと、読み手は「localStorage から描画したページ」と
 * 「本当に見せるものが無かったページ」を区別できない。`completeness` は助けに
 * ならない: あれが報告するのはパッケージが保持していない body で、storage は
 * 一度も body にならない。
 *
 * 確かめるのは 5 つ:
 *
 *   1. member が在り、必須の 4 つを持っている
 *   2. profile がこの検証器の読める綴りのいずれかで、stage がこの版の綴りである
 *   3. 各 origin が「両 area を持つ」か「unreadable」のどちらかである
 *      —— 空の area (keys: 0) と読めなかった origin は別物で、混ぜると
 *      この member が取り除こうとしている曖昧さが戻る
 *   4. `valuesOversize` を名乗る origin の値が `true` で、`unreadable` とも
 *      `valuesRecorded: false` とも同居していない —— 前者は両立しない 2 つの
 *      主張、後者は**誰も下していない判断**の報告になる
 *   5. digest が sha256: + 64 桁である
 *
 * **値そのものは見ない。** 目録は値を持たないと WACZ Profile が言っており、
 * それを確かめるのは形の検査ではなく `storage-shape` の側の仕事。
 *
 * 版の条件があるのは、この member が browserhive 6.0.0 で入ったため。それ未満では
 * 無くて当然で、走らせなかったことは `Report.skipped` に残る。1.1.0 を名乗って
 * いないアーカイブに 1.1.0 の MUST を当てて落とすのは、検証器として誤り。
 *
 * Spec: https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.6.0/#storage
 */
import { ok } from "../../result.js";
import {
  DIGEST_PATTERN,
  isKnownStorageProfile,
  KNOWN_STORAGE_PROFILES_LABEL,
  EXPECTED_STORAGE_STAGE,
  INVENTORY_MEMBERS,
  isRecord,
  readCapture,
} from "../browserhive-storage.js";
import type { Issue, ValidationRule } from "../domain.js";

const RULE = "browserhive/storage-inventory";

/** 1 area の形。keys と bytes は非負整数、digest は sha256 の綴り。 */
const areaIssues = (
  area: unknown,
  where: string,
): { messageKey: string; params: Record<string, string> }[] => {
  if (!isRecord(area)) {
    return [{ messageKey: `${RULE}.area-not-object`, params: { where } }];
  }
  const out: { messageKey: string; params: Record<string, string> }[] = [];
  for (const member of ["keys", "bytes"] as const) {
    const value = area[member];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      out.push({
        messageKey: `${RULE}.area-count`,
        params: { where, member, found: JSON.stringify(value) },
      });
    }
  }
  const digest = area["digest"];
  if (typeof digest !== "string" || !DIGEST_PATTERN.test(digest)) {
    out.push({
      messageKey: `${RULE}.digest-shape`,
      params: { where, found: JSON.stringify(digest) },
    });
  }
  return out;
};

export const browserhiveStorageInventoryRule: ValidationRule = {
  // docs-site/src/lib/extract.ts がソースを正規表現で読むので、
  // ここは定数ではなくリテラルで書く。
  name: "browserhive/storage-inventory",
  descriptionKey: "browserhive/storage-inventory.desc",
  conformance: "MUST",
  docs: [
    {
      label: "BrowserHive WACZ Profile §storage",
      url: {
        en: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.6.0/#storage",
        ja: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.6.0/ja/#storage",
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
    if (!isRecord(storage)) {
      // ここが本題。MUST なので、不在は「言うことがない」ではなく違反。
      push(`${RULE}.missing`, {});
      return ok(issues);
    }

    const missing = INVENTORY_MEMBERS.filter((m) => !(m in storage));
    if (missing.length > 0) push(`${RULE}.missing-member`, { members: missing.join(", ") });

    if (!isKnownStorageProfile(storage["profile"])) {
      push(`${RULE}.unknown-profile`, {
        found: JSON.stringify(storage["profile"]),
        expected: KNOWN_STORAGE_PROFILES_LABEL,
      });
    }
    if (storage["stage"] !== EXPECTED_STORAGE_STAGE) {
      push(`${RULE}.unknown-stage`, {
        found: JSON.stringify(storage["stage"]),
        expected: EXPECTED_STORAGE_STAGE,
      });
    }
    if (typeof storage["valuesRecorded"] !== "boolean") {
      push(`${RULE}.values-recorded-shape`, {
        found: JSON.stringify(storage["valuesRecorded"]),
      });
    }

    const origins = storage["origins"];
    if (!Array.isArray(origins)) {
      push(`${RULE}.origins-not-array`, { found: JSON.stringify(origins) });
      return ok(issues);
    }

    for (const [index, entry] of origins.entries()) {
      const where = `origins[${String(index)}]`;
      if (!isRecord(entry)) {
        push(`${RULE}.origin-not-object`, { where });
        continue;
      }
      if (typeof entry["origin"] !== "string") {
        push(`${RULE}.origin-shape`, { where, found: JSON.stringify(entry["origin"]) });
      }

      const unreadable = entry["unreadable"] === true;
      const hasAreas = "local" in entry && "session" in entry;

      // 「読めなかった」と「両 area を持つ」は排他。どちらでもない形、あるいは
      // 両方を名乗る形は、WACZ Profile が分けようとした 2 つを混ぜている。
      //
      // `valuesOversize` はここに**入らない** —— あれを持つ項目は area を
      // 持ったままなので (WACZ Profile 1.6.0 の MUST)、この XNOR を素通りする。
      // 三値にすると、area を持つ普通の項目まで巻き込む。
      if (unreadable === hasAreas) {
        push(`${RULE}.origin-form`, { where });
        continue;
      }

      // `valuesOversize` は「読めたが運ばないと決めた」。読めていない origin に
      // 立てると、両立しない 2 つを同時に主張することになる。
      if ("valuesOversize" in entry) {
        if (entry["valuesOversize"] !== true) {
          push(`${RULE}.oversize-shape`, {
            where,
            found: JSON.stringify(entry["valuesOversize"]),
          });
        }
        if (unreadable) push(`${RULE}.oversize-with-unreadable`, { where });
        // 値をそもそも求められていない取り込みでは、落とされたものは無い。
        // ここで立てると、**誰も下していない判断**を報告することになる。
        if (storage["valuesRecorded"] !== true) {
          push(`${RULE}.oversize-without-values`, { where });
        }
      }

      if (unreadable) continue;

      for (const area of ["local", "session"] as const) {
        for (const issue of areaIssues(entry[area], `${where}.${area}`)) {
          push(issue.messageKey, issue.params);
        }
      }
    }

    return ok(issues);
  },
};
