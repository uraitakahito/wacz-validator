// @module-tag warc
/**
 * `WarcIssueBucket`（同じ本・同じ message の issue を丸める）の試験。
 *
 * 境目は 4 件。4 件ちょうどなら丸めず、5 件目から最後の 1 件が残りの件数を運ぶ。本と message の
 * どちらかが違えば別の箱になる。
 */
import { describe, expect, it } from "vitest";
import type { Issue } from "../src/validate/domain.js";
import { ISSUES_PER_MESSAGE, WarcIssueBucket } from "../src/validate/warc-issue-bucket.js";

const issue = (entry: string, key: string, n: number): Issue => ({
  rule: "warc/test",
  severity: "warning",
  messageKey: `warc/test.${key}`,
  params: { record: String(n) },
  location: { entry, offset: n },
});

describe("WarcIssueBucket", () => {
  it("4 件ちょうどなら丸めない", () => {
    const bucket = new WarcIssueBucket();
    for (let n = 1; n <= ISSUES_PER_MESSAGE; n++) bucket.push(issue("a", "x", n));
    const out = bucket.drain();
    expect(out).toHaveLength(ISSUES_PER_MESSAGE);
    expect(out.every((i) => i.params?.["more"] === undefined)).toBe(true);
  });

  it("10 件なら 4 件を出し、最後の 1 件が残り 6 件を運ぶ", () => {
    const bucket = new WarcIssueBucket();
    for (let n = 1; n <= 10; n++) bucket.push(issue("a", "x", n));
    const out = bucket.drain();
    expect(out.map((i) => i.params?.["record"])).toEqual(["1", "2", "3", "4"]);
    expect(out.map((i) => i.params?.["more"])).toEqual([undefined, undefined, undefined, 6]);
  });

  it("本か message が違えば別に数える。並びは鍵が最初に現れた順", () => {
    const bucket = new WarcIssueBucket();
    for (let n = 1; n <= 5; n++) {
      bucket.push(issue("a", "x", n));
      bucket.push(issue("b", "x", n));
      bucket.push(issue("a", "y", n));
    }
    const out = bucket.drain();
    expect(out.map((i) => `${String(i.location?.entry)}/${i.messageKey}/${String(i.params?.["more"] ?? "")}`)).toEqual([
      "a/warc/test.x/",
      "a/warc/test.x/",
      "a/warc/test.x/",
      "a/warc/test.x/1",
      "b/warc/test.x/",
      "b/warc/test.x/",
      "b/warc/test.x/",
      "b/warc/test.x/1",
      "a/warc/test.y/",
      "a/warc/test.y/",
      "a/warc/test.y/",
      "a/warc/test.y/1",
    ]);
  });

  it("drain の後は空", () => {
    const bucket = new WarcIssueBucket();
    bucket.push(issue("a", "x", 1));
    bucket.drain();
    expect(bucket.drain()).toEqual([]);
  });
});
