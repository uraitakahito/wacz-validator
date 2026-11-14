/**
 * Rule: browserhive/random-shape (error · browserhive profile 限定)
 *
 * 乱数の控え（取り込みのページのスクリプトが受け取った乱数 `random/values.jsonl` と、それを控えたコード
 * `random/recorder.js`）と、その要約 `browserhive:capture.random` が、BrowserHive WACZ Profile 1.26.0 の
 * random・random-directory・random-lines の定めどおりか。指摘の種類（message key）は、WACZ Profile の決まり
 * 1 つにつき 1 つ —— WACZ Profile が決まりを 1 つ足し引きしたら、ここも 1 つ足し引きする。
 *
 * 要約（`browserhive:capture.random`）:
 *
 *   - `summary-missing`     `random` member が在る
 *   - `recorded`            `recorded` が真偽値
 *   - `summary-member`      `recorded` が `true` なら、`documents`・`draws` が 0 以上の整数で、`truncated` が真偽値
 *   - `summary-unexpected`  `recorded` が `true` なら `skipped` を、`false` なら `documents`・`draws`・`truncated` を持たない
 *   - `skipped`             `recorded` が `false` なら、`skipped` が `not-requested`・`withheld`・`failed` のどれか
 *   - `skipped-not-withheld` `document` が `withheld` を持つなら、`skipped` は `failed` でない（2 つ当たるときは並びで先の物）
 *   - `skipped-withheld-unfounded` `skipped` が `withheld` なら、`document` が `withheld` を持つ
 *   - `count`               `documents`・`draws` が、文書の行・値の行の数と同じ
 *
 * エントリ:
 *
 *   - `missing`             `recorded` が `true` なら、`random/values.jsonl` と `random/recorder.js` が在る
 *   - `not-in-resources`    そのとき、どちらも `resources` に載っている
 *   - `unexpected`          `recorded` が `false` なら、どちらも無い
 *   - `withheld-entry`      `document` が `withheld` を持つなら、どちらも無い
 *   - `recorded-withheld`   そのとき `recorded` は `true` でない（エントリの無い package で言う。在れば上の `withheld-entry`）
 *   - `not-json`            各行が JSON のオブジェクト
 *
 * 行:
 *
 *   - `unknown-profile`     `profile` が `browserhive:random/1`。違う版を名乗る行は、その先を見ない
 *   - `missing-member`      `profile`・`kind` と、文書の行なら `document`・`url`・`frame`・`dpr`、値の行なら
 *                           `document`・`seq`・`api`・`caller` が在る
 *   - `kind`                `kind` が `document` か `draw`
 *   - `not-count`           `document`・`seq`・`bytes` が 0 以上の整数
 *   - `not-string`          `url`・`caller`・`date` が文字列
 *   - `document-repeated`   2 つの文書の行が同じ `document` を持たない
 *   - `document-order`      文書の行が `document` の昇順
 *   - `frame`               `frame` が `main` か `frame`
 *   - `dpr`                 `dpr` が数
 *   - `record-date-pair`    `record` と `date` は、両方在るか、両方無い
 *   - `record-unknown`      `record` が、`archive/` の `response` の記録を名指す
 *   - `date-differs`        `date` が、その記録の `WARC-Date` と同じ字
 *   - `url-differs`         その記録の `WARC-Target-URI` が `url`（残したシークレットの値を置き換えたところを除く）
 *   - `data-url-data`       `data:` の URL の `url` は、最初のコンマの後ろに何も持たない
 *   - `draw-document-unknown` 値の行の `document` が、それより前の文書の行の `document`
 *   - `seq-order`           `seq` が、その文書の最初の値の行で 0、続く行で 1 つずつ増える
 *   - `api`                 `api` が `Math.random`・`crypto.getRandomValues`・`crypto.randomUUID` のどれか
 *   - `bytes-missing`       `crypto.getRandomValues` の行が `bytes` を持つ
 *   - `bytes-unexpected`    ほかの行が `bytes` を持たない
 *   - `value`               `value` が在れば、`api` の決める形（`Math.random` は 0 以上 1 未満の数、
 *                           `crypto.randomUUID` は小文字の 8-4-4-4-12 の 16 進、`crypto.getRandomValues` は
 *                           RFC 4648 §4 の標準の字と埋め字の base64）
 *   - `value-length`        `crypto.getRandomValues` の `value` が、ちょうど `bytes` バイトを言う
 *
 * **hash が合うかは見ない。** `datapackage/resource-hashes` が見る。`resources` に載っているかは、ここでも
 * error として見る —— `datapackage/resources-complete` は載せ忘れを warning にするだけで、控えを digest と
 * 署名の外に置いた package が検査を通ってしまう（`browserhive/trace-shape` と同じ）。
 *
 * **同じことを 2 度言わない。** `document` が `withheld` を持つ package のエントリは `withheld-entry` だけが言い、
 * `unexpected` は言わない。在ってはならないエントリの行は見ない（`recorded` が `false` か、文書を伏せた package）。
 *
 * **読めない物には照らさない。** 要約の数が 0 以上の整数でないか、JSON でない行か `kind` の読めない行が在れば、
 * 行の数を比べない。`document` の読めない行は並びを見ない。`WARC-Date` の無い記録とは時刻を比べない。違う版を
 * 名乗る行も、文書の番号と `seq` は数える（1 つの崩れで 2 つ言わない）。
 *
 * **archive の中だけでは決められないことは見ない。** 値がページの受け取った物であること（producer が値を
 * 変えていないこと）、`truncated` が本当のことを言っていること、行がシークレットの値を持たないこと（settings は
 * シークレットの名前しか持たない）、`caller` が呼び出し元のスクリプトの URL であること、package が交信の
 * `response` を持つ文書の行が `record` を持つこと、行を省いた producer が同じ `caller` と `api` の後の行も
 * 省いたこと、`dpr` が `settings.devicePixelRatios` のどれかであること（表の説明で、MUST の文ではない）。
 *
 * **`url` と `WARC-Target-URI` の照らし方。** 同じ字でなければならない。ただし `settings.secretArchive` が
 * 名前を持つ（残したシークレットが在る）package では、`url` の `***` を、どんな字の並びにも合う物として読む ——
 * 残したシークレットの値は記録には残り、行では `***` に置き換わる。隠すシークレットの値は、記録でも行でも
 * `***` になるので、同じ字で合う。
 *
 * **archive 自身の宣言 (`conformsTo`) で分ける。** 乱数の控えは WACZ Profile 1.26.0 で入ったので、それより前を
 * 名乗る archive と、名乗りが無いか読めない archive には当てない —— そのころの archive では、エントリの不在は
 * 何も述べない。
 *
 * Spec: https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.26.0/#random-directory
 *   （要約は同じ版の #random、行は #random-lines）
 */
import { ok } from "../../result.js";
import {
  BYTES_API,
  EXPECTED_RANDOM_PROFILE,
  RANDOM_APIS,
  RANDOM_ENTRIES,
  RANDOM_ENTRY,
  RANDOM_FRAMES,
  RANDOM_SKIPPED,
  readRandomLines,
  REQUIRED_DOCUMENT_MEMBERS,
  REQUIRED_DRAW_MEMBERS,
} from "../browserhive-random.js";
import { isRecord, profileAtLeast, readCapture } from "../browserhive-storage.js";
import { DATAPACKAGE_ENTRY, datapackageOf } from "../datapackage-source.js";
import type { IssueLocation, ValidationRule } from "../domain.js";
import { readResponses } from "../response-records.js";
import { shown } from "../warc11-scan.js";
import { WarcIssueBucket } from "../warc-issue-bucket.js";
import type { MsgParams } from "../../i18n/translate.js";

const RULE = "browserhive/random-shape";

/** JSON の値を文字で。無い値は `undefined`。文字は引用符つきになり、数と取り違えない。 */
const json = (v: unknown): string => (v === undefined ? "undefined" : JSON.stringify(v));

/** 0 以上の整数か。 */
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** 小文字の 16 進の UUID（8-4-4-4-12）。 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** RFC 4648 §4 の base64（標準の字・埋め字つき）。 */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** `api` ごとに、`value` がその形か。 */
const VALUE_FORMS: Readonly<Record<string, (v: unknown) => boolean>> = {
  "Math.random": (v) => typeof v === "number" && v >= 0 && v < 1,
  "crypto.randomUUID": (v) => typeof v === "string" && UUID.test(v),
  "crypto.getRandomValues": (v) => typeof v === "string" && BASE64.test(v),
};

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 行の `url` が、名指した記録の `WARC-Target-URI` と合うか。残したシークレットが在る package では、`url` の
 * `***` を、どんな字の並びにも合う物として読む。
 */
const urlMatches = (url: string, target: string, keptSecrets: boolean): boolean => {
  if (url === target) return true;
  if (!keptSecrets || !url.includes("***")) return false;
  return new RegExp(`^${url.split("***").map(escapeRegExp).join("[\\s\\S]*")}$`).test(target);
};

export const browserhiveRandomShapeRule: ValidationRule = {
  name: "browserhive/random-shape",
  descriptionKey: `${RULE}.desc`,
  conformance: "MUST",
  docs: [
    {
      label: "BrowserHive WACZ Profile §random",
      url: {
        en: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.26.0/#random",
        ja: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.26.0/ja/#random",
      },
    },
    {
      label: "BrowserHive WACZ Profile §The random directory",
      url: {
        en: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.26.0/#random-directory",
        ja: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.26.0/ja/#random-directory",
      },
    },
    {
      label: "BrowserHive WACZ Profile §Random lines",
      url: {
        en: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.26.0/#random-lines",
        ja: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.26.0/ja/#random-lines",
      },
    },
  ],
  applicability: {
    excludeProfiles: ["spec", "lenient"],
  },
  run: async (wacz) => {
    const capture = await readCapture(wacz);
    if (capture === undefined || !profileAtLeast(capture["conformsTo"], 1, 26)) return ok([]);

    // 行ごとの指摘は、長い控えでは行の数だけ出うる。同じエントリの同じ指摘は丸める。
    const bucket = new WarcIssueBucket();
    const issue = (messageKey: string, params: MsgParams, location: IssueLocation): void => {
      bucket.push({ rule: RULE, severity: "error", messageKey: `${RULE}.${messageKey}`, params, location });
    };
    const inDatapackage: IssueLocation = { entry: DATAPACKAGE_ENTRY };

    const document = capture["document"];
    const withheld = isRecord(document) ? document["withheld"] : undefined;
    const settings = capture["settings"];
    const secretArchive = isRecord(settings) ? settings["secretArchive"] : undefined;
    const keptSecrets = isRecord(secretArchive) && Object.keys(secretArchive).length > 0;

    // ---- 要約 (#random) ----
    const summary = capture["random"];
    let recorded: boolean | undefined;
    const declared = new Map<"documents" | "draws", number>();
    if (!isRecord(summary)) {
      issue("summary-missing", { found: json(summary) }, inDatapackage);
    } else if (typeof summary["recorded"] !== "boolean") {
      issue("recorded", { found: json(summary["recorded"]) }, inDatapackage);
    } else if (summary["recorded"]) {
      recorded = true;
      for (const member of ["documents", "draws"] as const) {
        const value = summary[member];
        if (isCount(value)) declared.set(member, value);
        else issue("summary-member", { member, found: json(value) }, inDatapackage);
      }
      if (typeof summary["truncated"] !== "boolean") {
        issue("summary-member", { member: "truncated", found: json(summary["truncated"]) }, inDatapackage);
      }
      if (summary["skipped"] !== undefined) issue("summary-unexpected", { recorded: "true", members: "skipped" }, inDatapackage);
    } else {
      recorded = false;
      const carried = ["documents", "draws", "truncated"].filter((m) => summary[m] !== undefined);
      if (carried.length > 0) issue("summary-unexpected", { recorded: "false", members: carried.join(", ") }, inDatapackage);
      const skipped = summary["skipped"];
      if (typeof skipped !== "string" || !RANDOM_SKIPPED.includes(skipped)) {
        issue("skipped", { found: json(skipped) }, inDatapackage);
      } else if (skipped === "failed" && withheld !== undefined) {
        // withheld が当たるなら、並びで後の failed は書かない。
        issue("skipped-not-withheld", { withheld: json(withheld) }, inDatapackage);
      } else if (skipped === "withheld" && isRecord(document) && withheld === undefined) {
        issue("skipped-withheld-unfounded", {}, inDatapackage);
      }
    }

    // ---- エントリ (#random-directory) ----
    const present = RANDOM_ENTRIES.filter((entry) => wacz.hasEntry(entry));
    if (withheld !== undefined) {
      // 文書を伏せた package は、ページから読んだ物である控えを持たない。
      for (const entry of present) issue("withheld-entry", { entry, withheld: json(withheld) }, { entry });
      if (present.length === 0 && recorded === true) issue("recorded-withheld", { withheld: json(withheld) }, inDatapackage);
      return ok(bucket.drain());
    }
    if (recorded === false) {
      for (const entry of present) issue("unexpected", { entry }, { entry });
      return ok(bucket.drain());
    }
    if (recorded === true) {
      for (const entry of RANDOM_ENTRIES) if (!present.includes(entry)) issue("missing", { entry }, { entry });
      // resources が配列でなければ照らさない（`datapackage/resource-hashes` が言う）。
      const { parsed: pkg } = await datapackageOf(wacz);
      if (pkg !== null && Array.isArray(pkg.resources)) {
        const resources = pkg.resources;
        for (const entry of present) {
          if (!resources.some((r) => r.path === entry)) issue("not-in-resources", { entry }, { entry });
        }
      }
    }

    // ---- 行 (#random-lines) ----
    const lines = await readRandomLines(wacz);
    if (lines === null) return ok(bucket.drain());

    const responses = await readResponses(wacz);
    /** 文書の行の `document` → それを最初に持った行。 */
    const documents = new Map<number, number>();
    /** 直前の文書の行の `document` と、その行。 */
    let previousDocument: { value: number; line: number } | undefined;
    /** `document` → その文書の直前の値の行の `seq`。 */
    const seqs = new Map<number, number>();
    const counted = { documents: 0, draws: 0 };
    /** JSON でない行か、`kind` の読めない行が在ったか。在れば行の数を比べない。 */
    let unclassified = false;

    for (const { lineNumber, parsed } of lines) {
      const line = String(lineNumber);
      const here: IssueLocation = { entry: RANDOM_ENTRY, line: lineNumber };
      if (parsed === null) {
        issue("not-json", { line }, here);
        unclassified = true;
        continue;
      }

      // 文書の番号と seq は、行の版の名乗りに関わらず数える。
      const kind = parsed["kind"];
      const doc = parsed["document"];
      const seq = parsed["seq"];
      let firstAt: number | undefined;
      const before = previousDocument;
      let previousSeq: number | undefined;
      if (kind === "document") {
        counted.documents += 1;
        if (isCount(doc)) {
          firstAt = documents.get(doc);
          if (firstAt === undefined) documents.set(doc, lineNumber);
          previousDocument = { value: doc, line: lineNumber };
        }
      } else if (kind === "draw") {
        counted.draws += 1;
        if (isCount(doc) && isCount(seq)) {
          previousSeq = seqs.get(doc);
          seqs.set(doc, seq);
        }
      } else {
        unclassified = true;
      }

      if (parsed["profile"] !== EXPECTED_RANDOM_PROFILE) {
        // 版が違えば、下の検査は別の規則を当てていることになる。この行はここで打ち切る。
        issue("unknown-profile", { line, found: json(parsed["profile"]) }, here);
        continue;
      }
      if (kind === undefined) {
        issue("missing-member", { line, members: "kind" }, here);
        continue;
      }
      if (kind !== "document" && kind !== "draw") {
        issue("kind", { line, found: json(kind) }, here);
        continue;
      }

      const required = kind === "document" ? REQUIRED_DOCUMENT_MEMBERS : REQUIRED_DRAW_MEMBERS;
      const missing = required.filter((m) => parsed[m] === undefined);
      if (missing.length > 0) issue("missing-member", { line, members: missing.join(", ") }, here);
      if (doc !== undefined && !isCount(doc)) issue("not-count", { line, member: "document", found: json(doc) }, here);

      if (kind === "document") {
        // 文書の行は document の昇順で、同じ値を 2 度持たない。
        if (isCount(doc)) {
          if (firstAt !== undefined) {
            issue("document-repeated", { line, document: String(doc), firstLine: String(firstAt) }, here);
          } else if (before !== undefined && doc < before.value) {
            issue("document-order", { line, document: String(doc), previous: String(before.value), previousLine: String(before.line) }, here);
          }
        }

        const url = parsed["url"];
        if (url !== undefined && typeof url !== "string") issue("not-string", { line, member: "url", found: json(url) }, here);
        const frame = parsed["frame"];
        if (frame !== undefined && (typeof frame !== "string" || !RANDOM_FRAMES.has(frame))) issue("frame", { line, found: json(frame) }, here);
        const dpr = parsed["dpr"];
        if (dpr !== undefined && typeof dpr !== "number") issue("dpr", { line, found: json(dpr) }, here);

        // record と date は組で在る。record は archive/ の response を名指し、date はその WARC-Date と同じ字、
        // その WARC-Target-URI は url。
        const record = parsed["record"];
        const date = parsed["date"];
        if ((record === undefined) !== (date === undefined)) {
          issue("record-date-pair", { line, present: record === undefined ? "date" : "record", absent: record === undefined ? "record" : "date" }, here);
        }
        if (date !== undefined && typeof date !== "string") issue("not-string", { line, member: "date", found: json(date) }, here);
        if (record !== undefined) {
          const target = typeof record === "string" ? responses.get(record) : undefined;
          if (target === undefined) {
            issue("record-unknown", { line, found: json(record) }, here);
          } else {
            if (typeof date === "string" && target.date !== undefined && date !== target.date) {
              issue("date-differs", { line, found: date, date: target.date, record: json(record) }, here);
            }
            if (typeof url === "string" && !urlMatches(url, target.url, keptSecrets)) {
              issue("url-differs", { line, url: shown(url), target: shown(target.url), record: json(record) }, here);
            }
          }
        }

        // data: の URL は、最初のコンマまでを書き、その後ろ（中身）を書かない。
        if (typeof url === "string" && /^data:/i.test(url)) {
          const comma = url.indexOf(",");
          if (comma !== -1 && comma < url.length - 1) issue("data-url-data", { line }, here);
        }
        continue;
      }

      // ---- 値の行 ----
      if (isCount(doc) && !documents.has(doc)) issue("draw-document-unknown", { line, document: String(doc) }, here);
      if (seq !== undefined && !isCount(seq)) {
        issue("not-count", { line, member: "seq", found: json(seq) }, here);
      } else if (isCount(doc) && isCount(seq)) {
        const expected = previousSeq === undefined ? 0 : previousSeq + 1;
        if (seq !== expected) issue("seq-order", { line, document: String(doc), seq: String(seq), expected: String(expected) }, here);
      }

      const api = parsed["api"];
      const knownApi = typeof api === "string" && RANDOM_APIS.has(api) ? api : undefined;
      if (api !== undefined && knownApi === undefined) issue("api", { line, found: json(api) }, here);

      const caller = parsed["caller"];
      if (caller !== undefined && typeof caller !== "string") issue("not-string", { line, member: "caller", found: json(caller) }, here);

      // bytes は crypto.getRandomValues の行にだけ在る。api の読めない行では照らさない。
      const bytes = parsed["bytes"];
      if (knownApi === BYTES_API) {
        if (bytes === undefined) issue("bytes-missing", { line }, here);
        else if (!isCount(bytes)) issue("not-count", { line, member: "bytes", found: json(bytes) }, here);
      } else if (knownApi !== undefined && bytes !== undefined) {
        issue("bytes-unexpected", { line, api: knownApi }, here);
      }

      // value は在れば api の決める形。crypto.getRandomValues なら、ちょうど bytes バイト。
      const value = parsed["value"];
      if (value !== undefined && knownApi !== undefined) {
        if (VALUE_FORMS[knownApi]?.(value) !== true) {
          issue("value", { line, api: knownApi, found: shown(json(value)) }, here);
        } else if (knownApi === BYTES_API && typeof value === "string" && isCount(bytes)) {
          const length = Buffer.from(value, "base64").byteLength;
          if (length !== bytes) issue("value-length", { line, bytes: String(bytes), found: length }, here);
        }
      }
    }

    // 要約の数は、文書の行と値の行の数。
    if (!unclassified) {
      for (const member of ["documents", "draws"] as const) {
        const value = declared.get(member);
        if (value !== undefined && value !== counted[member]) {
          issue("count", { member, declared: String(value), found: counted[member] }, { entry: RANDOM_ENTRY });
        }
      }
    }

    return ok(bucket.drain());
  },
};
