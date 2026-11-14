/**
 * `behaviors/` を読むための共有部分。
 *
 * rule ではないので `rules/` には置かない —— docs の抽出器は `rules/` 配下の
 * `.ts` をすべて rule と見なし、`name` と `conformance` を読めないファイルが
 * あると落ちる (`browserhive-axtree.ts` と同じ理由)。
 */
import { isRecord } from "./browserhive-storage.js";
import type { WaczReader } from "../wacz/reader.js";

/** BrowserHive がページで評価したソースを書くエントリ。 */
export const RUNTIME_ENTRY = "behaviors/runtime.js";
/** リクエストが運んできた behavior を書くエントリ。 */
export const CUSTOM_ENTRY = "behaviors/custom.jsonl";

/** `custom.jsonl` の各行が名乗る版。 */
export const EXPECTED_PROFILE = "browserhive:behaviors/1";

/** 各行が必ず持つ member。BrowserHive WACZ Profile 1.5.0 §behaviors-custom がそのまま並ぶ。 */
export const REQUIRED_MEMBERS = ["profile", "id", "source"] as const;

export interface CustomLine {
  lineNumber: number;
  /** JSON として読めなかった行は null。 */
  parsed: Record<string, unknown> | null;
}

/**
 * `behaviors/custom.jsonl` を行に分けて返す。エントリが無ければ `null` ——
 * **不在は違反ではない**ので、在るかどうかの判定を呼び出し側に残す。
 */
export const readCustomBehaviors = async (
  wacz: WaczReader,
): Promise<readonly CustomLine[] | null> => {
  const raw = await wacz.readEntry(CUSTOM_ENTRY);
  if (raw === undefined) return null;

  return raw
    .toString("utf-8")
    .split("\n")
    .map((text, index) => ({ text, lineNumber: index + 1 }))
    .filter(({ text }) => text.trim() !== "")
    .map(({ text, lineNumber }) => {
      try {
        const parsed: unknown = JSON.parse(text);
        return { lineNumber, parsed: isRecord(parsed) ? parsed : null };
      } catch {
        return { lineNumber, parsed: null };
      }
    });
};

/**
 * `settings.behaviors` のうち、リクエストが運んできたと申告されているものの id。
 *
 * 1.5.0 で `string[]` から `{ id, origin }[]` になった。古い形（文字の項目）は読まずに飛ばすので、
 * 1.5.0 より前の archive は、持ち込みを何も申告していない archive と同じに読む。
 *
 * それより前の archive に rule が当たらないわけではない。`browserhive/behaviors-shape` の版の条件は
 * producer の版（`browserhive >=8.6.0`）で、archive の版ではなく、`--profile browserhive@<版>` を添えた
 * 実行でしか効かない。版を添えない実行では、どの archive にもこの関数が当たる。
 */
export const customIdsFromSettings = (
  capture: Record<string, unknown> | undefined,
): string[] => {
  const settings = capture?.["settings"];
  if (!isRecord(settings)) return [];
  const behaviors = settings["behaviors"];
  if (!Array.isArray(behaviors)) return [];
  return behaviors
    .filter((b): b is Record<string, unknown> => isRecord(b))
    .filter((b) => b["origin"] === "custom")
    .map((b) => b["id"])
    .filter((id): id is string => typeof id === "string");
};
