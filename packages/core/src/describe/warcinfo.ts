/**
 * 報告の `warcinfo` の欄を組む。WACZ の中の各 WARC の本について、warcinfo の記録の場所と、
 * 本文の欄（書かれた順・繰り返しも残す）を、欄ごとの語彙（Dublin Core の語／WARC 1.1 の欄／
 * どちらでもない）つきで返す。
 *
 * 本は読み直さない。WARC 1.1 の rule と同じ走査（`validate/warc11-scan.ts`。reader ごとに 1 度だけ）が、
 * warcinfo の本文を欄に読んだ結果を持っている。構造が壊れた記録は載せない —— 欄の rule と同じく、
 * その記録の値は信じられず、壊れは `warc/record-structure` が言う（1 つの欠陥を 2 か所に出さない）。
 */
import type { WarcinfoField, WarcinfoRecord } from "../validate/domain.js";
import { fieldValue, recordType, scanWarcFiles, type ScannedFile } from "../validate/warc11-scan.js";
import type { WaczReader } from "../wacz/reader.js";
import { classifyWarcinfoField } from "../vocab/classify.js";

const fieldOf = (name: string, value: string): WarcinfoField => {
  const { vocabulary, ref } = classifyWarcinfoField(name);
  return { name, value, vocabulary, ...(ref !== undefined && { ref }) };
};

/** 走査の結果から、報告の `warcinfo` を組む。試験から直接呼ぶために export する。 */
export const describeWarcinfo = (files: readonly ScannedFile[]): WarcinfoRecord[] => {
  const out: WarcinfoRecord[] = [];
  for (const file of files) {
    for (const record of file.records) {
      if (!record.sound || recordType(record) !== "warcinfo") continue;
      const recordId = fieldValue(record, "WARC-Record-ID");
      const date = fieldValue(record, "WARC-Date");
      const filename = fieldValue(record, "WARC-Filename");
      const contentType = fieldValue(record, "Content-Type");
      const parsed = record.warcinfoFields;
      out.push({
        entry: record.entry,
        index: record.index,
        offset: record.offset,
        ...(recordId !== undefined && { recordId }),
        ...(date !== undefined && { date }),
        ...(filename !== undefined && { filename }),
        ...(contentType !== undefined && { contentType }),
        ...(parsed !== undefined && { fields: parsed.fields.map((f) => fieldOf(f.name, f.value)) }),
        ...(parsed !== undefined && parsed.problems.length > 0 && { problems: parsed.problems.map((p) => ({ ...p })) }),
      });
    }
  }
  return out;
};

/**
 * WACZ の warcinfo を集める。検証を止めないよう、読めなければ `undefined` を返す（`stats` と同じ
 * best-effort）。走査の promise は rule と共有なので、本が読めないと reject したものがここにも来る。
 */
export const collectWarcinfo = async (wacz: WaczReader): Promise<WarcinfoRecord[] | undefined> => {
  try {
    return describeWarcinfo(await scanWarcFiles(wacz));
  } catch {
    return undefined;
  }
};
