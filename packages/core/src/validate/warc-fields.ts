/**
 * `application/warc-fields` の本文を `key: value` の組に読む。
 *
 * BrowserHive の metadata レコード（送らなかった要求・終わらなかった取得・開かせなかったウィンドウ）は、
 * どれもこの形の本文を持つ。継続行は折り畳まない。同じ鍵が 2 度在れば、後の値が勝つ。
 *
 * rule ではないので `rules/` には置かない。docs の抽出器は `rules/` 配下の `.ts` をすべて rule と見なす。
 */
export const parseWarcFields = (body: Buffer): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of body.toString("utf-8").split("\n")) {
    const sep = line.indexOf(": ");
    if (sep > 0) out[line.slice(0, sep).trim()] = line.slice(sep + 2).trim();
  }
  return out;
};

/**
 * `application/warc-fields` の本文から、ある鍵の値を**全部**、書かれた順に読む。
 *
 * `parseWarcFields` は同じ鍵を後の値で上書きするので、「ちょうど 1 つ在るか」を問う rule
 * (`browserhive/warcinfo-declares-profile` の `conformsTo`) はこちらを使う。行の読み方は同じ。
 */
export const warcFieldValues = (body: Buffer, key: string): string[] => {
  const out: string[] = [];
  for (const line of body.toString("utf-8").split("\n")) {
    const sep = line.indexOf(": ");
    if (sep > 0 && line.slice(0, sep).trim() === key) out.push(line.slice(sep + 2).trim());
  }
  return out;
};
