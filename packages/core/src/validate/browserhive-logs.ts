/**
 * `logs/capture.jsonl`（取り込みのログ）を読むための共有部分。
 *
 * rule ではないので `rules/` には置かない —— docs の抽出器は `rules/` 配下の `.ts` をすべて rule と見なし、
 * `name` と `conformance` を読めないファイルがあると落ちる (`browserhive-behaviors.ts` と同じ理由)。
 *
 * Spec: https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.19.0/#logs-directory
 */
import { isRecord } from "./browserhive-storage.js";
import type { WaczReader } from "../wacz/reader.js";

/** 取り込みのログのエントリ。BrowserHive WACZ Profile 1.19.0 から、どの package も持つ（行が無ければ空のファイル）。 */
export const LOGS_ENTRY = "logs/capture.jsonl";

/** 各行が名乗る版。 */
export const EXPECTED_LOG_PROFILE = "browserhive:log/1";

/** 各行が必ず持つ member。WACZ Profile 1.19.0 §logs-lines の並び。 */
export const REQUIRED_LOG_MEMBERS = ["profile", "at", "ms", "source", "level", "msg"] as const;

/** 行の書き手。`script` の行だけが、どの behavior の行かを `script` で名指す。 */
export const LOG_SOURCES: ReadonlySet<string> = new Set(["script", "page", "browserhive"]);

/** 行の重さ。 */
export const LOG_LEVELS: ReadonlySet<string> = new Set(["debug", "info", "warn", "error"]);

/**
 * RFC 3339 の date-time（§5.6）。`T` と `Z` は小文字でもよい（同じ節の NOTE）。
 *
 * 時差つき（`+09:00`）も通す。WACZ Profile の Conformance の節は、timestamp を持つ member の値を
 * 「RFC 3339 date-time in UTC」と定めるが、UTC かどうかはここでは見ていない。
 */
export const RFC3339_DATE_TIME =
  /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])[Tt]([01]\d|2[0-3]):[0-5]\d:([0-5]\d|60)(\.\d+)?([Zz]|[+-]([01]\d|2[0-3]):[0-5]\d)$/;

export interface LogLine {
  lineNumber: number;
  /** JSON のオブジェクトとして読めなかった行は null。 */
  parsed: Record<string, unknown> | null;
}

/**
 * JSON Lines のエントリを行に分けて返す。エントリが無ければ `null` —— 在ることを求めるかは、archive が
 * 名乗る版で決まるので、呼び出し側に残す。空の行は飛ばす（ほかの JSON Lines の読み方と同じ）。
 * 取り込みの trace `trace/events.jsonl`（`browserhive-trace.ts`）も、同じ読み方をする。
 */
export const readJsonLines = async (wacz: WaczReader, entry: string): Promise<readonly LogLine[] | null> => {
  const raw = await wacz.readEntry(entry);
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

/** `logs/capture.jsonl` を行に分けて返す。エントリが無ければ `null`。 */
export const readLogLines = (wacz: WaczReader): Promise<readonly LogLine[] | null> => readJsonLines(wacz, LOGS_ENTRY);
