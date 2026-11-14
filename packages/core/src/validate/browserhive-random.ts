/**
 * `random/`（取り込みのページのスクリプトが受け取った乱数の控え `random/values.jsonl` と、それを控えたコード
 * `random/recorder.js`）を読むための共有部分。
 *
 * rule ではないので `rules/` には置かない —— docs の抽出器は `rules/` 配下の `.ts` をすべて rule と見なし、
 * `name` と `conformance` を読めないファイルがあると落ちる (`browserhive-trace.ts` と同じ理由)。
 *
 * Spec: https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.26.0/#random-directory
 */
import { readJsonLines, type LogLine } from "./browserhive-logs.js";
import type { WaczReader } from "../wacz/reader.js";

/** 控えた値のエントリ。`browserhive:capture.random.recorded` が `true` の package だけが持つ（行が無くても）。 */
export const RANDOM_ENTRY = "random/values.jsonl";

/** 値を控えるためにページで評価したコード。`random/values.jsonl` と組で在る。 */
export const RANDOM_RECORDER = "random/recorder.js";

/** `random/` のエントリ。どちらも在るか、どちらも無いか。 */
export const RANDOM_ENTRIES = [RANDOM_ENTRY, RANDOM_RECORDER] as const;

/** 各行が名乗る版。 */
export const EXPECTED_RANDOM_PROFILE = "browserhive:random/1";

/** 文書の行（`kind: "document"`）が必ず持つ member。WACZ Profile 1.26.0 §random-lines の並び。 */
export const REQUIRED_DOCUMENT_MEMBERS = ["document", "url", "frame", "dpr"] as const;

/** 値の行（`kind: "draw"`）が必ず持つ member。同じ節の並び。 */
export const REQUIRED_DRAW_MEMBERS = ["document", "seq", "api", "caller"] as const;

/** 文書の行の `frame`。 */
export const RANDOM_FRAMES: ReadonlySet<string> = new Set(["main", "frame"]);

/** 値の行の `api`。`bytes` を持つのは `crypto.getRandomValues` の行だけ。 */
export const RANDOM_APIS: ReadonlySet<string> = new Set(["Math.random", "crypto.getRandomValues", "crypto.randomUUID"]);

/** `bytes` を持つ行の `api`。 */
export const BYTES_API = "crypto.getRandomValues";

/** `recorded` が `false` の要約の `skipped`。2 つ以上が当たるときは、この並びで先の物。 */
export const RANDOM_SKIPPED: readonly string[] = ["not-requested", "withheld", "failed"];

/** `random/values.jsonl` を行に分けて返す。エントリが無ければ `null`。空の行は飛ばす。 */
export const readRandomLines = (wacz: WaczReader): Promise<readonly LogLine[] | null> => readJsonLines(wacz, RANDOM_ENTRY);
