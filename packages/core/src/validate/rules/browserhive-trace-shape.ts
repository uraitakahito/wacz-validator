/**
 * Rule: browserhive/trace-shape (error · browserhive profile 限定)
 *
 * 取り込みの trace `trace/events.jsonl` が、BrowserHive WACZ Profile 1.23.0 の trace・trace-directory・trace-lines の
 * 定めどおりか。指摘の種類（message key）は、WACZ Profile の決まり 1 つにつき 1 つ —— WACZ Profile が決まりを 1 つ足し引き
 * したら、ここも 1 つ足し引きする。
 *
 * 要約（`browserhive:capture.trace`）:
 *
 *   - `summary-missing`     `trace` member が在る
 *   - `summary-member`      `lines`・`dropped` が 0 以上の整数
 *   - `line-count`          `lines` が、エントリの行の数と同じ
 *
 * エントリ:
 *
 *   - `missing`             エントリが在る（行が無ければ空のファイル）
 *   - `not-in-resources`    `resources` に載っている
 *   - `not-json`            各行が JSON のオブジェクト
 *
 * 行:
 *
 *   - `unknown-profile`     `profile` が `browserhive:trace/1`。違う版を名乗る行は、その先を見ない
 *   - `missing-member`      `profile`・`kind`・`id`・`hop`・`url`・`method`・`startedAt`・`ms`・`outcome` が在る
 *   - `kind`                `kind` が `request`
 *   - `outcome`             `outcome` が決まった値のどれか
 *   - `not-string`          `id`・`url`・`method` が文字列
 *   - `hop`・`ms`           0 以上の整数
 *   - `started-at`          `startedAt` が RFC 3339 の時刻（時差つきも通す。UTC かどうかは見ない）
 *   - `hop-order`           同じ `id` の行が `hop` の昇順
 *   - `hop-repeated`        同じ `id` の 2 行が同じ `hop` を持たない
 *   - `withheld-member`     `not-archived`・`denied` の行が、応答・時間・`initiator`・`record` を持たない
 *   - `error-missing`       `failed` の行が `error` を持つ
 *   - `error-unexpected`    ほかの行が `error` を持たない
 *   - `end-unobservable`    `pending` でない行が `endUnobservable` を持たない
 *   - `duration-unexpected` `finished`・`redirected`・`failed` でない行が `durationMs` を持たない
 *   - `encoded-bytes-unexpected` `finished` でない行が `encodedBytes` を持たない
 *   - `flag-not-true`       `urlCut`・`endUnobservable`・`response.fromCache` は、在れば `true`
 *   - `data-url-not-cut`    `url` が `data:` の URL の行は `urlCut` を持つ
 *
 * 行と WARC の記録:
 *
 *   - `record-unknown`      `record` が、`archive/` の `response` の記録を名指す
 *   - `started-at-differs`  そういう行の `startedAt` が、その記録の `WARC-Date` と同じ字
 *   - `record-repeated`     2 行が同じ `record` を持たない
 *   - `response-unnamed`    要約の `dropped` が 0 なら、http(s) の `response` のどれにも、それを名指す行が在る
 *
 * **hash が合うかは見ない。** `datapackage/resource-hashes` が見る。`resources` に載っているかは、ここでも
 * error として見る —— `datapackage/resources-complete` は載せ忘れを warning にするだけで、trace を digest と
 * 署名の外に置いた package が検査を通ってしまう。
 *
 * **同じ member を 2 度言わない。** `not-archived`・`denied` の行の `durationMs`・`encodedBytes` は
 * `withheld-member` が言うので、`duration-unexpected`・`encoded-bytes-unexpected` はその行を見ない。
 *
 * **読めない物には照らさない。** 要約の `lines`・`dropped` が 0 以上の整数でなければ、行の数と、名指されて
 * いない `response` を見ない。`hop` が読めない行は並びを見ない。`WARC-Date` の無い記録とは時刻を比べない。
 * 違う版を名乗る行も、`record` が名指す記録は「名指されている」に数える（1 つの崩れで 2 つ言わない）。
 *
 * **archive の中だけでは決められないことは見ない。** 行が producer の作った順に並ぶこと、始まりの届いた要求の
 * すべてに行が在ること、`dropped` が残さなかった行の数であること、切った `url` が `urlCut` を持つこと、
 * `data:` の URL の中身が行に無いこと（producer が中身の代わりに書く物は producer が決める）、シークレットの
 * 値が行に無いこと（settings はシークレットの名前しか持たない）。
 *
 * **行の `url` は `WARC-Target-URI` と照らさない。** 行はシークレットの値を置き換え、長い URL を切るので、
 * 名指した記録の URI と同じとは限らない。**時刻の順も見ない** —— 行は producer が作った順で、`startedAt` も
 * `ms` も前の行より小さくなりうる。
 *
 * **archive 自身の宣言 (`conformsTo`) で分ける。** trace は WACZ Profile 1.23.0 で入ったので、それより前を名乗る
 * archive と、名乗りが無いか読めない archive には当てない —— そのころの archive では、エントリの不在は何も述べない。
 *
 * Spec: https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.23.0/#trace-directory
 *   （要約は同じ版の #trace、行は #trace-lines）
 */
import { ok } from "../../result.js";
import { RFC3339_DATE_TIME } from "../browserhive-logs.js";
import { isRecord, profileAtLeast, readCapture } from "../browserhive-storage.js";
import {
  ENDED_TRACE_OUTCOMES,
  EXPECTED_TRACE_KIND,
  EXPECTED_TRACE_PROFILE,
  readTraceLines,
  REQUIRED_TRACE_MEMBERS,
  TRACE_ENTRY,
  TRACE_OUTCOMES,
  WITHHELD_TRACE_FORBIDDEN_MEMBERS,
  WITHHELD_TRACE_OUTCOMES,
} from "../browserhive-trace.js";
import { DATAPACKAGE_ENTRY, datapackageOf } from "../datapackage-source.js";
import type { IssueLocation, ValidationRule } from "../domain.js";
import { readResponses } from "../response-records.js";
import { shown } from "../warc11-scan.js";
import { WarcIssueBucket } from "../warc-issue-bucket.js";
import type { MsgParams } from "../../i18n/translate.js";

const RULE = "browserhive/trace-shape";

/** JSON の値を文字で。無い値は `undefined`。文字は引用符つきになり、数と取り違えない。 */
const json = (v: unknown): string => (v === undefined ? "undefined" : JSON.stringify(v));

/** 0 以上の整数か。 */
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

export const browserhiveTraceShapeRule: ValidationRule = {
  name: "browserhive/trace-shape",
  descriptionKey: `${RULE}.desc`,
  conformance: "MUST",
  docs: [
    {
      label: "BrowserHive WACZ Profile §trace",
      url: {
        en: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.23.0/#trace",
        ja: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.23.0/ja/#trace",
      },
    },
    {
      label: "BrowserHive WACZ Profile §The trace directory",
      url: {
        en: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.23.0/#trace-directory",
        ja: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.23.0/ja/#trace-directory",
      },
    },
    {
      label: "BrowserHive WACZ Profile §Trace lines",
      url: {
        en: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.23.0/#trace-lines",
        ja: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.23.0/ja/#trace-lines",
      },
    },
  ],
  applicability: {
    excludeProfiles: ["spec", "lenient"],
  },
  run: async (wacz) => {
    const capture = await readCapture(wacz);
    if (capture === undefined || !profileAtLeast(capture["conformsTo"], 1, 23)) return ok([]);

    // 行ごとの指摘は、長い trace では行の数だけ出うる。同じエントリの同じ指摘は丸める。
    const bucket = new WarcIssueBucket();
    const issue = (messageKey: string, params: MsgParams, location: IssueLocation): void => {
      bucket.push({ rule: RULE, severity: "error", messageKey: `${RULE}.${messageKey}`, params, location });
    };

    // ---- 要約 (#trace) ----
    const summary = capture["trace"];
    let declaredLines: number | undefined;
    let dropped: number | undefined;
    if (!isRecord(summary)) {
      issue("summary-missing", { found: json(summary) }, { entry: DATAPACKAGE_ENTRY });
    } else {
      for (const member of ["lines", "dropped"] as const) {
        if (!isCount(summary[member])) issue("summary-member", { member, found: json(summary[member]) }, { entry: DATAPACKAGE_ENTRY });
      }
      if (isCount(summary["lines"])) declaredLines = summary["lines"];
      if (isCount(summary["dropped"])) dropped = summary["dropped"];
    }

    // ---- エントリ (#trace-directory) ----
    const lines = await readTraceLines(wacz);
    if (lines === null) {
      issue("missing", {}, { entry: TRACE_ENTRY });
      return ok(bucket.drain());
    }

    // resources が配列でなければ照らさない（`datapackage/resource-hashes` が言う）。
    const { parsed: pkg } = await datapackageOf(wacz);
    if (pkg !== null && Array.isArray(pkg.resources) && !pkg.resources.some((r) => r.path === TRACE_ENTRY)) {
      issue("not-in-resources", {}, { entry: TRACE_ENTRY });
    }

    if (declaredLines !== undefined && declaredLines !== lines.length) {
      issue("line-count", { declared: String(declaredLines), found: lines.length }, { entry: TRACE_ENTRY });
    }

    // ---- 行 (#trace-lines) ----
    const responses = await readResponses(wacz);
    /** `record` の値 → それを最初に持った行。 */
    const namedBy = new Map<string, number>();
    /** `id` → その id の直前の行の `hop` と、`hop` → それを最初に持った行。 */
    const chains = new Map<string, { last: number; lastLine: number; seen: Map<number, number> }>();

    for (const { lineNumber, parsed } of lines) {
      const line = String(lineNumber);
      const here: IssueLocation = { entry: TRACE_ENTRY, line: lineNumber };
      if (parsed === null) {
        issue("not-json", { line }, here);
        continue;
      }

      // 名指された記録は、行の版の名乗りに関わらず数える。
      const record = parsed["record"];
      const namedFirstAt = typeof record === "string" ? namedBy.get(record) : undefined;
      if (typeof record === "string" && namedFirstAt === undefined) namedBy.set(record, lineNumber);

      if (parsed["profile"] !== EXPECTED_TRACE_PROFILE) {
        // 版が違えば、下の検査は別の規則を当てていることになる。この行はここで打ち切る。
        issue("unknown-profile", { line, found: json(parsed["profile"]) }, here);
        continue;
      }

      const missing = REQUIRED_TRACE_MEMBERS.filter((m) => parsed[m] === undefined);
      if (missing.length > 0) issue("missing-member", { line, members: missing.join(", ") }, here);

      const kind = parsed["kind"];
      if (kind !== undefined && kind !== EXPECTED_TRACE_KIND) issue("kind", { line, found: json(kind) }, here);

      const outcome = parsed["outcome"];
      const knownOutcome = typeof outcome === "string" && TRACE_OUTCOMES.has(outcome) ? outcome : undefined;
      if (outcome !== undefined && knownOutcome === undefined) issue("outcome", { line, found: json(outcome) }, here);

      for (const member of ["id", "url", "method"] as const) {
        const value = parsed[member];
        if (value !== undefined && typeof value !== "string") issue("not-string", { line, member, found: json(value) }, here);
      }

      const ms = parsed["ms"];
      if (ms !== undefined && !isCount(ms)) issue("ms", { line, found: json(ms) }, here);

      const startedAt = parsed["startedAt"];
      if (startedAt !== undefined && (typeof startedAt !== "string" || !RFC3339_DATE_TIME.test(startedAt))) {
        issue("started-at", { line, found: json(startedAt) }, here);
      }

      // 同じ id の行はリダイレクトの連なり。hop は昇順で、同じ値を 2 度持たない。
      const id = parsed["id"];
      const hop = parsed["hop"];
      if (hop !== undefined && !isCount(hop)) {
        issue("hop", { line, found: json(hop) }, here);
      } else if (typeof id === "string" && isCount(hop)) {
        const chain = chains.get(id) ?? { last: hop, lastLine: lineNumber, seen: new Map<number, number>() };
        const sameHopAt = chain.seen.get(hop);
        if (sameHopAt !== undefined) {
          issue("hop-repeated", { line, id, hop: String(hop), firstLine: String(sameHopAt) }, here);
        } else if (hop < chain.last) {
          issue("hop-order", { line, id, hop: String(hop), previous: String(chain.last), previousLine: String(chain.lastLine) }, here);
        }
        if (sameHopAt === undefined) chain.seen.set(hop, lineNumber);
        chain.last = hop;
        chain.lastLine = lineNumber;
        chains.set(id, chain);
      }

      // 残さなかった要求と送らせなかった要求の行は、応答について何も持たない。
      const withheld = knownOutcome !== undefined && WITHHELD_TRACE_OUTCOMES.has(knownOutcome);
      if (knownOutcome !== undefined && withheld) {
        const carried = WITHHELD_TRACE_FORBIDDEN_MEMBERS.filter((m) => parsed[m] !== undefined);
        if (carried.length > 0) issue("withheld-member", { line, outcome: knownOutcome, members: carried.join(", ") }, here);
      }

      // durationMs は producer が終わりを見た行にだけ、encodedBytes は読み終えた行にだけ在る。残さなかった要求と
      // 送らせなかった要求の行は、上の withheld-member が言う。
      if (knownOutcome !== undefined && !withheld) {
        if (!ENDED_TRACE_OUTCOMES.has(knownOutcome) && parsed["durationMs"] !== undefined) {
          issue("duration-unexpected", { line, outcome: knownOutcome }, here);
        }
        if (knownOutcome !== "finished" && parsed["encodedBytes"] !== undefined) {
          issue("encoded-bytes-unexpected", { line, outcome: knownOutcome }, here);
        }
      }

      // error は failed の行にだけ在る。outcome の読めない行では照らさない。
      const error = parsed["error"];
      if (knownOutcome === "failed" && error === undefined) issue("error-missing", { line }, here);
      if (knownOutcome !== undefined && knownOutcome !== "failed" && error !== undefined) {
        issue("error-unexpected", { line, outcome: knownOutcome }, here);
      }

      if (knownOutcome !== undefined && knownOutcome !== "pending" && parsed["endUnobservable"] !== undefined) {
        issue("end-unobservable", { line, outcome: knownOutcome }, here);
      }

      // 在れば true。false を書く形は無い（無いことが false）。
      const response = parsed["response"];
      const flags: readonly (readonly [string, unknown])[] = [
        ["urlCut", parsed["urlCut"]],
        ["endUnobservable", parsed["endUnobservable"]],
        ["response.fromCache", isRecord(response) ? response["fromCache"] : undefined],
      ];
      for (const [member, value] of flags) {
        if (value !== undefined && value !== true) issue("flag-not-true", { line, member, found: json(value) }, here);
      }

      // data: の URL は中身を URL に持つ。行はその全体ではないので、urlCut を持つ。
      const url = parsed["url"];
      if (typeof url === "string" && /^data:/i.test(url) && parsed["urlCut"] === undefined) {
        issue("data-url-not-cut", { line }, here);
      }

      // record は archive/ の response を名指し、その行の startedAt は記録の WARC-Date と同じ字。
      if (record !== undefined) {
        const target = typeof record === "string" ? responses.get(record) : undefined;
        if (target === undefined) {
          issue("record-unknown", { line, found: json(record) }, here);
        } else if (typeof startedAt === "string" && target.date !== undefined && startedAt !== target.date) {
          issue("started-at-differs", { line, found: startedAt, date: target.date, record: json(record) }, here);
        }
        if (namedFirstAt !== undefined) {
          issue("record-repeated", { line, record: json(record), firstLine: String(namedFirstAt) }, here);
        }
      }
    }

    // 1 行も残さず書いたと言う package では、http(s) の response のどれにも行が在る。
    if (dropped === 0) {
      for (const [id, response] of responses) {
        if (!/^https?:/i.test(response.url) || namedBy.has(id)) continue;
        issue("response-unnamed", { url: shown(response.url), record: id }, { entry: response.entry, offset: response.offset });
      }
    }

    return ok(bucket.drain());
  },
};
