/**
 * Rule: browserhive/robots-override-shape (error · browserhive profile 限定)
 *
 * `browserhive:capture.robotsOverride` の形。BrowserHive WACZ Profile 1.29.0 で入った任意の member で、取り込みを
 * 求めた側（要求者）の申告を運ぶ —— 求めた URL を `robots.txt` が断っていると判じ、それでも登録された例外のもとで
 * 取り込みを求めた、という申告。在るなら、表の member をみな持つオブジェクトでなければならない。
 *
 * 見ること（どれも error。場所は `datapackage.json`）:
 *
 *   - `not-object`     `robotsOverride` がオブジェクト
 *   - `missing-member` `exemptionId`・`reason`・`pathPattern`・`scope`・`grantedBy`・`grantedAt`・`expiresAt` が在る
 *   - `not-string`     その 7 つが文字列
 *   - `empty`          `exemptionId`・`grantedBy` が 1 字以上
 *   - `reason-length`  `reason` が Unicode の code point で 1〜500（`.length` は UTF-16 の code unit なので使わない）
 *   - `path-pattern`   `pathPattern` が `/` で始まる
 *   - `scope`          `scope` が `seeds` か `links`
 *   - `date-time`      `grantedAt`・`expiresAt` が RFC 3339 の date-time（時差つきも通す。producer は UTC に
 *                      書き直さない）
 *
 * 1 つの member には 1 つだけ言う（欠け → 型 → 値）。表に無い member には何も言わない（`browserhive/settings-shape`
 * と同じ）。`reason` の中身は報告へ写さず、長さだけを言う。
 *
 * **見ないこと。** 申告は要求者の物で、producer が確かめるのもこの形だけ（形の合わない申告の要求は断る）。`robots.txt` がその URL を断っていたか、例外が
 * 在って URL に当たるか、取り込みの時に効いていたか（`grantedAt` と `expiresAt` の前後を含む）は、package からは
 * 分からない。`pathPattern` が `robots.txt` の path の書き方として読めるかも見ない。要求が申告を持っていたのに
 * member が無いこと、持っていなかったのに在ることも、package からは分からない。
 *
 * **無ければ何も言わない。** 無い package は「何も外していない」か「外したことを申告していない」のどちらかで、
 * どちらも正しい形。
 *
 * **archive 自身の宣言 (`conformsTo`) で分ける。** 1.28.0 以下を名乗る archive と、版を名乗らない archive には
 * 当てない —— それらが持つ同じ名前の member は、1.29.0 の定める物とは限らない（1.29.0 の Status の注）。
 *
 * Spec: https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.29.0/#robotsoverride
 */
import { ok } from "../../result.js";
import { RFC3339_DATE_TIME } from "../browserhive-logs.js";
import { isRecord, profileAtLeast, readCapture } from "../browserhive-storage.js";
import { DATAPACKAGE_ENTRY } from "../datapackage-source.js";
import type { Issue, ValidationRule } from "../domain.js";
import type { MsgParams } from "../../i18n/translate.js";

const RULE = "browserhive/robots-override-shape";

/** JSON の値を文字で。無い値は `undefined`。文字は引用符つきになり、数と取り違えない。 */
const json = (v: unknown): string => (v === undefined ? "undefined" : JSON.stringify(v));

/** `scope` の語。 */
const SCOPES: ReadonlySet<string> = new Set(["seeds", "links"]);

/** `reason` の長さの上限（Unicode の code point）。 */
const REASON_MAX = 500;

type Finding = readonly [messageKey: string, params: MsgParams];

/**
 * member ごとの値の検査。WACZ Profile 1.29.0 §robotsOverride の表の順。どの member も文字列で、ここへ来るのは
 * 文字列だけ。決まりどおりなら `undefined`。
 */
const MEMBERS: readonly (readonly [member: string, check: (value: string) => Finding | undefined])[] = [
  ["exemptionId", (v) => (v === "" ? ["empty", { member: "exemptionId" }] : undefined)],
  [
    "reason",
    (v) => {
      // 文字列の反復は code point ごと。`v.length` は UTF-16 の code unit の数。
      const length = Array.from(v).length;
      return length < 1 || length > REASON_MAX ? ["reason-length", { length }] : undefined;
    },
  ],
  ["pathPattern", (v) => (v.startsWith("/") ? undefined : ["path-pattern", { found: json(v) }])],
  ["scope", (v) => (SCOPES.has(v) ? undefined : ["scope", { found: json(v) }])],
  ["grantedBy", (v) => (v === "" ? ["empty", { member: "grantedBy" }] : undefined)],
  ["grantedAt", (v) => (RFC3339_DATE_TIME.test(v) ? undefined : ["date-time", { member: "grantedAt", found: json(v) }])],
  ["expiresAt", (v) => (RFC3339_DATE_TIME.test(v) ? undefined : ["date-time", { member: "expiresAt", found: json(v) }])],
];

export const browserhiveRobotsOverrideShapeRule: ValidationRule = {
  name: "browserhive/robots-override-shape",
  descriptionKey: `${RULE}.desc`,
  conformance: "MUST",
  docs: [
    {
      label: "BrowserHive WACZ Profile §robotsOverride",
      url: {
        en: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.29.0/#robotsoverride",
        ja: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.29.0/ja/#robotsoverride",
      },
    },
  ],
  applicability: {
    excludeProfiles: ["spec", "lenient"],
  },
  run: async (wacz) => {
    const capture = await readCapture(wacz);
    if (capture === undefined || !profileAtLeast(capture["conformsTo"], 1, 29)) return ok([]);

    const override = capture["robotsOverride"];
    // 任意の member。無い package は、何も外していないか、外したことを申告していない。
    if (override === undefined) return ok([]);

    const issues: Issue[] = [];
    const issue = (messageKey: string, params: MsgParams): void => {
      issues.push({
        rule: RULE,
        severity: "error",
        messageKey: `${RULE}.${messageKey}`,
        params,
        location: { entry: DATAPACKAGE_ENTRY },
      });
    };

    if (!isRecord(override)) {
      issue("not-object", { found: json(override) });
      return ok(issues);
    }
    for (const [member, check] of MEMBERS) {
      const value = override[member];
      if (value === undefined) {
        issue("missing-member", { member });
      } else if (typeof value !== "string") {
        issue("not-string", { member, found: json(value) });
      } else {
        const finding = check(value);
        if (finding !== undefined) issue(...finding);
      }
    }
    return ok(issues);
  },
};
