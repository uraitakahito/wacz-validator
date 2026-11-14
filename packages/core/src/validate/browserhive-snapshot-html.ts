/**
 * DOM の写し（BrowserHive WARC Profile 1.1.0 の #snapshot-content）の HTML に、頁の script が残っていないかを読む。
 *
 * もう 1 つ、子フレームの写し（WARC Profile 1.5.0）を名指す枠の要素の属性 `data-browserhive-snapshot` を読む。
 *
 * HTML を組み立て直す parser は持たない。写しは producer が HTML の直列化の決まりで書いた物で、見るのは
 * 開始タグ（script の要素の有無と、枠の要素の属性）だけなので、文字列のまま読める。それでも誤らないために 2 つを守る:
 *
 *   - **コメントを先に外す。** 古い頁は IE の条件付きコメント（`<!--[if lt IE 9]><script …><![endif]-->`）を
 *     持ち、写しはコメントを残す。中の `<script` は要素ではない
 *   - **タグの名の後ろを見る。** `<script` の後に空白・`/`・`>` が続くときだけタグと読む。`<script-loader>` の
 *     ようなカスタム要素を、script の要素と取り違えない
 *
 * 見落としうるもの: style などの生の文字の要素の中の `<script` は、要素ではないのに数える。属性の値の中の
 * `<!--` はコメントの始まりと読む（Chrome は 138 から属性の値の `<` を `&lt;` と書くので、BrowserHive の写しには
 * どちらも、ほぼ現れない）。
 *
 * rule ではないので `validate/rules/` には置かない（docs の抽出器は、そこの `.ts` をすべて rule と見なす）。
 */

/** コメントを空白 1 つに置き換える。`<!-->`・`<!--->` は空のコメント、閉じないコメントは終わりまで（HTML の字句の決まり）。 */
export const withoutComments = (html: string): string => {
  let out = "";
  let at = 0;
  for (;;) {
    const open = html.indexOf("<!--", at);
    if (open === -1) return out + html.slice(at);
    out += `${html.slice(at, open)} `;
    const rest = open + "<!--".length;
    if (html.startsWith(">", rest)) {
      at = rest + 1;
      continue;
    }
    if (html.startsWith("->", rest)) {
      at = rest + 2;
      continue;
    }
    const close = /--!?>/g;
    close.lastIndex = rest;
    const end = close.exec(html);
    if (end === null) return out;
    at = end.index + end[0].length;
  }
};

/** script の要素の開始タグ。名の大文字小文字を問わず、後ろに空白・`/`・`>` が続く形だけ。 */
const SCRIPT_START = /<script[\s/>]/i;

/** 写しに script の要素が在るか（コメントの中は数えない）。 */
export const hasScriptElement = (html: string): boolean => SCRIPT_START.test(withoutComments(html));

/** 親の写しの枠の要素が、写した子の URI を持つ属性（BrowserHive WARC Profile 1.5.0）。 */
export const SNAPSHOT_ATTRIBUTE = "data-browserhive-snapshot";

/** 開始タグ。属性の値の引用符の中の `>` でタグを切らない。 */
const START_TAG = /<([A-Za-z][^\s/>]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;

/** 開始タグの中の属性 1 つ。名と、引用符つき・引用符なしの値。 */
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

/** 属性の値の文字参照。直列化が書く名前つきの物（`&amp;`・`&quot;`・`&lt;`・`&gt;`・`&nbsp;`・`&#39;`）と数の物。 */
const NAMED_REFERENCES: Readonly<Record<string, string>> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
const decodeAttribute = (value: string): string =>
  value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref.startsWith("#")) {
      const code = ref[1] === "x" || ref[1] === "X" ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_REFERENCES[ref.toLowerCase()] ?? whole;
  });

/**
 * 写しの要素のうち `data-browserhive-snapshot` を持つ物の、要素の名（小文字）と属性の値（文字参照を解いた物）。
 * 文書の順に。コメントの中は数えない。`hasScriptElement` と同じく、style などの生の文字の要素の中のタグの形も数える。
 */
export const snapshotAttributes = (html: string): { element: string; value: string }[] => {
  const found: { element: string; value: string }[] = [];
  for (const tag of withoutComments(html).matchAll(START_TAG)) {
    const [, name = "", attributes = ""] = tag;
    for (const attribute of attributes.matchAll(ATTRIBUTE)) {
      const [, key = "", doubleQuoted, singleQuoted, unquoted] = attribute;
      if (key.toLowerCase() !== SNAPSHOT_ATTRIBUTE) continue;
      found.push({ element: name.toLowerCase(), value: decodeAttribute(doubleQuoted ?? singleQuoted ?? unquoted ?? "") });
      break; // 同じ名の 2 つ目の属性は、HTML の読み手が捨てる
    }
  }
  return found;
};
