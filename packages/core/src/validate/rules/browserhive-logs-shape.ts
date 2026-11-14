/**
 * Rule: browserhive/logs-shape (error · browserhive profile 限定)
 *
 * 取り込みのログ `logs/capture.jsonl` が、BrowserHive WACZ Profile 1.19.0 の logs-directory と logs-lines の定めどおりか。
 * 見るのは:
 *
 *   - エントリが在る（行が無ければ空のファイル）
 *   - 各行が JSON のオブジェクトで、`profile` が `browserhive:log/1`。違う版を名乗る行は、その先を見ない
 *   - `profile`・`at`・`ms`・`source`・`level`・`msg` が在る
 *   - `at` が RFC 3339 の時刻（時差つきも通す。UTC かどうかは見ない）、`ms` が 0 以上の整数で前の行の `ms` より
 *     小さくない、`msg` が文字列
 *   - `source` が `script`・`page`・`browserhive` のどれか、`level` が `debug`・`info`・`warn`・`error` のどれか
 *   - `script` は `source` が `script` の行にだけ在り、`settings.behaviors` のどれかの項目の `id`
 *   - `dpr` が在れば `settings.devicePixelRatios` のどれか、`truncated` が在れば boolean
 *   - `document` が `withheld` を持てば、`source` が `page` の行が無い（1 つの事実なので、行ごとではなく 1 件で言う）
 *
 * **resources に載っているかと、hash が合うかは見ない。** それぞれ `datapackage/resources-complete` と
 * `datapackage/resource-hashes` が見る。
 *
 * **読めない物には照らさない。** `settings.behaviors`・`settings.devicePixelRatios` が配列でなければ、`script`・`dpr`
 * の値を照らさない（`browserhive/settings-shape` が言う）。`ms` は、`ms` が読めた最後の行と比べる。
 *
 * **archive の中だけでは決められないことは見ない。** シークレットの値が行に無いこと（settings はシークレットの
 * 名前しか持たない）、捨てた行・切った行が申告されていること、package を組むまでに届いた行がすべて在ること。
 *
 * **archive 自身の宣言 (`conformsTo`) で分ける。** ログは WACZ Profile 1.19.0 で入ったので、それより前を名乗る
 * archive と、名乗りが無いか読めない archive には当てない —— そのころの archive では、エントリの不在は何も述べない。
 *
 * Spec: https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.19.0/#logs-directory
 *   （行は同じ版の #logs-lines）
 */
import { ok } from "../../result.js";
import {
  EXPECTED_LOG_PROFILE,
  LOG_LEVELS,
  LOG_SOURCES,
  LOGS_ENTRY,
  readLogLines,
  REQUIRED_LOG_MEMBERS,
  RFC3339_DATE_TIME,
} from "../browserhive-logs.js";
import { isRecord, profileAtLeast, readCapture } from "../browserhive-storage.js";
import type { Issue, IssueLocation, ValidationRule } from "../domain.js";
import type { MsgParams } from "../../i18n/translate.js";

const RULE = "browserhive/logs-shape";

/** JSON の値を文字で。無い値は `undefined`。文字は引用符つきになり、数と取り違えない。 */
const json = (v: unknown): string => (v === undefined ? "undefined" : JSON.stringify(v));

export const browserhiveLogsShapeRule: ValidationRule = {
  name: "browserhive/logs-shape",
  descriptionKey: `${RULE}.desc`,
  conformance: "MUST",
  docs: [
    {
      label: "BrowserHive WACZ Profile §The logs directory",
      url: {
        en: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.19.0/#logs-directory",
        ja: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.19.0/ja/#logs-directory",
      },
    },
    {
      label: "BrowserHive WACZ Profile §Log lines",
      url: {
        en: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.19.0/#logs-lines",
        ja: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.19.0/ja/#logs-lines",
      },
    },
  ],
  applicability: {
    excludeProfiles: ["spec", "lenient"],
  },
  run: async (wacz) => {
    const capture = await readCapture(wacz);
    if (capture === undefined || !profileAtLeast(capture["conformsTo"], 1, 19)) return ok([]);

    const issues: Issue[] = [];
    const issue = (messageKey: string, params: MsgParams, location: IssueLocation): void => {
      issues.push({ rule: RULE, severity: "error", messageKey: `${RULE}.${messageKey}`, params, location });
    };

    const lines = await readLogLines(wacz);
    if (lines === null) {
      issue("missing", {}, { entry: LOGS_ENTRY });
      return ok(issues);
    }

    // 行が名指す物。配列でなければ照らさない。
    const settings = isRecord(capture["settings"]) ? capture["settings"] : {};
    const behaviors = settings["behaviors"];
    const behaviorIds = Array.isArray(behaviors)
      ? behaviors.filter(isRecord).flatMap((b) => (typeof b["id"] === "string" ? [b["id"]] : []))
      : undefined;
    const ratios = settings["devicePixelRatios"];
    const pixelRatios: readonly unknown[] | undefined = Array.isArray(ratios) ? ratios : undefined;

    let previous: { ms: number; line: number } | undefined;
    const pageLines: number[] = [];
    for (const { lineNumber, parsed } of lines) {
      const line = String(lineNumber);
      const here: IssueLocation = { entry: LOGS_ENTRY, line: lineNumber };
      if (parsed === null) {
        issue("not-json", { line }, here);
        continue;
      }
      if (parsed["profile"] !== EXPECTED_LOG_PROFILE) {
        // 版が違えば、下の検査は別の規則を当てていることになる。この行はここで打ち切る。
        issue("unknown-profile", { line, found: json(parsed["profile"]) }, here);
        continue;
      }

      const missing = REQUIRED_LOG_MEMBERS.filter((m) => parsed[m] === undefined);
      if (missing.length > 0) issue("missing-member", { line, members: missing.join(", ") }, here);

      const at = parsed["at"];
      if (at !== undefined && (typeof at !== "string" || !RFC3339_DATE_TIME.test(at))) {
        issue("at", { line, found: json(at) }, here);
      }

      // 行は producer が受け取った順。ms は前の行より小さくならない。
      const ms = parsed["ms"];
      if (ms !== undefined) {
        if (typeof ms !== "number" || !Number.isInteger(ms) || ms < 0) {
          issue("ms", { line, found: json(ms) }, here);
        } else {
          if (previous !== undefined && ms < previous.ms) {
            issue("ms-decreased", { line, found: String(ms), previous: String(previous.ms), previousLine: String(previous.line) }, here);
          }
          previous = { ms, line: lineNumber };
        }
      }

      const source = parsed["source"];
      const knownSource = typeof source === "string" && LOG_SOURCES.has(source) ? source : undefined;
      if (source !== undefined && knownSource === undefined) issue("source", { line, found: json(source) }, here);

      const level = parsed["level"];
      if (level !== undefined && !(typeof level === "string" && LOG_LEVELS.has(level))) {
        issue("level", { line, found: json(level) }, here);
      }

      const msg = parsed["msg"];
      if (msg !== undefined && typeof msg !== "string") issue("msg", { line, found: json(msg) }, here);

      // script は script の行にだけ在り、settings.behaviors の項目を名指す。書き手の分からない行では照らさない。
      const script = parsed["script"];
      if (knownSource === "script") {
        if (script === undefined) {
          issue("script-missing", { line }, here);
        } else if (behaviorIds !== undefined && !(typeof script === "string" && behaviorIds.includes(script))) {
          issue("script", { line, found: json(script), behaviors: json(behaviorIds) }, here);
        }
      } else if (knownSource !== undefined && script !== undefined) {
        issue("script-unexpected", { line, source: knownSource, found: json(script) }, here);
      }

      const dpr = parsed["dpr"];
      if (dpr !== undefined && pixelRatios !== undefined && !pixelRatios.includes(dpr)) {
        issue("dpr", { line, found: json(dpr), ratios: json(pixelRatios) }, here);
      }

      const truncated = parsed["truncated"];
      if (truncated !== undefined && typeof truncated !== "boolean") {
        issue("truncated", { line, found: json(truncated) }, here);
      }

      if (knownSource === "page") pageLines.push(lineNumber);
    }

    // 文書を伏せた package は、どの文書が書いたかに関わらず page の行を持たない。
    const document = capture["document"];
    const withheld = isRecord(document) ? document["withheld"] : undefined;
    const [first] = pageLines;
    if (withheld !== undefined && first !== undefined) {
      issue(
        "withheld-page",
        {
          withheld: typeof withheld === "string" ? withheld : json(withheld),
          count: pageLines.length,
          first: String(first),
        },
        { entry: LOGS_ENTRY, line: first },
      );
    }
    return ok(issues);
  },
};
