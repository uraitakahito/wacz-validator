/**
 * `archive/` の `response` の記録を `WARC-Record-ID` で引けるようにする、共有の読み手。
 *
 * 行の `record` で response を名指すエントリ（取り込みの trace `trace/events.jsonl` と、乱数の控え
 * `random/values.jsonl`）を見る rule が使う。rule ではないので `rules/` には置かない —— docs の抽出器は
 * `rules/` 配下の `.ts` をすべて rule と見なす（`browserhive-trace.ts` と同じ理由）。
 */
import { getHeader, parseWarcRecord } from "../wacz/warc-header.js";
import { iterateWarcMembers } from "../wacz/warc-iter.js";
import type { WaczReader } from "../wacz/reader.js";

/** `archive/` の `response` の記録 1 つ。 */
export interface ResponseRecord {
  readonly entry: string;
  readonly offset: number;
  /** `WARC-Target-URI`。無ければ `"?"`。 */
  readonly url: string;
  /** `WARC-Date` の字そのまま。無ければ `undefined`。 */
  readonly date: string | undefined;
}

/**
 * `archive/` の全部の本から、`response` の記録を集める。鍵は `WARC-Record-ID` の URI（山括弧なし —— 行の
 * `record` と同じ形）。同じ ID の記録が 2 つ在れば、先の物を残す。
 */
export const readResponses = async (wacz: WaczReader): Promise<Map<string, ResponseRecord>> => {
  const responses = new Map<string, ResponseRecord>();
  for (const entry of wacz.warcEntries()) {
    const buf = await wacz.readEntry(entry);
    if (buf === undefined) continue;
    for (const member of iterateWarcMembers(buf, { loose: true })) {
      const record = parseWarcRecord(member.raw);
      if (record === null || getHeader(record, "WARC-Type")?.toLowerCase() !== "response") continue;
      const id = getHeader(record, "WARC-Record-ID")?.replace(/^<(.*)>$/, "$1");
      if (id === undefined || responses.has(id)) continue;
      responses.set(id, {
        entry,
        offset: member.offset,
        url: getHeader(record, "WARC-Target-URI") ?? "?",
        date: getHeader(record, "WARC-Date"),
      });
    }
  }
  return responses;
};
