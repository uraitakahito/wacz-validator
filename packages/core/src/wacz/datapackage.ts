/**
 * datapackage.json schema (Frictionless Data Package)。
 *
 * zod schema は意図的に *緩く* 保つ: WACZ で必須とされる field
 * (`profile`、`wacz_version`、`resources[*].hash` …) はすべて
 * `unknown` 型にする。これによって個別の validation rule が
 * 「ここでこの key が無い」という precise な diagnosis を出せる —
 * zod が最初に key を見逃した時点で parse 全体を fail させるのを
 * 避けたい。実際に enforce するのは "JSON object である" こと。
 * `.loose()` で extra field を保持しているのは、producer が
 * `mainPageURL`、`software` などや producer 固有の key を
 * 普通に emit するため。
 *
 * Spec: WACZ 1.1.1 §datapackage.json (Frictionless Data Package
 *       descriptor の上に作られている)。
 * Reference producer: browserhive の `src/storage/wacz/datapackage.ts`。
 */
import { z } from "zod";

/**
 * `resources[]` 内の resource ごとのレコード。各 field を
 * `.optional()` にしているのは spec が省略を許すからではなく、rule
 * 側 (datapackage-hashes.ts) が「この resource は field X が欠落」と
 * いう *具体的な* issue を出したいため。これにより zod が parse 全体
 * を拒絶することを防ぐ。
 *
 * NB: zod v4 では `z.unknown()` がデフォルトで non-optional になった
 * (v3 からの breaking change)。`.optional()` を付けることで、permissive
 * な WACZ parse のために v3 と等価な形に戻している。
 */
export const DatapackageResourceSchema = z
  .object({
    name: z.unknown().optional(),
    path: z.unknown().optional(),
    hash: z.unknown().optional(),
    bytes: z.unknown().optional(),
  })
  .loose();

export const DatapackageSchema = z
  .object({
    profile: z.unknown().optional(),
    // WACZ spec で要求される snake_case 名。この preset では lint の
    // naming-convention rule が有効化されていないので、eslint-disable
    // は不要。
    wacz_version: z.unknown().optional(),
    name: z.unknown().optional(),
    software: z.unknown().optional(),
    created: z.unknown().optional(),
    mainPageURL: z.unknown().optional(),
    mainPageDate: z.unknown().optional(),
    title: z.unknown().optional(),
    resources: z.array(DatapackageResourceSchema).optional(),
  })
  .loose();

export type DatapackageResource = z.infer<typeof DatapackageResourceSchema>;
export type Datapackage = z.infer<typeof DatapackageSchema>;

/**
 * raw JSON テキストを parse する。失敗 (JSON でない、object に
 * shape できない) は `null` を返す — 呼び出し側 rule が具体的な
 * 理由を Issue として報告するので、この層は「object として shape
 * できたか」だけを gate する。
 */
export const parseDatapackage = (text: string): Datapackage | null => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const result = DatapackageSchema.safeParse(raw);
  return result.success ? result.data : null;
};
