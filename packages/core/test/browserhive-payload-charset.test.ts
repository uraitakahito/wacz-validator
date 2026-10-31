// @module-tag engine
/**
 * `browserhive/payload-charset` のテスト。
 *
 * 守っている主張は profile 1.13.0 の Response payloads（本文の文字符号を変えてはならない）。推測なので warning。
 * 標本は BrowserHive v19 が実際に書いた形: Shift_JIS の「議法」を UTF-8 に書き直した本文と、charset の無い
 * UTF-8 の本文を windows-1252 として読み、UTF-8 で書き戻した本文（e-Gov 法令検索の CSS で見た形）。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseReportSource, type Issue } from "../src/validate/domain.js";
import { runValidation } from "../src/validate/engine.js";
import { DEFAULT_RULES } from "../src/validate/rules/index.js";
import { charsetFinding } from "../src/validate/rules/browserhive-payload-charset.js";
import { fileTransport } from "../src/wacz/transport.js";
import { WaczReader } from "../src/wacz/reader.js";
import { buildWacz, type WarcResponseSpec } from "./fixtures/generator.js";

const RULE = "browserhive/payload-charset";

/** 「議法」の Shift_JIS。 */
const SJIS = Buffer.from([0x8b, 0x63, 0x96, 0x40, 0x0a]);
/** 同じ文字の UTF-8 —— v19 は Shift_JIS の本文を、これに書き直していた。 */
const UTF8 = Buffer.from("議法\n", "utf-8");
/** UTF-8 の「議法」を windows-1252 として読み、UTF-8 で書き戻した形（è­°æ³•）。 */
const DOUBLE = Buffer.from(Buffer.from("議法\n", "utf-8").toString("latin1").replace("\u0095", "•"), "utf-8");

describe("charsetFinding", () => {
  it("宣言の charset で読めず UTF-8 でなら読める本文は、transcoded", () => {
    expect(charsetFinding("text/css; charset=Shift_JIS", UTF8)).toEqual({ kind: "transcoded", charset: "shift_jis" });
  });

  it("宣言どおりの Shift_JIS の本文は、何も言わない", () => {
    expect(charsetFinding("text/css; charset=Shift_JIS", SJIS)).toBeUndefined();
  });

  it("UTF-8 の本文を windows-1252 として読み、UTF-8 で書き戻した本文は、double-encoded", () => {
    expect(charsetFinding("text/css", DOUBLE)).toEqual({ kind: "double-encoded" });
    expect(charsetFinding("text/plain; charset=utf-8", DOUBLE)).toEqual({ kind: "double-encoded" });
  });

  it("正しい UTF-8 の本文（latin1 の範囲の文字も、その外の文字も）は、何も言わない", () => {
    expect(charsetFinding("text/css", UTF8)).toBeUndefined();
    expect(charsetFinding("text/html; charset=utf-8", Buffer.from("café ü", "utf-8"))).toBeUndefined();
  });

  it("文字の型でない本文・ASCII だけの本文・知らない charset は見ない", () => {
    expect(charsetFinding("image/png", DOUBLE)).toBeUndefined();
    expect(charsetFinding("text/css; charset=Shift_JIS", Buffer.from(".a{}"))).toBeUndefined();
    expect(charsetFinding("text/css; charset=x-unknown", UTF8)).toBeUndefined();
  });
});

describe("browserhive/payload-charset", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "wacz-validator-payload-charset-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const run = async (responses: WarcResponseSpec[]): Promise<Issue[]> => {
    const { bytes } = await buildWacz({ warcResponses: responses });
    const path = join(tmpDir, "fixture.wacz");
    await writeFile(path, bytes);
    const source = parseReportSource(path);
    if (!source.ok || source.value.kind !== "file") throw new Error("unreachable");
    const reader = await WaczReader.open(fileTransport(source.value.path));
    try {
      const result = await runValidation(reader, {
        validatorVersion: "0.0.0",
        rules: DEFAULT_RULES,
        profile: { name: "browserhive" },
      });
      if (!result.ok) throw new Error("unreachable");
      return result.value.issues.filter((i) => i.rule === RULE);
    } finally {
      await reader.close();
    }
  };

  it("v19 が書いた 2 つの形を warning で指し、正しい本文は指さない", async () => {
    const issues = await run([
      { uri: "https://site.test/sjis.css", mime: "text/css; charset=Shift_JIS", body: UTF8 },
      { uri: "https://site.test/nocharset.css", mime: "text/css", body: DOUBLE },
      { uri: "https://site.test/ok.css", mime: "text/css; charset=Shift_JIS", body: SJIS },
      { uri: "https://site.test/ok.txt", mime: "text/plain", body: UTF8 },
    ]);
    expect(issues).toEqual([
      {
        rule: RULE,
        severity: "warning",
        messageKey: `${RULE}.transcoded`,
        params: { url: "https://site.test/sjis.css", charset: "shift_jis" },
        location: { entry: "archive/data.warc.gz" },
      },
      {
        rule: RULE,
        severity: "warning",
        messageKey: `${RULE}.double-encoded`,
        params: { url: "https://site.test/nocharset.css" },
        location: { entry: "archive/data.warc.gz" },
      },
    ]);
  });
});
