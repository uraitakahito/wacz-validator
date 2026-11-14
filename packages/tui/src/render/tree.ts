/**
 * `Report.entries`(flat なファイル一覧)を WACZ 1.1.1 §5.1 風の
 * ディレクトリツリーに組み直す純関数群。Ink ビュー(app.tsx)が使う。
 * UI には依存しない — マーカーの「色」は tone を返すだけにして、
 * app.tsx 側で Ink の color に対応づける。
 */
import type { ReportEntry, Severity } from "@wacz-validator/protocol";

export interface TreeNode {
  /** セグメント名("archive" / "data.warc.gz")。root は ""。 */
  name: string;
  /** フルパス。 */
  path: string;
  isDir: boolean;
  /** ファイルのみ(対応する ReportEntry)。 */
  entry?: ReportEntry;
  children: TreeNode[];
}

/** flat な entries を "/" で分割してツリーへ合成する(決定的に path ソート)。 */
export const buildEntryTree = (entries: readonly ReportEntry[]): TreeNode => {
  const root: TreeNode = { name: "", path: "", isDir: true, children: [] };
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  for (const entry of sorted) {
    const segs = entry.path.split("/").filter(Boolean);
    let cur = root;
    segs.forEach((seg, i) => {
      const isLast = i === segs.length - 1;
      let child = cur.children.find((c) => c.name === seg);
      if (!child) {
        child = {
          name: seg,
          path: segs.slice(0, i + 1).join("/"),
          isDir: !isLast,
          children: [],
          ...(isLast && { entry }),
        };
        cur.children.push(child);
      }
      cur = child;
    });
  }
  return root;
};

export interface TreeRow {
  /** §5.1 の罫線 prefix("├── " / "│   └── " 等)。 */
  connector: string;
  name: string;
  path: string;
  isDir: boolean;
  entry?: ReportEntry;
}

/** ツリーを描画順(深さ優先)の行配列へ。各行に §5.1 の罫線 prefix を付ける。 */
export const flattenTree = (root: TreeNode): TreeRow[] => {
  const rows: TreeRow[] = [];
  const walk = (node: TreeNode, prefix: string): void => {
    node.children.forEach((child, i) => {
      const last = i === node.children.length - 1;
      rows.push({
        connector: prefix + (last ? "└── " : "├── "),
        name: child.name,
        path: child.path,
        isDir: child.isDir,
        ...(child.entry && { entry: child.entry }),
      });
      if (child.isDir) walk(child, prefix + (last ? "    " : "│   "));
    });
  };
  walk(root, "");
  return rows;
};

export type MarkerTone = "error" | "warning" | "none";

export interface EntryMarker {
  /** 表示グリフ("✗" / "⚠" / "(missing)" / "")。 */
  glyph: string;
  /** その file を指す issue の rule 名(無ければ空)。 */
  rules: string[];
  tone: MarkerTone;
}

/** file の最悪 severity(と present)からマーカーを決める。dir は none。 */
export const entryMarker = (entry?: ReportEntry): EntryMarker => {
  if (entry === undefined) return { glyph: "", rules: [], tone: "none" };
  const rules = entry.issues.map((i) => i.rule);
  // 欠落は「なぜ期待されるか」を併記する(§5.2 MUST / datapackage 宣言)。
  if (!entry.present) return { glyph: `(missing — ${missingReason(entry)})`, rules, tone: "error" };
  const worst = worstSeverity(entry.issues);
  if (worst === "error") return { glyph: "✗", rules, tone: "error" };
  if (worst === "warning") return { glyph: "⚠", rules, tone: "warning" };
  return { glyph: "", rules, tone: "none" };
};

/**
 * present:false の file が「なぜ期待されるか」を一語で返す。§5.2 MUST を
 * datapackage 宣言より優先(より強い根拠)。expectedBy が空の欠落は
 * 理由不明として "missing"(通常は起きない)。
 */
const missingReason = (entry: ReportEntry): string => {
  if (entry.expectedBy.includes("wacz-spec")) return "required by §5.2";
  if (entry.expectedBy.includes("datapackage")) return "declared in datapackage";
  return "missing";
};

const worstSeverity = (issues: { severity: Severity }[]): Severity | undefined => {
  if (issues.some((i) => i.severity === "error")) return "error";
  if (issues.some((i) => i.severity === "warning")) return "warning";
  if (issues.some((i) => i.severity === "info")) return "info";
  return undefined;
};
