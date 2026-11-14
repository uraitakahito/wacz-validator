/**
 * WARC.gz 用の independent-gzip-member iterator。
 *
 * WARC 1.1 に従って生成された `.warc.gz` は *independent* な gzip
 * member の連結である (record 1 つにつき 1 member)。これにより CDXJ
 * index の offset/length ペアを使って、ファイルの残りを parse せず
 * 単一 record まで seek して展開できる。(WARC 1.1 §A.1。参考実装
 * として browserhive の `src/storage/warc/writer.ts:1-15` がこの
 * コントラクトを実装している。) この不変条件が成り立つかは
 * `warc/members-independent` rule が検証する。
 *
 * 検出戦略: 先頭から **順に** 解く。member ごとに header の長さを
 * 数え (RFC 1952 §2.3)、`inflateRawSync` に `info: true` を渡して
 * deflate stream が入力を何 byte 消費したかを得る。member の長さは
 * `header + 消費した byte + trailer(8)` で、次の member はその直後
 * から始まる。境界を **推測しない** のが要点。
 *
 * かつては magic bytes `1f 8b 08` を scan して境界を推測していた。
 * その方式は、magic が compressed payload の中に偶然現れると壊れる
 * —— 偽の位置は自分が落ちるのではなく、**直前の本物の member を途中
 * で切って** 落とす。頻度は 9 MB あたりおよそ 1 個 (3 byte 一致の
 * 確率は 2^-24) で、1 個で足りた: strict の iterator は最初の不良で
 * throw し、同じ iterator を loose で使う `cdxj/warc-offsets` はそこ
 * で止まるので、以降の entry が全部「対応する member が無い」に
 * なる。実測で 9 MB の WACZ に対し 573 件の誤った Issue が出ていた。
 *
 * `gunzipSync` ではなく `inflateRawSync` を使うのは、Node の gzip
 * decoder が **連結された member を一括で読む** ため —— 1 member だけ
 * 解いたつもりでも消費 byte 数がファイル全体になり、境界が得られない。
 * その代わり trailer (CRC32 + ISIZE) の検証は自前で行う。
 *
 * iterator は `WarcMember { offset, length, gzipped, raw }` を yield
 * するので、downstream の rule は CDXJ offset をクロスチェックしたり
 * (`cdxj/warc-offsets`)、`raw` から WARC header を parse して
 * payload digest を再計算したり (`warc/payload-digest`) できる。
 */
import { crc32, inflateRawSync } from "node:zlib";

const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;
/**
 * `inflateRawSync(buf, { info: true })` が実際に返す形。
 *
 * Node はこの形を返すが `@types/node` の宣言は `info` を知らないので、ここで
 * 名前を付けて cast を 1 箇所に閉じ込める。欲しいのは `bytesWritten` ——
 * deflate stream が入力を何 byte 消費したか、つまり member の終端の位置。
 */
interface InflateRawInfo {
  buffer: Buffer;
  engine: { bytesWritten: number };
}

/** compression method。Node の inflate が受けるのは DEFLATE だけ。 */
const GZIP_DEFLATE = 0x08;
/** gzip trailer: CRC32(4) + ISIZE(4)。RFC 1952 §2.2。 */
const GZIP_TRAILER_LENGTH = 8;

export interface WarcMember {
  /** Byte offset of this member's first byte in the source buffer. */
  offset: number;
  /** Length of the gzipped member in bytes. */
  length: number;
  /** The gzipped bytes (still compressed). */
  gzipped: Buffer;
  /** Decompressed payload (the raw WARC record). */
  raw: Buffer;
}

export interface IterateOptions {
  /**
   * true のとき、`gunzipSync` の失敗を呑み込み、最初の不良 member で
   * iteration を停止する。この iterator を *使う* validation rule
   * は逆を求める — strict mode を要求し、throw を Issue に変換する。
   * (人向けにエラー context を出すなど) iteration ヘルパは loose
   * モードを使ってよい。
   *
   * Default: false (不良 member で throw)。
   */
  loose?: boolean;
}

/**
 * `bytes` 内の全 gzip member を iterate する。`opts.loose !== true`
 * のとき、malformed な member で throw する。関数は generator 風で
 * (Iterable を返す)、archive 全体を 2 回メモリに展開せず呼び出し側
 * が早期停止できる。
 */
export function* iterateWarcMembers(
  bytes: Buffer,
  opts: IterateOptions = {},
): Generator<WarcMember, void, void> {
  // offset 0 に member が無いファイルは "member ゼロ" — 呼び出し側
  // (`warc/members-independent`) がそれを専用の Issue で報告するので、
  // ここで throw しない。
  if (!startsWithGzipMagic(bytes, 0)) return;

  let offset = 0;
  while (offset < bytes.length) {
    if (!startsWithGzipMagic(bytes, offset)) {
      // 前の member の終端の先に、member でないバイトが続いている。
      if (opts.loose) return;
      throw new WarcMemberDecodeError(
        offset,
        bytes.length - offset,
        new Error("trailing bytes are not a gzip member"),
      );
    }

    let length: number;
    let raw: Buffer;
    try {
      const headerLength = gzipHeaderLength(bytes, offset);
      // `info: true` は engine に「入力を何バイト読んだか」を残す。deflate の
      // stream は自己終端なので、次の member を巻き込まずにちょうど止まる。
      const { buffer, engine } = inflateRawSync(bytes.subarray(offset + headerLength), {
        info: true,
      }) as unknown as InflateRawInfo;
      // trailer は自前で検める。`gunzipSync` を使っていたころは向こうが見てくれて
      // いたが、それは member の終端を先に知っている場合の話で、ここでは終端を
      // 求めている最中なので使えない。見ないままにすると、validator が壊れた
      // member を黙って通すことになる。
      verifyGzipTrailer(bytes, offset + headerLength + engine.bytesWritten, buffer);
      raw = buffer;
      length = headerLength + engine.bytesWritten + GZIP_TRAILER_LENGTH;
    } catch (error) {
      if (opts.loose) return;
      throw new WarcMemberDecodeError(offset, bytes.length - offset, error);
    }

    yield {
      offset,
      length,
      gzipped: bytes.subarray(offset, offset + length),
      raw,
    };
    offset += length;
  }
}

/** `offset` が gzip member の頭 (`1f 8b 08`) かどうか。 */
const startsWithGzipMagic = (bytes: Buffer, offset: number): boolean =>
  offset + 2 < bytes.length &&
  bytes[offset] === GZIP_MAGIC_0 &&
  bytes[offset + 1] === GZIP_MAGIC_1 &&
  bytes[offset + 2] === GZIP_DEFLATE;

/**
 * gzip member の header の長さ (RFC 1952 §2.3)。固定部は 10 byte で、
 * FLG によって FEXTRA / FNAME / FCOMMENT / FHCRC が可変長で続く。
 *
 * これを自前で数えるのは、header の直後から deflate stream が始まる位置を
 * 知る必要があるため — `inflateRawSync` に渡す先頭がそこになる。
 */
const gzipHeaderLength = (bytes: Buffer, offset: number): number => {
  const flg = bytes[offset + 3] ?? 0;
  let p = offset + 10;
  if (flg & 0x04) {
    const xlen = (bytes[p] ?? 0) | ((bytes[p + 1] ?? 0) << 8);
    p += 2 + xlen;
  }
  if (flg & 0x08) {
    while (p < bytes.length && bytes[p] !== 0) p += 1;
    p += 1;
  }
  if (flg & 0x10) {
    while (p < bytes.length && bytes[p] !== 0) p += 1;
    p += 1;
  }
  if (flg & 0x02) p += 2;
  return p - offset;
};

/**
 * gzip member の trailer (CRC32 + ISIZE) を検証する。
 *
 * RFC 1952 §2.2 では、どちらも little-endian の 4 byte。ISIZE は 2^32 を法とした
 * 展開後の長さ。合わなければ throw する — 呼ぶ側がそれを `WarcMemberDecodeError`
 * に包む。
 */
const verifyGzipTrailer = (bytes: Buffer, trailerStart: number, inflated: Buffer): void => {
  if (trailerStart + GZIP_TRAILER_LENGTH > bytes.length) {
    throw new Error("gzip member is truncated: no room for its trailer");
  }
  const expectedCrc = bytes.readUInt32LE(trailerStart);
  const actualCrc = crc32(inflated);
  if (expectedCrc !== actualCrc) {
    throw new Error(
      `gzip member CRC32 mismatch: trailer says ${String(expectedCrc)}, payload hashes to ${String(actualCrc)}`,
    );
  }
  const expectedSize = bytes.readUInt32LE(trailerStart + 4);
  const actualSize = inflated.length >>> 0;
  if (expectedSize !== actualSize) {
    throw new Error(
      `gzip member ISIZE mismatch: trailer says ${String(expectedSize)}, payload is ${String(actualSize)} bytes`,
    );
  }
};

export class WarcMemberDecodeError extends Error {
  override readonly name = "WarcMemberDecodeError";
  readonly offset: number;
  readonly length: number;
  // `Error` 自身は optional な `cause` (ES2022) を持つ。`override`
  // を付けて narrow した (常に存在する) 型で再宣言することで、
  // throw 側が型付きアクセスを失わずに元の失敗を attach できる。
  override readonly cause: unknown;
  constructor(offset: number, length: number, cause: unknown) {
    super(`Failed to decode gzip member at offset ${String(offset)} (length ${String(length)})`);
    this.offset = offset;
    this.length = length;
    this.cause = cause;
  }
}
