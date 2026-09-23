/**
 * WARC のレコードを「一覧の 1 行」と「開いた 1 件」に整える純関数。
 *
 * daemon の `readRecords` / `readRecord` が使う。検証の rule が持つ parser
 * (`parseWarcRecord` / `iterateWarcMembers`) の上に載せるだけで、WARC の
 * 読み方をここで増やさない —— 読み方が 2 つあると、検証と画面が食い違う。
 */
import type { Buffer } from "node:buffer";
import { getHeader, parseWarcRecord, type WarcHeader } from "./warc-header.js";
import type { WarcMember } from "./warc-iter.js";

/** 一覧の 1 行。索引との突き合わせ (`indexed`) は daemon が足す。 */
export interface WarcRecordSummary {
  offset: number;
  length: number;
  /** `WARC-Type` を小文字で。見出しが読めなければ `?`。 */
  type: string;
  uri?: string;
  date?: string;
  /** WARC の `Content-Type` (`application/http;msgtype=response` 等)。 */
  contentType?: string;
  /** 応答なら HTTP の状態コード。 */
  status?: number;
  /** 応答なら HTTP の `content-type` (parameters を落として小文字)。 */
  mime?: string;
}

export interface HttpBlock {
  /** 状態行 (`HTTP/1.1 200 OK`)。 */
  status: string;
  headers: WarcHeader[];
}

export interface ParsedRecord {
  protocol?: string;
  warc: WarcHeader[];
  /** WARC の `Content-Type` が `application/http` のとき、本文の頭にある HTTP の見出し。 */
  http?: HttpBlock;
  /** 本文。HTTP なら entity body (見出しの後ろ)。 */
  body: Buffer;
}

const CRLFCRLF = "\r\n\r\n";

const parseHttpHead = (head: string): HttpBlock => {
  const [status = "", ...rest] = head.split("\r\n");
  const headers: WarcHeader[] = [];
  for (const line of rest) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    headers.push({ name: line.slice(0, colon), value: line.slice(colon + 1).trimStart() });
  }
  return { status, headers };
};

/** 大小無視・後勝ちの見出し引き (HTTP の意味論と同じ)。 */
export const httpHeader = (block: HttpBlock, name: string): string | undefined => {
  const lowered = name.toLowerCase();
  let value: string | undefined;
  for (const header of block.headers) {
    if (header.name.toLowerCase() === lowered) value = header.value;
  }
  return value;
};

/** `text/html; charset=utf-8` → `text/html`。空なら undefined。 */
export const mimeOf = (contentType: string | undefined): string | undefined => {
  const type = contentType?.split(";")[0]?.trim().toLowerCase();
  return type === undefined || type === "" ? undefined : type;
};

/**
 * 展開済みの 1 レコードを、WARC の見出し・(あれば) HTTP の見出し・本文に割る。
 * 見出しの区切りが無ければ undefined (レコードではない)。
 */
export const parseRecord = (raw: Buffer): ParsedRecord | undefined => {
  const record = parseWarcRecord(raw);
  if (record === null) return undefined;
  const base = record.protocol !== undefined ? { protocol: record.protocol } : {};
  const contentType = getHeader(record, "Content-Type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/http")) {
    return { ...base, warc: record.headers, body: record.body };
  }
  const sep = record.body.indexOf(CRLFCRLF);
  // HTTP の見出しが閉じていない (壊れた block) → 本文をそのまま見せる
  if (sep === -1) return { ...base, warc: record.headers, body: record.body };
  return {
    ...base,
    warc: record.headers,
    http: parseHttpHead(record.body.subarray(0, sep).toString("utf-8")),
    body: record.body.subarray(sep + CRLFCRLF.length),
  };
};

/** 一覧に出す分だけを取り出す。本文は読まない (見出しまで)。 */
export const summarizeMember = (member: WarcMember): WarcRecordSummary => {
  const parsed = parseRecord(member.raw);
  const base = { offset: member.offset, length: member.length };
  if (parsed === undefined) return { ...base, type: "?" };
  const warc = (name: string): string | undefined => {
    const lowered = name.toLowerCase();
    let value: string | undefined;
    for (const header of parsed.warc) {
      if (header.name.toLowerCase() === lowered) value = header.value;
    }
    return value;
  };
  const summary: WarcRecordSummary = { ...base, type: (warc("WARC-Type") ?? "?").toLowerCase() };
  const uri = warc("WARC-Target-URI");
  if (uri !== undefined) summary.uri = uri;
  const date = warc("WARC-Date");
  if (date !== undefined) summary.date = date;
  const contentType = warc("Content-Type");
  if (contentType !== undefined) summary.contentType = contentType;
  if (parsed.http !== undefined) {
    const code = Number(parsed.http.status.split(" ")[1]);
    if (Number.isInteger(code)) summary.status = code;
    const mime = mimeOf(httpHeader(parsed.http, "content-type"));
    if (mime !== undefined) summary.mime = mime;
  }
  return summary;
};
