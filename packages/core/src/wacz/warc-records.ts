/**
 * WARC の記録を、WARC 1.1 の §4 の形に照らしながら区切って読む。
 *
 * `warc-header.ts` の `parseWarcRecord` は「gzip の 1 member に 1 記録」を前提に、読めるものを
 * 読む寛容な parser で、何が壊れていたかは言わない。こちらは WARC 1.1 の記録の文法
 *
 *   warc-record = header CRLF block CRLF CRLF
 *   header      = version warc-fields
 *   version     = "WARC/1.1" CRLF
 *   warc-fields = *( named-field CRLF )
 *
 * に照らし、壊れを {@link WarcStructureProblem} として返す。記録の終わりは `Content-Length` で
 * 決めるので、1 member に記録が 2 つ以上入った本（Annex D は 1 記録 1 member を勧めるだけで、
 * 求めてはいない）も、圧縮していない `.warc` も同じ道で読める。
 *
 * 見出しは行ごとに読み、行の終わりが CRLF か LF かを行ごとに見る（CRLF と LF が混ざった見出しも
 * 版の行から読める）。`Content-Length` が無い・数でない・実体と合わないときは、次の記録の頭
 * （記録を閉じる並びに続く `WARC/`）を探して区切り直す。block がたまたま同じ並びを含むと
 * 区切りを誤るが、それは WARC を block に抱えた記録くらいで、そのときは長さの問題が先に出ている。
 */
import { Buffer } from "node:buffer";
import { readNamedFields } from "./named-fields.js";
import type { ParsedWarcRecord } from "./warc-header.js";

const CRLFCRLF = Buffer.from("\r\n\r\n");
const LFLF = Buffer.from("\n\n");
const RECORD_HEAD = Buffer.from("WARC/");

export type WarcStructureProblemKind =
  /** 先頭の行が `WARC/<版>` でない。記録として読まない。 */
  | "no-version-line"
  /** 版の行は在るが 1.1 でない（`WARC/1.0` など）。記録は 1.1 の決まりで見続ける。 */
  | "version-not-1-1"
  /** 見出しの行が CRLF でなく LF で終わっている（一部の行だけでも）。 */
  | "lf-line-ending"
  /** 見出しと block を分ける空行が無い。記録として読まない。 */
  | "no-blank-line"
  /** `name: value` の形でない行（名が token でない・コロンが無い）。 */
  | "bad-field-line"
  /** 値が次の行へ折り返されている。文法上は合法で、注釈 #74 は書かないことを勧める。 */
  | "folded-line"
  /** 見出しが UTF-8 として読めない。 */
  | "non-utf8"
  /** `Content-Length` が無い。 */
  | "content-length-missing"
  /** `Content-Length` が数（1*DIGIT）でない。 */
  | "content-length-form"
  /** block の実体の長さが `Content-Length` と合わない。 */
  | "content-length-mismatch"
  /** block の後に、記録を閉じる CRLF CRLF が無い。 */
  | "no-terminator";

/**
 * 見つかっても、記録の欄はまだ信じてよい問題。`warc/record-structure` 以外の rule は、
 * これ以外の問題を 1 つでも持つ記録を見ない（同じ欠陥を 2 本の rule が言わないため）。
 */
const SOUND_KINDS: ReadonlySet<WarcStructureProblemKind> = new Set(["version-not-1-1", "folded-line"]);

export interface WarcStructureProblem {
  kind: WarcStructureProblemKind;
  /** 見出しの中の 1 始まりの行（行の問題のとき）。 */
  line?: number;
  /** 見つかった値（版の行・壊れた行の先頭・Content-Length の値）や、折り返された欄の名。 */
  found?: string;
  /** `Content-Length` の値と実体の長さ（長さの問題のとき）。 */
  declared?: number;
  actual?: number;
}

export interface InspectedWarcRecord {
  /** 読んだバイト列の中で、記録が始まる位置。 */
  start: number;
  /** 記録の終わりの次の位置。次の記録はここから始まる。 */
  end: number;
  /**
   * 読めた記録。折り返しは 1 行にまとめ、値の前後の空白は落としてある。版の行が無い・
   * 空行が無い記録は `null`。
   */
  record: ParsedWarcRecord | null;
  /** 版の行の版（`"1.1"` など）。版の行が無ければ `undefined`。 */
  version?: string;
  problems: WarcStructureProblem[];
  /** `SOUND_KINDS` 以外の問題を持たない。欄の rule が見てよい記録。 */
  sound: boolean;
}

const VERSION_LINE = /^WARC\/(\d+\.\d+)$/;
const DIGITS = /^\d+$/;
const utf8 = new TextDecoder("utf-8", { fatal: true });

const isUtf8 = (buf: Buffer): boolean => {
  try {
    utf8.decode(buf);
    return true;
  } catch {
    return false;
  }
};

/**
 * 見出しを行に分ける。行の終わりは LF で探し、直前が CR かどうかを行ごとに見る。最初の空行で
 * 見出しが終わる。空行が無ければ `blankLineEnd` は -1。
 */
const readHeaderLines = (
  buf: Buffer,
  start: number,
): { lines: Buffer[]; blankLineEnd: number; bareLf: boolean; blankIsCrlf: boolean } => {
  const lines: Buffer[] = [];
  let bareLf = false;
  let at = start;
  for (;;) {
    const nl = buf.indexOf(0x0a, at);
    if (nl === -1) return { lines, blankLineEnd: -1, bareLf, blankIsCrlf: true };
    const crlf = nl > at && buf[nl - 1] === 0x0d;
    const line = buf.subarray(at, crlf ? nl - 1 : nl);
    at = nl + 1;
    if (!crlf) bareLf = true;
    if (line.length === 0) return { lines, blankLineEnd: at, bareLf, blankIsCrlf: crlf };
    lines.push(line);
  }
};

/**
 * `Content-Length` で区切れなかった記録の終わりを、次の記録の頭から探す。
 * 見つからなければ、読んでいるバイト列の終わりまでがこの記録。
 */
const resync = (
  buf: Buffer,
  bodyStart: number,
  terminator: Buffer,
): { blockLength: number; end: number; terminated: boolean } => {
  const next = buf.indexOf(Buffer.concat([terminator, RECORD_HEAD]), bodyStart);
  if (next !== -1) return { blockLength: next - bodyStart, end: next + terminator.byteLength, terminated: true };
  const terminated =
    buf.length - bodyStart >= terminator.byteLength && buf.subarray(buf.length - terminator.byteLength).equals(terminator);
  return {
    blockLength: buf.length - bodyStart - (terminated ? terminator.byteLength : 0),
    end: buf.length,
    terminated,
  };
};

const inspectOne = (buf: Buffer, start: number): InspectedWarcRecord => {
  const problems: WarcStructureProblem[] = [];
  const done = (end: number, record: ParsedWarcRecord | null, version?: string): InspectedWarcRecord => ({
    start,
    end,
    record,
    ...(version !== undefined && { version }),
    problems,
    sound: record !== null && problems.every((p) => SOUND_KINDS.has(p.kind)),
  });

  const { lines, blankLineEnd, bareLf, blankIsCrlf } = readHeaderLines(buf, start);
  const first = (lines[0] ?? buf.subarray(start, Math.min(buf.length, start + 40))).toString("utf-8");
  const version = VERSION_LINE.exec(first)?.[1];
  if (version === undefined) {
    problems.push({ kind: "no-version-line", found: first.slice(0, 40) });
    return done(buf.length, null);
  }
  if (version !== "1.1") problems.push({ kind: "version-not-1-1", found: first });
  if (bareLf) problems.push({ kind: "lf-line-ending" });
  if (blankLineEnd === -1) {
    problems.push({ kind: "no-blank-line" });
    return done(buf.length, null, version);
  }
  if (!isUtf8(buf.subarray(start, blankLineEnd))) problems.push({ kind: "non-utf8" });
  const { fields: headers, problems: fieldProblems } = readNamedFields(
    lines.slice(1).map((line) => line.toString("utf-8")),
    2,
  );
  problems.push(...fieldProblems);

  // 記録を閉じる並びは、見出しを閉じた空行と同じ改行で探す（LF で書いた記録は LF LF で閉じている）。
  const terminator = blankIsCrlf ? CRLFCRLF : LFLF;
  const bodyStart = blankLineEnd;
  // 後勝ち（`getHeader` と同じ）。繰り返しそのものは `warc/fields-by-type` が言う。
  const declaredRaw = headers.filter((h) => h.name.toLowerCase() === "content-length").at(-1)?.value;
  let blockLength: number;
  let end: number;
  if (declaredRaw === undefined || !DIGITS.test(declaredRaw)) {
    problems.push(
      declaredRaw === undefined
        ? { kind: "content-length-missing" }
        : { kind: "content-length-form", found: declaredRaw.slice(0, 40) },
    );
    ({ blockLength, end } = resync(buf, bodyStart, terminator));
  } else {
    const declared = Number(declaredRaw);
    const blockEnd = bodyStart + declared;
    const after = blockEnd + terminator.byteLength;
    const closes = buf.subarray(blockEnd, after).equals(terminator);
    const nextIsRecord = after === buf.length || buf.subarray(after, after + RECORD_HEAD.byteLength).equals(RECORD_HEAD);
    if (closes && nextIsRecord) {
      blockLength = declared;
      end = after;
    } else if (blockEnd === buf.length) {
      problems.push({ kind: "no-terminator" });
      blockLength = declared;
      end = buf.length;
    } else {
      const found = resync(buf, bodyStart, terminator);
      problems.push({ kind: "content-length-mismatch", declared, actual: found.blockLength });
      ({ blockLength, end } = found);
    }
  }

  const record: ParsedWarcRecord = {
    protocol: first,
    headers,
    body: buf.subarray(bodyStart, bodyStart + blockLength),
  };
  return done(end, record, version);
};

/**
 * バイト列（gzip の 1 member を展開したもの、または圧縮していない WARC の本）を、記録ごとに
 * 区切って検める。版の行や空行が無い記録に当たると、そこから先は記録として読まない。
 */
export const inspectWarcRecords = (buf: Buffer): InspectedWarcRecord[] => {
  const out: InspectedWarcRecord[] = [];
  let start = 0;
  while (start < buf.length) {
    const one = inspectOne(buf, start);
    out.push(one);
    if (one.end <= start) break;
    start = one.end;
  }
  return out;
};
