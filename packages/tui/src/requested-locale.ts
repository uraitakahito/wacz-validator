/**
 * daemon へ送る表示 locale を決める。**旗が無ければ、TUI を動かしている端末の言語を送る。**
 *
 * daemon の `resolveLocale` は、受け取った値が在ればそれを読み、無いときだけ daemon 自身の環境変数を
 * 見る。空の文字列は「在る」ので、送ると環境変数を見ずに en に落ちる —— daemon を分けた 2026-06 から、
 * 旗なしの TUI は `LANG=ja_JP.UTF-8` でも英語だった。見る順は `--lang` の説明と validate-cli と同じ:
 * 旗 → `WACZ_VALIDATOR_LANG` → `LANG`。`ja_JP.UTF-8` を `ja` に縮めるのと、知らない値を en に落とす
 * のは daemon の側 (core の `resolveLocale`)。
 *
 * 言語を決めるのは読む人の端末の側 —— `--server` で別の機械の daemon につなぐときも、その daemon の
 * 環境ではなく、読む人の言語で出す。
 */
export const requestedLocale = (
  flag: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string => flag ?? env["WACZ_VALIDATOR_LANG"] ?? env["LANG"] ?? "";
