/**
 * Rule: warc/members-independent
 *
 * 各 WARC record は独立した gzip member として配置する必要がある。
 * そうすると WARC spec に従って member を連結したものが valid な
 * `.warc.gz` になり、CDXJ offset で他を decode せず単一 record まで
 * seek できる。
 *
 * Spec: WARC 1.1 §A.1 ("Record at a time gzip" — 各 record は
 *       自己完結した gzip member で、ファイルはそれらの member の
 *       連結)。
 * Reference producer: browserhive/src/storage/warc/writer.ts:1-15
 *       がこの不変条件をコードコメントで直接 ドキュメント化している。
 *
 * 検証方法: iterator を `loose: false` で歩く。iterator は先頭から
 * 順に member を解き、header の長さと deflate が消費した byte 数から
 * 次の member の位置を求める (境界を推測しない)。member として解け
 * ない位置に来ると `WarcMemberDecodeError` を throw するので、これを
 * catch して問題の offset / length を報告する。
 *
 * Severity は `error` — non-independent-member な WARC は CDXJ の
 * offset/length ペアに依存するすべての replay engine を silent に
 * 壊す。
 */
import { ok } from "../../result.js";
import { WarcMemberDecodeError, iterateWarcMembers } from "../../wacz/warc-iter.js";
import type { Issue, ValidationRule } from "../domain.js";

export const warcMembersIndependentRule: ValidationRule = {
  name: "warc/members-independent",
  descriptionKey: "warc/members-independent.desc",
  conformance: "MUST",
  docs: [
      {
        label: "WARC 1.1 §Record-at-time compression",
        url: {
          en: "https://uraitakahito.github.io/warc-specifications/specifications/warc-format/warc-1.1-annotated/#record-at-time-compression",
        },
      },
  ],

  run: async (wacz) => {
    const issues: Issue[] = [];
    // 1 本も無ければ、不在は resource-hashes など他の rule が表面化する。本ごとに独立に歩く。
    for (const entry of wacz.warcEntries()) {
      const bytes = await wacz.readEntry(entry);
      if (!bytes) continue;
      issues.push(...walk(entry, bytes));
    }
    return ok(issues);
  },
};

/** 1 本を先頭から歩き、落ちたところを issue にする。 */
const walk = (entry: string, bytes: Buffer): Issue[] => {
  const issues: Issue[] = [];
  try {
    let memberCount = 0;
    for (const _member of iterateWarcMembers(bytes, { loose: false })) {
      void _member;
      memberCount += 1;
    }
    if (memberCount === 0) {
      issues.push({
        rule: "warc/members-independent",
        severity: "error",
        messageKey: "warc/members-independent.no-members",
        params: { entry },
        location: { entry },
        details: { archiveBytes: bytes.byteLength },
      });
    }
  } catch (error) {
    if (error instanceof WarcMemberDecodeError) {
      issues.push({
        rule: "warc/members-independent",
        severity: "error",
        messageKey: "warc/members-independent.decode-failed",
        params: { offset: String(error.offset), length: String(error.length) },
        location: { entry, offset: error.offset },
        details: {
          offset: error.offset,
          length: error.length,
          reason: error.cause instanceof Error ? error.cause.message : String(error.cause),
        },
      });
    } else {
      // 想定外の throw — propagate せず issue として表面化することで、
      // 検証 run 自体は最後まで走らせる。
      issues.push({
        rule: "warc/members-independent",
        severity: "error",
        messageKey: "warc/members-independent.unexpected-error",
        params: { entry, detail: error instanceof Error ? error.message : String(error) },
        location: { entry },
      });
    }
  }
  return issues;
};
