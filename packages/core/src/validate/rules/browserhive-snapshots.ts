/**
 * Rule: browserhive/snapshots (error · browserhive profile 限定)
 *
 * 取り込みが撮った DOM の写しを、archive のどこから読んでも同じ物が指されているか。WACZ Profile 1.17.0 は
 * `browserhive:capture.snapshots` に時点ごと（`after-load`・`after-behaviors`）の成り行き —— 撮った写しと、
 * 撮らなかった理由 —— を並べさせ、ページ一覧（`pages/pages.jsonl`）を写しごとの行にし、写しを索引に載せさせる。
 * BrowserHive WARC Profile 1.1.0 は、写しを `resource` と、それを `WARC-Refers-To` で指す `metadata` の組で書かせる。
 * 見るのは:
 *
 *   - `snapshots` が配列で、項目がどれもオブジェクト。時点の並びが `after-load` 1 つと、`settings.behaviors` が
 *     空でなければその後の `after-behaviors` 1 つで、ほかの項目は無い
 *   - 撮らなかった項目（`skipped` を持つ）の理由が `withheld`・`too-large`・`task-budget`・`failed` のどれか
 *   - 撮った項目の `url` が `urn:browserhive:snapshot:<stage>:` で始まり、`record`（山括弧なし）の名指す `resource`
 *     が在り、`url`・`date`・`bytes` がその `WARC-Target-URI`・`WARC-Date`・`Content-Length` と同じ
 *   - その resource を指す metadata が在り、`WARC-Target-URI`・`WARC-Date` が resource と同じで、`snapshot` の欄が
 *     項目の `stage`、`secrets-replaced` の欄が項目の `secretsReplaced`
 *   - 写しの本文に script の要素が無い（コメントの中は数えない。読み方は `browserhive-snapshot-html.ts`）
 *   - どの項目も名指さない写し（`WARC-Target-URI` が `urn:browserhive:snapshot:` の resource）が無い
 *   - ページ一覧の行が写しごとに 1 行ずつ `snapshots` の順に並び（写しが無ければ `stage` の無い 1 行）、各行の
 *     `url`・`ts` が写しの `WARC-Target-URI`・`WARC-Date`。行の `id` は互いに違う
 *   - 写しが在れば、`mainPageURL` がページ一覧の最初の行の `url`
 *   - 索引に写しの resource を指す行（`filename` と `offset` がその記録）が在り、その鍵が `WARC-Target-URI` そのままで、
 *     JSON に `status` が無い
 *
 * 値を比べる検査は、どれも 1 つの message key（`mismatch`）で言う。どちらの値が誤りかは archive の中だけでは
 * 決められないので、2 つの値を並べて見せる。
 *
 * **組の metadata が resource と別の本に在ることは、ここでは言わない。** それは `browserhive/exchange-in-one-file`
 * が言う（WARC Profile 1.1.0 の Records and files）。ここで言うのは、どの本にも無いときだけ。
 *
 * **読めない物には照らさない。** `settings.behaviors` が読めなければ時点の並びを、ページ一覧に JSON として読めない
 * 行が在ればページ一覧を見ない。それぞれ `browserhive/settings-shape` と `pages/page-schema` が言う。索引や
 * ページ一覧の不在は `wacz/required-files` が言う。
 *
 * **archive 自身の宣言 (`conformsTo`) で分ける。** 写しは WACZ Profile 1.17.0 で入ったので、それより前を名乗る
 * archive と、名乗りが無いか読めない archive には当てない。
 *
 * Spec: https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.17.0/#snapshots
 *   （ページ一覧は同じ版の #pages、索引は #archive-files。#archive-files の出典は 1.24.0 を指す ——
 *   同じ節のスクリーンショットの決まりを `browserhive/screenshots` が見るので、同じ節は同じ版で指す）と
 *   https://uraitakahito.github.io/browserhive-warc-spec/1.1.0/#snapshots
 */
import { ok } from "../../result.js";
import { parseCdxj, type CdxjEntry } from "../../wacz/cdxj-parser.js";
import { fieldRecord, parseWarcFieldsBody } from "../../wacz/named-fields.js";
import type { WaczReader } from "../../wacz/reader.js";
import { getHeader, parseWarcRecord, type ParsedWarcRecord } from "../../wacz/warc-header.js";
import { iterateWarcMembers } from "../../wacz/warc-iter.js";
import { hasScriptElement } from "../browserhive-snapshot-html.js";
import { isRecord, profileAtLeast, readCapture } from "../browserhive-storage.js";
import { datapackageOf } from "../datapackage-source.js";
import type { Issue, IssueLocation, ValidationRule } from "../domain.js";

const RULE = "browserhive/snapshots";
const DATAPACKAGE = "datapackage.json";
const PAGES_ENTRY = "pages/pages.jsonl";
const CDXJ_ENTRY = "indexes/index.cdxj";

/** 写しの `WARC-Target-URI` の頭。後ろに時点、`:`、写した時点の文書の URL（fragment 無し）が続く。 */
const SNAPSHOT_URI = "urn:browserhive:snapshot:";
/** 撮らなかった理由（WACZ Profile 1.17.0）。 */
const SKIPPED_REASONS: ReadonlySet<string> = new Set(["withheld", "too-large", "task-budget", "failed"]);

/** 本の中の記録 1 つ。落ちたときに名指す本と位置を持つ。 */
interface Located {
  readonly entry: string;
  readonly offset: number;
  readonly record: ParsedWarcRecord;
}

/** 撮った項目と、その `record` の名指す resource（無ければ `undefined`）。ページ一覧と索引はこれに照らす。 */
interface Taken {
  readonly stage: string;
  readonly resource: Located | undefined;
}

/** JSON の値を文字で。無い値は `undefined`。 */
const json = (v: unknown): string => (v === undefined ? "undefined" : JSON.stringify(v));

/** 文字の欄の値を見せる。文字はそのまま、ほかは JSON。 */
const shown = (v: unknown): string => (typeof v === "string" ? v : json(v));

/** 数の欄の値を見せる。数は 10 進、ほかは JSON —— 文字で書いた数は引用符つきになり、数と取り違えない。 */
const shownNumber = (v: unknown): string => (typeof v === "number" ? String(v) : json(v));

/** 型の名。落ちたときに何が在ったかを言うため。 */
const typeName = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

/**
 * archive の全部の本を 1 度読み、resource を `WARC-Record-ID` で、metadata を `WARC-Refers-To` で引けるようにする。
 * 写しの resource（`WARC-Target-URI` が urn の物）は、どれかの項目が名指しているかを見るために別にも並べる。
 */
const readRecords = async (
  wacz: WaczReader,
): Promise<{
  resources: Map<string, Located>;
  snapshotResources: Located[];
  metadataByTarget: Map<string, Located[]>;
}> => {
  const resources = new Map<string, Located>();
  const snapshotResources: Located[] = [];
  const metadataByTarget = new Map<string, Located[]>();
  for (const entry of wacz.warcEntries()) {
    const buf = await wacz.readEntry(entry);
    if (buf === undefined) continue;
    for (const member of iterateWarcMembers(buf, { loose: true })) {
      const record = parseWarcRecord(member.raw);
      if (record === null) continue;
      const located: Located = { entry, offset: member.offset, record };
      const type = (getHeader(record, "WARC-Type") ?? "").toLowerCase();
      if (type === "resource") {
        const id = getHeader(record, "WARC-Record-ID");
        if (id !== undefined && !resources.has(id)) resources.set(id, located);
        if ((getHeader(record, "WARC-Target-URI") ?? "").startsWith(SNAPSHOT_URI)) snapshotResources.push(located);
      } else if (type === "metadata") {
        const target = getHeader(record, "WARC-Refers-To");
        if (target === undefined) continue;
        const list = metadataByTarget.get(target);
        if (list === undefined) metadataByTarget.set(target, [located]);
        else list.push(located);
      }
    }
  }
  return { resources, snapshotResources, metadataByTarget };
};

/**
 * ページ一覧のページの行（header の次から）と、その行番号。JSON のオブジェクトとして読めない行が 1 つでも在れば
 * `null` —— 行の並びを照らせない（読めない行は `pages/page-schema` が言う）。
 */
const readPageLines = (text: string): { line: number; page: Record<string, unknown> }[] | null => {
  const pages: { line: number; page: Record<string, unknown> }[] = [];
  let header = true;
  for (const [i, raw] of text.split("\n").entries()) {
    if (raw.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (header) {
      header = false;
      continue;
    }
    if (!isRecord(parsed)) return null;
    pages.push({ line: i + 1, page: parsed });
  }
  return pages;
};

/** 索引の行と、その行番号。読めない行は飛ばす（`cdxj/index-valid-data` が言う）。 */
const readIndexLines = (text: string): { line: number; entry: CdxjEntry }[] =>
  text.split("\n").flatMap((raw, i) => {
    const [entry] = parseCdxj(raw).entries;
    return entry === undefined ? [] : [{ line: i + 1, entry }];
  });

export const browserhiveSnapshotsRule: ValidationRule = {
  name: "browserhive/snapshots",
  descriptionKey: `${RULE}.desc`,
  conformance: "MUST",
  docs: [
    {
      label: "BrowserHive WARC Profile §Snapshots",
      url: {
        en: "https://uraitakahito.github.io/browserhive-warc-spec/1.1.0/#snapshots",
        ja: "https://uraitakahito.github.io/browserhive-warc-spec/1.1.0/ja/#snapshots",
      },
    },
    {
      label: "BrowserHive WACZ Profile §snapshots",
      url: {
        en: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.17.0/#snapshots",
        ja: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.17.0/ja/#snapshots",
      },
    },
    {
      label: "BrowserHive WACZ Profile §Pages",
      url: {
        en: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.18.0/#pages",
        ja: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.18.0/ja/#pages",
      },
    },
    {
      label: "BrowserHive WACZ Profile §Archive files",
      url: {
        en: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.24.0/#archive-files",
        ja: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.24.0/ja/#archive-files",
      },
    },
  ],
  applicability: {
    excludeProfiles: ["spec", "lenient"],
  },
  run: async (wacz) => {
    const capture = await readCapture(wacz);
    if (capture === undefined || !profileAtLeast(capture["conformsTo"], 1, 17)) return ok([]);

    const issues: Issue[] = [];
    const issue = (messageKey: string, params: Record<string, string>, location: IssueLocation): void => {
      issues.push({ rule: RULE, severity: "error", messageKey: `${RULE}.${messageKey}`, params, location });
    };
    /** 2 つの値が違えば言う。`where` の `field` が `found`、`other` の `otherField` が `expected`。 */
    const compare = (
      stage: string,
      [where, field, found]: readonly [string, string, string],
      [other, otherField, expected]: readonly [string, string, string],
      location: IssueLocation,
    ): void => {
      if (found !== expected) issue("mismatch", { stage, where, field, found, other, otherField, expected }, location);
    };
    const inDatapackage: IssueLocation = { entry: DATAPACKAGE };
    const at = (located: Located): IssueLocation => ({ entry: located.entry, offset: located.offset });

    const snapshots = capture["snapshots"];
    if (!Array.isArray(snapshots)) {
      issue("shape", { at: "snapshots", found: typeName(snapshots) }, inDatapackage);
      return ok(issues);
    }
    const items: Record<string, unknown>[] = [];
    snapshots.forEach((item: unknown, index) => {
      if (isRecord(item)) items.push(item);
      else issue("shape", { at: `snapshots[${String(index)}]`, found: typeName(item) }, inDatapackage);
    });

    // 時点の並び。behaviors が読めなければ照らさない（settings の形は browserhive/settings-shape が言う）。
    const settings = capture["settings"];
    const behaviors = isRecord(settings) ? settings["behaviors"] : undefined;
    if (Array.isArray(behaviors) && items.length === snapshots.length) {
      const expected = behaviors.length > 0 ? ["after-load", "after-behaviors"] : ["after-load"];
      const found = JSON.stringify(items.map((item) => item["stage"]));
      if (found !== JSON.stringify(expected)) {
        issue("stages", { found, expected: JSON.stringify(expected), behaviors: String(behaviors.length) }, inDatapackage);
      }
    }

    const { resources, snapshotResources, metadataByTarget } = await readRecords(wacz);
    const taken: Taken[] = [];
    const named = new Set<Located>();
    for (const item of items) {
      const stage = shown(item["stage"]);
      const skipped = item["skipped"];
      if (skipped !== undefined) {
        if (typeof skipped !== "string" || !SKIPPED_REASONS.has(skipped)) {
          issue("skipped", { stage, found: shown(skipped) }, inDatapackage);
        }
        continue;
      }

      const url = item["url"];
      if (typeof url !== "string" || !url.startsWith(`${SNAPSHOT_URI}${stage}:`)) {
        issue("url", { stage, url: shown(url) }, inDatapackage);
      }
      const record = item["record"];
      const resource = typeof record === "string" ? resources.get(`<${record}>`) : undefined;
      taken.push({ stage, resource });
      if (resource === undefined) {
        issue("no-resource", { stage, record: shown(record) }, inDatapackage);
        continue;
      }
      named.add(resource);
      const targetUri = shown(getHeader(resource.record, "WARC-Target-URI"));
      const date = shown(getHeader(resource.record, "WARC-Date"));
      compare(stage, ["snapshots", "url", shown(url)], ["resource", "WARC-Target-URI", targetUri], inDatapackage);
      compare(stage, ["snapshots", "date", shown(item["date"])], ["resource", "WARC-Date", date], inDatapackage);
      compare(
        stage,
        ["snapshots", "bytes", shownNumber(item["bytes"])],
        ["resource", "Content-Length", shown(getHeader(resource.record, "Content-Length"))],
        inDatapackage,
      );
      if (hasScriptElement(resource.record.body.toString("utf-8"))) {
        issue("script", { stage, url: targetUri }, at(resource));
      }

      // 組の metadata。同じ本の物を先に見る。別の本にしか無ければ、それは browserhive/exchange-in-one-file が言う。
      const candidates = metadataByTarget.get(getHeader(resource.record, "WARC-Record-ID") ?? "") ?? [];
      const metadata = candidates.find((m) => m.entry === resource.entry) ?? candidates[0];
      if (metadata === undefined) {
        issue("no-metadata", { stage, url: targetUri }, at(resource));
        continue;
      }
      const fields = fieldRecord(parseWarcFieldsBody(metadata.record.body).fields);
      compare(
        stage,
        ["metadata", "WARC-Target-URI", shown(getHeader(metadata.record, "WARC-Target-URI"))],
        ["resource", "WARC-Target-URI", targetUri],
        at(metadata),
      );
      compare(
        stage,
        ["metadata", "WARC-Date", shown(getHeader(metadata.record, "WARC-Date"))],
        ["resource", "WARC-Date", date],
        at(metadata),
      );
      compare(stage, ["metadata", "snapshot", shown(fields["snapshot"])], ["snapshots", "stage", stage], at(metadata));
      compare(
        stage,
        ["snapshots", "secretsReplaced", shownNumber(item["secretsReplaced"])],
        ["metadata", "secrets-replaced", shown(fields["secrets-replaced"])],
        inDatapackage,
      );
    }

    // どの項目も名指さない写し。
    for (const located of snapshotResources) {
      if (named.has(located)) continue;
      issue(
        "unlisted",
        {
          url: shown(getHeader(located.record, "WARC-Target-URI")),
          record: shown(getHeader(located.record, "WARC-Record-ID")),
        },
        at(located),
      );
    }

    // ページ一覧。WACZ Profile 1.18.0 から: 1 行目は文書の行（stage 無し）、その後に写しごとに 1 行を
    // snapshots の順に。1.17.0: 写しごとに 1 行を snapshots の順に、写しが無ければ stage の無い 1 行。
    // 版は archive が名乗る conformsTo で分ける（store には 1.17.0 の archive も残る）。
    const documentFirst = profileAtLeast(capture["conformsTo"], 1, 18);
    const pagesBuf = await wacz.readEntry(PAGES_ENTRY);
    const pages = pagesBuf === undefined ? null : readPageLines(pagesBuf.toString("utf-8"));
    if (pages !== null) {
      const stages = taken.map((t) => t.stage);
      const expected = JSON.stringify(documentFirst ? [null, ...stages] : stages.length > 0 ? stages : [null]);
      const found = JSON.stringify(pages.map(({ page }) => page["stage"] ?? null));
      if (found !== expected) {
        issue("pages", { found, expected }, { entry: PAGES_ENTRY });
      } else {
        const offset = documentFirst ? 1 : 0; // 1.18.0 からは、写しの行は文書の行の後
        taken.forEach(({ stage, resource }, i) => {
          const row = pages[i + offset];
          if (resource === undefined || row === undefined) return;
          const location: IssueLocation = { entry: PAGES_ENTRY, line: row.line };
          compare(
            stage,
            ["pages/pages.jsonl", "url", shown(row.page["url"])],
            ["resource", "WARC-Target-URI", shown(getHeader(resource.record, "WARC-Target-URI"))],
            location,
          );
          compare(
            stage,
            ["pages/pages.jsonl", "ts", shown(row.page["ts"])],
            ["resource", "WARC-Date", shown(getHeader(resource.record, "WARC-Date"))],
            location,
          );
        });
      }
      // 読み手は id の同じ行を 1 つしか残さない。
      const seen = new Set<string>();
      const repeated = new Set<string>();
      for (const { line, page } of pages) {
        if (page["id"] === undefined) continue;
        const id = shown(page["id"]);
        if (seen.has(id) && !repeated.has(id)) {
          repeated.add(id);
          issue("page-id", { id }, { entry: PAGES_ENTRY, line });
        }
        seen.add(id);
      }
      // mainPageURL は最初の行の url（1.18.0 からはいつでも＝文書の行、1.17.0 は写しが在るとき＝最初の写し）。
      const first = pages[0];
      if ((documentFirst || taken.length > 0) && first !== undefined) {
        const mainPageURL = (await datapackageOf(wacz)).parsed?.mainPageURL;
        if (mainPageURL !== first.page["url"]) {
          issue("main-page", { found: shown(mainPageURL), expected: shown(first.page["url"]) }, inDatapackage);
        }
      }
    }

    // 索引: 写しの resource を指す行が在り、鍵は WARC-Target-URI のまま、JSON に status が無い。行は鍵や url ではなく
    // 指す記録で探す —— 写しの URI を文書の URL で書いた archive で、その文書の応答の行を写しの行と取り違えない。
    const cdxjBuf = await wacz.readEntry(CDXJ_ENTRY);
    if (cdxjBuf !== undefined) {
      const lines = readIndexLines(cdxjBuf.toString("utf-8"));
      for (const { stage, resource } of taken) {
        if (resource === undefined) continue;
        const uri = getHeader(resource.record, "WARC-Target-URI") ?? "";
        const file = resource.entry.slice("archive/".length);
        const rows = lines.filter(
          ({ entry }) => entry.fields["filename"] === file && String(entry.fields["offset"]) === String(resource.offset),
        );
        if (rows.length === 0) {
          issue("not-indexed", { stage, url: uri }, { entry: CDXJ_ENTRY });
          continue;
        }
        for (const { line, entry } of rows) {
          const location: IssueLocation = { entry: CDXJ_ENTRY, line };
          compare(stage, ["indexes/index.cdxj", "urlkey", entry.surt], ["resource", "WARC-Target-URI", uri], location);
          if (entry.fields["status"] !== undefined) {
            issue("index-status", { stage, url: uri, status: shown(entry.fields["status"]) }, location);
          }
        }
      }
    }
    return ok(issues);
  },
};
