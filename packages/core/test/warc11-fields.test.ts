// @module-tag warc
/**
 * WARC 1.1 の欄の目録（`warc11-fields.ts`）の試験。
 *
 * 目録は §5 の「may be used in / shall not be used in / mandatory on」の文を表にしたもので、
 * `warc/mandatory-fields`・`warc/fields-by-type` はこれを読むだけ。ここでは、仕様の文から作った
 * 対応表（下の `EXPECTED`）と目録を全部の欄 × 全部の type で突き合わせる。目録を 1 か所だけ
 * 書き換えると、ここが落ちる。
 *
 * アンカーは、注釈つき WARC 1.1 の頁の見出しの id（2026-11-01 に頁から取った）。
 */
import { describe, expect, it } from "vitest";
import {
  fieldPresence,
  WARC11_FIELDS,
  WARC_RECORD_TYPES,
  warcFieldSpec,
  type FieldPresence,
  type WarcRecordType,
} from "../src/validate/warc11-fields.js";

/** 注釈つき WARC 1.1 の頁にある見出しの id（名前付き欄の節）。 */
const PAGE_ANCHORS = new Set([
  "warc-record-id-mandatory",
  "content-length-mandatory",
  "warc-date-mandatory",
  "warc-type-mandatory",
  "content-type",
  "warc-concurrent-to",
  "warc-block-digest",
  "warc-payload-digest",
  "warc-ip-address",
  "warc-refers-to",
  "warc-refers-to-target-uri",
  "warc-refers-to-date",
  "warc-target-uri",
  "warc-truncated",
  "warc-warcinfo-id",
  "warc-filename",
  "warc-profile",
  "warc-identified-payload-type",
  "warc-segment-number",
  "warc-segment-origin-id",
  "warc-segment-total-length",
]);

const M = "mandatory";
const O = "optional";
const F = "forbidden";
const U = "undefined";

/**
 * 仕様の文から作った対応表。列は warcinfo, response, resource, request, metadata, revisit,
 * conversion, continuation の順。
 */
const EXPECTED: Record<string, readonly FieldPresence[]> = {
  "WARC-Record-ID": [M, M, M, M, M, M, M, M],
  "Content-Length": [M, M, M, M, M, M, M, M],
  "WARC-Date": [M, M, M, M, M, M, M, M],
  "WARC-Type": [M, M, M, M, M, M, M, M],
  "Content-Type": [O, O, O, O, O, O, O, O],
  "WARC-Concurrent-To": [F, O, O, O, O, O, F, F],
  "WARC-Block-Digest": [O, O, O, O, O, O, O, O],
  "WARC-Payload-Digest": [F, O, O, O, F, O, O, O],
  "WARC-IP-Address": [F, O, O, O, O, O, F, F],
  "WARC-Refers-To": [F, F, F, F, O, O, O, F],
  "WARC-Refers-To-Target-URI": [F, F, F, F, F, O, F, F],
  "WARC-Refers-To-Date": [F, F, F, F, F, O, F, F],
  "WARC-Target-URI": [F, M, M, M, O, M, M, M],
  "WARC-Truncated": [O, O, O, O, O, O, O, O],
  "WARC-Warcinfo-ID": [F, O, O, O, O, O, O, O],
  "WARC-Filename": [O, F, F, F, F, F, F, F],
  "WARC-Profile": [U, U, U, U, U, M, U, U],
  "WARC-Identified-Payload-Type": [F, O, O, O, F, O, O, O],
  "WARC-Segment-Number": [O, O, O, O, O, O, O, M],
  "WARC-Segment-Origin-ID": [F, F, F, F, F, F, F, M],
  "WARC-Segment-Total-Length": [F, F, F, F, F, F, F, O],
};

describe("WARC 1.1 の欄の目録", () => {
  it("目録の欄と対応表の欄が同じ", () => {
    expect(WARC11_FIELDS.map((spec) => spec.name).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(Object.entries(EXPECTED))("%s の type ごとの扱いが仕様の文と同じ", (name, row) => {
    const spec = warcFieldSpec(name);
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    const actual = Object.fromEntries(WARC_RECORD_TYPES.map((type: WarcRecordType) => [type, fieldPresence(spec, type)]));
    const expected = Object.fromEntries(WARC_RECORD_TYPES.map((type, i) => [type, row[i]]));
    expect(actual).toEqual(expected);
  });

  it("繰り返してよい欄は WARC-Concurrent-To だけ", () => {
    expect(WARC11_FIELDS.filter((spec) => spec.repeatable === true).map((spec) => spec.name)).toEqual(["WARC-Concurrent-To"]);
  });

  it("どの欄のアンカーも頁の見出しに在る", () => {
    for (const spec of WARC11_FIELDS) expect(PAGE_ANCHORS.has(spec.anchor), spec.name).toBe(true);
  });

  it("名は大小を無視して引ける", () => {
    expect(warcFieldSpec("warc-target-uri")?.name).toBe("WARC-Target-URI");
    expect(warcFieldSpec("X-Extension")).toBeUndefined();
  });
});
