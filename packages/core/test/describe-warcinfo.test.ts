// @module-tag warc
/**
 * 報告の `warcinfo` の欄（`describe/warcinfo.ts`・`validate/warc11-scan.ts`・`render/json.ts`）の試験。
 *
 * 走査に手で組んだ WARC のバイト列（gzip の member と、圧縮していない本）を渡す単体の試験と、
 * `runValidation` を通して報告に載るかを見る試験に分ける。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectWarcinfo, describeWarcinfo } from "../src/describe/warcinfo.js";
import { renderJson } from "../src/render/json.js";
import { parseReportSource, type Report } from "../src/validate/domain.js";
import { runValidation } from "../src/validate/engine.js";
import { DEFAULT_RULES } from "../src/validate/rules/index.js";
import { WARCINFO_FIELDS_MAX, scanWarcFile } from "../src/validate/warc11-scan.js";
import { WARCINFO_SPEC_URL } from "../src/vocab/warcinfo-fields.js";
import { fileTransport } from "../src/wacz/transport.js";
import { WaczReader } from "../src/wacz/reader.js";
import { buildWacz, type FixtureOptions } from "./fixtures/generator.js";

const CRLF = "\r\n";
const ID = "<urn:uuid:3f1c7a52-8d4e-4b6a-9e21-5c0d7b8a6f14>";

/** WARC 1.1 の記録 1 件。`contentLength` を渡すと、実体と食い違う長さを書ける。 */
const warcRecord = (opts: {
  type?: string;
  contentType?: string;
  body: string;
  contentLength?: number;
}): Buffer => {
  const body = Buffer.from(opts.body, "utf-8");
  const head = [
    "WARC/1.1",
    `WARC-Type: ${opts.type ?? "warcinfo"}`,
    `WARC-Record-ID: ${ID}`,
    "WARC-Date: 2026-11-01T09:30:00.000Z",
    "WARC-Filename: data-000.warc.gz",
    `Content-Type: ${opts.contentType ?? "application/warc-fields"}`,
    `Content-Length: ${String(opts.contentLength ?? body.length)}`,
  ].join(CRLF);
  return Buffer.concat([Buffer.from(`${head}${CRLF}${CRLF}`), body, Buffer.from(`${CRLF}${CRLF}`)]);
};
const fields = (lines: string[]): string => lines.map((l) => `${l}${CRLF}`).join("");

/** BrowserHive v22.0.1 が書く warcinfo の本文と同じ 5 欄。 */
const BROWSERHIVE = fields([
  "software: browserhive/22.0.1",
  "format: WARC File Format 1.1",
  "conformsTo: http://iipc.github.io/warc-specifications/specifications/warc-format/warc-1.1/",
  "robots-policy: ignore",
  "description: Capture of https://page.site.test/",
]);

describe("describeWarcinfo", () => {
  const ENTRY = "archive/data-000.warc.gz";

  it("BrowserHive の warcinfo の 5 欄を、語彙つきで書かれた順に返す", () => {
    const files = [{ entry: ENTRY, records: scanWarcFile(ENTRY, gzipSync(warcRecord({ body: BROWSERHIVE }))) }];
    expect(describeWarcinfo(files)).toEqual([
      {
        entry: ENTRY,
        index: 1,
        offset: 0,
        recordId: ID,
        date: "2026-11-01T09:30:00.000Z",
        filename: "data-000.warc.gz",
        contentType: "application/warc-fields",
        fields: [
          { name: "software", value: "browserhive/22.0.1", vocabulary: "warc", ref: WARCINFO_SPEC_URL },
          { name: "format", value: "WARC File Format 1.1", vocabulary: "dcterms", ref: "http://purl.org/dc/terms/format" },
          {
            name: "conformsTo",
            value: "http://iipc.github.io/warc-specifications/specifications/warc-format/warc-1.1/",
            vocabulary: "dcterms",
            ref: "http://purl.org/dc/terms/conformsTo",
          },
          { name: "robots-policy", value: "ignore", vocabulary: null },
          {
            name: "description",
            value: "Capture of https://page.site.test/",
            vocabulary: "dcterms",
            ref: "http://purl.org/dc/terms/description",
          },
        ],
      },
    ]);
  });

  it("圧縮していない本の warcinfo も、同じに読む", () => {
    const entry = "archive/data-000.warc";
    const [described] = describeWarcinfo([{ entry, records: scanWarcFile(entry, warcRecord({ body: BROWSERHIVE })) }]);
    expect(described?.entry).toBe(entry);
    expect(described?.fields?.map((f) => f.vocabulary)).toEqual(["warc", "dcterms", "dcterms", null, "dcterms"]);
  });

  it("折り返し・名前の大文字小文字・繰り返しをそのまま写し、本文の問題も返す", () => {
    const body = fields(["Format: WARC File Format 1.0", "conformsTo:", " https://spec.site.test/warc/", "creator: A", "creator: B"]);
    const [described] = describeWarcinfo([{ entry: ENTRY, records: scanWarcFile(ENTRY, gzipSync(warcRecord({ body }))) }]);
    expect(described?.fields).toEqual([
      { name: "Format", value: "WARC File Format 1.0", vocabulary: "dcterms", ref: "http://purl.org/dc/terms/format" },
      { name: "conformsTo", value: "https://spec.site.test/warc/", vocabulary: "dcterms", ref: "http://purl.org/dc/terms/conformsTo" },
      { name: "creator", value: "A", vocabulary: "dcterms", ref: "http://purl.org/dc/terms/creator" },
      { name: "creator", value: "B", vocabulary: "dcterms", ref: "http://purl.org/dc/terms/creator" },
    ]);
    expect(described?.problems).toEqual([{ kind: "folded-line", line: 3, found: "conformsTo" }]);
  });

  it("application/warc-fields でない warcinfo は、fields なしで載せる", () => {
    const records = scanWarcFile(ENTRY, gzipSync(warcRecord({ contentType: "text/plain", body: "software: x\r\n" })));
    const [described] = describeWarcinfo([{ entry: ENTRY, records }]);
    expect(described?.contentType).toBe("text/plain");
    expect(described).not.toHaveProperty("fields");
  });

  it("Content-Type の引数と大文字小文字は見ない", () => {
    const records = scanWarcFile(
      ENTRY,
      gzipSync(warcRecord({ contentType: "Application/WARC-Fields; charset=utf-8", body: "software: x\r\n" })),
    );
    expect(describeWarcinfo([{ entry: ENTRY, records }])[0]?.fields).toEqual([
      { name: "software", value: "x", vocabulary: "warc", ref: WARCINFO_SPEC_URL },
    ]);
  });

  it(`本文が ${String(WARCINFO_FIELDS_MAX)} バイトを超える warcinfo は、欄を読まずに載せる`, () => {
    const big = `description: ${"x".repeat(WARCINFO_FIELDS_MAX)}\r\n`;
    const [described] = describeWarcinfo([{ entry: ENTRY, records: scanWarcFile(ENTRY, gzipSync(warcRecord({ body: big }))) }]);
    expect(described?.contentType).toBe("application/warc-fields");
    expect(described).not.toHaveProperty("fields");
  });

  it("構造が壊れた warcinfo は載せない —— 壊れは warc/record-structure が言う", () => {
    const broken = warcRecord({ body: BROWSERHIVE, contentLength: 3 });
    const records = scanWarcFile(ENTRY, gzipSync(broken));
    expect(records[0]?.sound).toBe(false);
    expect(describeWarcinfo([{ entry: ENTRY, records }])).toEqual([]);
  });

  it("warcinfo でない記録は載せない", () => {
    const records = scanWarcFile(ENTRY, gzipSync(warcRecord({ type: "metadata", body: "via: https://page.site.test/\r\n" })));
    expect(describeWarcinfo([{ entry: ENTRY, records }])).toEqual([]);
  });
});

describe("報告の warcinfo（runValidation を通す）", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "wacz-validator-warcinfo-report-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const reportFor = async (options: FixtureOptions): Promise<Report> => {
    const { bytes } = await buildWacz(options);
    const path = join(tmpDir, "fixture.wacz");
    await writeFile(path, bytes);
    const source = parseReportSource(path);
    if (!source.ok || source.value.kind !== "file") throw new Error("unreachable");
    const reader = await WaczReader.open(fileTransport(source.value.path));
    try {
      const result = await runValidation(reader, { validatorVersion: "0.0.0", rules: DEFAULT_RULES, profile: { name: "spec" } });
      if (!result.ok) throw new Error("runValidation returned err — unreachable");
      return result.value;
    } finally {
      await reader.close();
    }
  };

  it("WARC の本の warcinfo と、足した欄が、報告に載る", async () => {
    const report = await reportFor({ warcinfoLines: ["format: WARC File Format 1.1", "conformsTo: https://spec.site.test/warc/"] });
    expect(report.warcinfo).toHaveLength(1);
    const [record] = report.warcinfo ?? [];
    expect(record?.entry).toBe("archive/data.warc.gz");
    expect(record?.fields?.map((f) => [f.name, f.vocabulary])).toEqual([
      ["software", "warc"],
      ["format", "dcterms"],
      ["conformsTo", "dcterms"],
    ]);
  });

  it("warcinfo が 1 件も無ければ、key ごと出ない", async () => {
    const report = await reportFor({ warcRecordPatches: [{ index: 0, set: { "WARC-Type": "metadata" } }] });
    expect(report).not.toHaveProperty("warcinfo");
  });

  it("本が読めなければ undefined を返し、検証を止めない", async () => {
    const reader = { warcEntries: () => ["archive/x.warc.gz"], readEntry: () => Promise.reject(new Error("boom")) };
    expect(await collectWarcinfo(reader as unknown as WaczReader)).toBeUndefined();
  });
});

describe("renderJson の warcinfo", () => {
  const report = {
    validatorVersion: "0.0.0",
    profile: { name: "spec" },
    source: { kind: "file", path: "/tmp/x.wacz" },
    summary: { passed: 0, failed: 0, warnings: 0, info: 0, durationMs: 0 },
    issues: [],
    entries: [],
    warcinfo: [
      {
        entry: "archive/data.warc.gz",
        index: 1,
        offset: 0,
        fields: [
          { name: "format", value: "WARC File Format 1.1", vocabulary: "dcterms", ref: "http://purl.org/dc/terms/format" },
          { name: "software", value: "x", vocabulary: "warc", ref: WARCINFO_SPEC_URL },
          { name: "robots-policy", value: "ignore", vocabulary: null },
        ],
      },
    ],
  } as unknown as Report;

  const labels = (locale: "en" | "ja"): (string | undefined)[] =>
    (JSON.parse(renderJson(report, locale)) as { warcinfo: { fields: { label?: string }[] }[] }).warcinfo[0]?.fields.map(
      (f) => f.label,
    ) ?? [];

  it("語彙のある欄に、頼まれた言語の表示名を付ける。語彙の無い欄には付けない", () => {
    expect(labels("ja")).toEqual(["Dublin Core の語", "WARC 1.1 の warcinfo の欄", undefined]);
    expect(labels("en")).toEqual(["Dublin Core term", "WARC 1.1 warcinfo field", undefined]);
  });
});
