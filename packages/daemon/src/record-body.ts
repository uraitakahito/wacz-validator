/**
 * レコードの本文を「画面に返せる形」に整える純ロジック。
 *
 * 方針: gzip のメンバは展開してから見る (出力 cap で打ち切るので展開 bomb に強い)。
 * raster の画像は `image` として大きさだけ返し、実体は REST の `/record/body` が
 * bytes で返す。テキストでないバイトは文字化けさせず `binary` (大きさだけ)。
 * I/O は持たず Buffer だけで完結するので hermetic にテストできる。
 */
import { createGunzip } from "node:zlib";
import type { RecordBody } from "@wacz-validator/protocol";

/** NUL の手前にこれ未満しかテキストが無ければ、プレビューに値しない=バイナリ扱い。 */
const TEXT_MIN = 16;

/**
 * `<img>` で描いてよい画像。SVG は入れない —— XML であり script を含みうるので、
 * 受け取った画面のオリジンで動いてしまう。SVG は text として見せる。
 */
export const RASTER: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);

/** 先頭 2 byte が gzip マジック(1f 8b)か。 */
export const isGzip = (b: Buffer): boolean => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;

/**
 * head が UTF-8 テキストとして妥当か。cap 境界で割れた末尾のマルチバイト 1 文字は
 * 許容するため、末尾を最大 3 byte 落として strict デコードを試す。内部に不正バイトが
 * あれば(画像・圧縮データ等)false。
 */
export const isTextUtf8 = (head: Buffer): boolean => {
  for (let drop = 0; drop <= 3 && drop <= head.length; drop++) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(head.subarray(0, head.length - drop));
      return true;
    } catch {
      // 末尾が不完全なマルチバイトかもしれないので 1 byte 削って再試行。
    }
  }
  return false;
};

/**
 * gzip を展開しつつ出力を cap byte で打ち切る(展開 bomb 対策)。
 * cap 到達で早期に stream を destroy する。壊れた gzip は reject。
 * WACZ の `.warc.gz` は record 単位 gzip を連結した multi-member が多いが、
 * createGunzip は連結メンバを順に展開でき、cap で先頭から切るので有用な preview になる。
 */
export const gunzipCapped = (
  input: Buffer,
  cap: number,
): Promise<{ data: Buffer; truncated: boolean }> =>
  new Promise((resolve, reject) => {
    const gunzip = createGunzip();
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const finish = (truncated: boolean): void => {
      if (done) return;
      done = true;
      resolve({ data: Buffer.concat(chunks).subarray(0, cap), truncated });
    };
    gunzip.on("data", (c: Buffer) => {
      chunks.push(c);
      total += c.length;
      if (total >= cap) {
        gunzip.destroy();
        finish(true);
      }
    });
    gunzip.on("end", () => {
      finish(false);
    });
    gunzip.on("error", reject);
    gunzip.end(input);
  });

/**
 * 本文を {@link RecordBody} にする。raster の画像は mime で決める (バイトは見ない)。
 * それ以外は、最初の NUL の手前が UTF-8 なら text (textCap で切る)、でなければ binary。
 * `truncated` は展開が cap で打ち切られたときの印で、text にそのまま伝える。
 */
export const classifyBody = (
  mime: string | undefined,
  bytes: Buffer,
  textCap: number,
  truncated: boolean,
): RecordBody => {
  if (mime !== undefined && RASTER.has(mime)) {
    return { kind: "image", mime, byteLength: bytes.length };
  }
  const nul = bytes.indexOf(0);
  const region = nul === -1 ? bytes : bytes.subarray(0, nul);
  const head = region.subarray(0, textCap);
  if ((nul !== -1 && region.length < TEXT_MIN) || !isTextUtf8(head)) {
    return { kind: "binary", ...(mime !== undefined && { mime }), byteLength: bytes.length };
  }
  return {
    kind: "text",
    content: head.toString("utf-8"),
    truncated: truncated || nul !== -1 || region.length > textCap,
  };
};
