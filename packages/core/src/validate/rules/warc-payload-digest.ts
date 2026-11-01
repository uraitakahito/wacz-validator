/**
 * Rule: warc/payload-digest
 *
 * `WARC-Payload-Digest` header は record の payload bytes に対する
 * 新しい SHA-256 と一致する必要がある。"Payload" は WARC 1.1 の §6 が
 * record type ごとに定める:
 *
 *   - response / request:  HTTP entity body (内側の `\r\n\r\n` 区切り
 *                          の後の bytes)
 *   - resource / conversion: record block をそのまま
 *   - revisit:             ここでは意図的にチェックしない — revisit
 *                          record は他 record の digest を再記述する
 *                          だけで自身に payload を持たないため、
 *                          local な sha が当てはまらない
 *   - warcinfo / metadata: payload の定義が無い。§5.9 はこの記録に
 *                          `WARC-Payload-Digest` を書くこと自体を禁じる
 *                          ので、照らさない (書いてあることは
 *                          `warc/fields-by-type` が言う)
 *   - 分割した記録:        `WARC-Segment-Number` を持つ先頭と continuation
 *                          の digest は、論理記録全体の payload のもの
 *                          (§5.9・§7)。1 つの segment の block とは合わない
 *                          ので照らさない
 *
 * digest の値は Base32 (RFC 4648、uppercase、padding なし) と Base16
 * (16 進) のどちらでも読む。WARC 1.1 は書き方を決めておらず、注釈
 * (recommendation #80) は Base32 を大文字・Base16 を小文字で書き、読む側は
 * 大小と padding を揃えて読むことを勧める。BrowserHive・Webrecorder は
 * Base32、Scoop は Base16 で書く (Base32 とだけ比べていたころは、Scoop の
 * 正しい digest を全部「不一致」と言っていた)。他のアルゴリズム (`sha1:...` 等) を emit する
 * producer は warning ではなく info レベルの note として受け入れる。
 * spec が任意の `algorithm:value` を許容しており、wacz-validator は
 * spec-coverage suite ではないため。
 *
 * Severity: `warning`。replay ツールは lookup 時に digest を再検証
 * しないのが普通なので、不一致はユーザ可視な挙動を壊さない — ただし
 * producer が response を記録した後で WARC bytes が変更された
 * シグナルにはなり、ほぼ常に corruption。
 */
import { ok } from "../../result.js";
import { formatHexLines } from "../../render/hex.js";
import { sha256Base32, sha256Hex } from "../../wacz/digest.js";
import { getHeader, httpEntityBody, parseWarcRecord } from "../../wacz/warc-header.js";
import { iterateWarcMembers } from "../../wacz/warc-iter.js";
import type { Issue, ValidationRule } from "../domain.js";

/**
 * `WARC-Payload-Digest` が record block をそのまま digest 対象にする
 * record type (§6.4・§6.8)。response / request は HTTP entity スライスを使う。
 */
const BODY_VERBATIM_TYPES = new Set(["resource", "conversion"]);

/** payload を照らさない record type。revisit は他の記録の payload、warcinfo / metadata は payload を持たない。 */
const NOT_CHECKED_TYPES = new Set(["revisit", "warcinfo", "metadata"]);

export const warcPayloadDigestRule: ValidationRule = {
  name: "warc/payload-digest",
  descriptionKey: "warc/payload-digest.desc",
  conformance: "SHOULD",
  docs: [
      {
        label: "WARC 1.1 §WARC-Payload-Digest",
        url: {
          en: "https://uraitakahito.github.io/warc-specifications/specifications/warc-format/warc-1.1-annotated/#warc-payload-digest",
        },
      },
  ],

  run: async (wacz) => {
    const issues: Issue[] = [];
    // 1 本も無ければ、不在は resource-hashes が cover する。member の番号は本ごとに数える。
    for (const entry of wacz.warcEntries()) {
      const warcBuf = await wacz.readEntry(entry);
      if (!warcBuf) continue;
      issues.push(...digestsOf(entry, warcBuf));
    }
    return ok(issues);
  },
};

/**
 * 宣言された sha256 の値（`sha256:` の後ろ）が payload の digest と同じか。Base16（64 桁の 16 進）
 * なら 16 進で、それ以外は Base32 で比べる（大小と末尾の padding は揃える）。不一致のときに見せる
 * 計算値は、宣言と同じ書き方にする。
 */
const compareSha256 = (declaredValue: string, payload: Buffer): { same: boolean; computed: string } => {
  if (/^[0-9a-f]{64}$/i.test(declaredValue)) {
    const computed = sha256Hex(payload);
    return { same: `sha256:${declaredValue.toLowerCase()}` === computed, computed };
  }
  const computed = sha256Base32(payload);
  return { same: `sha256:${declaredValue.replace(/=+$/, "").toUpperCase()}` === computed, computed };
};

/** 1 本の全 member の digest を照らす。 */
const digestsOf = (entry: string, warcBuf: Buffer): Issue[] => {
  const issues: Issue[] = [];
  let memberIdx = 0;
  for (const member of iterateWarcMembers(warcBuf, { loose: true })) {
    memberIdx += 1;
    const record = parseWarcRecord(member.raw);
    if (!record) continue;

    const recordType = (getHeader(record, "WARC-Type") ?? "").toLowerCase();
    const declared = getHeader(record, "WARC-Payload-Digest");
    if (declared === undefined) continue; // spec 上 optional。

    if (NOT_CHECKED_TYPES.has(recordType)) continue; // header コメント参照。
    // 分割した記録の digest は論理記録全体のもの (header コメント参照)。
    if (recordType === "continuation" || getHeader(record, "WARC-Segment-Number") !== undefined) continue;

    // sha256 以外のアルゴリズムは spec で許容される。rule は
    // informational にこれを表面化して、当該行は不一致ではなく
    // 未検証なのだと operator が把握できるようにする。
    if (!declared.toLowerCase().startsWith("sha256:")) {
      issues.push({
        rule: "warc/payload-digest",
        severity: "info",
        messageKey: "warc/payload-digest.non-sha256",
        params: { memberIdx: String(memberIdx), algo: declared.split(":")[0] ?? "" },
        location: { entry, offset: member.offset },
        details: { recordType, declared },
      });
      continue;
    }

    const payload = BODY_VERBATIM_TYPES.has(recordType) ? record.body : httpEntityBody(record);
    if (payload === null) {
      issues.push({
        rule: "warc/payload-digest",
        severity: "warning",
        messageKey: "warc/payload-digest.no-http-body",
        params: { memberIdx: String(memberIdx), recordType: recordType || "unknown" },
        location: { entry, offset: member.offset },
        details: { recordType, declared },
      });
      continue;
    }

    const { same, computed } = compareSha256(declared.slice(declared.indexOf(":") + 1), payload);
    if (!same) {
      issues.push({
        rule: "warc/payload-digest",
        severity: "warning",
        messageKey: "warc/payload-digest.mismatch",
        params: { memberIdx: String(memberIdx) },
        location: { entry, offset: member.offset },
        details: {
          recordType,
          expected: declared,
          actual: computed,
          payloadBytes: payload.byteLength,
          // payload 先頭 256 bytes の hex dump — operator が record
          // の運ぶはずのリソース (HTML? image? 全ゼロ pad?) として
          // 妥当に見えるかを目視確認できる。TUI 側の hex viewer が
          // この field を消費する。
          hexPreview: formatHexLines(payload),
        },
      });
    }
  }
  return issues;
};
