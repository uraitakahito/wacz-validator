/**
 * Rule: cdxj/warc-offsets
 *
 * 各 CDXJ entry は `offset` / `length` field を持ち、これが
 * `archive/data.warc.gz` 内の WARC record の byte range を指す。両方
 * とも valid な整数文字列で、かつ independent な gzip member 境界に
 * 正確に当たる必要がある — そうでないと offset で seek する replay
 * ツールは garbage を fetch して silent に "Archived Page Not Found"
 * を返す。
 *
 * Spec / 慣習: pywb / wacz-creator は offset / length を decimal で
 *       文字列化する。wabac.js の CDXJ loader は文字列と数値の両方を
 *       parse するので、producer 側はどちらでも自由。
 * Reference producer: browserhive の `src/storage/wacz/cdxj.ts` は
 *       文字列として出力する。
 *
 * クロスチェック戦略:
 *   1. `archive/` の WARC を全部、既存の `iterateWarcMembers` で辿り、本ごとに
 *      (offset, length) ペアを map に集める。
 *   2. CDXJ entry ごとに `filename` の本を選び、`offset` / `length` を parse し、
 *      その本の member を lookup。
 *   3. 不一致 → error。CDXJ の行番号と、近傍の候補 member (operator
 *      が corruption を目視できるよう) を付ける。
 *
 * `filename` が `archive/` のどの本でもない entry は `file-not-in-archive` (error)。
 * WARC が何本にも分かれて初めて起きる誤りで、1 本のときは `cdxj/filename-archive-relative`
 * の `archive/` プレフィックスの検査と重なっていた。`filename` が無い entry はそちらが言う。
 */
import { ok } from "../../result.js";
import { parseCdxj } from "../../wacz/cdxj-parser.js";
import { parseWarcRecord } from "../../wacz/warc-header.js";
import {
  WarcMemberDecodeError,
  iterateWarcMembers,
  type WarcMember,
} from "../../wacz/warc-iter.js";
import type { Issue, ValidationRule } from "../domain.js";

const CDXJ_ENTRY = "indexes/index.cdxj";

export const cdxjWarcOffsetsRule: ValidationRule = {
  name: "cdxj/warc-offsets",
  descriptionKey: "cdxj/warc-offsets.desc",
  conformance: "MUST",
  docs: [
      {
        label: "WACZ §indexes",
        url: {
          en: "https://specs.webrecorder.net/wacz/1.1.1/#indexes",
          ja: "https://uraitakahito.github.io/specs/wacz/1.1.1/#indexes",
        },
      },
  ],
  applicability: {
    severityByProfile: {
      lenient: {
        "cdxj/warc-offsets.missing-or-nonnumeric": "warning",
        "cdxj/warc-offsets.offset-no-match": "warning",
        "cdxj/warc-offsets.length-mismatch": "warning",
        "cdxj/warc-offsets.file-not-in-archive": "warning",
      },
    },
  },

  run: async (wacz) => {
    const issues: Issue[] = [];

    const cdxjBuf = await wacz.readEntry(CDXJ_ENTRY);
    if (!cdxjBuf) return ok(issues); // 不在は他 rule が報告する。

    // 本ごとの member。鍵は `archive/` からの相対の名 (CDXJ の `filename` と同じ形)。
    // `loose: true` にしているのは、warc/members-independent rule が
    // 既に rich な context つきで decode 失敗を報告するため。member
    // 1 つの不良で offset check を short-circuit させて、他の CDXJ
    // 行の visibility を失うのを避けたい。
    const files = new Map<string, { members: WarcMember[]; byOffset: Map<number, WarcMember> }>();
    for (const warcEntry of wacz.warcEntries()) {
      const warcBuf = await wacz.readEntry(warcEntry);
      if (!warcBuf) continue;
      let members: WarcMember[];
      try {
        members = Array.from(iterateWarcMembers(warcBuf, { loose: true }));
      } catch (error) {
        if (error instanceof WarcMemberDecodeError) continue;
        throw error;
      }
      const byOffset = new Map<number, WarcMember>();
      for (const m of members) byOffset.set(m.offset, m);
      files.set(warcEntry.slice("archive/".length), { members, byOffset });
    }
    if (files.size === 0) return ok(issues);

    const { entries } = parseCdxj(cdxjBuf.toString("utf-8"));
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry) continue;
      const filename = entry.fields["filename"];
      if (typeof filename !== "string" || filename.startsWith("archive/")) continue; // 無い・`archive/` 付きは cdxj/filename-archive-relative が言う。
      const file = files.get(filename);
      if (file === undefined) {
        issues.push({
          rule: "cdxj/warc-offsets",
          severity: "error",
          messageKey: "cdxj/warc-offsets.file-not-in-archive",
          params: { line: String(i + 1), filename },
          location: { entry: CDXJ_ENTRY, line: i + 1 },
          details: { filename, archive: [...files.keys()] },
        });
        continue;
      }
      const { members, byOffset } = file;

      const offsetField = entry.fields["offset"];
      const lengthField = entry.fields["length"];
      const offset = parseIntOrUndef(offsetField);
      const length = parseIntOrUndef(lengthField);

      const line = i + 1;
      if (offset === undefined || length === undefined) {
        issues.push({
          rule: "cdxj/warc-offsets",
          severity: "error",
          messageKey: "cdxj/warc-offsets.missing-or-nonnumeric",
          params: { line: String(line) },
          location: { entry: CDXJ_ENTRY, line },
          details: { offset: offsetField, length: lengthField },
        });
        continue;
      }

      const member = byOffset.get(offset);
      if (!member) {
        // 候補には WARC-Type header を付けて、operator が CDXJ 行が
        // それらしい record を指しているか一目で分かるようにする。
        // 全 member を dump せず近接の 2 〜 3 件だけ sniff して、
        // 詳細ブロックを読める長さに保つ。
        const candidates = members
          .map((m) => ({
            offset: m.offset,
            length: m.length,
            warcHeader: snippetHeader(m),
          }))
          .slice(0, 3);
        issues.push({
          rule: "cdxj/warc-offsets",
          severity: "error",
          messageKey: "cdxj/warc-offsets.offset-no-match",
          params: { line: String(line), offset: String(offset) },
          location: { entry: CDXJ_ENTRY, line, offset },
          details: {
            requested: { offset, length },
            candidates,
          },
        });
        continue;
      }
      if (member.length !== length) {
        issues.push({
          rule: "cdxj/warc-offsets",
          severity: "error",
          messageKey: "cdxj/warc-offsets.length-mismatch",
          params: {
            line: String(line),
            length: String(length),
            offset: String(offset),
            actual: String(member.length),
          },
          location: { entry: CDXJ_ENTRY, line, offset },
          details: {
            expected: { offset, length },
            actual: { offset: member.offset, length: member.length },
            // この offset に実在する record の完全な header block。
            // CDXJ 側 length のずれが header バグなのか、WARC が
            // 書き換えられたのかを operator が判別できる。
            warcHeader: snippetHeader(member),
          },
        });
      }
    }

    return ok(issues);
  },
};

/**
 * member の decode 済み bytes から正式な WARC header 行 (protocol +
 * Key:Value 行、blank line 区切りを除いたもの) を抜き出す。
 * issue.details に入れて、TUI の warcHeader view が「CDXJ 行が指し
 * 示した先には実際にはどの record があるか」を併記できるようにする。
 */
const snippetHeader = (member: WarcMember): string[] => {
  const record = parseWarcRecord(member.raw);
  if (!record) return [];
  const lines: string[] = [];
  if (record.protocol !== undefined) lines.push(record.protocol);
  for (const h of record.headers) {
    lines.push(`${h.name}: ${h.value}`);
  }
  return lines;
};

const parseIntOrUndef = (raw: unknown): number | undefined => {
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) return raw;
  if (typeof raw !== "string") return undefined;
  // CDXJ の慣習は decimal。非数字を含むなら reject — hex 風の
  // offset が間違った member と silent に match するのを防ぐ。
  if (!/^\d+$/.test(raw)) return undefined;
  return Number.parseInt(raw, 10);
};
