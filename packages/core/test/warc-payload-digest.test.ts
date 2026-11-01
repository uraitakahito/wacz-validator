// @module-tag warc
/**
 * `warc/payload-digest` が照らす記録と照らさない記録の試験。
 *
 * payload は WARC 1.1 の §6 が type ごとに定める。warcinfo と metadata には payload の定義が無く、
 * §5.9 はそこに `WARC-Payload-Digest` を書くこと自体を禁じる（書いてあることは
 * `warc/fields-by-type` が言う）。分割した記録の digest は論理記録全体の payload のもので、
 * 1 つの segment の block とは合わない。どちらも照らさない。conversion は block を payload として照らす。
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Base32 } from "../src/wacz/digest.js";
import type { FixtureOptions } from "./fixtures/generator.js";
import { rawRecord, reportFor } from "./fixtures/warc11.js";

const RULE = "warc/payload-digest";
const WRONG = "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const digestIssues = async (options: FixtureOptions): Promise<string[]> =>
  (await reportFor(options)).issues.filter((i) => i.rule === RULE).map((i) => i.messageKey.slice(RULE.length + 1));

const conversion = (digest: string, block = "converted text"): Buffer =>
  rawRecord(
    [
      "WARC/1.1",
      "WARC-Type: conversion",
      "WARC-Record-ID: <urn:uuid:00000000-0000-0000-0000-000000000990>",
      "WARC-Date: 2026-05-13T00:00:00Z",
      "WARC-Target-URI: https://site.test/doc.pdf",
      "Content-Type: text/plain",
      `WARC-Payload-Digest: ${digest}`,
      `Content-Length: ${String(Buffer.byteLength(block))}`,
    ],
    block,
  );

describe("warc/payload-digest が照らす記録", () => {
  it("warcinfo と metadata の Payload-Digest は照らさない（書いたことは fields-by-type が言う）", async () => {
    const options: FixtureOptions = {
      warcIncompleteRecords: 1,
      warcRecordPatches: [
        { index: 0, set: { "WARC-Payload-Digest": WRONG } },
        { index: 1, set: { "WARC-Payload-Digest": WRONG } },
      ],
    };
    expect(await digestIssues(options)).toEqual([]);
    const forbidden = (await reportFor(options)).issues.filter((i) => i.messageKey === "warc/fields-by-type.forbidden");
    expect(forbidden.map((i) => i.params?.["type"])).toEqual(["warcinfo", "metadata"]);
  });

  it("分割した記録の Payload-Digest は論理記録のものなので照らさない", async () => {
    const logical = sha256Base32(Buffer.from("first part, last part"));
    const options: FixtureOptions = {
      warcSegmented: [{ uri: "https://site.test/big", parts: ["first part, ", "last part"] }],
      warcRecordPatches: [
        { index: 1, set: { "WARC-Payload-Digest": logical } },
        { index: 2, set: { "WARC-Payload-Digest": logical } },
      ],
    };
    expect(await digestIssues(options)).toEqual([]);
  });

  it("conversion は block を payload として照らす", async () => {
    expect(await digestIssues({ warcRawMembers: [conversion(sha256Base32(Buffer.from("converted text")))] })).toEqual([]);
    expect(await digestIssues({ warcRawMembers: [conversion(WRONG)] })).toEqual(["mismatch"]);
  });

  it("応答の Payload-Digest は今までどおり照らす", async () => {
    const options: FixtureOptions = {
      payloadDigestBad: true,
      warcResponses: [{ uri: "https://site.test/", mime: "text/html", body: "<p>ok</p>" }],
    };
    expect(await digestIssues(options)).toEqual(["mismatch"]);
  });

  it("payloadDigestBad は応答が無いと組めない（warcinfo に digest を書かない）", async () => {
    await expect(reportFor({ payloadDigestBad: true })).rejects.toThrow(/warcResponses/);
  });
});

describe("warc/payload-digest が読む digest の書き方", () => {
  const BODY = "<p>ok</p>";
  const hex = createHash("sha256").update(BODY).digest("hex");
  const withDigest = (digest: string): FixtureOptions => ({
    warcResponses: [{ uri: "https://site.test/", mime: "text/html", body: BODY }],
    warcRecordPatches: [{ index: 1, set: { "WARC-Payload-Digest": digest } }],
  });

  it("Base16（16 進）の digest も、大文字でも小文字でも照らせる（Scoop は Base16 で書く）", async () => {
    expect(await digestIssues(withDigest(`sha256:${hex}`))).toEqual([]);
    expect(await digestIssues(withDigest(`sha256:${hex.toUpperCase()}`))).toEqual([]);
  });

  it("Base32 は大小と末尾の padding を揃えて読む", async () => {
    const b32 = sha256Base32(Buffer.from(BODY)).slice("sha256:".length);
    expect(await digestIssues(withDigest(`sha256:${b32.toLowerCase()}`))).toEqual([]);
    expect(await digestIssues(withDigest(`sha256:${b32}====`))).toEqual([]);
  });

  it("値が違えば、宣言と同じ書き方の計算値を添えて不一致", async () => {
    const wrong = `sha256:${"0".repeat(64)}`;
    const report = await reportFor(withDigest(wrong));
    const issue = report.issues.find((i) => i.rule === RULE);
    expect(issue?.messageKey).toBe(`${RULE}.mismatch`);
    expect((issue?.details as { actual?: string } | undefined)?.actual).toBe(`sha256:${hex}`);
  });
});
