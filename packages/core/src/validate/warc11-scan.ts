/**
 * WARC 1.1 の rule（`warc/record-structure` ほか）が共有する、WACZ の中の WARC の走査。
 *
 * 7 本の rule は同じ記録を見る。engine は rule を並べて走らせ（`Promise.all`）、
 * `WaczReader.readEntry` は呼ぶたびに entry を展開し直す（HTTP なら取り直す）ので、rule ごとに
 * 読むと同じ本を 7 回展開することになる。ここで reader ごとに 1 度だけ読み、記録の見出しと
 * 構造の診断だけを覚える。block の中身は持たない（どの rule も長さしか使わない）。warcinfo だけは、
 * 本文を欄に読んだ結果（文字列）を持つ（報告の `warcinfo` の欄のため。`describe/warcinfo.ts`）。
 * 本文の Buffer は展開した本全体を指すので、持つと本を丸ごと抱えることになる。
 *
 * 圧縮した本は gzip の member を順に解き（`warc/members-independent` と同じ iterator を寛容に
 * 使う。解けない member から先は、その rule が言う）、member の中を記録に区切る。圧縮して
 * いない本は、本全体を記録に区切る。どちらを使うかは名前でなく中身の頭で決める（名前と
 * 中身の食い違いは `warc/extension-gzip-match` が言う）。
 */
import type { WaczReader } from "../wacz/reader.js";
import type { WarcHeader } from "../wacz/warc-header.js";
import { iterateWarcMembers } from "../wacz/warc-iter.js";
import { parseWarcFieldsBody, type NamedFields } from "../wacz/named-fields.js";
import { inspectWarcRecords, type InspectedWarcRecord, type WarcStructureProblem } from "../wacz/warc-records.js";

export interface ScannedRecord {
  /** `archive/` の中の本の名（ZIP の entry 名）。 */
  entry: string;
  /** 本の中で何番目の記録か（1 始まり）。message の「記録 #N」。 */
  index: number;
  /** 圧縮した本では member の先頭、圧縮していない本では記録の先頭のバイト位置。 */
  offset: number;
  /** 版の行の版（`"1.1"` など）。 */
  version?: string;
  /** 見出しの欄。記録として読めなかった（版の行や空行が無い）ときは空。 */
  headers: readonly WarcHeader[];
  /** block の長さ（見つかった実体）。 */
  blockLength: number;
  problems: readonly WarcStructureProblem[];
  /** 構造の問題が無いか、あっても欄を信じてよいもの（版・折り返し）だけ。欄の rule はこれだけを見る。 */
  sound: boolean;
  /**
   * warcinfo の本文を欄に読んだ結果。構造が健全で、`Content-Type` が `application/warc-fields` で、
   * 本文が {@link WARCINFO_FIELDS_MAX} 以下の warcinfo だけが持つ。
   */
  warcinfoFields?: NamedFields;
}

export interface ScannedFile {
  entry: string;
  records: readonly ScannedRecord[];
}

const isGzip = (buf: Buffer): boolean => buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;

/** warcinfo の本文を欄に読むのは、この大きさまで。走査の結果は、記録の分だけメモリに残る。 */
export const WARCINFO_FIELDS_MAX = 64 * 1024;

const lastHeader = (record: InspectedWarcRecord, name: string): string | undefined =>
  record.record?.headers.filter((h) => h.name.toLowerCase() === name).at(-1)?.value;

/** `Content-Type` が `application/warc-fields` か（引数と大文字小文字は見ない）。 */
const isWarcFields = (contentType: string | undefined): boolean =>
  contentType?.split(";")[0]?.trim().toLowerCase() === "application/warc-fields";

const warcinfoFieldsOf = (one: InspectedWarcRecord): NamedFields | undefined => {
  if (!one.sound || one.record === null) return undefined;
  if (lastHeader(one, "warc-type")?.toLowerCase() !== "warcinfo") return undefined;
  if (!isWarcFields(lastHeader(one, "content-type"))) return undefined;
  if (one.record.body.length > WARCINFO_FIELDS_MAX) return undefined;
  return parseWarcFieldsBody(one.record.body);
};

/** 1 冊の本を記録に区切って検める。試験から直接呼ぶために export する。 */
export const scanWarcFile = (entry: string, buf: Buffer): ScannedRecord[] => {
  const records: ScannedRecord[] = [];
  const add = (raw: Buffer, base: number | undefined): void => {
    for (const one of inspectWarcRecords(raw)) {
      const warcinfoFields = warcinfoFieldsOf(one);
      records.push({
        entry,
        index: records.length + 1,
        offset: base ?? one.start,
        ...(one.version !== undefined && { version: one.version }),
        headers: one.record?.headers ?? [],
        blockLength: one.record?.body.length ?? 0,
        problems: one.problems,
        sound: one.sound,
        ...(warcinfoFields !== undefined && { warcinfoFields }),
      });
    }
  };
  if (isGzip(buf)) {
    for (const member of iterateWarcMembers(buf, { loose: true })) add(member.raw, member.offset);
  } else {
    add(buf, undefined);
  }
  return records;
};

const scans = new WeakMap<WaczReader, Promise<ScannedFile[]>>();

const scanAll = async (wacz: WaczReader): Promise<ScannedFile[]> => {
  const files: ScannedFile[] = [];
  for (const entry of wacz.warcEntries()) {
    const buf = await wacz.readEntry(entry);
    if (buf === undefined) continue;
    files.push({ entry, records: scanWarcFile(entry, buf) });
  }
  return files;
};

/** WACZ の中の WARC を全部走査する。同じ reader には同じ結果を返す（1 度しか読まない）。 */
export const scanWarcFiles = (wacz: WaczReader): Promise<ScannedFile[]> => {
  let scan = scans.get(wacz);
  if (scan === undefined) {
    scan = scanAll(wacz);
    scans.set(wacz, scan);
  }
  return scan;
};

/** 欄の値を、書かれた順に全部（名の大小は無視）。 */
export const fieldValues = (record: ScannedRecord, name: string): string[] => {
  const lowered = name.toLowerCase();
  return record.headers.filter((h) => h.name.toLowerCase() === lowered).map((h) => h.value);
};

/** 欄の値。繰り返されていれば最後の値（`getHeader` と同じ。繰り返しは `warc/fields-by-type` が言う）。 */
export const fieldValue = (record: ScannedRecord, name: string): string | undefined => fieldValues(record, name).at(-1);

/** `WARC-Type` を小文字で。無ければ `undefined`。 */
export const recordType = (record: ScannedRecord): string | undefined => fieldValue(record, "WARC-Type")?.toLowerCase();

/** message に載せる値。長い値は切る（URI や壊れた行がそのまま報告を埋めないように）。 */
export const shown = (value: string): string => (value.length > 80 ? `${value.slice(0, 77)}...` : value);
