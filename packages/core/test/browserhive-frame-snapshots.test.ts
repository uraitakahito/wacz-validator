// @module-tag engine
/**
 * `browserhive/frame-snapshots` のテスト。
 *
 * 守っている主張は BrowserHive WACZ Profile 1.27.0 と BrowserHive WARC Profile 1.5.0 の子フレームの写し。子の写しは、
 * datapackage の snapshots の項目の frames・WARC の resource と metadata の組・親の写しの `data-browserhive-snapshot`
 * の属性・索引のどこから読んでも同じ物を指し、ページ一覧に載らず、script の要素を持たない。
 *
 * 標本は、正しい archive（`archive()`: after-load の主の写しの下に、子 1・その下の子 2（入れ子）・子 3 を書き、
 * 子 4 は方針で伏せた）から 1 か所だけを崩して作る。崩した 1 か所を、狙った鍵 1 つだけが言うことを見る —— rule が
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
import { fileTransport } from "../src/wacz/transport.js";
import { WaczReader } from "../src/wacz/reader.js";
import {
  buildWacz,
  type FixtureOptions,
  type WarcMetadataSpec,
  type WarcRecordInfo,
  type WarcResourceSpec,
} from "./fixtures/generator.js";

const RULE = "browserhive/frame-snapshots";
const WACZ_1_26 = "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.26.0/";
const WACZ_1_27 = "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.27.0/";
const DATAPACKAGE: IssueLocation = { entry: "datapackage.json" };
const PAGES = "pages/pages.jsonl";
const INDEX = "indexes/index.cdxj";
const MAIN = "archive/data.warc.gz";
const STAGE = "after-load";
const DATE = "2026-11-15T01:20:05.118Z";

const DOC = "https://site.test/";
const MAIN_URI = `urn:browserhive:snapshot:${STAGE}:${DOC}`;
const MAIN_RECORD = "urn:uuid:5e0f6a3c-2d7b-4f1e-9a8c-1b2d3e4f5a6b";

/** 子の写し 1 つ。 */
interface Child {
  readonly frame: number;
  readonly parent: number;
  readonly doc: string;
  readonly record: string;
  readonly body: string;
  readonly secretsReplaced: number;
}

const uriOf = (frame: number, doc: string): string => `urn:browserhive:frame-snapshot:${STAGE}:${String(frame)}:${doc}`;
const html = (base: string, body: string): string =>
  `<!DOCTYPE html><html lang="en"><head><base href="${base}"><meta charset="utf-8"><title>Shop</title></head><body>${body}</body></html>`;
/** 写した子を持つ枠の要素。`src` は元のまま、属性の値は直列化のとおり `&` を `&amp;` に。 */
const frameTag = (src: string, uri?: string, element = "iframe"): string =>
  `<${element} src="${src}"${uri === undefined ? "" : ` data-browserhive-snapshot="${uri.replaceAll("&", "&amp;")}"`}></${element}>`;

const DOC_1 = "https://site.test/a.html";
const DOC_2 = "https://site.test/inner.html";
// `&` を持つ URL —— 属性の値の文字参照を解かない読み手は、子 3 の属性を見つけられない。
const DOC_3 = "https://site.test/b.html?x=1&y=2";

const C2: Child = {
  frame: 2,
  parent: 1,
  doc: DOC_2,
  record: "urn:uuid:6a1f7b4d-3e8c-4a2f-8b9d-2c3e4f5a6b7c",
  body: html(DOC_2, "<p>inner</p>"),
  secretsReplaced: 0,
};
const C1: Child = {
  frame: 1,
  parent: 0,
  doc: DOC_1,
  record: "urn:uuid:7b2a8c5e-4f9d-4b3a-9cae-3d4f5a6b7c8d",
  body: html(DOC_1, `<h1>menu</h1>${frameTag("inner.html", uriOf(2, DOC_2))}`),
  secretsReplaced: 1,
};
const C3: Child = {
  frame: 3,
  parent: 0,
  doc: DOC_3,
  record: "urn:uuid:8c3b9d6f-5a0e-4c4b-8dbf-4e5f6a7b8c9e",
  body: html(DOC_3, "<p>right</p>"),
  secretsReplaced: 0,
};
const CHILDREN = [C1, C2, C3] as const;

/** 主の写し。子 1・子 3 の枠は属性を持ち、方針で伏せた子 4 と別 origin の枠は持たない。 */
const MAIN_BODY = html(
  DOC,
  frameTag("a.html", uriOf(1, DOC_1)) +
    frameTag("b.html?x=1&amp;y=2", uriOf(3, DOC_3)) +
    frameTag("ad.html") +
    frameTag("https://other.test/"),
);

const mainResource = (body = MAIN_BODY): WarcResourceSpec => ({ uri: MAIN_URI, date: DATE, recordId: `<${MAIN_RECORD}>`, body });
const mainMetadata: WarcMetadataSpec = {
  uri: MAIN_URI,
  date: DATE,
  refersTo: `<${MAIN_RECORD}>`,
  fields: { snapshot: STAGE, "document-uri": DOC, "secrets-replaced": "0" },
};
const resourceOf = (c: Child, over: Partial<WarcResourceSpec> = {}): WarcResourceSpec => ({
  uri: uriOf(c.frame, c.doc),
  date: DATE,
  recordId: `<${c.record}>`,
  body: c.body,
  ...over,
});
const fieldsOf = (c: Child): Record<string, string> => ({
  snapshot: STAGE,
  "document-uri": c.doc,
  "secrets-replaced": String(c.secretsReplaced),
  frame: String(c.frame),
  parent: String(c.parent),
});
const metadataOf = (c: Child, fields: Record<string, string> = fieldsOf(c)): WarcMetadataSpec => ({
  uri: uriOf(c.frame, c.doc),
  date: DATE,
  refersTo: `<${c.record}>`,
  fields,
});
const frameEntryOf = (c: Child): Record<string, unknown> => ({
  frame: c.frame,
  parent: c.parent,
  url: uriOf(c.frame, c.doc),
  date: DATE,
  record: c.record,
  bytes: Buffer.byteLength(c.body),
  secretsReplaced: c.secretsReplaced,
});
const SKIPPED_4 = { frame: 4, parent: 0, skipped: "withheld" };
const FRAME_ENTRIES = (): Record<string, unknown>[] => [...CHILDREN.map(frameEntryOf), SKIPPED_4];
const FRAME_COUNTS = { read: 4, unreadable: 1, withheld: 1 };

const snapshotEntry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  stage: STAGE,
  url: MAIN_URI,
  date: DATE,
  record: MAIN_RECORD,
  bytes: Buffer.byteLength(MAIN_BODY),
  secretsReplaced: 0,
  frames: FRAME_ENTRIES(),
  frameCounts: FRAME_COUNTS,
  ...over,
});

const DOC_ROW = { id: "task-1", url: DOC, ts: "2026-11-15T01:20:03.502Z", title: "Shop" };
const SNAPSHOT_ROW = { id: `task-1-${STAGE}`, url: MAIN_URI, ts: DATE, stage: STAGE, title: "Shop" };

/** スクリプトの無い取り込みが after-load を撮り、子を 3 つ書いて 1 つ伏せた archive。`over` で 1 か所を崩す。 */
const archive = (over: Partial<FixtureOptions> = {}): FixtureOptions => ({
  software: "browserhive/31.2.0",
  conformsTo: WACZ_1_27,
  settings: { behaviors: [] },
  warcResources: [mainResource(), ...CHILDREN.map((c) => resourceOf(c))],
  warcMetadata: [mainMetadata, ...CHILDREN.map((c) => metadataOf(c))],
  pageEntries: [DOC_ROW, SNAPSHOT_ROW],
  snapshots: [snapshotEntry()],
  mainPageUrlOverride: DOC,
  ...over,
});

/** 子 `c` だけを替えた resource の並び。 */
const resourcesWith = (c: Child, over: Partial<WarcResourceSpec>): WarcResourceSpec[] => [
  mainResource(),
  ...CHILDREN.map((x) => (x === c ? resourceOf(x, over) : resourceOf(x))),
];
/** `frames` の 1 項目だけを替えた snapshots。 */
const framesWith = (index: number, change: (entry: Record<string, unknown>) => Record<string, unknown> | undefined): Record<string, unknown>[] => {
  const frames = FRAME_ENTRIES().flatMap((e, i) => {
    if (i !== index) return [e];
    const changed = change({ ...e });
    return changed === undefined ? [] : [changed];
  });
  return [snapshotEntry({ frames })];
};

const bad = (messageKey: string, params: Record<string, string>, location: IssueLocation): Issue => ({
  rule: RULE,
  severity: "error",
  messageKey: `${RULE}.${messageKey}`,
  params,
  location,
});

/** 主の本の中の、`WARC-Target-URI` が `uri` の resource の位置。 */
const resourceAt = (records: readonly WarcRecordInfo[], options: FixtureOptions, uri: string): IssueLocation => {
  const resources = records.filter((r) => r.type === "resource");
  const index = (options.warcResources ?? []).findIndex((r) => r.uri === uri);
  const found = resources[index];
  if (found === undefined) throw new Error(`no resource ${uri}`);
  return { entry: MAIN, offset: found.offset };
};

describe("browserhive/frame-snapshots", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "wacz-validator-frame-snapshots-"));
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
  /** この rule の issue と、狙った resource の位置。 */
  const runAt = async (options: FixtureOptions, uri: string): Promise<{ issues: Issue[]; location: IssueLocation }> => {
    const { report, records } = await reportOf(options);
    return { issues: report.issues.filter((i) => i.rule === RULE), location: resourceAt(records, options, uri) };
  };

  describe("通す形", () => {
    it("子を 3 つ（1 つは入れ子）書き 1 つ伏せた archive には何も言わない", async () => {
      expect(await run(archive())).toEqual([]);
    });

    it("同じ archive に browserhive/snapshots も何も言わない —— 子の写しを名指さない写しと数えない", async () => {
      const { report } = await reportOf(archive());
      expect(report.issues.filter((i) => i.rule === "browserhive/snapshots")).toEqual([]);
    });

    it("子の写しの metadata を、warc/recording-complete は未完了の記録と数えない", async () => {
      const { report } = await reportOf(archive());
      expect(report.issues.filter((i) => i.rule === "warc/recording-complete" && i.severity !== "info")).toEqual([]);
    });

    it("枠の無い頁は、空の frames と 0 の frameCounts で通る", async () => {
      const plain = html(DOC, "<p>no frames</p>");
      const options = archive({
        warcResources: [mainResource(plain)],
        warcMetadata: [mainMetadata],
        snapshots: [snapshotEntry({ bytes: Buffer.byteLength(plain), frames: [], frameCounts: { read: 0, unreadable: 0, withheld: 0 } })],
      });
      expect(await run(options)).toEqual([]);
    });

    it("写しを撮らなかった時点の項目は frames を持たなくてよい", async () => {
      expect(await run(archive({ warcResources: [], warcMetadata: [], pageEntries: [DOC_ROW], snapshots: [{ stage: STAGE, skipped: "withheld" }] }))).toEqual([]);
    });
  });

  describe("datapackage の frames と frameCounts", () => {
    it("写しを書いた項目に frames が無ければ error", async () => {
      const { frames: _dropped, ...entry } = snapshotEntry();
      const issues = await run(archive({ snapshots: [entry] }));
      expect(issues[0]).toEqual(bad("frames", { stage: STAGE, found: "undefined" }, DATAPACKAGE));
      // 名指されなくなった子の写しも残る。
      expect(issues.slice(1).map((i) => [i.messageKey, i.params?.["url"]])).toEqual(
        CHILDREN.map((c) => [`${RULE}.unlisted`, uriOf(c.frame, c.doc)]),
      );
    });

    it("frameCounts の member が数でなければ error", async () => {
      expect(await run(archive({ snapshots: [snapshotEntry({ frameCounts: { read: 4, unreadable: "1", withheld: 1 } })] }))).toEqual([
        bad("counts", { stage: STAGE, member: "frameCounts.unreadable", found: '"1"' }, DATAPACKAGE),
      ]);
    });

    it("frame が 1 以上の整数でなければ error", async () => {
      expect(await run(archive({ snapshots: framesWith(3, (e) => ({ ...e, frame: 0 })) }))).toEqual([
        bad("entry", { stage: STAGE, at: "frames[3]", member: "frame", found: "0" }, DATAPACKAGE),
      ]);
    });

    it("番号が並びの順に 1 つずつでなければ error", async () => {
      expect(await run(archive({ snapshots: framesWith(3, (e) => ({ ...e, frame: 5 })) }))).toEqual([
        bad("number", { stage: STAGE, at: "frames[3]", found: "5", expected: "4" }, DATAPACKAGE),
      ]);
    });

    it("親が前の子かその祖先でなければ error —— 子 4 の親を、閉じた枝の子 2 にした", async () => {
      // 子 2 は子 1 の下。子 4 の前は子 3 で、その祖先は主だけなので、前順の並びでは子 2 は子 4 の親になれない。
      expect(await run(archive({ snapshots: framesWith(3, (e) => ({ ...e, parent: 2 })) }))).toEqual([
        bad("parent", { stage: STAGE, frame: "4", parent: "2" }, DATAPACKAGE),
      ]);
    });

    /** 子 1 を `reason` で書かなかった archive。子 1 の記録も、主の写しの子 1 の属性も無い。 */
    const withoutChild1 = (reason: string, counts: Record<string, number> = FRAME_COUNTS): FixtureOptions => {
      const body = html(DOC, frameTag("a.html") + frameTag("b.html?x=1&amp;y=2", uriOf(3, DOC_3)) + frameTag("ad.html"));
      return archive({
        warcResources: [mainResource(body), resourceOf(C2), resourceOf(C3)],
        warcMetadata: [mainMetadata, metadataOf(C2), metadataOf(C3)],
        snapshots: [
          snapshotEntry({
            bytes: Buffer.byteLength(body),
            frames: [{ frame: 1, parent: 0, skipped: reason }, frameEntryOf(C2), frameEntryOf(C3), SKIPPED_4],
            frameCounts: counts,
          }),
        ],
      });
    };

    it("書かなかった子（too-large）の下に書いた子が在ってよい —— 親の写しが無いので、子を名指す属性も無い", async () => {
      expect(await run(withoutChild1("too-large"))).toEqual([]);
    });

    it("伏せた子（withheld）の下の子を書けば error —— 伏せた文書の中の枠は写さない", async () => {
      expect(await run(withoutChild1("withheld", { read: 4, unreadable: 1, withheld: 2 }))).toEqual([
        bad("withheld-descendant", { stage: STAGE, frame: "2", parent: "1" }, DATAPACKAGE),
      ]);
    });

    it("書かなかった子の項目が frame・parent・skipped のほかを持てば error", async () => {
      expect(await run(archive({ snapshots: framesWith(3, (e) => ({ ...e, url: uriOf(4, "https://site.test/ad.html") })) }))).toEqual([
        bad("skipped-members", { stage: STAGE, frame: "4", members: "url" }, DATAPACKAGE),
      ]);
    });

    it("写しを撮らなかった時点の項目が frames を持てば error", async () => {
      const options = archive({ warcResources: [], warcMetadata: [], pageEntries: [DOC_ROW], snapshots: [{ stage: STAGE, skipped: "withheld", frames: [] }] });
      expect(await run(options)).toEqual([bad("stage-frames", { stage: STAGE, member: "frames" }, DATAPACKAGE)]);
    });

    it("frameCounts.withheld が skipped: withheld の項目の数でなければ error", async () => {
      expect(await run(archive({ snapshots: [snapshotEntry({ frameCounts: { ...FRAME_COUNTS, withheld: 0 } })] }))).toEqual([
        bad("withheld-count", { stage: STAGE, found: "0", expected: "1" }, DATAPACKAGE),
      ]);
    });

    it("frameCounts.read がほかの項目の数より少なければ error。多いのは、項目を持たない枠（about:blank など）の分", async () => {
      expect(await run(archive({ snapshots: [snapshotEntry({ frameCounts: { ...FRAME_COUNTS, read: 2 } })] }))).toEqual([
        bad("read-count", { stage: STAGE, found: "2", items: "3" }, DATAPACKAGE),
      ]);
      expect(await run(archive({ snapshots: [snapshotEntry({ frameCounts: { ...FRAME_COUNTS, read: 3 } })] }))).toEqual([]);
    });

    it("書かなかった理由が 4 つのどれでもなければ error", async () => {
      // 伏せた子が無くなるので、frameCounts.withheld も 0 に。
      const frames = [...CHILDREN.map(frameEntryOf), { ...SKIPPED_4, skipped: "cross-origin" }];
      expect(await run(archive({ snapshots: [snapshotEntry({ frames, frameCounts: { ...FRAME_COUNTS, withheld: 0 } })] }))).toEqual([
        bad("skipped", { stage: STAGE, frame: "4", found: "cross-origin" }, DATAPACKAGE),
      ]);
    });
  });

  describe("子の写しの組", () => {
    it("url の番号が frame と違えば error", async () => {
      expect(await run(archive({ snapshots: framesWith(2, (e) => ({ ...e, url: uriOf(2, DOC_3) })) }))).toEqual([
        bad("url", { stage: STAGE, frame: "3", url: uriOf(2, DOC_3) }, DATAPACKAGE),
        bad("mismatch", { stage: STAGE, frame: "3", where: "frames", field: "url", found: uriOf(2, DOC_3), other: "resource", otherField: "WARC-Target-URI", expected: uriOf(3, DOC_3) }, DATAPACKAGE),
        // 主の写しの属性は子 3 の本当の URI を名指したまま。
        expect.objectContaining({ messageKey: `${RULE}.attribute-stray` }),
        expect.objectContaining({ messageKey: `${RULE}.attribute-missing` }),
      ]);
    });

    it("record の名指す resource が無ければ error", async () => {
      const resources = [mainResource(), resourceOf(C1), resourceOf(C2)];
      const { issues } = await runAt(archive({ warcResources: resources }), MAIN_URI);
      expect(issues).toEqual([bad("no-resource", { stage: STAGE, frame: "3", record: C3.record }, DATAPACKAGE)]);
    });

    it("bytes が resource の Content-Length と違えば error", async () => {
      expect(await run(archive({ snapshots: framesWith(1, (e) => ({ ...e, bytes: 1 })) }))).toEqual([
        bad("mismatch", { stage: STAGE, frame: "2", where: "frames", field: "bytes", found: "1", other: "resource", otherField: "Content-Length", expected: String(Buffer.byteLength(C2.body)) }, DATAPACKAGE),
      ]);
    });

    it("resource の Content-Type が text/html; charset=utf-8 でなければ error", async () => {
      const options = archive({ warcResources: resourcesWith(C2, { contentType: "text/plain" }) });
      const { issues, location } = await runAt(options, uriOf(2, DOC_2));
      expect(issues).toEqual([bad("content-type", { stage: STAGE, frame: "2", url: uriOf(2, DOC_2), found: "text/plain" }, location)]);
    });

    it("metadata が無ければ error", async () => {
      const options = archive({ warcMetadata: [mainMetadata, metadataOf(C1), metadataOf(C3)] });
      const { issues, location } = await runAt(options, uriOf(2, DOC_2));
      expect(issues).toEqual([bad("no-metadata", { stage: STAGE, frame: "2", url: uriOf(2, DOC_2) }, location)]);
    });

    it("resource を指す metadata が 2 つあれば error", async () => {
      const options = archive({ warcMetadata: [mainMetadata, ...CHILDREN.map((c) => metadataOf(c)), metadataOf(C2)] });
      const { issues, location } = await runAt(options, uriOf(2, DOC_2));
      expect(issues).toEqual([bad("metadata-repeated", { stage: STAGE, frame: "2", url: uriOf(2, DOC_2), count: "2" }, location)]);
    });

    it("URI の URL が document-uri から fragment を除いた物でなければ error。fragment は除いて比べる", async () => {
      const withDocumentUri = (documentUri: string): FixtureOptions =>
        archive({ warcMetadata: [mainMetadata, metadataOf(C1), metadataOf(C2), metadataOf(C3, { ...fieldsOf(C3), "document-uri": documentUri })] });
      expect(await run(withDocumentUri(`${DOC_3}#top`))).toEqual([]);
      const issues = await run(withDocumentUri("https://site.test/b.html"));
      expect(issues.map((i) => [i.messageKey, i.params?.["documentUri"]])).toEqual([[`${RULE}.document-uri`, "https://site.test/b.html"]]);
    });

    it("document-record が archive の response を名指さなければ error。名指せば通り、無くてもよい", async () => {
      const DELIVERED = "urn:uuid:9d4c0e7a-6b1f-4d5c-9e0a-5f6a7b8c9d0e";
      const withDocumentRecord = (record: string): FixtureOptions =>
        archive({
          warcResponses: [{ uri: DOC_3, mime: "text/html", body: "<p>right</p>", recordId: `<${DELIVERED}>` }],
          warcMetadata: [mainMetadata, metadataOf(C1), metadataOf(C2), metadataOf(C3, { ...fieldsOf(C3), "document-record": record })],
        });
      expect(await run(withDocumentRecord(`<${DELIVERED}>`))).toEqual([]);
      const missing = "<urn:uuid:00000000-0000-0000-0000-000000000000>";
      const issues = await run(withDocumentRecord(missing));
      expect(issues.map((i) => [i.messageKey, i.params?.["record"]])).toEqual([[`${RULE}.document-record`, missing]]);
    });

    it("resource が WARC-Concurrent-To を持てば error —— 子の写しは交信の一部ではない", async () => {
      // 主の本の記録: warcinfo・主の写し・子 1・子 2・子 3・metadata ×4。2 番目が子 1 の resource。
      const options = archive({ warcRecordPatches: [{ index: 2, set: { "WARC-Concurrent-To": `<${C3.record}>` } }] });
      const { issues, location } = await runAt(options, uriOf(1, DOC_1));
      expect(issues).toEqual([bad("concurrent-to", { stage: STAGE, frame: "1", url: uriOf(1, DOC_1), type: "resource" }, location)]);
    });

    it("metadata の parent の欄が項目の parent と違えば error", async () => {
      const options = archive({ warcMetadata: [mainMetadata, metadataOf(C1), metadataOf(C2, { ...fieldsOf(C2), parent: "0" }), metadataOf(C3)] });
      expect((await run(options)).map((i) => [i.messageKey, i.params?.["field"]])).toEqual([[`${RULE}.mismatch`, "parent"]]);
    });

    it("metadata の frame の欄が項目の frame と違えば error", async () => {
      const options = archive({ warcMetadata: [mainMetadata, metadataOf(C1, { ...fieldsOf(C1), frame: "2" }), metadataOf(C2), metadataOf(C3)] });
      expect((await run(options)).map((i) => [i.messageKey, i.params?.["field"]])).toEqual([[`${RULE}.mismatch`, "frame"]]);
    });

    it("secretsReplaced が metadata の secrets-replaced と違えば error", async () => {
      expect((await run(archive({ snapshots: framesWith(0, (e) => ({ ...e, secretsReplaced: 0 })) }))).map((i) => [i.messageKey, i.params?.["field"]])).toEqual([
        [`${RULE}.mismatch`, "secretsReplaced"],
      ]);
    });

    it("子の写しに script の要素が在れば error", async () => {
      const body = html(DOC_3, "<p>right</p><script>alert(1)</script>");
      const options = archive({
        warcResources: resourcesWith(C3, { body }),
        snapshots: framesWith(2, (e) => ({ ...e, bytes: Buffer.byteLength(body) })),
      });
      const { issues, location } = await runAt(options, uriOf(3, DOC_3));
      expect(issues).toEqual([bad("script", { stage: STAGE, frame: "3", url: uriOf(3, DOC_3) }, location)]);
    });
  });

  describe("親の写しの属性と子の対応", () => {
    it("親の写しから子の属性を消せば error —— 入れ子の子 2 の親は子 1", async () => {
      const body = html(DOC_1, `<h1>menu</h1>${frameTag("inner.html")}`);
      const options = archive({
        warcResources: resourcesWith(C1, { body }),
        snapshots: framesWith(0, (e) => ({ ...e, bytes: Buffer.byteLength(body) })),
      });
      const { issues, location } = await runAt(options, uriOf(1, DOC_1));
      expect(issues).toEqual([bad("attribute-missing", { stage: STAGE, frame: "2", url: uriOf(2, DOC_2), parent: uriOf(1, DOC_1) }, location)]);
    });

    it("主の写しから子の属性を消せば error —— 子 1 の親は主", async () => {
      const body = html(DOC, frameTag("a.html") + frameTag("b.html?x=1&amp;y=2", uriOf(3, DOC_3)) + frameTag("ad.html"));
      const options = archive({ warcResources: [mainResource(body), ...CHILDREN.map((c) => resourceOf(c))] });
      const { issues, location } = await runAt(options, MAIN_URI);
      expect(issues).toEqual([bad("attribute-missing", { stage: STAGE, frame: "1", url: uriOf(1, DOC_1), parent: MAIN_URI }, location)]);
    });

    it("書かなかった子の枠に属性を付ければ error", async () => {
      const ad = uriOf(4, "https://site.test/ad.html");
      const body = html(DOC, frameTag("a.html", uriOf(1, DOC_1)) + frameTag("b.html?x=1&amp;y=2", uriOf(3, DOC_3)) + frameTag("ad.html", ad));
      const options = archive({ warcResources: [mainResource(body), ...CHILDREN.map((c) => resourceOf(c))] });
      const { issues, location } = await runAt(options, MAIN_URI);
      expect(issues).toEqual([bad("attribute-stray", { stage: STAGE, url: MAIN_URI, value: ad }, location)]);
    });

    it("孫の属性を主の写しに付ければ error —— 子 2 の親は子 1 で、主ではない", async () => {
      const body = MAIN_BODY.replace("</body>", `${frameTag("inner.html", uriOf(2, DOC_2))}</body>`);
      const options = archive({ warcResources: [mainResource(body), ...CHILDREN.map((c) => resourceOf(c))] });
      const { issues, location } = await runAt(options, MAIN_URI);
      expect(issues).toEqual([bad("attribute-stray", { stage: STAGE, url: MAIN_URI, value: uriOf(2, DOC_2) }, location)]);
    });

    it("属性が frame・iframe でない要素に在れば error", async () => {
      const body = MAIN_BODY.replace(frameTag("a.html", uriOf(1, DOC_1)), frameTag("a.html", uriOf(1, DOC_1), "embed"));
      const options = archive({ warcResources: [mainResource(body), ...CHILDREN.map((c) => resourceOf(c))] });
      const { issues, location } = await runAt(options, MAIN_URI);
      expect(issues).toEqual([
        bad("attribute-element", { stage: STAGE, url: MAIN_URI, element: "embed", value: uriOf(1, DOC_1) }, location),
      ]);
    });

    it("frame の要素（frameset の枠）の属性も読む", async () => {
      const body = html(DOC, `<frameset cols="30%,70%">${frameTag("a.html", uriOf(1, DOC_1), "frame")}${frameTag("b.html?x=1&amp;y=2", uriOf(3, DOC_3), "frame")}</frameset>`);
      const options = archive({ warcResources: [mainResource(body), ...CHILDREN.map((c) => resourceOf(c))] });
      expect(await run(options)).toEqual([]);
    });

    it("コメントの中の属性は数えない", async () => {
      const body = MAIN_BODY.replace("</body>", `<!-- ${frameTag("x.html", uriOf(9, "https://site.test/x.html"))} --></body>`);
      const options = archive({ warcResources: [mainResource(body), ...CHILDREN.map((c) => resourceOf(c))] });
      expect(await run(options)).toEqual([]);
    });
  });

  describe("名指されない子・ページ一覧・索引", () => {
    it("datapackage から子を消せば、名指されない子の写しとして error", async () => {
      // 子 3 を frames から落とし、番号を詰める（伏せた子が 3 になる）。主の写しの子 3 の属性も、名指す子を失う。
      const frames = [frameEntryOf(C1), frameEntryOf(C2), { ...SKIPPED_4, frame: 3 }];
      const options = archive({ snapshots: [snapshotEntry({ frames })] });
      const { report, records } = await reportOf(options);
      const issues = report.issues.filter((i) => i.rule === RULE);
      expect(issues.map((i) => i.messageKey)).toEqual([`${RULE}.attribute-stray`, `${RULE}.unlisted`]);
      expect(issues.at(-1)).toEqual(
        bad("unlisted", { url: uriOf(3, DOC_3), record: `<${C3.record}>` }, resourceAt(records, options, uriOf(3, DOC_3))),
      );
    });

    it("子の写しをページ一覧に足せば error", async () => {
      const row = { id: "task-1-frame-1", url: uriOf(1, DOC_1), ts: DATE, title: "menu" };
      expect(await run(archive({ pageEntries: [DOC_ROW, SNAPSHOT_ROW, row] }))).toEqual([
        bad("in-pages", { url: uriOf(1, DOC_1) }, { entry: PAGES, line: 4 }),
      ]);
    });

    it("子の写しの行が索引に無ければ error", async () => {
      expect(await run(archive({ warcResources: resourcesWith(C2, { omitIndex: true }) }))).toEqual([
        bad("not-indexed", { stage: STAGE, frame: "2", url: uriOf(2, DOC_2) }, { entry: INDEX }),
      ]);
    });
  });

  describe("走る範囲", () => {
    it("WACZ Profile 1.26.0 を名乗る archive には当てない", async () => {
      const { frames: _dropped, ...entry } = snapshotEntry();
      const broken = archive({ conformsTo: WACZ_1_26, snapshots: [entry] });
      expect(await run(broken)).toEqual([]);
      // 同じ archive でも 1.27.0 を名乗れば落ちる。黙ったのは版のせいで、形のせいではない。
      expect((await run({ ...broken, conformsTo: WACZ_1_27 })).map((i) => i.messageKey)).toContain(`${RULE}.frames`);
    });

    it("archive が版を名乗らなければ当てない", async () => {
      const { conformsTo: _dropped, ...unnamed } = archive({ snapshots: [snapshotEntry({ frames: "none" })] });
      expect(await run(unnamed)).toEqual([]);
    });

    it("spec の profile では走らない", async () => {
      expect(await run(archive({ snapshots: [snapshotEntry({ frames: "none" })] }), { name: "spec" })).toEqual([]);
    });
  });
});
