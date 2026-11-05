// @module-tag engine
/**
 * `browserhive/snapshots` のテスト。
 *
 * 守っている主張は WACZ Profile 1.17.0 と 1.18.0（Pages の 1 行目は文書）の snapshots・Pages・Archive files（索引の段落）と、BrowserHive WARC Profile
 * 1.1.0 の Snapshots。取り込みが撮った DOM の写しは、datapackage の snapshots の項目・WARC の resource と metadata の
 * 組・ページ一覧の行・索引の行のどこから読んでも同じ物を指し、写しは script の要素を持たない。
 *
 * 標本は、正しい archive（2 つの時点を撮った `archive()`、after-load だけの `onlyAfterLoad()`、どの時点も撮らなかった
 * `withheld()`）から 1 か所だけを崩して作る。崩した 1 か所を、狙った鍵 1 つだけが言うことを見る —— rule が
 * その 1 か所を見ていることを、区別できる入力で確かめるため。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProfileSelector } from "@wacz-validator/contract";
import { parseReportSource, type Issue, type IssueLocation, type Report } from "../src/validate/domain.js";
import { runValidation } from "../src/validate/engine.js";
import { DEFAULT_RULES } from "../src/validate/rules/index.js";
import { sha256Base32 } from "../src/wacz/digest.js";
import { fileTransport } from "../src/wacz/transport.js";
import { WaczReader } from "../src/wacz/reader.js";
import {
  buildWacz,
  type FixtureOptions,
  type WarcMetadataSpec,
  type WarcRecordInfo,
  type WarcResourceSpec,
} from "./fixtures/generator.js";
import { firedWarc11Rules } from "./fixtures/warc11.js";

const RULE = "browserhive/snapshots";
const WACZ_1_16 = "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.16.0/";
const WACZ_1_17 = "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.17.0/";
const WACZ_1_18 = "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.18.0/";
const DATAPACKAGE: IssueLocation = { entry: "datapackage.json" };
const PAGES = "pages/pages.jsonl";
const INDEX = "indexes/index.cdxj";
const MAIN = "archive/data.warc.gz";

/** 写した文書の URL。時点 B の前に、頁が History API で URL を替えた（文書は同じ）。 */
const DOC_A = "https://site.test/";
const DOC_B = "https://site.test/results";

/** 写し 1 枚の、archive のあちこちに現れる値。 */
interface Shot {
  readonly stage: "after-load" | "after-behaviors";
  /** resource と metadata の `WARC-Target-URI`。 */
  readonly url: string;
  readonly date: string;
  /** `WARC-Record-ID` の中の URI（山括弧なし）。 */
  readonly record: string;
  readonly body: string;
  readonly secretsReplaced: number;
  readonly documentUri: string;
}

const html = (base: string, body: string): string =>
  `<!DOCTYPE html><html lang="en"><head><base href="${base}"><meta charset="utf-8"><title>Shop</title></head><body>${body}</body></html>`;

const A: Shot = {
  stage: "after-load",
  url: `urn:browserhive:snapshot:after-load:${DOC_A}`,
  date: "2026-11-02T01:20:05.118Z",
  record: "urn:uuid:5e0f6a3c-2d7b-4f1e-9a8c-1b2d3e4f5a6b",
  body: html(DOC_A, '<form role="search"><input name="q"></form>'),
  secretsReplaced: 0,
  documentUri: DOC_A,
};
const B: Shot = {
  stage: "after-behaviors",
  url: `urn:browserhive:snapshot:after-behaviors:${DOC_B}`,
  date: "2026-11-02T01:20:07.415Z",
  record: "urn:uuid:d6874c5c-9710-40d4-9fb8-ceb24bb0dfc8",
  body: html(DOC_B, '<form role="search"><input name="q" value="lamp"></form><h1>3 results</h1>'),
  secretsReplaced: 1,
  documentUri: `${DOC_B}#top`,
};

const resourceOf = (s: Shot): WarcResourceSpec => ({ uri: s.url, date: s.date, recordId: `<${s.record}>`, body: s.body });
const fieldsOf = (s: Shot): Record<string, string> => ({
  snapshot: s.stage,
  "document-uri": s.documentUri,
  "secrets-replaced": String(s.secretsReplaced),
});
const metadataOf = (s: Shot): WarcMetadataSpec => ({ uri: s.url, date: s.date, refersTo: `<${s.record}>`, fields: fieldsOf(s) });
const entryOf = (s: Shot): Record<string, unknown> => ({
  stage: s.stage,
  url: s.url,
  date: s.date,
  record: s.record,
  bytes: Buffer.byteLength(s.body),
  secretsReplaced: s.secretsReplaced,
});
const pageOf = (s: Shot): Record<string, unknown> => ({ id: `task-1-${s.stage}`, url: s.url, ts: s.date, stage: s.stage, title: "Shop" });

/** 2 つの時点を撮った archive（スクリプトが 1 本走った取り込み）。`over` で 1 か所を崩す。 */
const archive = (over: Partial<FixtureOptions> = {}): FixtureOptions => ({
  software: "browserhive/23.0.0",
  conformsTo: WACZ_1_17,
  settings: { behaviors: [{ name: "search" }] },
  warcResources: [resourceOf(A), resourceOf(B)],
  warcMetadata: [metadataOf(A), metadataOf(B)],
  pageEntries: [pageOf(A), pageOf(B)],
  snapshots: [entryOf(A), entryOf(B)],
  mainPageUrlOverride: A.url,
  ...over,
});

/** スクリプトの無い取り込みが、after-load だけを撮った archive。 */
const onlyAfterLoad = (over: Partial<FixtureOptions> = {}, shot: Shot = A): FixtureOptions =>
  archive({
    settings: { behaviors: [] },
    warcResources: [resourceOf(shot)],
    warcMetadata: [metadataOf(shot)],
    pageEntries: [pageOf(shot)],
    snapshots: [entryOf(shot)],
    mainPageUrlOverride: shot.url,
    ...over,
  });

/** 写しを 1 つも撮らなかった archive（方針が文書を伏せた）。ページ一覧は要求の URL の 1 行（stage 無し）。 */
const withheld = (over: Partial<FixtureOptions> = {}): FixtureOptions => ({
  software: "browserhive/23.0.0",
  conformsTo: WACZ_1_17,
  settings: { behaviors: [{ name: "search" }] },
  snapshots: [
    { stage: "after-load", skipped: "withheld" },
    { stage: "after-behaviors", skipped: "withheld" },
  ],
  ...over,
});

const bad = (messageKey: string, params: Record<string, string>, location: IssueLocation): Issue => ({
  rule: RULE,
  severity: "error",
  messageKey: `${RULE}.${messageKey}`,
  params,
  location,
});

/** 値を比べて落ちた 1 件。`where` の `field` が `found`、`other` の `otherField` が `expected`。 */
const mismatch = (
  stage: string,
  [where, field, found]: readonly [string, string, string],
  [other, otherField, expected]: readonly [string, string, string],
  location: IssueLocation,
): Issue => bad("mismatch", { stage, where, field, found, other, otherField, expected }, location);

/** 主の本の中の、`n` 番目（0 始まり）の `type` の記録の位置。 */
const at = (records: readonly WarcRecordInfo[], type: WarcRecordInfo["type"], n = 0): IssueLocation => {
  const found = records.filter((r) => r.type === type)[n];
  if (found === undefined) throw new Error(`no ${type} record #${String(n)}`);
  return { entry: MAIN, offset: found.offset };
};

describe("browserhive/snapshots", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "wacz-validator-snapshots-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const reportOf = async (
    options: FixtureOptions,
    selector: ProfileSelector = { name: "browserhive" },
  ): Promise<{ report: Report; records: WarcRecordInfo[] }> => {
    const { bytes, warcRecords } = await buildWacz(options);
    const path = join(tmpDir, "fixture.wacz");
    await writeFile(path, bytes);
    const source = parseReportSource(path);
    if (!source.ok || source.value.kind !== "file") throw new Error("unreachable");
    const reader = await WaczReader.open(fileTransport(source.value.path));
    try {
      const result = await runValidation(reader, { validatorVersion: "0.0.0", rules: DEFAULT_RULES, profile: selector });
      if (!result.ok) throw new Error("runValidation returned err — unreachable");
      return { report: result.value, records: warcRecords };
    } finally {
      await reader.close();
    }
  };
  const run = async (options: FixtureOptions, selector?: ProfileSelector): Promise<Issue[]> =>
    (await reportOf(options, selector)).report.issues.filter((i) => i.rule === RULE);
  /** この rule の issue と、主の本の記録の位置。 */
  const runWith = async (options: FixtureOptions): Promise<{ issues: Issue[]; records: WarcRecordInfo[] }> => {
    const { report, records } = await reportOf(options);
    return { issues: report.issues.filter((i) => i.rule === RULE), records };
  };

  describe("通す形", () => {
    it("2 つの時点を撮った archive には何も言わない", async () => {
      expect(await run(archive())).toEqual([]);
    });

    it("スクリプトの無い取り込みが after-load だけを撮った archive には何も言わない", async () => {
      expect(await run(onlyAfterLoad())).toEqual([]);
    });

    it("どの時点も撮らなかった archive（伏せた文書）には何も言わない —— ページ一覧は stage の無い 1 行", async () => {
      expect(await run(withheld())).toEqual([]);
    });

    it("撮らなかった理由は 4 つのどれでもよい", async () => {
      for (const reason of ["withheld", "too-large", "task-budget", "failed"]) {
        const options = onlyAfterLoad({
          settings: { behaviors: [{ name: "search" }] },
          snapshots: [entryOf(A), { stage: "after-behaviors", skipped: reason }],
        });
        expect(await run(options), reason).toEqual([]);
      }
    });
  });

  describe("snapshots の形と時点の並び", () => {
    it("snapshots が無ければ error —— profile 1.17.0 から必須", async () => {
      const { snapshots: _dropped, ...options } = archive();
      expect(await run(options)).toEqual([bad("shape", { at: "snapshots", found: "undefined" }, DATAPACKAGE)]);
    });

    it("項目がオブジェクトでなければ error", async () => {
      expect(await run(onlyAfterLoad({ snapshots: [entryOf(A), 42] }))).toEqual([
        bad("shape", { at: "snapshots[1]", found: "number" }, DATAPACKAGE),
      ]);
    });

    it("スクリプトが走ったのに after-behaviors の項目が無ければ error", async () => {
      expect(await run(onlyAfterLoad({ settings: { behaviors: [{ name: "search" }] } }))).toEqual([
        bad("stages", { found: '["after-load"]', expected: '["after-load","after-behaviors"]', behaviors: "1" }, DATAPACKAGE),
      ]);
    });

    it("スクリプトが走っていないのに after-behaviors の項目があれば error", async () => {
      expect(await run(archive({ settings: { behaviors: [] } }))).toEqual([
        bad("stages", { found: '["after-load","after-behaviors"]', expected: '["after-load"]', behaviors: "0" }, DATAPACKAGE),
      ]);
    });

    it("after-behaviors が after-load より前に並べば error", async () => {
      // ページ一覧と mainPageURL も同じ順に揃え、並びの検査だけが言うことを見る。
      const options = archive({
        snapshots: [entryOf(B), entryOf(A)],
        pageEntries: [pageOf(B), pageOf(A)],
        mainPageUrlOverride: B.url,
      });
      expect(await run(options)).toEqual([
        bad("stages", { found: '["after-behaviors","after-load"]', expected: '["after-load","after-behaviors"]', behaviors: "1" }, DATAPACKAGE),
      ]);
    });

    it("撮らなかった理由が 4 つのどれでもなければ error", async () => {
      const options = onlyAfterLoad({
        settings: { behaviors: [{ name: "search" }] },
        snapshots: [entryOf(A), { stage: "after-behaviors", skipped: "robots" }],
      });
      expect(await run(options)).toEqual([bad("skipped", { stage: "after-behaviors", found: "robots" }, DATAPACKAGE)]);
    });
  });

  describe("撮った項目と、写しの resource", () => {
    it("url が写しの URI でなければ error（時点の違う urn）", async () => {
      // resource・metadata・ページ一覧・索引は崩した url で揃え、url の形の検査だけが言うことを見る。
      const shot: Shot = { ...A, url: `urn:browserhive:snapshot:after-behaviors:${DOC_A}` };
      expect(await run(onlyAfterLoad({}, shot))).toEqual([bad("url", { stage: "after-load", url: shot.url }, DATAPACKAGE)]);
    });

    it("url が写しの URI でなければ error（文書の URL そのもの）", async () => {
      const shot: Shot = { ...A, url: DOC_A };
      expect(await run(onlyAfterLoad({}, shot))).toEqual([bad("url", { stage: "after-load", url: DOC_A }, DATAPACKAGE)]);
    });

    it("record の名指す resource が無ければ error —— 名指されない写しも残るので、2 つの決まりが破れる", async () => {
      const { issues, records } = await runWith(
        onlyAfterLoad({ snapshots: [{ ...entryOf(A), record: "urn:uuid:00000000-0000-0000-0000-00000000dead" }] }),
      );
      expect(issues).toEqual([
        bad("no-resource", { stage: "after-load", record: "urn:uuid:00000000-0000-0000-0000-00000000dead" }, DATAPACKAGE),
        bad("unlisted", { url: A.url, record: `<${A.record}>` }, at(records, "resource")),
      ]);
    });

    it("山括弧つきの record は名指していない —— JSON の値は WARC-Record-ID の中の URI だけ", async () => {
      const { issues, records } = await runWith(onlyAfterLoad({ snapshots: [{ ...entryOf(A), record: `<${A.record}>` }] }));
      expect(issues).toEqual([
        bad("no-resource", { stage: "after-load", record: `<${A.record}>` }, DATAPACKAGE),
        bad("unlisted", { url: A.url, record: `<${A.record}>` }, at(records, "resource")),
      ]);
    });

    it("url が resource の WARC-Target-URI と違えば error", async () => {
      const other = `urn:browserhive:snapshot:after-load:${DOC_A}other`;
      expect(await run(onlyAfterLoad({ snapshots: [{ ...entryOf(A), url: other }] }))).toEqual([
        mismatch("after-load", ["snapshots", "url", other], ["resource", "WARC-Target-URI", A.url], DATAPACKAGE),
      ]);
    });

    it("date が resource の WARC-Date と違えば error", async () => {
      expect(await run(onlyAfterLoad({ snapshots: [{ ...entryOf(A), date: "2026-11-02T01:20:05Z" }] }))).toEqual([
        mismatch("after-load", ["snapshots", "date", "2026-11-02T01:20:05Z"], ["resource", "WARC-Date", A.date], DATAPACKAGE),
      ]);
    });

    it("bytes が resource の Content-Length と違えば error。数を文字で書いても違う", async () => {
      const length = String(Buffer.byteLength(A.body));
      for (const [bytes, found] of [
        [Buffer.byteLength(A.body) + 1, String(Buffer.byteLength(A.body) + 1)],
        [length, `"${length}"`],
      ] as const) {
        expect(await run(onlyAfterLoad({ snapshots: [{ ...entryOf(A), bytes }] })), found).toEqual([
          mismatch("after-load", ["snapshots", "bytes", found], ["resource", "Content-Length", length], DATAPACKAGE),
        ]);
      }
    });

    it("どの項目も名指さない写しが在れば error", async () => {
      const stale: Shot = { ...A, url: `urn:browserhive:snapshot:after-load:${DOC_A}stale`, record: "urn:uuid:00000000-0000-0000-0000-00000000aaaa" };
      const { issues, records } = await runWith(archive({ warcResources: [resourceOf(A), resourceOf(B), resourceOf(stale)] }));
      expect(issues).toEqual([bad("unlisted", { url: stale.url, record: `<${stale.record}>` }, at(records, "resource", 2))]);
    });
  });

  describe("組の metadata", () => {
    it("resource を指す metadata がどの本にも無ければ error", async () => {
      const { issues, records } = await runWith(archive({ warcMetadata: [metadataOf(B)] }));
      expect(issues).toEqual([bad("no-metadata", { stage: "after-load", url: A.url }, at(records, "resource"))]);
    });

    it("metadata が resource と別の本に在るだけなら言わない —— それは browserhive/exchange-in-one-file が言う", async () => {
      const options = archive({
        warcName: "data-000.warc.gz",
        warcinfoFilename: "data-000.warc.gz",
        warcMetadata: [metadataOf(B)],
        extraWarcs: [{ name: "data-001.warc.gz", warcinfoFilename: "data-001.warc.gz", metadata: [metadataOf(A)] }],
      });
      const { report } = await reportOf(options);
      expect(report.issues.filter((i) => i.rule === RULE)).toEqual([]);
      expect(report.issues.filter((i) => i.rule === "browserhive/exchange-in-one-file")).toEqual([
        {
          rule: "browserhive/exchange-in-one-file",
          severity: "error",
          messageKey: "browserhive/exchange-in-one-file.metadata",
          params: { url: A.url, entry: "archive/data-001.warc.gz", other: "archive/data-000.warc.gz" },
          location: { entry: "archive/data-001.warc.gz" },
        },
      ]);
    });

    it("metadata の WARC-Target-URI が resource と違えば error", async () => {
      const uri = `urn:browserhive:snapshot:after-load:${DOC_A}x`;
      const { issues, records } = await runWith(archive({ warcMetadata: [{ ...metadataOf(A), uri }, metadataOf(B)] }));
      expect(issues).toEqual([
        mismatch("after-load", ["metadata", "WARC-Target-URI", uri], ["resource", "WARC-Target-URI", A.url], at(records, "metadata")),
      ]);
    });

    it("metadata の WARC-Date が resource と違えば error", async () => {
      const date = "2026-11-02T01:20:06.000Z";
      const { issues, records } = await runWith(archive({ warcMetadata: [{ ...metadataOf(A), date }, metadataOf(B)] }));
      expect(issues).toEqual([
        mismatch("after-load", ["metadata", "WARC-Date", date], ["resource", "WARC-Date", A.date], at(records, "metadata")),
      ]);
    });

    it("metadata の snapshot の欄が項目の stage と違えば error", async () => {
      const metadata = { ...metadataOf(A), fields: { ...fieldsOf(A), snapshot: "after-behaviors" } };
      const { issues, records } = await runWith(archive({ warcMetadata: [metadata, metadataOf(B)] }));
      expect(issues).toEqual([
        mismatch("after-load", ["metadata", "snapshot", "after-behaviors"], ["snapshots", "stage", "after-load"], at(records, "metadata")),
      ]);
    });

    it("secretsReplaced が metadata の secrets-replaced と違えば error", async () => {
      const metadata = { ...metadataOf(B), fields: { ...fieldsOf(B), "secrets-replaced": "2" } };
      expect(await run(archive({ warcMetadata: [metadataOf(A), metadata] }))).toEqual([
        mismatch("after-behaviors", ["snapshots", "secretsReplaced", "1"], ["metadata", "secrets-replaced", "2"], DATAPACKAGE),
      ]);
    });
  });

  describe("写しの本文", () => {
    it.each([
      ["<script>alert(1)</script>", "素の script"],
      ['<SCRIPT src="x.js"></SCRIPT>', "大文字"],
      ['<svg><script\nhref="x.js"/></svg>', "名の後ろが改行"],
    ])("script の要素が在れば error: %s（%s）", async (inner) => {
      const shot: Shot = { ...A, body: html(DOC_A, inner) };
      const { issues, records } = await runWith(onlyAfterLoad({}, shot));
      expect(issues).toEqual([bad("script", { stage: "after-load", url: A.url }, at(records, "resource"))]);
    });

    it.each([
      ['<!--[if lt IE 9]><script src="html5shiv.js"></script><![endif]-->', "IE の条件付きコメントの中"],
      ["<script-loader></script-loader>", "名が script で始まるカスタム要素"],
      ["<p>&lt;script&gt; は文字</p>", "文字の中の escape した <script>"],
    ])("script の要素でなければ言わない: %s（%s）", async (inner) => {
      expect(await run(onlyAfterLoad({}, { ...A, body: html(DOC_A, inner) }))).toEqual([]);
    });
  });

  describe("ページ一覧", () => {
    it("写しの行が足りなければ error", async () => {
      expect(await run(archive({ pageEntries: [pageOf(A)] }))).toEqual([
        bad("pages", { found: '["after-load"]', expected: '["after-load","after-behaviors"]' }, { entry: PAGES }),
      ]);
    });

    it("写しの行のほかに行があれば error", async () => {
      const extra = { id: "task-1", url: DOC_A, ts: A.date, title: "Shop" };
      expect(await run(archive({ pageEntries: [pageOf(A), pageOf(B), extra] }))).toEqual([
        bad("pages", { found: '["after-load","after-behaviors",null]', expected: '["after-load","after-behaviors"]' }, { entry: PAGES }),
      ]);
    });

    it("写しが無いのに行が stage を持てば error", async () => {
      const entry = { id: "task-1", url: DOC_A, ts: A.date, stage: "after-load" };
      expect(await run(withheld({ pageEntries: [entry] }))).toEqual([
        bad("pages", { found: '["after-load"]', expected: "[null]" }, { entry: PAGES }),
      ]);
    });

    it("行の ts が写しの WARC-Date と違えば error", async () => {
      const ts = "2026-11-02T01:20:05Z";
      expect(await run(archive({ pageEntries: [{ ...pageOf(A), ts }, pageOf(B)] }))).toEqual([
        mismatch("after-load", ["pages/pages.jsonl", "ts", ts], ["resource", "WARC-Date", A.date], { entry: PAGES, line: 2 }),
      ]);
    });

    it("行の url が写しの WARC-Target-URI と違えば error", async () => {
      // mainPageURL は最初の行の url に揃える（mainPageURL の検査は別に見る）。
      expect(await run(archive({ pageEntries: [{ ...pageOf(A), url: DOC_A }, pageOf(B)], mainPageUrlOverride: DOC_A }))).toEqual([
        mismatch("after-load", ["pages/pages.jsonl", "url", DOC_A], ["resource", "WARC-Target-URI", A.url], { entry: PAGES, line: 2 }),
      ]);
    });

    it("同じ id の行が 2 つあれば error —— 読み手は 1 つしか残さない", async () => {
      expect(await run(archive({ pageEntries: [pageOf(A), { ...pageOf(B), id: "task-1-after-load" }] }))).toEqual([
        bad("page-id", { id: "task-1-after-load" }, { entry: PAGES, line: 3 }),
      ]);
    });

    it("写しが在るのに mainPageURL が最初の行の url でなければ error", async () => {
      expect(await run(archive({ mainPageUrlOverride: B.url }))).toEqual([
        bad("main-page", { found: B.url, expected: A.url }, DATAPACKAGE),
      ]);
    });

    it("mainPageURL が写しの urn でも cdxj/pages-mainpage は黙る —— ページ一覧にも索引の JSON の url にも在る", async () => {
      const silent = await reportOf(archive());
      expect(silent.report.issues.filter((i) => i.rule === "cdxj/pages-mainpage")).toEqual([]);
      // 対照: 索引に写しの行が無ければ、cdxj/pages-mainpage は mainPageURL を索引に見つけられない。
      const resources = [{ ...resourceOf(A), omitIndex: true }, resourceOf(B)];
      const loud = await reportOf(archive({ warcResources: resources }));
      expect(loud.report.issues.filter((i) => i.rule === "cdxj/pages-mainpage").map((i) => i.messageKey)).toEqual([
        "cdxj/pages-mainpage.no-cdxj-record",
      ]);
    });
  });

  describe("WACZ Profile 1.18.0 —— ページ一覧の 1 行目は文書", () => {
    /** 取り込みを求められた文書の行（stage 無し・ts は取り込みの開始）。 */
    const DOC_ROW = { id: "task-1", url: DOC_A, ts: "2026-11-02T01:20:03.502Z", title: "Shop" };
    const doc18 = (over: Partial<FixtureOptions> = {}): FixtureOptions =>
      archive({ conformsTo: WACZ_1_18, pageEntries: [DOC_ROW, pageOf(A), pageOf(B)], mainPageUrlOverride: DOC_A, ...over });

    it("文書の行の後に写しの行が並び、mainPageURL が文書の行なら何も言わない", async () => {
      expect(await run(doc18())).toEqual([]);
    });

    it("写しを 1 つも撮らなかった archive は、文書の行 1 つで通る", async () => {
      expect(await run(withheld({ conformsTo: WACZ_1_18 }))).toEqual([]);
    });

    it("写しの行だけ（1.17.0 の形）なら error", async () => {
      expect(await run(doc18({ pageEntries: [pageOf(A), pageOf(B)], mainPageUrlOverride: A.url }))).toEqual([
        bad("pages", { found: '["after-load","after-behaviors"]', expected: '[null,"after-load","after-behaviors"]' }, { entry: PAGES }),
      ]);
    });

    it("文書の行が写しの後ろなら error", async () => {
      expect(await run(doc18({ pageEntries: [pageOf(A), pageOf(B), DOC_ROW], mainPageUrlOverride: A.url }))).toEqual([
        bad("pages", { found: '["after-load","after-behaviors",null]', expected: '[null,"after-load","after-behaviors"]' }, { entry: PAGES }),
      ]);
    });

    it("文書の行が stage を持てば error", async () => {
      const staged = { ...DOC_ROW, stage: "document" };
      expect(await run(doc18({ pageEntries: [staged, pageOf(A), pageOf(B)] }))).toEqual([
        bad("pages", { found: '["document","after-load","after-behaviors"]', expected: '[null,"after-load","after-behaviors"]' }, { entry: PAGES }),
      ]);
    });

    it("mainPageURL が最初の写しなら error —— 1.18.0 からは文書の行", async () => {
      expect(await run(doc18({ mainPageUrlOverride: A.url }))).toEqual([
        bad("main-page", { found: A.url, expected: DOC_A }, DATAPACKAGE),
      ]);
    });

    it("写しの行の url と ts は、文書の行の次（2 行目）から照らす", async () => {
      const ts = "2026-11-02T01:20:05Z";
      expect(await run(doc18({ pageEntries: [DOC_ROW, { ...pageOf(A), ts }, pageOf(B)] }))).toEqual([
        mismatch("after-load", ["pages/pages.jsonl", "ts", ts], ["resource", "WARC-Date", A.date], { entry: PAGES, line: 3 }),
      ]);
    });

    it("1.17.0 の archive は、いままでの形で照らす —— 文書の行が先頭なら error", async () => {
      expect(await run(archive({ pageEntries: [DOC_ROW, pageOf(A), pageOf(B)], mainPageUrlOverride: DOC_A }))).toEqual([
        bad("pages", { found: '[null,"after-load","after-behaviors"]', expected: '["after-load","after-behaviors"]' }, { entry: PAGES }),
      ]);
    });
  });

  describe("索引", () => {
    it("写しの resource の行が索引に無ければ error", async () => {
      const resources = [resourceOf(A), { ...resourceOf(B), omitIndex: true }];
      expect(await run(archive({ warcResources: resources }))).toEqual([
        bad("not-indexed", { stage: "after-behaviors", url: B.url }, { entry: INDEX }),
      ]);
    });

    /** 写しの行だけの索引。行は組んだ記録の本当の位置を指し、B の行の鍵と JSON を差し替える。 */
    const indexWith = async (b: { key?: string; extra?: Record<string, string> }): Promise<string> => {
      const resources = (await buildWacz(archive())).warcRecords.filter((r) => r.type === "resource");
      const line = (shot: Shot, n: number, key: string, extra: Record<string, string> = {}): string => {
        const record = resources[n];
        if (record === undefined) throw new Error("unreachable: two resources");
        const json = { url: shot.url, mime: "text/html", digest: "sha256:0000", length: String(record.length), offset: String(record.offset), filename: "data.warc.gz", ...extra };
        return `${key} 20261102012005 ${JSON.stringify(json)}`;
      };
      return [line(A, 0, A.url), line(B, 1, b.key ?? B.url, b.extra), ""].join("\n");
    };

    it("索引の行は鍵でなく指す記録で探す —— 鍵と url が写しの URI でも、別の記録を指す行は写しの行ではない", async () => {
      const resources = [resourceOf(A), { ...resourceOf(B), omitIndex: true }];
      const elsewhere = `${B.url} 20261102012007 ${JSON.stringify({ url: B.url, mime: "text/html", filename: "data.warc.gz", offset: "0", length: "1" })}\n`;
      const options = archive({ warcResources: resources });
      const index = (await buildWacz(options)).bytes.length > 0 ? await indexWith({}) : "";
      const first = index.split("\n")[0] ?? "";
      expect(await run({ ...options, cdxjOverride: `${first}\n${elsewhere}` })).toEqual([
        bad("not-indexed", { stage: "after-behaviors", url: B.url }, { entry: INDEX }),
      ]);
    });

    it("行の鍵が WARC-Target-URI でなければ error（SURT の形に崩した鍵）", async () => {
      expect(await run(archive({ cdxjOverride: await indexWith({ key: "site,test)/results" }) }))).toEqual([
        mismatch("after-behaviors", ["indexes/index.cdxj", "urlkey", "site,test)/results"], ["resource", "WARC-Target-URI", B.url], { entry: INDEX, line: 2 }),
      ]);
    });

    it("行の JSON が status を持てば error —— 写しはサーバの応答ではない", async () => {
      expect(await run(archive({ cdxjOverride: await indexWith({ extra: { status: "200" } }) }))).toEqual([
        bad("index-status", { stage: "after-behaviors", url: B.url, status: "200" }, { entry: INDEX, line: 2 }),
      ]);
    });
  });

  describe("走る範囲", () => {
    it("WACZ Profile 1.16.0 を名乗る archive には当てない", async () => {
      const broken = archive({ conformsTo: WACZ_1_16, snapshots: "after-load" });
      expect(await run(broken)).toEqual([]);
      // 同じ archive でも 1.17.0 を名乗れば落ちる。黙ったのは版のせいで、形のせいではない。
      expect(await run({ ...broken, conformsTo: WACZ_1_17 })).toEqual([bad("shape", { at: "snapshots", found: "string" }, DATAPACKAGE)]);
    });

    it("archive が版を名乗らなければ当てない", async () => {
      const { conformsTo: _dropped, ...unnamed } = archive({ snapshots: "after-load" });
      expect(await run(unnamed)).toEqual([]);
    });

    it("spec の profile では走らない", async () => {
      expect(await run(archive({ snapshots: "after-load" }), { name: "spec" })).toEqual([]);
    });
  });

  describe("写しの記録と WARC 1.1 の rule", () => {
    /** BrowserHive の metadata と同じく `WARC-Block-Digest` を持たせる（主の本の 3・4 番目が写しの metadata）。 */
    const withBlockDigests = (): FixtureOptions["warcRecordPatches"] =>
      [A, B].map((shot, i) => {
        const body = Buffer.from(`${Object.entries(fieldsOf(shot)).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n`, "utf-8");
        return { index: 3 + i, set: { "WARC-Block-Digest": sha256Base32(body) } };
      });

    it("写しの resource と metadata は、どの WARC 1.1 の rule も鳴らさない（browserhive の profile）", async () => {
      const { report, records } = await reportOf(archive({ warcRecordPatches: withBlockDigests() ?? [] }));
      // 積んだ順の位置が、上の書き換えの前提どおりであること。
      expect(records.map((r) => r.type)).toEqual(["warcinfo", "resource", "resource", "metadata", "metadata"]);
      expect(firedWarc11Rules(report)).toEqual([]);
      expect(report.issues.filter((i) => i.rule === "warc/payload-digest")).toEqual([]);
      expect(report.issues.filter((i) => i.rule === "warc/recording-complete")).toEqual([]);
    });

    it("resource から WARC-Target-URI を消せば、warc/mandatory-fields が言う（resource には必須）", async () => {
      const { report } = await reportOf(archive({ warcRecordPatches: [{ index: 1, set: { "WARC-Target-URI": null } }] }));
      expect(firedWarc11Rules(report)).toEqual(["warc/mandatory-fields"]);
    });

    it("metadata に WARC-Payload-Digest を書けば、warc/fields-by-type が言う（metadata には payload が無い）", async () => {
      const { report } = await reportOf(
        archive({ warcRecordPatches: [{ index: 3, set: { "WARC-Payload-Digest": sha256Base32(Buffer.from("x")) } }] }),
      );
      expect(firedWarc11Rules(report)).toEqual(["warc/fields-by-type"]);
    });

    it("resource の WARC-Payload-Digest が本文と合わなければ、warc/payload-digest が言う（resource の payload は block）", async () => {
      const digest = "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      const { report } = await reportOf(archive({ warcRecordPatches: [{ index: 1, set: { "WARC-Payload-Digest": digest } }] }));
      expect(report.issues.filter((i) => i.rule === "warc/payload-digest").map((i) => i.messageKey)).toEqual([
        "warc/payload-digest.mismatch",
      ]);
    });
  });
});
