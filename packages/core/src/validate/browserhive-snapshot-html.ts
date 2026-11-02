/**
 * DOM の写し（BrowserHive WARC Profile 1.1.0 の #snapshot-content）の HTML に、頁の script が残っていないかを読む。
 *
 * HTML を組み立て直す parser は持たない。写しは producer が HTML の直列化の決まりで書いた物で、見るのは
 * script の要素の開始タグの有無だけなので、文字列のまま読める。それでも誤らないために 2 つを守る:
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
