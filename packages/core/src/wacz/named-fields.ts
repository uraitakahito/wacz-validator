/**
 * WARC 1.1 の「名前: 値」の行（named-field）を読む。
 *
 * 記録の見出しと、`application/warc-fields` の本文（warcinfo・metadata）は、同じ `warc-fields` の
 * 文法で書かれる（WARC 1.1 の File and record model。繰り返しの形は注釈つき版の正誤 #116）:
 *
 *   warc-fields = *( named-field CRLF )
 *   named-field = field-name ":" [ field-value ]
 *
 * - 名前は RFC 7230 の token。WARC 1.1 は名前の大文字小文字を区別しない（{@link fieldValues}）
 * - コロンの後の空白は任意。値の前後の空白は落とす
 * - 空白かタブで始まる行は、前の欄の値の続き（折り返し）。文法上は合法で、注釈 #74 は書かないことを
 *   勧める。つないだうえで `folded-line` として返す
 * - 同じ名前の欄は、書かれた順に全部残す。繰り返してよいかは欄ごとの決まりで、それは rule が言う
 *
 * 見出しは `warc-records.ts` が行に分けてから {@link readNamedFields} に渡す。本文は
 * {@link parseWarcFieldsBody} が行に分ける。見出しの行分けは最初の空行で止まり、改行の無い最後の行を
 * 落とすので、本文には使えない。
 *
 * rule ではないので `validate/rules/` には置かない（docs の抽出器は、そこの `.ts` をすべて rule と見なす）。
 */
import type { Buffer } from "node:buffer";
import type { WarcHeader } from "./warc-header.js";

/** 名前と値の行で見つかる問題。`warc-records.ts` の `WarcStructureProblem` に、そのまま入る形。 */
export interface NamedFieldProblem {
  /** `bad-field-line`: 名前が token でない・コロンが無い・続ける前の欄が無いのに折り返している。`folded-line`: 折り返し。 */
  kind: "bad-field-line" | "folded-line";
  /** 1 始まりの行。数え始めは {@link readNamedFields} の `firstLine`。 */
  line: number;
  /** 壊れた行の先頭（40 字まで）か、折り返された欄の名。 */
  found: string;
}

export interface NamedFields {
  /** 読めた欄。書かれた順で、名前は書かれた綴りのまま。 */
  fields: WarcHeader[];
  problems: NamedFieldProblem[];
}

/** RFC 7230 の token。欄の名に許される文字。 */
export const FIELD_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * 行（行末の改行は外したもの）から欄を読む。折り返しは前の欄の値に、空白 1 つでつなぐ。
 * 空の行は飛ばす（見出しの行に空の行は来ない。本文の終わりの改行や、終わりの空行のため）。
 *
 * @param firstLine `lines[0]` が何行目か。見出しは版の行が 1 行目なので 2 を渡す。
 */
export const readNamedFields = (lines: readonly string[], firstLine = 1): NamedFields => {
  const fields: WarcHeader[] = [];
  const problems: NamedFieldProblem[] = [];
  lines.forEach((line, i) => {
    const lineNo = i + firstLine;
    if (line === "") return;
    if (line.startsWith(" ") || line.startsWith("\t")) {
      const previous = fields.at(-1);
      if (previous === undefined) {
        problems.push({ kind: "bad-field-line", line: lineNo, found: line.trim().slice(0, 40) });
        return;
      }
      problems.push({ kind: "folded-line", line: lineNo, found: previous.name });
      previous.value = `${previous.value} ${line.trim()}`.trim();
      return;
    }
    const colon = line.indexOf(":");
    const name = colon === -1 ? "" : line.slice(0, colon);
    if (!FIELD_NAME.test(name)) {
      problems.push({ kind: "bad-field-line", line: lineNo, found: line.slice(0, 40) });
      return;
    }
    fields.push({ name, value: line.slice(colon + 1).trim() });
  });
  return { fields, problems };
};

/**
 * `application/warc-fields` の本文を行に分ける。LF で割り、行末の CR を外す。空の行で止まらず、
 * 改行で終わらない最後の行も読む。行の番号を保つため、空の行も並びに残す。
 */
export const splitBodyLines = (body: Buffer | string): string[] =>
  (typeof body === "string" ? body : body.toString("utf-8"))
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));

/** `application/warc-fields` の本文（warcinfo・metadata の block）を欄に読む。行の番号は本文の 1 行目から。 */
export const parseWarcFieldsBody = (body: Buffer | string): NamedFields => readNamedFields(splitBodyLines(body), 1);

/** 名前が `name` の欄の値を、書かれた順に全部。名前の大文字小文字は区別しない（WARC 1.1）。 */
export const fieldValues = (fields: readonly WarcHeader[], name: string): string[] => {
  const wanted = name.toLowerCase();
  return fields.filter((f) => f.name.toLowerCase() === wanted).map((f) => f.value);
};

/**
 * 欄を、書かれた綴りをそのまま鍵にした Record にする。同じ綴りが 2 度在れば、後の値が勝つ。
 *
 * BrowserHive の metadata（送らなかった要求・終わらなかった取得・開かせなかったウィンドウ）のように、
 * 欄の綴りを producer の仕様が決めている本文を、鍵で引いて読むときに使う。綴りの違う同じ名前を
 * 1 つに数えたいとき（WARC 1.1 の決まりどおりに読むとき）は {@link fieldValues} を使う。
 */
export const fieldRecord = (fields: readonly WarcHeader[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const f of fields) out[f.name] = f.value;
  return out;
};
