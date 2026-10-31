/**
 * Best-effort な `ReportStats` 計算。
 *
 * validation rule と並列に走らせて、renderer が "42 records · 4.8 MB
 * · 3 hosts" のような footer を context として表示できるようにする。
 * これを rule registry とは意図的に分離している: stats 抽出の失敗
 * (壊れた WARC、読めない CDXJ) は report を block しては *いけない* し、
 * stats 成功が issue を出して *いけない*。なので内部エラーがあれば
 * `undefined` を返して、renderer 側で footer を省く。
 *
 * `archive/` の WARC は何本でもよい (BrowserHive 21.0.0 からは大きさで
 * 切り替えて何本も置く)。本の数と大きさは全部の和で、1 本も無ければ
 * stats そのものを省く。
 */
import { parseCdxj } from "../wacz/cdxj-parser.js";
import type { WaczReader } from "../wacz/reader.js";
import { iterateWarcMembers } from "../wacz/warc-iter.js";
import type { ReportStats } from "./domain.js";

const CDXJ_ENTRY = "indexes/index.cdxj";

export const computeStats = async (wacz: WaczReader): Promise<ReportStats | undefined> => {
  try {
    const entries = wacz.warcEntries();
    if (entries.length === 0) return undefined;

    let count = 0;
    let archiveBytes = 0;
    for (const entry of entries) {
      const warcBuf = await wacz.readEntry(entry);
      if (!warcBuf) continue;
      archiveBytes += warcBuf.byteLength;
      for (const _member of iterateWarcMembers(warcBuf, { loose: true })) {
        void _member;
        count += 1;
      }
    }

    const cdxjBuf = await wacz.readEntry(CDXJ_ENTRY);
    const hosts = new Set<string>();
    if (cdxjBuf) {
      const { entries } = parseCdxj(cdxjBuf.toString("utf-8"));
      for (const entry of entries) {
        const url = entry.fields["url"];
        if (typeof url !== "string") continue;
        try {
          // `new URL` は opaque な scheme (about:, blob: など) を reject する。
          // operational に意味のある "host" ではないので、URL をそのまま
          // 含めるのではなく skip する。
          hosts.add(new URL(url).hostname);
        } catch {
          // skip
        }
      }
    }

    return {
      warcRecordCount: count,
      warcArchiveBytes: archiveBytes,
      hosts: Array.from(hosts).sort(),
    };
  } catch {
    return undefined;
  }
};
