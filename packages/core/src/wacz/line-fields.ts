/**
 * 1 行を「ラベル付きの field 列」に割る純計算。
 *
 * WACZ の中身は **1 行に 1 レコードを詰め込む形式** が多い。実物
 * (`samples/wikipedia.wacz`) を測ると `indexes/index.cdx.gz` は 113 行で
 * 中央値 563 文字・最長 2064 文字あり、80 桁の端末では 14% しか見えない。
 * 切れた残りを読む手段が無いので、選んだ 1 行だけを縦に開けるようにする。
 *
 * かつては tui が持っていた。いまは daemon の `readLine` がここで割って
 * `fields` を返す —— tui も browser の画面も、割り方を持たない。
 *
 * 割り方は上から順に試して、当たらなければ次へ落とす:
 *
 *   1. CDXJ  … 空白で 3 分割でき、3 つ目が JSON object
 *   2. JSONL … 行全体が JSON object
 *   3. その他 … 割らない (1 field のまま)
 *
 * **どの入力でも必ず 1 つ以上の field を返す。** 呼び手は
 * 「割れなかった」を分岐せずに描ける。
 *
 * I/O を持たないので hermetic にテストできる。
 */

export interface Field {
  label: string;
  value: string;
  /**
   * JSON object の key 由来か。`key` / `timestamp` のような **こちらが付けた**
   * ラベルと、データが名乗ったラベルを UI が区別できるようにしている。
   */
  fromJson: boolean;
}

/** 割れなかった行に使うラベル。 */
const RAW_LABEL = "line";

/** JSON object として parse できたときだけ中身を返す (配列・数値・null は対象外)。 */
const asObject = (text: string): Record<string, unknown> | undefined => {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

const jsonFields = (object: Record<string, unknown>): Field[] =>
  Object.entries(object).map(([label, value]) => ({
    label,
    value: typeof value === "string" ? value : JSON.stringify(value),
    fromJson: true,
  }));

/**
 * CDXJ の 14 桁 timestamp に人間可読な日時を添える。
 *
 * **CDXJ と判定できた行の 2 つ目に限る。** 「14 桁の数字」という形だけを見て
 * 日時と決めつけると、たまたま 14 桁の別物を誤読する。ここでは位置の情報が
 * あるので安全に解釈できる。
 */
const withReadableTimestamp = (timestamp: string): string => {
  if (!/^\d{14}$/.test(timestamp)) return timestamp;
  // 14 桁であることは上で確かめてあるので、位置で切り出す。捕獲群の分割代入は
  // どれも `string | undefined` になり、template literal に置けない。
  const at = (from: number, to: number): string => timestamp.slice(from, to);
  return `${timestamp}  (${at(0, 4)}-${at(4, 6)}-${at(6, 8)} ${at(8, 10)}:${at(10, 12)}:${at(12, 14)} UTC)`;
};

export const explodeLine = (line: string): Field[] => {
  // CDXJ: `<SURT キー> <timestamp> <JSON>`。JSON 側にも空白が入るので、
  // 分割は先頭 2 つの空白だけで行う (`split(" ")` では値の中で割れる)。
  const first = line.indexOf(" ");
  const second = first < 0 ? -1 : line.indexOf(" ", first + 1);
  if (second > 0) {
    const object = asObject(line.slice(second + 1));
    if (object !== undefined) {
      return [
        { label: "key", value: line.slice(0, first), fromJson: false },
        {
          label: "timestamp",
          value: withReadableTimestamp(line.slice(first + 1, second)),
          fromJson: false,
        },
        ...jsonFields(object),
      ];
    }
  }

  // 空の object (`{}`) は parse できても見せる field が無い。ここで採ると
  // 「何も描かれない行」が生まれるので、割らなかった扱いにして raw を見せる。
  const whole = asObject(line);
  if (whole !== undefined && Object.keys(whole).length > 0) return jsonFields(whole);

  return [{ label: RAW_LABEL, value: line, fromJson: false }];
};
