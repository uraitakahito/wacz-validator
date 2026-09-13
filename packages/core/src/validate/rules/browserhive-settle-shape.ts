/**
 * Rule: browserhive/settle-shape (browserhive profile 限定 · >=10.3.0)
 *
 * `browserhive:capture.settle` が profile 1.7.0 の定めどおりに在るか。
 *
 * **見るのは 3 つの主張で、どれも「待ちの終わり方を、読み手が信じてよいか」に関わる。**
 *
 * ① 在ること。1.7.0 で必須になった。待ちは取り込みのたびに走るので、`coverage` や
 *    `dismissal` と違い「しなかった」を意味する不在が無い —— 不在は「言っていない」に
 *    しか読めない。
 *
 * ② 必須の member が在り、型が合うこと。合図の時刻は数値か `null` で、**`null` も
 *    書かれていること**。省かれた時刻は「その合図を見ていなかった」と読まれ、
 *    「満ちなかった」とは別の事実になる。`tls.hosts` の `null` と同じ理屈。
 *
 * ③ `endedBy` が 4 つの時刻と食い違わないこと。`null` があるのに `"quiet"`、無いのに
 *    `"deadline"` は、どちらもその取り込みが稼いでいない主張。
 *
 * **値の大きさは見ない。** 何秒待ったか、上限をいくつにしたかは producer が決めること。
 * 期限に当たったこと自体は違反ではなく、`browserhive/settle-deadline` が warning で言う。
 *
 * 版の条件があるのは、`settle` を必須にした 1.7.0 を browserhive が 10.3.0 から名乗るため。
 * 10.1.0 と 10.2.0 も `settle` を運ぶが、1.6.0 を名乗っており (未定義の member として)、
 * 10.1.0 の形は 1.7.0 と違う。それらに 1.7.0 の MUST を当てて落とすのは検証器として誤り。
 *
 * Spec: https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.7.0/#settle
 */
import { ok } from "../../result.js";
import { isRecord, readCapture } from "../browserhive-storage.js";
import type { Issue, ValidationRule } from "../domain.js";

const RULE = "browserhive/settle-shape";

/** この版が定める唯一の `strategy`。 */
const STRATEGY = "fully-loaded";

const isNumber = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v);

/** profile 1.7.0 §settle の「Required: yes」のうち、値そのものの行。 */
const SCALARS: readonly { readonly name: string; readonly check: (v: unknown) => boolean }[] = [
  { name: "strategy", check: (v) => typeof v === "string" },
  { name: "endedBy", check: (v) => v === "quiet" || v === "deadline" },
  { name: "waitedMs", check: isNumber },
  { name: "devicePixelRatio", check: isNumber },
];

/** `limits` の中身。どれも数値。 */
const LIMITS = ["minMs", "maxMs", "quietMs", "networkConcurrency"] as const;

/** 合図と、その時刻の名前。load だけが「起きた」時刻で、ほかは「静まった」時刻。 */
export const SETTLE_SIGNALS = [
  { signal: "load", field: "atMs" },
  { signal: "network", field: "quietAtMs" },
  { signal: "cpu", field: "quietAtMs" },
  { signal: "dom", field: "quietAtMs" },
] as const;

/** 型の名前。落ちたときに何が在ったかを言うため。 */
const typeName = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

export const browserhiveSettleShapeRule: ValidationRule = {
  // docs の抽出器はソースを文字列として読むので、ここは定数ではなく
  // リテラルで書く (他の rule も同じ)。
  name: "browserhive/settle-shape",
  descriptionKey: `${RULE}.desc`,
  conformance: "MUST",
  docs: [
    {
      label: "BrowserHive WACZ Profile §settle",
      url: {
        en: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.7.0/#settle",
        ja: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.7.0/ja/#settle",
      },
    },
  ],
  applicability: {
    excludeProfiles: ["spec", "lenient"],
    profileVersions: { browserhive: ">=10.3.0" },
  },
  run: async (wacz) => {
    const capture = await readCapture(wacz);
    if (capture === undefined) return ok([]);

    const settle = capture["settle"];
    if (settle === undefined) {
      return ok([{ rule: RULE, severity: "error", messageKey: `${RULE}.missing` } satisfies Issue]);
    }
    if (!isRecord(settle)) {
      return ok([
        {
          rule: RULE,
          severity: "error",
          messageKey: `${RULE}.not-object`,
          params: { found: typeName(settle) },
        } satisfies Issue,
      ]);
    }

    const issues: Issue[] = [];
    const missing = (member: string): void => {
      issues.push({ rule: RULE, severity: "error", messageKey: `${RULE}.missing-member`, params: { member } });
    };
    const wrongType = (member: string, value: unknown): void => {
      issues.push({
        rule: RULE,
        severity: "error",
        messageKey: `${RULE}.wrong-type`,
        params: { member, found: typeName(value) },
      });
    };

    for (const { name, check } of SCALARS) {
      const value = settle[name];
      if (value === undefined) missing(name);
      else if (!check(value)) wrongType(name, value);
    }
    // 形が読めても、この版が定めていない組の合図は読みようがない。
    if (typeof settle["strategy"] === "string" && settle["strategy"] !== STRATEGY) {
      issues.push({
        rule: RULE,
        severity: "error",
        messageKey: `${RULE}.unknown-strategy`,
        params: { found: settle["strategy"], expected: STRATEGY },
      });
    }

    const limits = settle["limits"];
    if (limits === undefined) missing("limits");
    else if (!isRecord(limits)) wrongType("limits", limits);
    else {
      for (const name of LIMITS) {
        const value = limits[name];
        if (value === undefined) missing(`limits.${name}`);
        else if (!isNumber(value)) wrongType(`limits.${name}`, value);
      }
    }

    // 4 つの時刻。全部が読めたときだけ endedBy と突き合わせる —— 読めない時刻があるなら、
    // それ自体が既に落ちている。
    const times: { signal: string; at: number | null }[] = [];
    for (const { signal, field } of SETTLE_SIGNALS) {
      const outcome = settle[signal];
      if (outcome === undefined) {
        missing(signal);
        continue;
      }
      if (!isRecord(outcome)) {
        wrongType(signal, outcome);
        continue;
      }
      const at = outcome[field];
      if (at === undefined) {
        issues.push({
          rule: RULE,
          severity: "error",
          messageKey: `${RULE}.missing-time`,
          params: { member: `${signal}.${field}` },
        });
      } else if (at !== null && !isNumber(at)) {
        wrongType(`${signal}.${field}`, at);
      } else {
        times.push({ signal, at: at as number | null });
      }
    }

    if (times.length === SETTLE_SIGNALS.length) {
      const unsatisfied = times.filter((t) => t.at === null).map((t) => t.signal);
      if (settle["endedBy"] === "quiet" && unsatisfied.length > 0) {
        issues.push({
          rule: RULE,
          severity: "error",
          messageKey: `${RULE}.quiet-with-null`,
          params: { signals: unsatisfied.join(", ") },
        });
      }
      if (settle["endedBy"] === "deadline" && unsatisfied.length === 0) {
        issues.push({ rule: RULE, severity: "error", messageKey: `${RULE}.deadline-without-null` });
      }
    }

    return ok(issues);
  },
};
