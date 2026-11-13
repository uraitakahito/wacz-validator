/**
 * CDXJ parser。
 *
 * `indexes/index.cdxj` の各非空行は次の形を持つ:
 *
 *   <surt-url> <yyyymmddhhmmss> <json>
 *
 * 行は `\n` で区切られる。空行や末尾の改行は許容する。最初の 2 つの
 * 空白区切りトークンが SURT と 14 桁の timestamp。2 つ目の空白から
 * 後がレコードを表す JSON object (url / mime / status / digest /
 * length / offset / filename)。
 *
 * Spec / 慣習: pywb の CDXJ format ドキュメント。WACZ 1.1.1 spec は
 *       index format を差し替え可能にしているが、`index.cdxj` が
 *       新しい producer の事実上の選択肢。Reference producer:
 *       browserhive の `src/storage/wacz/cdxj.ts`。
 *
 * 分割戦略: JSON 値自身に空白が含まれる (`": "` 等) ため、ナイーブな
 * `.split(" ")` は JSON を壊す。最初の 2 つの空白位置を求めて slice
 * する — `String#indexOf` を 2 回するのは、形が固定であることを
 * 考えると、capture group を伴う regex より速く明快。
 */
import { err, ok, type Result } from "../result.js";

export interface CdxjEntry {
  /** SURT (Sort-friendly URI Reordering Transform) of the captured URL. */
  surt: string;
  /** 14-digit timestamp `yyyymmddhhmmss`. */
  timestamp: string;
  /** Parsed JSON object (whatever the producer wrote — typed as Record for downstream rules to narrow). */
  fields: Record<string, unknown>;
}

export interface CdxjLineError {
  /** 1-based line number in the source CDXJ text. */
  line: number;
  /** The offending line (truncated to 200 chars to keep error reports bounded). */
  rawLine: string;
  reason:
    | "missing-fields" // Couldn't find two whitespace separators.
    | "invalid-json" // The JSON tail did not parse.
    | "json-not-object" // The JSON parsed but wasn't an object literal.
    | "empty-surt-or-timestamp"; // First two tokens empty.
}

export interface CdxjParseResult {
  entries: CdxjEntry[];
  errors: CdxjLineError[];
}

const MAX_RAW_LINE_LEN = 200;

/**
 * CDXJ ドキュメントを parse する。結果は常に両方の array を持つ —
 * 呼び出し側が `errors` の存在を validation 失敗とみなすか、それとも
 * informational として扱うかを決める。CDXJ 系 rule は parse 済み
 * entry の field を見るため、行単位の parse エラーで short-circuit
 * せず `errors` array に積む方が rule 側で診断を組み立てやすい。
 */
export const parseCdxj = (text: string): CdxjParseResult => {
  const entries: CdxjEntry[] = [];
  const errors: CdxjLineError[] = [];

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (rawLine === undefined) continue;
    if (rawLine.length === 0) continue;

    const parsed = parseLine(rawLine);
    if (parsed.ok) {
      entries.push(parsed.value);
    } else {
      errors.push({
        line: i + 1,
        rawLine: rawLine.slice(0, MAX_RAW_LINE_LEN),
        reason: parsed.error,
      });
    }
  }

  return { entries, errors };
};

const parseLine = (line: string): Result<CdxjEntry, CdxjLineError["reason"]> => {
  const firstSpace = line.indexOf(" ");
  if (firstSpace === -1) return err("missing-fields");
  const secondSpace = line.indexOf(" ", firstSpace + 1);
  if (secondSpace === -1) return err("missing-fields");

  const surt = line.slice(0, firstSpace);
  const timestamp = line.slice(firstSpace + 1, secondSpace);
  const json = line.slice(secondSpace + 1);

  if (surt.length === 0 || timestamp.length === 0) {
    return err("empty-surt-or-timestamp");
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(json);
  } catch {
    return err("invalid-json");
  }

  if (typeof parsedJson !== "object" || parsedJson === null || Array.isArray(parsedJson)) {
    return err("json-not-object");
  }

  return ok({
    surt,
    timestamp,
    fields: parsedJson as Record<string, unknown>,
  });
};
