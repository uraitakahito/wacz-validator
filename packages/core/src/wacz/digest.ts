/**
 * WACZ validation 用の SHA-256 helper。
 *
 * WACZ は 2 つの異なる digest フォーマットを使う:
 *   - `datapackage.json` resource hash:    `sha256:<hex>`     (この module)
 *   - WARC `WARC-Payload-Digest` header:   `sha256:<base32>`  (`warc/payload-digest`
 *                                                              rule が使う。rule は
 *                                                              Base16 の値も読む)
 *
 * 後で片方を触る人にこの非対称性が見えるよう、2 形式を 1 モジュール
 * にまとめている。
 */
import { createHash } from "node:crypto";

/**
 * 与えた bytes に対する `sha256:<hex>`。WACZ `datapackage.json` が
 * 埋め込む Frictionless Data Package descriptor が指定するフォーマット。
 */
export const sha256Hex = (bytes: Buffer): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/**
 * 与えた bytes に対する `sha256:<base32>` — WARC-Payload-Digest
 * フォーマット (RFC 4648 base32、padding なし、uppercase)。
 * `warc/payload-digest` rule が使う。hex バージョンの近くに置いて
 * 両者の encoding が同期するようにしておく。
 */
export const sha256Base32 = (bytes: Buffer): string => {
  const digest = createHash("sha256").update(bytes).digest();
  return `sha256:${toBase32(digest)}`;
};

/**
 * RFC 4648 base32 encoder (padding なし)。依存関係を取らずに inline
 * してある: 純粋なロジックで 30 行ほどなので、推移的依存を増やす
 * 価値はない。
 */
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const toBase32 = (bytes: Buffer): string => {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      // BASE32_ALPHABET はちょうど 32 文字。5-bit 値は 0..31 にしか
      // index しないので lookup は total — `!` は安全。
      const ch = BASE32_ALPHABET[(value >> bits) & 0x1f];
      if (ch !== undefined) output += ch;
    }
  }
  if (bits > 0) {
    const ch = BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
    if (ch !== undefined) output += ch;
  }
  return output;
};
