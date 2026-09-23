// @module-tag cdxj
/**
 * `explodeLine` の単体テスト。
 *
 * 標本は **実物** を使う。`samples/wikipedia.wacz` の `indexes/index.cdx.gz`
 * から取った 476 文字の 1 行をそのまま埋めている。合成データだけだと
 * 「実際の producer が出す形」を外したことに気づけない — 値に空白が入る、
 * key に `)` や `?` が混じる、といった点は作った例では再現しにくい。
 */
import { describe, expect, it } from "vitest";
import { explodeLine } from "../src/wacz/line-fields.js";

/** samples/wikipedia.wacz の indexes/index.cdx.gz 2 行目 (476 文字)。 */
const REAL_CDXJ_LINE =
  'org,wikimedia,upload)/wikipedia/commons/4/4d/icon_pdf_file.png 20220831121514 {"url": "https://upload.wikimedia.org/wikipedia/commons/4/4d/Icon_pdf_file.png", "mime": "image/png", "status": "200", "digest": "sha1:UKKPFYIP53NFMQTHRDY2CQERNZXKXWY3", "length": "1320", "offset": "5504", "filename": "rec-20220831121514140372-203de340fdad.warc.gz", "recordDigest": "sha256:9a5ad858a5a8730074545095192ad070224dcb489d0d6b4e48926a0f7ea89fb7", "referrer": "https://en.wikipedia.org/"}';

/** samples/wikipedia.wacz の pages/pages.jsonl 2 行目。 */
const REAL_JSONL_LINE =
  '{"id": "4GiJ8W2EwC6Ew5fQqDZGQy", "url": "https://en.wikipedia.org/wiki/World_Wide_Web", "ts": "2022-08-31T12:15:12Z", "title": "World Wide Web - Wikipedia"}';

const valueOf = (line: string, label: string): string | undefined =>
  explodeLine(line).find((f) => f.label === label)?.value;

describe("explodeLine", () => {
  describe("CDXJ", () => {
    it("実物の 1 行を key / timestamp + JSON の field に割る", () => {
      const fields = explodeLine(REAL_CDXJ_LINE);
      expect(fields.map((f) => f.label)).toEqual([
        "key",
        "timestamp",
        "url",
        "mime",
        "status",
        "digest",
        "length",
        "offset",
        "filename",
        "recordDigest",
        "referrer",
      ]);
    });

    it("80 桁では見えなかった値まで取り出せている", () => {
      // 元の行は 476 文字。80 桁の端末では JSON がまるごと切れていた。
      expect(REAL_CDXJ_LINE.length).toBe(476);
      expect(valueOf(REAL_CDXJ_LINE, "offset")).toBe("5504");
      expect(valueOf(REAL_CDXJ_LINE, "filename")).toBe(
        "rec-20220831121514140372-203de340fdad.warc.gz",
      );
    });

    it("key は SURT のまま渡す(`)` や `?` で切らない)", () => {
      expect(valueOf(REAL_CDXJ_LINE, "key")).toBe(
        "org,wikimedia,upload)/wikipedia/commons/4/4d/icon_pdf_file.png",
      );
    });

    it("timestamp に人間可読な日時を添える", () => {
      expect(valueOf(REAL_CDXJ_LINE, "timestamp")).toBe("20220831121514  (2022-08-31 12:15:14 UTC)");
    });

    it("JSON の値に空白が入っても 3 分割の境界を誤らない", () => {
      // 先頭 2 つの空白だけで割る。値の中の空白で割ると JSON が壊れる。
      const line = 'com,example)/ 20260101000000 {"title": "hello world again"}';
      expect(valueOf(line, "key")).toBe("com,example)/");
      expect(valueOf(line, "title")).toBe("hello world again");
    });

    it("JSON でない値は文字列化して見せる", () => {
      const line = 'com,example)/ 20260101000000 {"n": 42, "ok": true, "list": [1, 2]}';
      expect(valueOf(line, "n")).toBe("42");
      expect(valueOf(line, "ok")).toBe("true");
      expect(valueOf(line, "list")).toBe("[1,2]");
    });
  });

  describe("JSONL", () => {
    it("行全体が JSON object なら field だけに割る", () => {
      const fields = explodeLine(REAL_JSONL_LINE);
      expect(fields.map((f) => f.label)).toEqual(["id", "url", "ts", "title"]);
      expect(fields.every((f) => f.fromJson)).toBe(true);
    });
  });

  describe("割れない行", () => {
    // ここが効いていないと、想定外の中身を開いた瞬間に何も出なくなる。
    const raw = (line: string): string | undefined => valueOf(line, "line");

    it("ただのテキストはそのまま 1 field", () => {
      expect(raw("WARC/1.0")).toBe("WARC/1.0");
    });

    it("JSON が壊れていても落ちない", () => {
      const broken = 'com,example)/ 20260101000000 {"url": "https://x/", ';
      expect(raw(broken)).toBe(broken);
    });

    it("JSON 風でも object でなければ割らない", () => {
      expect(raw("[1, 2, 3]")).toBe("[1, 2, 3]");
      expect(raw("null")).toBe("null");
    });

    it("空行でも field が 1 つは返る", () => {
      // 0 個返すと呼び手が「何も描かない」分岐を持つことになる。
      expect(explodeLine("")).toHaveLength(1);
      expect(raw("")).toBe("");
    });

    it("空白が 1 つしかない行は CDXJ ではない", () => {
      expect(raw('key {"a": 1}')).toBe('key {"a": 1}');
    });
  });

  it("どんな入力でも 1 つ以上の field を返す", () => {
    for (const line of ["", " ", "x", "{}", "{", REAL_CDXJ_LINE, REAL_JSONL_LINE]) {
      expect(explodeLine(line).length, JSON.stringify(line)).toBeGreaterThan(0);
    }
  });
});
