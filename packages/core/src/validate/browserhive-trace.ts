/**
 * `trace/events.jsonl`（取り込みの trace。取り込みが始まりを見た要求と、そのそれぞれがどうなったか）を
 * 読むための共有部分。
 *
 * rule ではないので `rules/` には置かない —— docs の抽出器は `rules/` 配下の `.ts` をすべて rule と見なし、
 * `name` と `conformance` を読めないファイルがあると落ちる (`browserhive-logs.ts` と同じ理由)。
 *
 * Spec: https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.23.0/#trace-directory
 */
import { readJsonLines, type LogLine } from "./browserhive-logs.js";
import type { WaczReader } from "../wacz/reader.js";

/** 取り込みの trace のエントリ。BrowserHive WACZ Profile 1.23.0 から、どの package も持つ（行が無ければ空のファイル）。 */
export const TRACE_ENTRY = "trace/events.jsonl";

/** 各行が名乗る版。 */
export const EXPECTED_TRACE_PROFILE = "browserhive:trace/1";

/** 各行が記録する物。この版では要求だけ。 */
export const EXPECTED_TRACE_KIND = "request";

/** 各行が必ず持つ member。WACZ Profile 1.23.0 §trace-lines の並び。 */
export const REQUIRED_TRACE_MEMBERS = [
  "profile",
  "kind",
  "id",
  "hop",
  "url",
  "method",
  "startedAt",
  "ms",
  "outcome",
] as const;

/** 要求がどうなったか。 */
export const TRACE_OUTCOMES: ReadonlySet<string> = new Set([
  "finished",
  "redirected",
  "failed",
  "pending",
  "not-archived",
  "denied",
  "evicted",
]);

/** producer が終わりを見た要求。`durationMs` を持てるのは、この行だけ。 */
export const ENDED_TRACE_OUTCOMES: ReadonlySet<string> = new Set(["finished", "redirected", "failed"]);

/** 方針で残さなかった要求（`no-archive`）と、送らせなかった要求（`deny`）の行。 */
export const WITHHELD_TRACE_OUTCOMES: ReadonlySet<string> = new Set(["not-archived", "denied"]);

/**
 * 残さなかった要求と送らせなかった要求の行が持たない member。行が応答の status・大きさ・掛かった時間を
 * 持つと、WARC に残さないと決めた物を trace から読めてしまう。
 */
export const WITHHELD_TRACE_FORBIDDEN_MEMBERS = [
  "initiator",
  "response",
  "timing",
  "durationMs",
  "encodedBytes",
  "record",
] as const;

/** `trace/events.jsonl` を行に分けて返す。エントリが無ければ `null`。空の行は飛ばす。 */
export const readTraceLines = (wacz: WaczReader): Promise<readonly LogLine[] | null> => readJsonLines(wacz, TRACE_ENTRY);
