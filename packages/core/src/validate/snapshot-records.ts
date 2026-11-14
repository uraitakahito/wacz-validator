/**
 * DOM の写し（主の文書の写しと、子フレームの写し）を見る rule の、共有の読み手。
 *
 * `browserhive/snapshots`（主の文書の写し）と `browserhive/frame-snapshots`（子フレームの写し）が、同じ
 * resource と metadata の組・ページ一覧・索引を読む。rule ではないので `rules/` には置かない —— docs の
 * 抽出器は `rules/` 配下の `.ts` をすべて rule と見なす（`response-records.ts` と同じ理由）。
 */
import { parseCdxj, type CdxjEntry } from "../wacz/cdxj-parser.js";
import type { WaczReader } from "../wacz/reader.js";
import { getHeader, parseWarcRecord, type ParsedWarcRecord } from "../wacz/warc-header.js";
import { iterateWarcMembers } from "../wacz/warc-iter.js";
import { isRecord } from "./browserhive-storage.js";

/** 本の中の記録 1 つ。落ちたときに名指す本と位置を持つ。 */
export interface Located {
  readonly entry: string;
  readonly offset: number;
  readonly record: ParsedWarcRecord;
}

/** archive の resource と metadata。 */
export interface SnapshotRecords {
  /** resource を `WARC-Record-ID`（山括弧つき）で。同じ ID が 2 つ在れば先の物。 */
  readonly resources: ReadonlyMap<string, Located>;
  /** すべての resource を、本の順・本の中の順に。どの項目にも名指されない写しを探すのに使う。 */
  readonly resourceList: readonly Located[];
  /** metadata を `WARC-Refers-To` で。 */
  readonly metadataByTarget: ReadonlyMap<string, readonly Located[]>;
}

/** archive の全部の本を 1 度読み、resource を `WARC-Record-ID` で、metadata を `WARC-Refers-To` で引けるようにする。 */
export const readSnapshotRecords = async (wacz: WaczReader): Promise<SnapshotRecords> => {
  const resources = new Map<string, Located>();
  const resourceList: Located[] = [];
  const metadataByTarget = new Map<string, Located[]>();
  for (const entry of wacz.warcEntries()) {
    const buf = await wacz.readEntry(entry);
    if (buf === undefined) continue;
    for (const member of iterateWarcMembers(buf, { loose: true })) {
      const record = parseWarcRecord(member.raw);
      if (record === null) continue;
      const located: Located = { entry, offset: member.offset, record };
      const type = (getHeader(record, "WARC-Type") ?? "").toLowerCase();
      if (type === "resource") {
        const id = getHeader(record, "WARC-Record-ID");
        if (id !== undefined && !resources.has(id)) resources.set(id, located);
        resourceList.push(located);
      } else if (type === "metadata") {
        const target = getHeader(record, "WARC-Refers-To");
        if (target === undefined) continue;
        const list = metadataByTarget.get(target);
        if (list === undefined) metadataByTarget.set(target, [located]);
        else list.push(located);
      }
    }
  }
  return { resources, resourceList, metadataByTarget };
};

/** resource を指す metadata。同じ本の物を先に選ぶ（別の本にしか無いことは `browserhive/exchange-in-one-file` が言う）。 */
export const metadataOf = (records: SnapshotRecords, resource: Located): Located | undefined => {
  const candidates = records.metadataByTarget.get(getHeader(resource.record, "WARC-Record-ID") ?? "") ?? [];
  return candidates.find((m) => m.entry === resource.entry) ?? candidates[0];
};

/**
 * ページ一覧のページの行（header の次から）と、その行番号。JSON のオブジェクトとして読めない行が 1 つでも在れば
 * `null` —— 行の並びを照らせない（読めない行は `pages/page-schema` が言う）。
 */
export const readPageLines = (text: string): { line: number; page: Record<string, unknown> }[] | null => {
  const pages: { line: number; page: Record<string, unknown> }[] = [];
  let header = true;
  for (const [i, raw] of text.split("\n").entries()) {
    if (raw.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (header) {
      header = false;
      continue;
    }
    if (!isRecord(parsed)) return null;
    pages.push({ line: i + 1, page: parsed });
  }
  return pages;
};

/** 索引の行と、その行番号。読めない行は飛ばす（`cdxj/index-valid-data` が言う）。 */
export const readIndexLines = (text: string): { line: number; entry: CdxjEntry }[] =>
  text.split("\n").flatMap((raw, i) => {
    const [entry] = parseCdxj(raw).entries;
    return entry === undefined ? [] : [{ line: i + 1, entry }];
  });

/**
 * 索引の行のうち、記録 `located` を指す物（`filename` と `offset` がその記録）。鍵や url ではなく指す記録で探す
 * —— 写しの URI を文書の URL で書いた archive で、その文書の応答の行を写しの行と取り違えない。
 */
export const indexLinesOf = (
  lines: readonly { line: number; entry: CdxjEntry }[],
  located: Located,
): { line: number; entry: CdxjEntry }[] => {
  const file = located.entry.slice("archive/".length);
  return lines.filter(
    ({ entry }) => entry.fields["filename"] === file && String(entry.fields["offset"]) === String(located.offset),
  );
};
