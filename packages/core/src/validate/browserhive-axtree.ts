/**
 * `accessibility/axtree.jsonl` を読むための共有部分。
 *
 * rule ではないので `rules/` には置かない —— docs の抽出器は `rules/` 配下の
 * `.ts` をすべて rule と見なし、`name` と `conformance` を読めないファイルが
 * あると落ちる。
 */
import type { WaczReader } from "../wacz/reader.js";

/** BrowserHive が描画後のアクセシビリティツリーを書くエントリ。 */
export const AXTREE_ENTRY = "accessibility/axtree.jsonl";

/** BrowserHive WACZ Profile が定める、この版で許される property。 */
export const ALLOWED_NODE_KEYS: ReadonlySet<string> = new Set([
  "role",
  "name",
  "level",
  "url",
  "checked",
  "expanded",
  "disabled",
  "required",
  "value",
  "children",
]);

/**
 * 木に残っていてはならない role。
 *
 * producer は畳んで子を親に繋ぐことになっている。残っているということは、
 * 刈り込みが宣言どおりに働いていない。
 */
export const COLLAPSED_ROLES: ReadonlySet<string> = new Set([
  "generic",
  "none",
  "InlineTextBox",
]);

/** スナップショット 1 件が必ず持つ member。 */
export const REQUIRED_MEMBERS = [
  "profile",
  "url",
  "takenAt",
  "stage",
  "tree",
] as const;

export const EXPECTED_PROFILE = "browserhive:axtree/1";

export interface AxtreeLine {
  /** 1 始まりの行番号。どの行かを message に出せるようにする。 */
  readonly lineNumber: number;
  /** JSON として読めた場合の中身。読めなければ `null`。 */
  readonly parsed: Record<string, unknown> | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * エントリを 1 行ずつ読む。エントリが無ければ `null` —— 「壊れている」ではなく
 * 「この capture は撮っていない」なので、呼ぶ側が区別できるようにする。
 */
export const readAxtree = async (
  wacz: WaczReader,
): Promise<readonly AxtreeLine[] | null> => {
  const raw = await wacz.readEntry(AXTREE_ENTRY);
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

/** 木を深さ優先で辿る。`children` が配列でない枝はそこで止める。 */
export const walkTree = (
  tree: unknown,
  visit: (node: Record<string, unknown>) => void,
): void => {
  if (!Array.isArray(tree)) return;
  for (const node of tree) {
    if (!isRecord(node)) continue;
    visit(node);
    walkTree(node["children"], visit);
  }
};
