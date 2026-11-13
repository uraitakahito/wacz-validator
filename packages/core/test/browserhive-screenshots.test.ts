// @module-tag engine
/**
 * `browserhive/screenshots` のテスト。
 *
 * 守っている主張は WACZ Profile 1.24.0 の screenshots・Archive files（索引の段落）と、BrowserHive WARC Profile 1.3.0 の
 * Screenshots。取り込みが時点ごとに撮ったスクリーンショットは、datapackage の screenshots の項目・WARC の resource と
 * metadata の組・索引の行のどこから読んでも同じ物を指し、絵に写りうる物を残さないと頼まれた取り込みの package は絵を
 * 持たず、絵は WebP の静止画。
 *
 * 標本は、正しい archive（2 つの時点の絵を持つ `archive()`、after-load だけの `onlyAfterLoad()`、どの時点の絵も持たない
 * `skippedOnly()`）から 1 か所だけを崩して作る。崩した 1 か所を、狙った鍵 1 つだけが言うことを見る —— rule が
 * その 1 か所を見ていることを、区別できる入力で確かめるため。
 *
 * 画像は cwebp・webpmux で作った本物の WebP（単色）。rule は頭しか読まないが、頭を手で組んだ物ではなく、
 * encoder の書いたバイト列で確かめる。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProfileSelector } from "@wacz-validator/contract";
import {
  SCREENSHOT_RATIO,
  SCREENSHOT_SIZE,
  parseScreenshotUri,
  readWebpStill,
  sameAspect,
} from "../src/validate/browserhive-screenshot.js";
import { parseReportSource, type Issue, type IssueLocation, type Report } from "../src/validate/domain.js";
import { runValidation } from "../src/validate/engine.js";
import { DEFAULT_RULES } from "../src/validate/rules/index.js";
import { sha256Base32 } from "../src/wacz/digest.js";
import { fileTransport } from "../src/wacz/transport.js";
import { WaczReader } from "../src/wacz/reader.js";
import {
  buildWacz,
  responseRecordId,
  type FixtureOptions,
  type WarcMetadataSpec,
  type WarcRecordInfo,
  type WarcResourceSpec,
} from "./fixtures/generator.js";
import { firedWarc11Rules } from "./fixtures/warc11.js";

const RULE = "browserhive/screenshots";
const WACZ_1_23 = "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.23.0/";
const WACZ_1_24 = "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.24.0/";
const DATAPACKAGE: IssueLocation = { entry: "datapackage.json" };
const INDEX = "indexes/index.cdxj";
const MAIN = "archive/data.warc.gz";

/** 絵が写した文書の URL。時点 B の前に、取り込みのページが History API で URL を替えた（文書は同じ）。 */
const DOC_A = "https://site.test/";
const DOC_B = "https://site.test/results";

// ---- 本物の WebP（単色）。名前は「種類・幅 x 高さ」。 ----
const webp = (base64: string): Buffer => Buffer.from(base64, "base64");
/** lossless（`VP8L`）1280x800。 */
const LOSSLESS_1280_800 = webp(
  "UklGRlAAAABXRUJQVlA4TEMAAAAv/8THAAdQ5CIXuf8BAUnS//2BEf3P+M9//vOf//znP//5z3/+85///Oc///nPf/7zn//85z//+c9//vOf//zn/x0AAA==",
);
/** lossy（`VP8 `）16x10。 */
const LOSSY_16_10 = webp("UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoQAAoAD8D+JaQAA3AA/tXYAAA=");
/** extended（`VP8X`）の静止画 1280x800（EXIF つき）。 */
const EXTENDED_1280_800 = webp(
  "UklGRnoAAABXRUJQVlA4WAoAAAAIAAAA/wQAHwMAVlA4TEMAAAAv/8THAAdQ5CIXuf8BAUnS//2BEf3P+M9//vOf//znP//5z3/+85///Oc///nPf/7zn//85z//+c9//vOf//zn/x0AAEVYSUYQAAAARXhpZgAASUkqAAgAAAAAAA==",
);
/** extended（`VP8X`）の animation 2x1（2 コマ）。 */
const ANIMATED_2_1 = webp(
  "UklGRogAAABXRUJQVlA4WAoAAAACAAAAAQAAAAAAQU5JTQYAAAD/////AABBTk1GKgAAAAAAAAAAAAEAAAAAAGQAAABWUDhMEQAAAC8BAAAAB1DkIhe5/4GI6H8AAEFOTUYqAAAAAAAAAAAAAQAAAAAAZAAAAFZQOEwRAAAALwEAAAAHUOQiF7n/gYjofwAA",
);
/** lossless 1280x801 —— viewport 1280x800 と、丸めの内の違い。 */
const LOSSLESS_1280_801 = webp(
  "UklGRlAAAABXRUJQVlA4TEMAAAAv/wTIAAdQ5CIXuf8BAUnS//2BEf3P+M9//vOf//znP//5z3/+85///Oc///nPf/7zn//85z//+c9//vOf//zn/70AAA==",
);
/** lossless 1280x803 —— 丸めを超える違い。 */
const LOSSLESS_1280_803 = webp(
  "UklGRlAAAABXRUJQVlA4TEMAAAAv/4TIAAdQ5CIXuf8BAUnS//2BEf3P+M9//vOf//znP//5z3/+85///Oc///nPf/7zn//85z//+c9//vOf//zn//0BAA==",
);
/** lossless 1280x2400 —— viewport の先まで写した絵の形。 */
const LOSSLESS_1280_2400 = webp(
  "UklGRqQAAABXRUJQVlA4TJcAAAAv/8RXAgdQ5CIXuf8BAEX6/58i+p/63//+97///e9///vf//73v//973//+9///ve///3vf//73//+97///e9///vf//73v//973//+9///ve///3vf//73//+97///e9///vf//73v//973//+9///ve///3vf//73//+97///e9///vf//73v//973//+9///ve//7cAAA==",
);
/** PNG の頭。WebP ではない。 */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);

/** スクリーンショット 1 枚の、archive のあちこちに現れる値。 */
interface Shot {
  readonly stage: "after-load" | "after-behaviors";
  /** resource と metadata の `WARC-Target-URI`。 */
  readonly url: string;
  readonly date: string;
  /** `WARC-Record-ID` の中の URI（山括弧なし）。 */
  readonly record: string;
  readonly body: Buffer;
  readonly documentUri: string;
  readonly viewport: string;
  readonly devicePixelRatio: string;
  readonly imageSize: string;
}

const A: Shot = {
  stage: "after-load",
  url: `urn:browserhive:screenshot:after-load:${DOC_A}`,
  date: "2026-11-02T01:20:05.204Z",
  record: "urn:uuid:0b6f7c1e-5a2d-4e83-b9f0-3c4d5e6f7a8b",
  body: LOSSLESS_1280_800,
  documentUri: DOC_A,
  viewport: "1280x800",
  devicePixelRatio: "1",
  imageSize: "1280x800",
};
/** 密度 2 の表示のために描いた取り込みのページを、小さな lossy の絵に撮った形。`document-uri` は fragment を持つ。 */
const B: Shot = {
  stage: "after-behaviors",
  url: `urn:browserhive:screenshot:after-behaviors:${DOC_B}`,
  date: "2026-11-02T01:20:07.512Z",
  record: "urn:uuid:8f3a1c7e-52d4-4b9a-b6e0-1d7c9a4f2e35",
  body: LOSSY_16_10,
  documentUri: `${DOC_B}#top`,
  viewport: "1280x800",
  devicePixelRatio: "2",
  imageSize: "16x10",
};

const resourceOf = (s: Shot): WarcResourceSpec => ({
  uri: s.url,
  date: s.date,
  recordId: `<${s.record}>`,
  body: s.body,
  contentType: "image/webp",
});
const fieldsOf = (s: Shot): Record<string, string> => ({
  screenshot: s.stage,
  "document-uri": s.documentUri,
  viewport: s.viewport,
  "device-pixel-ratio": s.devicePixelRatio,
  "image-size": s.imageSize,
});
const metadataOf = (s: Shot): WarcMetadataSpec => ({ uri: s.url, date: s.date, refersTo: `<${s.record}>`, fields: fieldsOf(s) });
const entryOf = (s: Shot): Record<string, unknown> => ({
  stage: s.stage,
  url: s.url,
  date: s.date,
  record: s.record,
  bytes: s.body.byteLength,
});
const skippedAs = (reason: string): Record<string, unknown>[] => [
  { stage: "after-load", skipped: reason },
  { stage: "after-behaviors", skipped: reason },
];

/** スクリプトが 1 本走り、シークレットも方針も無い取り込みの settings。`over` で 1 つを替える。 */
const settingsWith = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  behaviors: [{ name: "search" }],
  secrets: [],
  urlPolicies: [],
  contentTypePolicies: [],
  ...over,
});
/** 取り込みに渡したシークレットの名前（値ではない）。 */
const hidden = ["api_token"];

/** 2 つの時点の絵を持つ archive（スクリプトが 1 本走った取り込み）。`over` で 1 か所を崩す。 */
const archive = (over: Partial<FixtureOptions> = {}): FixtureOptions => ({
  software: "browserhive/31.0.0",
  conformsTo: WACZ_1_24,
  settings: settingsWith(),
  warcResources: [resourceOf(A), resourceOf(B)],
  warcMetadata: [metadataOf(A), metadataOf(B)],
  screenshots: [entryOf(A), entryOf(B)],
  ...over,
});

/** スクリプトの無い取り込みが、after-load の絵だけを持つ archive。 */
const onlyAfterLoad = (over: Partial<FixtureOptions> = {}, shot: Shot = A): FixtureOptions =>
  archive({
    settings: settingsWith({ behaviors: [] }),
    warcResources: [resourceOf(shot)],
    warcMetadata: [metadataOf(shot)],
    screenshots: [entryOf(shot)],
    ...over,
  });

/** どの時点の絵も持たない archive。2 つの項目が同じ理由を持つ。 */
const skippedOnly = (reason: string, over: Partial<FixtureOptions> = {}): FixtureOptions => ({
  software: "browserhive/31.0.0",
  conformsTo: WACZ_1_24,
  settings: settingsWith(),
  screenshots: skippedAs(reason),
  ...over,
});

// ---- 方針が要求に当たったことを言うレコード ----
const HERO = "https://cdn.test/hero.png";
/** `no-archive` で残さなかった要求のレコード。`resourceType` を渡さなければ欄ごと書かない。 */
const notArchived = (resourceType?: string, action = "no-archive"): WarcMetadataSpec => ({
  uri: HERO,
  fields: { action, pattern: "*://cdn.test/*", method: "GET", ...(resourceType !== undefined && { resourceType }) },
});
/** 本文を残さなかった応答（`warcResponses` の 0 番目）のレコード。 */
const bodyNotKept = (truncated = "url-policy"): WarcMetadataSpec => ({
  uri: HERO,
  refersTo: responseRecordId(0),
  fields: { truncated },
});
/** その応答を `record` で名指す trace の行。`resourceType` を渡さなければ member ごと書かない。 */
const traceLine = (resourceType?: string, record = responseRecordId(0).slice(1, -1)): Record<string, unknown> => ({
  profile: "browserhive:trace/1",
  kind: "request",
  id: "1234.56",
  hop: 0,
  url: HERO,
  method: "GET",
  ...(resourceType !== undefined && { resourceType }),
  startedAt: "2026-05-13T00:00:00Z",
  ms: 12,
  outcome: "finished",
  record,
});
/** `no-body` の方針が当たった応答を持つ archive の部品。`trace` は行の並び（`undefined` ならエントリごと無い）。 */
const noBody = (
  metadata: readonly WarcMetadataSpec[],
  trace: Record<string, unknown>[] | undefined,
  truncated = "url-policy",
): Partial<FixtureOptions> => ({
  warcResponses: [{ uri: HERO, mime: "image/png", body: "" }],
  warcMetadata: [...metadata, bodyNotKept(truncated)],
  ...(trace !== undefined && { trace }),
});

/**
 * 絵を持ってはならない package の条件のうち、`settings.secrets` の後ろの 4 つ。`because` は rule が理由を言う字で、
 * `over` は、絵の metadata（`shots`）に条件を足した archive の部品。
 */
const WITHHELD_CONDITIONS: readonly (readonly [string, string, (shots: readonly WarcMetadataSpec[]) => Partial<FixtureOptions>])[] = [
  [
    "media type の方針を持つ",
    "settings.contentTypePolicies",
    () => ({ settings: settingsWith({ contentTypePolicies: [{ prefix: "video/", action: "no-body" }] }) }),
  ],
  ["document が withheld を持つ", "document.withheld", () => ({ document: { url: DOC_B, withheld: "url-policy" } })],
  ["no-archive の方針が画像の要求に当たった", "action: no-archive", (shots) => ({ warcMetadata: [...shots, notArchived("Image")] })],
  ["no-body の方針が画像の要求に当たった", "truncated: url-policy", (shots) => noBody(shots, [traceLine("Image")])],
];

const bad = (
  messageKey: string,
  params: Record<string, string | number>,
  location: IssueLocation,
  severity: "error" | "warning" = "error",
): Issue => ({ rule: RULE, severity, messageKey: `${RULE}.${messageKey}`, params, location });

/** 値を比べて落ちた 1 件。`where` の `field` が `found`、`other` の `otherField` が `expected`。 */
const mismatch = (
  shot: string,
  [where, field, found]: readonly [string, string, string],
  [other, otherField, expected]: readonly [string, string, string],
  location: IssueLocation,
): Issue => bad("mismatch", { shot, where, field, found, other, otherField, expected }, location);

/** 絵を持つ項目の数と、スクリーンショットの resource の数（`forbidden-*` の文に入る）。 */
const held = (entries: number, records: number): Record<string, number> => ({ entries, records });

/** 主の本の中の、`n` 番目（0 始まり）の `type` のレコードの位置。 */
const at = (records: readonly WarcRecordInfo[], type: WarcRecordInfo["type"], n = 0): IssueLocation => {
  const found = records.filter((r) => r.type === type)[n];
  if (found === undefined) throw new Error(`no ${type} record #${String(n)}`);
  return { entry: MAIN, offset: found.offset };
};

describe("スクリーンショットのレコードを読む部品", () => {
  describe("readWebpStill —— WebP の頭から、静止画かどうかと幅・高さを読む", () => {
    it.each([
      ["lossless（VP8L）", LOSSLESS_1280_800, 1280, 800],
      ["lossy（VP8）", LOSSY_16_10, 16, 10],
      ["extended（VP8X）の静止画", EXTENDED_1280_800, 1280, 800],
      ["縦に長い lossless", LOSSLESS_1280_2400, 1280, 2400],
      ["高さが 1 だけ違う lossless", LOSSLESS_1280_801, 1280, 801],
    ])("%s は静止画で、幅と高さが読める", (_name, bytes, width, height) => {
      expect(readWebpStill(bytes)).toEqual({ kind: "still", width, height });
    });

    it("animation の旗が立った VP8X は静止画ではない", () => {
      expect(readWebpStill(ANIMATED_2_1)).toEqual({ kind: "animated" });
    });

    it.each([
      ["PNG", PNG],
      ["空", Buffer.alloc(0)],
      ["頭の 12 バイトだけ", LOSSLESS_1280_800.subarray(0, 12)],
      ["途中で切れた画像（RIFF の名乗る長さより短い）", LOSSLESS_1280_800.subarray(0, 40)],
      ["RIFF の字が違う", Buffer.concat([Buffer.from("RIFX"), LOSSLESS_1280_800.subarray(4)])],
      ["WEBP の字が違う", Buffer.concat([Buffer.from("RIFF"), LOSSLESS_1280_800.subarray(4, 8), Buffer.from("WAVE"), LOSSLESS_1280_800.subarray(12)])],
      ["最初の chunk が画像でない", Buffer.concat([LOSSLESS_1280_800.subarray(0, 12), Buffer.from("EXIF"), LOSSLESS_1280_800.subarray(16)])],
      ["VP8L の signature が違う", Buffer.concat([LOSSLESS_1280_800.subarray(0, 20), Buffer.from([0x00]), LOSSLESS_1280_800.subarray(21)])],
      ["VP8 の start code が違う", Buffer.concat([LOSSY_16_10.subarray(0, 23), Buffer.from([0x00]), LOSSY_16_10.subarray(24)])],
    ])("%s は WebP として読めない", (_name, bytes) => {
      expect(readWebpStill(bytes)).toEqual({ kind: "not-webp" });
    });

    it("後ろに余りのバイトが在っても読む（WebP の読み手は余りを無視してよい）", () => {
      expect(readWebpStill(Buffer.concat([LOSSY_16_10, Buffer.from("tail")]))).toEqual({ kind: "still", width: 16, height: 10 });
    });
  });

  describe("欄の書式（仕様の ABNF）", () => {
    it.each(["1280x800", "1x1", "10x20000"])("size: %s は通る", (value) => {
      expect(SCREENSHOT_SIZE.test(value)).toBe(true);
    });
    it.each(["0800x0", "1280X800", "1280x0", "0x800", "1280x", "x800", "1280", "1280x800x2", " 1280x800", "1280 x 800", "1280.0x800", ""])(
      "size: %s は通らない",
      (value) => {
        expect(SCREENSHOT_SIZE.test(value)).toBe(false);
      },
    );
    it.each(["1", "2", "1.5", "0.5", "10", "1.05", "2.625", "0.05"])("ratio: %s は通る", (value) => {
      expect(SCREENSHOT_RATIO.test(value)).toBe(true);
    });
    it.each(["2.0", "1.50", "02", "0", "0.0", "0.50", "1.", ".5", "1e2", "-1", "+2", "2x", " 2", ""])("ratio: %s は通らない", (value) => {
      expect(SCREENSHOT_RATIO.test(value)).toBe(false);
    });
  });

  describe("parseScreenshotUri", () => {
    it("時点と文書の URL に分ける。URL の中のコロンは URL の物", () => {
      expect(parseScreenshotUri(`urn:browserhive:screenshot:after-behaviors:${DOC_B}`)).toEqual({ stage: "after-behaviors", url: DOC_B });
    });
    it.each([
      ["写しの URI", `urn:browserhive:snapshot:after-load:${DOC_A}`],
      ["この版の定めない時点", `urn:browserhive:screenshot:full-page:${DOC_A}`],
      ["時点の後ろのコロンが無い", "urn:browserhive:screenshot:after-load"],
      ["URL が空", "urn:browserhive:screenshot:after-load:"],
    ])("%s は読めない", (_name, uri) => {
      expect(parseScreenshotUri(uri)).toBeUndefined();
    });
  });

  describe("sameAspect —— 縦横の比が、pixel への丸めを除いて同じか", () => {
    const viewport = { width: 1280, height: 800 };
    it.each([
      [1280, 800],
      [16, 10],
      [2560, 1600],
      [1280, 801],
      [1281, 800],
      [639, 400],
    ])("%d x %d は viewport 1280x800 と同じ比", (width, height) => {
      expect(sameAspect({ width, height }, viewport)).toBe(true);
    });
    it.each([
      [1280, 803],
      [1280, 2400],
      [1280, 720],
      [800, 1280],
    ])("%d x %d は viewport 1280x800 と違う比", (width, height) => {
      expect(sameAspect({ width, height }, viewport)).toBe(false);
    });
  });
});

describe("browserhive/screenshots", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "wacz-validator-screenshots-"));
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
  /** この rule の issue と、主の本のレコードの位置。 */
  const runWith = async (options: FixtureOptions): Promise<{ issues: Issue[]; records: WarcRecordInfo[] }> => {
    const { report, records } = await reportOf(options);
    return { issues: report.issues.filter((i) => i.rule === RULE), records };
  };

  describe("通す形", () => {
    it("2 つの時点の絵を持つ archive には何も言わない（lossless と lossy）", async () => {
      expect(await run(archive())).toEqual([]);
    });

    it("スクリプトの無い取り込みが after-load の絵だけを持つ archive には何も言わない", async () => {
      expect(await run(onlyAfterLoad())).toEqual([]);
    });

    it("extended（VP8X）の静止画も通す", async () => {
      expect(await run(onlyAfterLoad({}, { ...A, body: EXTENDED_1280_800 }))).toEqual([]);
    });

    it("シークレットも方針も無い取り込みでは、絵を持たない理由は secret のほかの 4 つのどれでもよい", async () => {
      for (const reason of ["disabled", "withheld", "task-budget", "failed"]) {
        expect(await run(skippedOnly(reason)), reason).toEqual([]);
      }
    });

    it("シークレットを渡された取り込みでは、理由は disabled か secret", async () => {
      for (const reason of ["disabled", "secret"]) {
        expect(await run(skippedOnly(reason, { settings: settingsWith({ secrets: hidden }) })), reason).toEqual([]);
      }
    });

    it("片方の時点だけ絵を持てる（後の時点は撮れなかった）", async () => {
      const options = onlyAfterLoad({
        settings: settingsWith(),
        screenshots: [entryOf(A), { stage: "after-behaviors", skipped: "failed" }],
      });
      expect(await run(options)).toEqual([]);
    });
  });

  describe("screenshots の形と時点の並び", () => {
    it("screenshots が無ければ error —— profile 1.24.0 から必須", async () => {
      const { screenshots: _dropped, ...options } = skippedOnly("disabled");
      expect(await run(options)).toEqual([bad("shape", { at: "screenshots", found: "undefined" }, DATAPACKAGE)]);
    });

    it("screenshots が配列でなければ error", async () => {
      expect(await run(skippedOnly("disabled", { screenshots: { stage: "after-load", skipped: "disabled" } }))).toEqual([
        bad("shape", { at: "screenshots", found: "object" }, DATAPACKAGE),
      ]);
    });

    it("項目がオブジェクトでなければ error", async () => {
      expect(await run(onlyAfterLoad({ screenshots: [entryOf(A), 42] }))).toEqual([
        bad("shape", { at: "screenshots[1]", found: "number" }, DATAPACKAGE),
      ]);
    });

    it("スクリプトが走ったのに after-behaviors の項目が無ければ error", async () => {
      expect(await run(onlyAfterLoad({ settings: settingsWith() }))).toEqual([
        bad("stages", { found: '["after-load"]', expected: '["after-load","after-behaviors"]', behaviors: "1" }, DATAPACKAGE),
      ]);
    });

    it("スクリプトが走っていないのに after-behaviors の項目があれば error", async () => {
      expect(await run(archive({ settings: settingsWith({ behaviors: [] }) }))).toEqual([
        bad("stages", { found: '["after-load","after-behaviors"]', expected: '["after-load"]', behaviors: "0" }, DATAPACKAGE),
      ]);
    });

    it("after-behaviors が after-load より前に並べば error", async () => {
      expect(await run(archive({ screenshots: [entryOf(B), entryOf(A)] }))).toEqual([
        bad("stages", { found: '["after-behaviors","after-load"]', expected: '["after-load","after-behaviors"]', behaviors: "1" }, DATAPACKAGE),
      ]);
    });

    it("2 つの時点のほかに項目があれば error", async () => {
      const screenshots = [...skippedAs("disabled"), { stage: "full-page", skipped: "disabled" }];
      expect(await run(skippedOnly("disabled", { screenshots }))).toEqual([
        bad(
          "stages",
          { found: '["after-load","after-behaviors","full-page"]', expected: '["after-load","after-behaviors"]', behaviors: "1" },
          DATAPACKAGE,
        ),
      ]);
    });

    it("settings.behaviors が読めなければ、時点の並びは照らさない", async () => {
      expect(await run(onlyAfterLoad({ settings: { secrets: [] } }))).toEqual([]);
    });
  });

  describe("絵を持たない項目（skipped）", () => {
    it("理由が 5 つのどれでもなければ error —— 写しの理由 too-large は、スクリーンショットの理由ではない", async () => {
      const screenshots = [{ stage: "after-load", skipped: "disabled" }, { stage: "after-behaviors", skipped: "too-large" }];
      expect(await run(skippedOnly("disabled", { screenshots }))).toEqual([
        bad("skipped", { stage: "after-behaviors", found: "too-large" }, DATAPACKAGE),
      ]);
    });

    it("stage と skipped のほかの member を持てば error", async () => {
      const screenshots = [{ stage: "after-load", skipped: "failed", date: A.date, bytes: 0 }, { stage: "after-behaviors", skipped: "failed" }];
      expect(await run(skippedOnly("failed", { screenshots }))).toEqual([
        bad("skipped-members", { stage: "after-load", members: "date, bytes" }, DATAPACKAGE),
      ]);
    });

    it("settings.secrets が空なのに secret なら error", async () => {
      expect(await run(skippedOnly("secret"))).toEqual([
        bad("secret-without-secrets", { stage: "after-load" }, DATAPACKAGE),
        bad("secret-without-secrets", { stage: "after-behaviors" }, DATAPACKAGE),
      ]);
    });

    it("settings.secrets が読めなければ、secret の理由は照らさない", async () => {
      expect(await run(skippedOnly("secret", { settings: { behaviors: [{ name: "search" }] } }))).toEqual([]);
    });

    it.each(["withheld", "task-budget", "failed"])(
      "settings.secrets が空でないのに %s なら error —— 並びで先の secret を書く",
      async (reason) => {
        const screenshots = [{ stage: "after-load", skipped: "secret" }, { stage: "after-behaviors", skipped: reason }];
        expect(await run(skippedOnly("secret", { settings: settingsWith({ secrets: hidden }), screenshots }))).toEqual([
          bad("skipped-not-secret", { stage: "after-behaviors", found: reason }, DATAPACKAGE),
        ]);
      },
    );

    describe.each(WITHHELD_CONDITIONS)("%s取り込み", (_name, because, over) => {
      it.each(["task-budget", "failed"])("%s なら error —— 並びで先の withheld を書く", async (reason) => {
        const screenshots = [{ stage: "after-load", skipped: "withheld" }, { stage: "after-behaviors", skipped: reason }];
        expect(await run(skippedOnly("withheld", { ...over([]), screenshots }))).toEqual([
          bad("skipped-not-withheld", { stage: "after-behaviors", found: reason, because }, DATAPACKAGE),
        ]);
      });

      it.each(["disabled", "withheld"])("%s には何も言わない", async (reason) => {
        expect(await run(skippedOnly(reason, over([])))).toEqual([]);
      });
    });

    it("2 つの条件に当たれば、理由の文に両方を並べる", async () => {
      const options = skippedOnly("failed", {
        settings: settingsWith({ contentTypePolicies: [{ prefix: "video/", action: "no-body" }] }),
        document: { url: DOC_B, withheld: "content-type" },
        screenshots: [{ stage: "after-load", skipped: "disabled" }, { stage: "after-behaviors", skipped: "failed" }],
      });
      expect(await run(options)).toEqual([
        bad(
          "skipped-not-withheld",
          { stage: "after-behaviors", found: "failed", because: "settings.contentTypePolicies, document.withheld" },
          DATAPACKAGE,
        ),
      ]);
    });

    it("絵に写らない種類の要求にだけ方針が当たった取り込みでは、failed でよい", async () => {
      expect(await run(skippedOnly("failed", { warcMetadata: [notArchived("Script")] }))).toEqual([]);
      expect(await run(skippedOnly("failed", noBody([], [traceLine("Stylesheet")])))).toEqual([]);
    });
  });

  describe("絵を持つ項目と、スクリーンショットの resource", () => {
    it.each(["url", "date", "record", "bytes"])("%s が無ければ error", async (member) => {
      const { [member]: _dropped, ...entry } = entryOf(A);
      const { issues, records } = await runWith(onlyAfterLoad({ screenshots: [entry] }));
      expect(issues).toEqual([
        bad("missing-member", { stage: "after-load", members: member }, DATAPACKAGE),
        // record の無い項目は何も名指さないので、resource は名指されないまま残る。
        ...(member === "record" ? [bad("unlisted", { url: A.url, record: `<${A.record}>` }, at(records, "resource"))] : []),
      ]);
    });

    it("url がその時点のスクリーンショットの URI でなければ error（時点の違う urn）", async () => {
      // resource・metadata・索引は崩した url で揃え、url の形の検査だけが言うことを見る。
      const shot: Shot = { ...A, url: `urn:browserhive:screenshot:after-behaviors:${DOC_A}` };
      const options = onlyAfterLoad({ warcMetadata: [{ ...metadataOf(shot), fields: { ...fieldsOf(shot), screenshot: "after-behaviors" } }] }, shot);
      expect(await run(options)).toEqual([bad("url", { stage: "after-load", url: shot.url }, DATAPACKAGE)]);
    });

    it("record の名指す resource が無ければ error —— 名指されない絵も残るので、2 つの決まりが破れる", async () => {
      const { issues, records } = await runWith(
        onlyAfterLoad({ screenshots: [{ ...entryOf(A), record: "urn:uuid:00000000-0000-0000-0000-00000000dead" }] }),
      );
      expect(issues).toEqual([
        bad("no-resource", { stage: "after-load", record: "urn:uuid:00000000-0000-0000-0000-00000000dead" }, DATAPACKAGE),
        bad("unlisted", { url: A.url, record: `<${A.record}>` }, at(records, "resource")),
      ]);
    });

    it("山括弧つきの record は名指していない —— JSON の値は WARC-Record-ID の中の URI だけ", async () => {
      const { issues, records } = await runWith(onlyAfterLoad({ screenshots: [{ ...entryOf(A), record: `<${A.record}>` }] }));
      expect(issues).toEqual([
        bad("no-resource", { stage: "after-load", record: `<${A.record}>` }, DATAPACKAGE),
        bad("unlisted", { url: A.url, record: `<${A.record}>` }, at(records, "resource")),
      ]);
    });

    it("url が resource の WARC-Target-URI と違えば error", async () => {
      const other = `urn:browserhive:screenshot:after-load:${DOC_A}other`;
      expect(await run(onlyAfterLoad({ screenshots: [{ ...entryOf(A), url: other }] }))).toEqual([
        mismatch(A.url, ["screenshots", "url", other], ["resource", "WARC-Target-URI", A.url], DATAPACKAGE),
      ]);
    });

    it("date が resource の WARC-Date と違えば error", async () => {
      expect(await run(onlyAfterLoad({ screenshots: [{ ...entryOf(A), date: "2026-11-02T01:20:05Z" }] }))).toEqual([
        mismatch(A.url, ["screenshots", "date", "2026-11-02T01:20:05Z"], ["resource", "WARC-Date", A.date], DATAPACKAGE),
      ]);
    });

    it("bytes が resource の Content-Length と違えば error。数を文字で書いても違う", async () => {
      const length = String(A.body.byteLength);
      for (const [bytes, found] of [
        [A.body.byteLength + 1, String(A.body.byteLength + 1)],
        [length, `"${length}"`],
      ] as const) {
        expect(await run(onlyAfterLoad({ screenshots: [{ ...entryOf(A), bytes }] })), found).toEqual([
          mismatch(A.url, ["screenshots", "bytes", found], ["resource", "Content-Length", length], DATAPACKAGE),
        ]);
      }
    });

    it("どの項目も名指さないスクリーンショットが在れば error", async () => {
      const stale: Shot = { ...A, url: `urn:browserhive:screenshot:after-load:${DOC_A}stale`, documentUri: `${DOC_A}stale`, record: "urn:uuid:00000000-0000-0000-0000-00000000aaaa" };
      const { issues, records } = await runWith(
        archive({ warcResources: [resourceOf(A), resourceOf(B), resourceOf(stale)], warcMetadata: [metadataOf(A), metadataOf(B), metadataOf(stale)] }),
      );
      expect(issues).toEqual([bad("unlisted", { url: stale.url, record: `<${stale.record}>` }, at(records, "resource", 2))]);
    });

    it("項目が 1 つも絵を名指さないのに resource が在れば error", async () => {
      const { issues, records } = await runWith(onlyAfterLoad({ screenshots: [{ stage: "after-load", skipped: "failed" }] }));
      expect(issues).toEqual([bad("unlisted", { url: A.url, record: `<${A.record}>` }, at(records, "resource"))]);
    });
  });

  describe("絵を持ってはならない package", () => {
    it("settings.secrets が空でないのに絵を持てば error", async () => {
      expect(await run(archive({ settings: settingsWith({ secrets: hidden }) }))).toEqual([bad("forbidden-secrets", held(2, 2), DATAPACKAGE)]);
    });

    it("settings.contentTypePolicies が空でないのに絵を持てば error", async () => {
      const settings = settingsWith({ contentTypePolicies: [{ prefix: "video/", action: "no-body" }] });
      expect(await run(archive({ settings }))).toEqual([bad("forbidden-content-type-policies", held(2, 2), DATAPACKAGE)]);
    });

    it("document が withheld を持つのに絵を持てば error（前の時点の絵でも）", async () => {
      // 後の時点の文書だけが伏せられ、その時点の項目は withheld。前の時点の絵も持てない。
      const options = onlyAfterLoad({
        settings: settingsWith(),
        document: { url: DOC_B, withheld: "url-policy" },
        screenshots: [entryOf(A), { stage: "after-behaviors", skipped: "withheld" }],
      });
      expect(await run(options)).toEqual([bad("forbidden-document-withheld", { ...held(1, 1), withheld: "url-policy" }, DATAPACKAGE)]);
    });

    it("withheld を持たない document は条件に当たらない", async () => {
      expect(await run(archive({ document: { url: DOC_B } }))).toEqual([]);
    });

    describe("no-archive で残さなかった要求のレコード", () => {
      const withRecord = (...extra: WarcMetadataSpec[]): FixtureOptions => archive({ warcMetadata: [metadataOf(A), metadataOf(B), ...extra] });

      it.each(["Document", "Image", "Media"])("resourceType が %s なら error", async (resourceType) => {
        const { issues, records } = await runWith(withRecord(notArchived(resourceType)));
        expect(issues).toEqual([
          bad("forbidden-no-archive", { ...held(2, 2), url: HERO, kind: "typed", resourceType, count: 1 }, at(records, "metadata", 2)),
        ]);
      });

      it("resourceType を持たなければ error —— package は要求の種類を言えない", async () => {
        const { issues, records } = await runWith(withRecord(notArchived()));
        expect(issues).toEqual([
          bad("forbidden-no-archive", { ...held(2, 2), url: HERO, kind: "untyped", resourceType: "", count: 1 }, at(records, "metadata", 2)),
        ]);
      });

      it.each(["Script", "Stylesheet", "XHR", "image", "TextTrack"])("resourceType が %s なら当たらない（字のまま比べる）", async (resourceType) => {
        expect(await run(withRecord(notArchived(resourceType)))).toEqual([]);
      });

      it("deny で送らせなかった要求のレコードは当たらない", async () => {
        expect(await run(withRecord(notArchived("Image", "deny"), notArchived(undefined, "deny")))).toEqual([]);
      });

      it("当たるレコードが 2 つ以上でも 1 件で言い、最初の 1 つを名指して数を添える", async () => {
        const { issues, records } = await runWith(withRecord(notArchived("Script"), notArchived("Media"), notArchived()));
        expect(issues).toEqual([
          bad("forbidden-no-archive", { ...held(2, 2), url: HERO, kind: "typed", resourceType: "Media", count: 2 }, at(records, "metadata", 3)),
        ]);
      });
    });

    describe("no-body で本文を残さなかった応答のレコード（truncated: url-policy）", () => {
      const shots = [metadataOf(A), metadataOf(B)];
      const expected = (records: readonly WarcRecordInfo[], kind: string, resourceType: string): Issue[] => [
        bad("forbidden-no-body", { ...held(2, 2), url: HERO, kind, resourceType, count: 1 }, at(records, "metadata", 2)),
      ];

      it.each(["Document", "Image", "Media"])("その response を名指す trace の行の resourceType が %s なら error", async (resourceType) => {
        const { issues, records } = await runWith(archive(noBody(shots, [traceLine(resourceType)])));
        expect(issues).toEqual(expected(records, "typed", resourceType));
      });

      it("名指す行が resourceType を持たなければ error", async () => {
        const { issues, records } = await runWith(archive(noBody(shots, [traceLine()])));
        expect(issues).toEqual(expected(records, "untyped", ""));
      });

      it("名指す行が無ければ error（行は在るが、別の response を名指す）", async () => {
        const { issues, records } = await runWith(archive(noBody(shots, [traceLine("Script", "urn:uuid:00000000-0000-0000-0000-00000000beef")])));
        expect(issues).toEqual(expected(records, "untraced", ""));
      });

      it("trace のエントリが無くても、名指す行が無いのと同じ", async () => {
        const { issues, records } = await runWith(archive(noBody(shots, undefined)));
        expect(issues).toEqual(expected(records, "untraced", ""));
      });

      it.each(["Script", "Stylesheet", "Fetch"])("名指す行の resourceType が %s なら当たらない", async (resourceType) => {
        expect(await run(archive(noBody(shots, [traceLine(resourceType)])))).toEqual([]);
      });

      it.each(["too-large", "task-cap", "content-type", "not-intercepted"])(
        "truncated が %s のレコードは、行の resourceType が Image でも当たらない",
        async (truncated) => {
          expect(await run(archive(noBody(shots, [traceLine("Image")], truncated)))).toEqual([]);
        },
      );
    });

    it("項目が絵を名指さなくても、resource が在れば絵を持っている", async () => {
      const { issues, records } = await runWith(
        onlyAfterLoad({ settings: settingsWith({ behaviors: [], secrets: hidden }), screenshots: [{ stage: "after-load", skipped: "secret" }] }),
      );
      expect(issues).toEqual([
        bad("unlisted", { url: A.url, record: `<${A.record}>` }, at(records, "resource")),
        bad("forbidden-secrets", held(0, 1), DATAPACKAGE),
      ]);
    });

    it("resource が無くても、項目が絵を名指せば絵を持っている", async () => {
      const options = onlyAfterLoad({ settings: settingsWith({ behaviors: [], secrets: hidden }), warcResources: [], warcMetadata: [] });
      expect(await run(options)).toEqual([
        bad("no-resource", { stage: "after-load", record: A.record }, DATAPACKAGE),
        bad("forbidden-secrets", held(1, 0), DATAPACKAGE),
      ]);
    });

    it("当たる条件ごとに言う", async () => {
      const settings = settingsWith({ secrets: hidden, contentTypePolicies: [{ prefix: "video/", action: "no-body" }] });
      const { issues } = await runWith(archive({ settings, document: { url: DOC_B, withheld: "content-type" }, warcMetadata: [metadataOf(A), metadataOf(B), notArchived("Image")] }));
      expect(issues.map((i) => i.messageKey)).toEqual([
        `${RULE}.forbidden-secrets`,
        `${RULE}.forbidden-content-type-policies`,
        `${RULE}.forbidden-document-withheld`,
        `${RULE}.forbidden-no-archive`,
      ]);
    });
  });

  describe("snapshots が withheld と記録する時点", () => {
    const snapshots = [{ stage: "after-load", skipped: "too-large" }, { stage: "after-behaviors", skipped: "withheld" }];

    it("その時点の項目が絵を持てば error", async () => {
      expect(await run(archive({ snapshots }))).toEqual([bad("snapshot-withheld", { stage: "after-behaviors" }, DATAPACKAGE)]);
    });

    it("その時点の項目が skipped を持てば言わない。ほかの理由で写しの無い時点は、絵を持てる", async () => {
      const options = onlyAfterLoad({ settings: settingsWith(), snapshots, screenshots: [entryOf(A), { stage: "after-behaviors", skipped: "withheld" }] });
      expect(await run(options)).toEqual([]);
    });
  });

  describe("resource のレコード", () => {
    it("WARC-Target-URI の時点の後ろが空なら error", async () => {
      const shot: Shot = { ...A, url: "urn:browserhive:screenshot:after-load:" };
      const { issues, records } = await runWith(onlyAfterLoad({}, shot));
      expect(issues).toEqual([bad("resource-uri", { url: shot.url }, at(records, "resource"))]);
    });

    it("WARC-Target-URI の時点が、この版の定める 2 つでなければ error（項目の url の形も破れる）", async () => {
      const shot: Shot = { ...A, url: `urn:browserhive:screenshot:full-page:${DOC_A}` };
      const { issues, records } = await runWith(onlyAfterLoad({}, shot));
      expect(issues).toEqual([
        bad("url", { stage: "after-load", url: shot.url }, DATAPACKAGE),
        bad("resource-uri", { url: shot.url }, at(records, "resource")),
      ]);
    });

    it.each(["image/png", "image/webp; q=1", "application/octet-stream"])("Content-Type が %s なら error", async (contentType) => {
      const { issues, records } = await runWith(onlyAfterLoad({ warcResources: [{ ...resourceOf(A), contentType }] }));
      expect(issues).toEqual([bad("content-type", { url: A.url, found: contentType }, at(records, "resource"))]);
    });

    it("Content-Type が無ければ error", async () => {
      const { issues, records } = await runWith(onlyAfterLoad({ warcRecordPatches: [{ index: 1, set: { "Content-Type": null } }] }));
      expect(issues).toEqual([bad("content-type", { url: A.url, found: "undefined" }, at(records, "resource"))]);
    });

    it.each(["WARC-Block-Digest", "WARC-Payload-Digest"])("%s が無ければ error", async (field) => {
      const { issues, records } = await runWith(onlyAfterLoad({ warcRecordPatches: [{ index: 1, set: { [field]: null } }] }));
      expect(issues).toEqual([bad("digest-missing", { url: A.url, field }, at(records, "resource"))]);
    });

    it.each(["WARC-Block-Digest", "WARC-Payload-Digest"])("%s が block の digest でなければ error", async (field) => {
      const other = sha256Base32(Buffer.from("another block"));
      const { issues, records } = await runWith(onlyAfterLoad({ warcRecordPatches: [{ index: 1, set: { [field]: other } }] }));
      expect(issues).toEqual([bad("digest", { url: A.url, field }, at(records, "resource"))]);
    });

    it("sha256 でない digest は計算しない", async () => {
      const patch = { index: 1, set: { "WARC-Block-Digest": "sha1:3I42H3S6NNFQ2MSVX7XZKYAYSCX5QBYJ" } };
      expect(await run(onlyAfterLoad({ warcRecordPatches: [patch] }))).toEqual([]);
    });

    it("WARC-Concurrent-To を持てば error（resource も metadata も）", async () => {
      const concurrent = { "WARC-Concurrent-To": "<urn:uuid:00000000-0000-0000-0000-000000000200>" };
      const { issues, records } = await runWith(
        onlyAfterLoad({ warcRecordPatches: [{ index: 1, set: concurrent }, { index: 2, set: concurrent }] }),
      );
      expect(issues).toEqual([
        bad("concurrent-to", { url: A.url, type: "resource" }, at(records, "resource")),
        bad("concurrent-to", { url: A.url, type: "metadata" }, at(records, "metadata")),
      ]);
    });

    it("block が WebP でなければ error（PNG）", async () => {
      const { issues, records } = await runWith(onlyAfterLoad({}, { ...A, body: PNG }));
      expect(issues).toEqual([bad("not-webp", { url: A.url }, at(records, "resource"))]);
    });

    it("block が途中で切れた WebP なら error", async () => {
      const { issues, records } = await runWith(onlyAfterLoad({}, { ...A, body: LOSSLESS_1280_800.subarray(0, 40) }));
      expect(issues).toEqual([bad("not-webp", { url: A.url }, at(records, "resource"))]);
    });

    it("block が animation の WebP なら error —— 静止画ではない", async () => {
      const { issues, records } = await runWith(onlyAfterLoad({}, { ...A, body: ANIMATED_2_1, imageSize: "2x1" }));
      expect(issues).toEqual([bad("animated", { url: A.url }, at(records, "resource"))]);
    });
  });

  describe("組の metadata", () => {
    it("resource を指す metadata がどの本にも無ければ error", async () => {
      const { issues, records } = await runWith(archive({ warcMetadata: [metadataOf(B)] }));
      expect(issues).toEqual([bad("no-metadata", { url: A.url }, at(records, "resource"))]);
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

    it("resource を指す metadata が 2 つ在れば error —— ちょうど 1 つ", async () => {
      const { issues, records } = await runWith(onlyAfterLoad({ warcMetadata: [metadataOf(A), metadataOf(A)] }));
      expect(issues).toEqual([bad("metadata-repeated", { url: A.url, count: 2 }, at(records, "resource"))]);
    });

    it("metadata の WARC-Target-URI が resource と違えば error", async () => {
      const uri = `urn:browserhive:screenshot:after-load:${DOC_A}x`;
      const { issues, records } = await runWith(archive({ warcMetadata: [{ ...metadataOf(A), uri }, metadataOf(B)] }));
      expect(issues).toEqual([
        mismatch(A.url, ["metadata", "WARC-Target-URI", uri], ["resource", "WARC-Target-URI", A.url], at(records, "metadata")),
      ]);
    });

    it("metadata の WARC-Date が resource と違えば error", async () => {
      const date = "2026-11-02T01:20:06.000Z";
      const { issues, records } = await runWith(archive({ warcMetadata: [{ ...metadataOf(A), date }, metadataOf(B)] }));
      expect(issues).toEqual([mismatch(A.url, ["metadata", "WARC-Date", date], ["resource", "WARC-Date", A.date], at(records, "metadata"))]);
    });

    it.each(["screenshot", "document-uri", "viewport", "device-pixel-ratio", "image-size"])("本文に %s が無ければ error", async (name) => {
      const { [name]: _dropped, ...fields } = fieldsOf(A);
      const { issues, records } = await runWith(onlyAfterLoad({ warcMetadata: [{ ...metadataOf(A), fields }] }));
      expect(issues).toEqual([bad("metadata-field-missing", { url: A.url, fields: name }, at(records, "metadata"))]);
    });

    it("document-record は無くてよく、在ってもよい", async () => {
      const fields = { ...fieldsOf(A), "document-record": "<urn:uuid:3d6b2f0e-8c1a-4b7e-a2f4-6e9d1c5b8a07>" };
      expect(await run(onlyAfterLoad({ warcMetadata: [{ ...metadataOf(A), fields }] }))).toEqual([]);
    });

    it.each([
      ["action", "no-archive"],
      ["truncated", "url-policy"],
      ["window", "not-opened"],
      ["snapshot", "after-load"],
    ])("本文が %s を持てば error —— そして、その metadata を方針のレコードには数えない", async (name, value) => {
      // action: no-archive・truncated: url-policy を方針のレコードに数えれば、forbidden-* も鳴る。
      const { issues, records } = await runWith(onlyAfterLoad({ warcMetadata: [{ ...metadataOf(A), fields: { ...fieldsOf(A), [name]: value } }] }));
      expect(issues).toEqual([bad("metadata-field-forbidden", { url: A.url, fields: name }, at(records, "metadata"))]);
    });

    it("screenshot の欄が URI の中の時点と違えば error", async () => {
      const fields = { ...fieldsOf(A), screenshot: "after-behaviors" };
      const { issues, records } = await runWith(onlyAfterLoad({ warcMetadata: [{ ...metadataOf(A), fields }] }));
      expect(issues).toEqual([
        mismatch(A.url, ["metadata", "screenshot", "after-behaviors"], ["resource", "WARC-Target-URI (stage)", "after-load"], at(records, "metadata")),
      ]);
    });

    it("URI の中の URL が document-uri と違えば error", async () => {
      const fields = { ...fieldsOf(A), "document-uri": `${DOC_A}other` };
      const { issues, records } = await runWith(onlyAfterLoad({ warcMetadata: [{ ...metadataOf(A), fields }] }));
      expect(issues).toEqual([
        mismatch(A.url, ["resource", "WARC-Target-URI (URL)", DOC_A], ["metadata", "document-uri (no fragment)", `${DOC_A}other`], at(records, "resource")),
      ]);
    });

    it("URI の中の URL が fragment を持てば error —— document-uri から fragment を除いた物", async () => {
      const shot: Shot = { ...A, url: `urn:browserhive:screenshot:after-load:${DOC_A}#top`, documentUri: `${DOC_A}#top` };
      const { issues, records } = await runWith(onlyAfterLoad({}, shot));
      expect(issues).toEqual([
        mismatch(shot.url, ["resource", "WARC-Target-URI (URL)", `${DOC_A}#top`], ["metadata", "document-uri (no fragment)", DOC_A], at(records, "resource")),
      ]);
    });

    it.each([
      ["viewport", "0800x0"],
      ["viewport", "1280X800"],
      ["viewport", "1280 x 800"],
      ["device-pixel-ratio", "2.0"],
      ["device-pixel-ratio", "1.50"],
      ["device-pixel-ratio", "02"],
      ["device-pixel-ratio", "0"],
      ["image-size", "1280X800"],
      ["image-size", "01280x800"],
    ])("%s が %s なら error —— 仕様の書式でない", async (name, value) => {
      const { issues, records } = await runWith(onlyAfterLoad({ warcMetadata: [{ ...metadataOf(A), fields: { ...fieldsOf(A), [name]: value } }] }));
      expect(issues).toEqual([bad("field-form", { url: A.url, field: name, found: value }, at(records, "metadata"))]);
    });

    it.each(["1", "2", "1.5", "0.75"])("device-pixel-ratio が %s なら通す", async (value) => {
      const fields = { ...fieldsOf(A), "device-pixel-ratio": value };
      expect(await run(onlyAfterLoad({ warcMetadata: [{ ...metadataOf(A), fields }] }))).toEqual([]);
    });

    it("image-size が画像自身の幅と高さでなければ error", async () => {
      // 画像は 16x10。縦横の比は viewport と同じなので、image-size の検査だけが言う。
      const { issues, records } = await runWith(onlyAfterLoad({}, { ...A, body: LOSSY_16_10 }));
      expect(issues).toEqual([bad("image-size", { url: A.url, declared: "1280x800", actual: "16x10" }, at(records, "metadata"))]);
    });

    it("screenshot の欄を持つ metadata が、スクリーンショットの resource を指さなければ error", async () => {
      const stray: WarcMetadataSpec = { ...metadataOf(A), refersTo: "<urn:uuid:00000000-0000-0000-0000-00000000dead>" };
      const unlinked: WarcMetadataSpec = { uri: A.url, date: A.date, fields: fieldsOf(A) };
      const { issues, records } = await runWith(onlyAfterLoad({ warcMetadata: [metadataOf(A), stray, unlinked] }));
      expect(issues).toEqual([
        bad("metadata-orphan", { url: A.url, refersTo: "<urn:uuid:00000000-0000-0000-0000-00000000dead>" }, at(records, "metadata", 1)),
        bad("metadata-orphan", { url: A.url, refersTo: "undefined" }, at(records, "metadata", 2)),
      ]);
    });
  });

  describe("画像の縦横の比（warning）", () => {
    it("viewport の先まで写した絵（1280x2400）には warning", async () => {
      const { issues, records } = await runWith(onlyAfterLoad({}, { ...A, body: LOSSLESS_1280_2400, imageSize: "1280x2400" }));
      expect(issues).toEqual([bad("aspect", { url: A.url, image: "1280x2400", viewport: "1280x800" }, at(records, "resource"), "warning")]);
    });

    it("丸めの内の違い（1280x801）には言わず、超える違い（1280x803）には warning", async () => {
      expect(await run(onlyAfterLoad({}, { ...A, body: LOSSLESS_1280_801, imageSize: "1280x801" }))).toEqual([]);
      const { issues, records } = await runWith(onlyAfterLoad({}, { ...A, body: LOSSLESS_1280_803, imageSize: "1280x803" }));
      expect(issues).toEqual([bad("aspect", { url: A.url, image: "1280x803", viewport: "1280x800" }, at(records, "resource"), "warning")]);
    });

    it("絵の大きさは viewport と違ってよい（比が同じなら）", async () => {
      expect(await run(onlyAfterLoad({}, { ...A, body: LOSSY_16_10, imageSize: "16x10" }))).toEqual([]);
    });

    it("warning だけの archive は valid のまま", async () => {
      const { report } = await reportOf(onlyAfterLoad({}, { ...A, body: LOSSLESS_1280_2400, imageSize: "1280x2400" }));
      expect(report.issues.filter((i) => i.rule === RULE).map((i) => i.severity)).toEqual(["warning"]);
    });
  });

  describe("索引", () => {
    it("絵の行が索引に無ければ error", async () => {
      const resources = [resourceOf(A), { ...resourceOf(B), omitIndex: true }];
      expect(await run(archive({ warcResources: resources }))).toEqual([bad("not-indexed", { url: B.url }, { entry: INDEX })]);
    });

    /** 絵の行だけの索引。行は組んだレコードの本当の位置を指し、B の行の鍵と JSON を差し替える。 */
    const indexWith = async (b: { key?: string; extra?: Record<string, string> }): Promise<string> => {
      const resources = (await buildWacz(archive())).warcRecords.filter((r) => r.type === "resource");
      const line = (shot: Shot, n: number, key: string, extra: Record<string, string> = {}): string => {
        const record = resources[n];
        if (record === undefined) throw new Error("unreachable: two resources");
        const json = { url: shot.url, mime: "image/webp", digest: "sha256:0000", length: String(record.length), offset: String(record.offset), filename: "data.warc.gz", ...extra };
        return `${key} 20261102012005 ${JSON.stringify(json)}`;
      };
      return [line(A, 0, A.url), line(B, 1, b.key ?? B.url, b.extra), ""].join("\n");
    };

    it("手で組んだ索引でも、正しければ何も言わない", async () => {
      expect(await run(archive({ cdxjOverride: await indexWith({}) }))).toEqual([]);
    });

    it("索引の行は鍵でなく指すレコードで探す —— 鍵と url が絵の URI でも、別のレコードを指す行は絵の行ではない", async () => {
      const elsewhere = `${B.url} 20261102012007 ${JSON.stringify({ url: B.url, mime: "image/webp", filename: "data.warc.gz", offset: "0", length: "1" })}\n`;
      const first = (await indexWith({})).split("\n")[0] ?? "";
      expect(await run(archive({ cdxjOverride: `${first}\n${elsewhere}` }))).toEqual([bad("not-indexed", { url: B.url }, { entry: INDEX })]);
    });

    it("行の鍵が WARC-Target-URI でなければ error（SURT の形に崩した鍵）", async () => {
      expect(await run(archive({ cdxjOverride: await indexWith({ key: "site,test)/results" }) }))).toEqual([
        mismatch(B.url, ["indexes/index.cdxj", "urlkey", "site,test)/results"], ["resource", "WARC-Target-URI", B.url], { entry: INDEX, line: 2 }),
      ]);
    });

    it("行の JSON が status を持てば error —— 絵はオリジンの応答ではない", async () => {
      expect(await run(archive({ cdxjOverride: await indexWith({ extra: { status: "200" } }) }))).toEqual([
        bad("index-status", { url: B.url, status: "200" }, { entry: INDEX, line: 2 }),
      ]);
    });
  });

  describe("走る範囲", () => {
    it("WACZ Profile 1.23.0 を名乗る archive には当てない", async () => {
      const broken = skippedOnly("disabled", { conformsTo: WACZ_1_23, screenshots: "after-load" });
      expect(await run(broken)).toEqual([]);
      // 同じ archive でも 1.24.0 を名乗れば落ちる。黙ったのは版のせいで、形のせいではない。
      expect(await run({ ...broken, conformsTo: WACZ_1_24 })).toEqual([bad("shape", { at: "screenshots", found: "string" }, DATAPACKAGE)]);
    });

    it("1.23.0 を名乗る archive がスクリーンショットのレコードを持っていても言わない（写しの rule が 1.16.0 にしているのと同じ）", async () => {
      // 1.24.0 なら、シークレットを渡された取り込みの絵・名指されない絵・PNG の block で落ちる archive。
      const broken = onlyAfterLoad({ conformsTo: WACZ_1_23, settings: settingsWith({ behaviors: [], secrets: hidden }), screenshots: [] }, { ...A, body: PNG });
      expect(await run(broken)).toEqual([]);
      expect((await run({ ...broken, conformsTo: WACZ_1_24 })).map((i) => i.messageKey)).toEqual([
        `${RULE}.stages`,
        `${RULE}.unlisted`,
        `${RULE}.forbidden-secrets`,
        `${RULE}.not-webp`,
      ]);
    });

    it("archive が版を名乗らなければ当てない", async () => {
      const { conformsTo: _dropped, ...unnamed } = skippedOnly("disabled", { screenshots: "after-load" });
      expect(await run(unnamed)).toEqual([]);
    });

    it("spec の profile では走らない", async () => {
      expect(await run(skippedOnly("disabled", { screenshots: "after-load" }), { name: "spec" })).toEqual([]);
    });
  });

  describe("スクリーンショットのレコードと、ほかの rule", () => {
    /** BrowserHive の metadata と同じく `WARC-Block-Digest` を持たせる（主の本の 3・4 番目が絵の metadata）。 */
    const withBlockDigests = (): NonNullable<FixtureOptions["warcRecordPatches"]> =>
      [A, B].map((shot, i) => {
        const body = Buffer.from(`${Object.entries(fieldsOf(shot)).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n`, "utf-8");
        return { index: 3 + i, set: { "WARC-Block-Digest": sha256Base32(body) } };
      });

    it("絵の resource と metadata は、どの WARC 1.1 の rule も鳴らさない（browserhive の profile）", async () => {
      const { report, records } = await reportOf(archive({ warcRecordPatches: withBlockDigests() }));
      // 積んだ順の位置が、上の書き換えの前提どおりであること。
      expect(records.map((r) => r.type)).toEqual(["warcinfo", "resource", "resource", "metadata", "metadata"]);
      expect(firedWarc11Rules(report)).toEqual([]);
      expect(report.issues.filter((i) => i.rule === "warc/payload-digest")).toEqual([]);
    });

    it("絵の metadata を、warc/recording-complete は未完了の取得に数えない（どの版を名乗る archive でも）", async () => {
      for (const conformsTo of [WACZ_1_24, WACZ_1_23]) {
        const { report } = await reportOf(archive({ conformsTo }));
        expect(report.issues.filter((i) => i.rule === "warc/recording-complete"), conformsTo).toEqual([]);
      }
    });

    it("metadata に WARC-Payload-Digest を書けば、warc/fields-by-type が言う（この rule は言わない）", async () => {
      const { report } = await reportOf(
        archive({ warcRecordPatches: [{ index: 3, set: { "WARC-Payload-Digest": sha256Base32(Buffer.from("x")) } }] }),
      );
      expect(firedWarc11Rules(report)).toEqual(["warc/fields-by-type"]);
      expect(report.issues.filter((i) => i.rule === RULE)).toEqual([]);
    });

    it("pages/pages.jsonl に絵の行を足せば、browserhive/snapshots の行の並びの検査が言う（この rule は言わない）", async () => {
      // pages/pages.jsonl は文書の行と写しの行だけ。スクリーンショットは行を持たない。
      const page = { id: "task-1", url: DOC_A, ts: A.date, title: "Shop" };
      const shotPage = { id: "task-1-shot", url: A.url, ts: A.date, stage: "after-load" };
      const options = skippedOnly("disabled", { snapshots: skippedAs("failed"), pageEntries: [page, shotPage] });
      const { report } = await reportOf(options);
      expect(report.issues.filter((i) => i.rule === "browserhive/snapshots").map((i) => i.messageKey)).toContain("browserhive/snapshots.pages");
    });
  });
});
