/**
 * スクリーンショット（BrowserHive WARC Profile 1.3.0 の #screenshots）のレコードを読むための共有部分:
 * `WARC-Target-URI` の形、metadata の欄の書式、block の WebP の頭。
 *
 * rule ではないので `rules/` には置かない —— docs の抽出器は `rules/` 配下の `.ts` をすべて rule と見なし、
 * `name` と `conformance` を読めないファイルがあると落ちる (`browserhive-snapshot-html.ts` と同じ理由)。
 *
 * Spec: https://uraitakahito.github.io/browserhive-warc-spec/1.3.0/#screenshots
 */

/** スクリーンショットの `WARC-Target-URI` の頭。後ろに時点、`:`、その時点の文書の URL（fragment 無し）が続く。 */
export const SCREENSHOT_URI = "urn:browserhive:screenshot:";

/** この版が定める時点。`screenshot` の欄の値で、URI の中にも同じ字で入る。 */
export const SCREENSHOT_STAGES: readonly string[] = ["after-load", "after-behaviors"];

/** `viewport`・`image-size` の値（仕様の ABNF の `size`）: 幅、小文字の `x`、高さ。どちらも 1 以上の 10 進で、先頭に 0 が無い。 */
export const SCREENSHOT_SIZE = /^([1-9]\d*)x([1-9]\d*)$/;

/**
 * `device-pixel-ratio` の値（仕様の ABNF の `ratio`）: 0 より大きい 10 進で、指数が無く、省ける 0 を持たない
 * （`2`・`1.5`・`0.5`。`2.0`・`1.50`・`02`・`0` は通らない）。
 */
export const SCREENSHOT_RATIO = /^(?:[1-9]\d*(?:\.\d*[1-9])?|0\.\d*[1-9])$/;

/**
 * スクリーンショットの `WARC-Target-URI` を時点と文書の URL に分ける。頭が違うか、時点がこの版の定める物で
 * ないか、URL が空なら `undefined`。
 */
export const parseScreenshotUri = (uri: string): { stage: string; url: string } | undefined => {
  if (!uri.startsWith(SCREENSHOT_URI)) return undefined;
  const rest = uri.slice(SCREENSHOT_URI.length);
  const stage = SCREENSHOT_STAGES.find((s) => rest.startsWith(`${s}:`));
  if (stage === undefined) return undefined;
  const url = rest.slice(stage.length + 1);
  return url === "" ? undefined : { stage, url };
};

/** `1280x800` の形の値を幅と高さに読む。形が違えば `undefined`。 */
export const parseScreenshotSize = (value: string): { width: number; height: number } | undefined => {
  const match = SCREENSHOT_SIZE.exec(value);
  return match === null ? undefined : { width: Number(match[1]), height: Number(match[2]) };
};

/** WebP の頭を読んだ答え。静止画なら幅と高さ、そうでなければ理由。 */
export type WebpStill =
  | { readonly kind: "still"; readonly width: number; readonly height: number }
  /** WebP として読めない: `RIFF`…`WEBP` で始まらない、最初の chunk を知らない、頭が途中で切れている。 */
  | { readonly kind: "not-webp" }
  /** WebP だが、animation の旗が立っている。 */
  | { readonly kind: "animated" };

const NOT_WEBP: WebpStill = { kind: "not-webp" };

/** `VP8X` の旗のうち animation。 */
const VP8X_ANIMATION = 0x02;

/**
 * block が WebP の静止画かを、頭だけから読む（画像は decode しない）。
 *
 * WebP は RIFF の入れ物: `RIFF`、後ろの長さ（4 バイト、little-endian）、`WEBP`、その後に chunk が並ぶ。最初の chunk が
 * 画像の種類を決め、幅と高さもそこに在る:
 *
 *   - `VP8 `（lossy）: frame tag 3 バイト、start code `9d 01 2a`、幅と高さが 14 bit ずつ（上の 2 bit は拡大の指定）
 *   - `VP8L`（lossless）: signature `2f`、続く 32 bit に「幅 − 1」「高さ − 1」が 14 bit ずつ
 *   - `VP8X`（extended）: 旗 1 バイト、予約 3 バイト、「幅 − 1」「高さ − 1」が 24 bit ずつ。旗の animation が
 *     立っていれば静止画ではない
 *
 * RIFF が名乗る長さより block が短ければ、画像は途中で切れている。長いこと（後ろの余り）は言わない —— WebP の
 * 読み手は余りを無視してよい。
 */
export const readWebpStill = (block: Buffer): WebpStill => {
  if (block.length < 20) return NOT_WEBP;
  if (block.toString("latin1", 0, 4) !== "RIFF" || block.toString("latin1", 8, 12) !== "WEBP") return NOT_WEBP;
  if (block.readUInt32LE(4) + 8 > block.length) return NOT_WEBP;

  const chunk = block.toString("latin1", 12, 16);
  const data = block.subarray(20);
  if (chunk === "VP8 ") {
    if (data.length < 10 || data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) return NOT_WEBP;
    return { kind: "still", width: data.readUInt16LE(6) & 0x3fff, height: data.readUInt16LE(8) & 0x3fff };
  }
  if (chunk === "VP8L") {
    if (data.length < 5 || data[0] !== 0x2f) return NOT_WEBP;
    const bits = data.readUInt32LE(1);
    return { kind: "still", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    if (data.length < 10) return NOT_WEBP;
    if (((data[0] ?? 0) & VP8X_ANIMATION) !== 0) return { kind: "animated" };
    return { kind: "still", width: data.readUIntLE(4, 3) + 1, height: data.readUIntLE(7, 3) + 1 };
  }
  return NOT_WEBP;
};

/**
 * 画像の縦横の比が、pixel への丸めを除いて viewport と同じか。同じ倍率 s で、幅も高さも viewport の s 倍から
 * 1 pixel 未満しか離れていない、という s が在るかを見る（切り捨て・切り上げ・四捨五入のどれで丸めても通る）。
 */
export const sameAspect = (
  image: { width: number; height: number },
  viewport: { width: number; height: number },
): boolean =>
  (image.width - 1) * viewport.height < (image.height + 1) * viewport.width &&
  (image.height - 1) * viewport.width < (image.width + 1) * viewport.height;
