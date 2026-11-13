// @module-tag tui
/**
 * requestedLocale (daemon へ送る表示 locale) の単体テスト。
 *
 * 純粋関数なので daemon も WACZ も不要。旗なしの TUI が空の文字列を送っていた間は、daemon が
 * 環境変数を見ずに en に落としていた (`--lang` の説明は「Defaults to LANG / en」)。
 */
import { describe, expect, it } from "vitest";
import { requestedLocale } from "../src/requested-locale.js";

describe("requestedLocale", () => {
  it("旗が在れば、環境変数より旗を送る", () => {
    expect(requestedLocale("en", { WACZ_VALIDATOR_LANG: "ja", LANG: "ja_JP.UTF-8" })).toBe("en");
  });

  it("旗が無ければ WACZ_VALIDATOR_LANG を送る (LANG より先)", () => {
    expect(requestedLocale(undefined, { WACZ_VALIDATOR_LANG: "ja", LANG: "en_US.UTF-8" })).toBe("ja");
  });

  it("旗も WACZ_VALIDATOR_LANG も無ければ、端末の LANG をそのまま送る (縮めるのは daemon)", () => {
    expect(requestedLocale(undefined, { LANG: "ja_JP.UTF-8" })).toBe("ja_JP.UTF-8");
  });

  it("どれも無ければ空の文字列を送る (daemon が en に落とす)", () => {
    expect(requestedLocale(undefined, {})).toBe("");
  });
});
