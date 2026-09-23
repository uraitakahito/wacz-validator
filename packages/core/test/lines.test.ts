// @module-tag wacz
/**
 * `splitLines` (バイト列 → 行) の純関数テスト。I/O を持たないので常時走る。
 *
 * 見るもの: chunk の境目、CRLF、cap で切ること、cap の境目の多バイト文字、
 * binary の判定、最後の行の扱い、そして**読み手が止めたら先を読まないこと**。
 */
import { Buffer } from "node:buffer";
import { setImmediate as pause } from "node:timers/promises";
import { createGunzip, createInflateRaw, deflateRawSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { cutUtf8, decompress, splitLines, type Line } from "../src/wacz/lines.js";

/** chunk を 1 つずつ、tick を挟んで渡す (本物の stream と同じく、届くのは非同期)。 */
const chunks = async function* (parts: (string | Buffer)[]): AsyncGenerator<Buffer> {
  for (const part of parts) {
    await pause();
    yield typeof part === "string" ? Buffer.from(part, "utf-8") : part;
  }
};

const all = async (parts: (string | Buffer)[], cap = 1024): Promise<Line[]> => {
  const out: Line[] = [];
  for await (const line of splitLines(chunks(parts), cap)) out.push(line);
  return out;
};

const texts = async (parts: (string | Buffer)[], cap = 1024): Promise<string[]> =>
  (await all(parts, cap)).map((line) => line.text);

describe("splitLines", () => {
  it("chunk の境目をまたぐ行を 1 行にする", async () => {
    expect(await texts(["ab", "c\nde", "f\n"])).toEqual(["abc", "def"]);
  });

  it("CRLF の \\r を落とし、長さにも数えない", async () => {
    const lines = await all(["a\r\nbc\r\n"]);
    expect(lines.map((l) => l.text)).toEqual(["a", "bc"]);
    expect(lines.map((l) => l.bytes)).toEqual([1, 2]);
  });

  it("cap を超えた行は先頭だけを持ち、cut にする —— 本来の長さは残す", async () => {
    const lines = await all(["abcdefgh\nxy\n"], 4);
    expect(lines[0]).toEqual({ text: "abcd", cut: true, binary: false, bytes: 8 });
    expect(lines[1]).toEqual({ text: "xy", cut: false, binary: false, bytes: 2 });
  });

  it("ちょうど cap の行は切らない (\\r が付いていても)", async () => {
    const lines = await all(["abcd\r\nabcde\n"], 4);
    expect(lines[0]).toEqual({ text: "abcd", cut: false, binary: false, bytes: 4 });
    expect(lines[1]).toEqual({ text: "abcd", cut: true, binary: false, bytes: 5 });
  });

  it("cap の境目で割れた多バイト文字を落とす (U+FFFD を作らない)", async () => {
    // あ = E3 81 82、い = E3 81 84。cap 4 は「い」の 1 バイト目で切れる。
    const [line] = await all(["あい\n"], 4);
    expect(line?.text).toBe("あ");
    expect(line?.text.includes("�")).toBe(false);
    expect(line?.cut).toBe(true);
    expect(line?.bytes).toBe(6);
  });

  it("NUL を含む行は binary —— text は空、大きさだけ残す", async () => {
    const [line] = await all([Buffer.from([0x61, 0x00, 0x62, 0x0a])]);
    expect(line).toEqual({ text: "", cut: false, binary: true, bytes: 3 });
  });

  it("UTF-8 でない行は binary", async () => {
    const [line] = await all([Buffer.from([0xff, 0xfe, 0x41, 0x0a])]);
    expect(line?.binary).toBe(true);
    expect(line?.text).toBe("");
  });

  it("改行の無い最後の行は出し、改行で終わる入力に空行は足さない", async () => {
    expect(await texts(["a\nb"])).toEqual(["a", "b"]);
    expect(await texts(["a\n"])).toEqual(["a"]);
    expect(await texts(["a\n\n"])).toEqual(["a", ""]);
  });

  it("空の入力は 0 行", async () => {
    expect(await texts([])).toEqual([]);
    expect(await texts([""])).toEqual([]);
  });

  it("読み手が止めたら、その先の chunk を読まない", async () => {
    let pulled = 0;
    const counting = async function* (): AsyncGenerator<Buffer> {
      for (const part of ["x\n", "y\n", "z\n"]) {
        await pause();
        pulled++;
        yield Buffer.from(part, "utf-8");
      }
    };
    for await (const line of splitLines(counting(), 1024)) {
      expect(line.text).toBe("x");
      break;
    }
    expect(pulled).toBe(1);
  });
});

describe("decompress", () => {
  const gather = async (chunks: AsyncIterable<Buffer>): Promise<string> => {
    const out: Buffer[] = [];
    for await (const chunk of chunks) out.push(chunk);
    return Buffer.concat(out).toString("utf-8");
  };

  it("gzip の連結メンバを、chunk の境目に関わらず順に解く", async () => {
    const two = Buffer.concat([gzipSync("hello "), gzipSync("world")]);
    const parts = [two.subarray(0, 7), two.subarray(7, 20), two.subarray(20)];
    expect(await gather(decompress(chunks(parts), createGunzip))).toBe("hello world");
  });

  it("ZIP の DEFLATE (raw) を解く", async () => {
    const raw = deflateRawSync(Buffer.from("deflate-raw works"));
    expect(await gather(decompress(chunks([raw]), createInflateRaw))).toBe("deflate-raw works");
  });

  it("壊れた入力は throw する (黙って空にしない)", async () => {
    await expect(gather(decompress(chunks(["not gzip at all"]), createGunzip))).rejects.toThrow();
  });

  it("読み手が止めたら、その先の chunk を読まない", async () => {
    let pulled = 0;
    const counting = async function* (): AsyncGenerator<Buffer> {
      for (const text of ["one\n", "two\n", "three\n"]) {
        await pause();
        pulled++;
        yield gzipSync(text);
      }
    };
    for await (const line of splitLines(decompress(counting(), createGunzip), 1024)) {
      expect(line.text).toBe("one");
      break;
    }
    expect(pulled).toBe(1);
  });
});

describe("cutUtf8", () => {
  it("末尾が完全な文字なら何もしない", () => {
    expect(cutUtf8(Buffer.from("aあ", "utf-8")).toString("utf-8")).toBe("aあ");
  });

  it("末尾の途中で切れた文字を落とす (2・3・4 バイト)", () => {
    for (const ch of ["é", "あ", "😀"]) {
      const whole = Buffer.from(`a${ch}`, "utf-8");
      for (let keep = 1; keep < whole.length - 1; keep++) {
        expect(cutUtf8(whole.subarray(0, 1 + keep)).toString("utf-8")).toBe("a");
      }
    }
  });
});
