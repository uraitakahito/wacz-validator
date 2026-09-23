/**
 * バイト列を行に割る。**読み手が止めたら、その先は読まない。**
 *
 * WACZ の中身は 1 行 1 レコードの形式が多い (CDXJ・JSONL)。1 行が 400 KB を超える
 * ことも (実測: BrowserHive の `accessibility/axtree.jsonl` は 1 行 404,696 B)、
 * WARC の本文が何 MB も改行を含まないこともある。呼び手が cap を決め、超えた行は
 * 先頭 cap バイトだけを持って残りは捨てる —— 捨てる分は数えるだけで、メモリに積まない。
 *
 * - 行末は `\n`。直前の `\r` は落とし、長さにも数えない (WARC は CRLF)
 * - NUL を含む行と、UTF-8 として読めない行は `binary` —— text は空で、大きさだけ残す
 * - cap の境目で割れた多バイト文字は、末尾 3 バイトまで戻して落とす (U+FFFD を作らない)
 * - 改行で終わる入力に、空の最終行は足さない。改行の無い最後の行は出す
 *
 * I/O を持たず chunk の列だけで完結するので、hermetic に試験できる。
 */
import { Buffer } from "node:buffer";
import type { Transform } from "node:stream";

/**
 * chunk の列を zlib の stream (gunzip / inflateRaw) に通す。**pipe を使わない** ——
 * 読み手が途中で止めたとき、pipe の連鎖は「誰がいつ閉じるか」が stream の
 * 内部事情で決まり、閉じ損ねた片方が 'error' を投げて落ちる。ここでは chunk を
 * 1 つ書いて出てきた分を返す、を繰り返すだけ。止めれば finally で捨てる。
 *
 * 出てきた分は 'data' で受ける (流れる形)。読まずに write の callback を待つと、
 * 出力が 16 KiB (highWaterMark) を超えたところで Transform が callback を止め、
 * 互いに待って固まる —— 実物の datapackage.json (展開 73 KB) で実際に固まった。
 *
 * gunzip は連結メンバ (WARC.gz) も順に解く (node の既定)。壊れた入力は throw。
 */
export async function* decompress(
  chunks: AsyncIterable<Buffer>,
  make: () => Transform,
): AsyncGenerator<Buffer> {
  const z = make();
  const out: Buffer[] = [];
  z.on("data", (piece: Buffer) => {
    out.push(piece);
  });
  // 壊れた入力で zlib が落ちると、書き込みの callback は来ない (stream が destroy
  // される)。'error' と競わせて、どちらが先でも待ちが戻るようにする。
  const failure: { cause?: Error } = {};
  const failed = new Promise<void>((resolve) => {
    z.once("error", (cause: Error) => {
      failure.cause = cause;
      resolve();
    });
  });
  const settle = (run: (done: () => void) => void): Promise<void> =>
    Promise.race([
      new Promise<void>((resolve) => {
        run(resolve);
      }),
      failed,
    ]);
  const drain = function* (): Generator<Buffer> {
    for (;;) {
      const piece = out.shift();
      if (piece === undefined) return;
      yield piece;
    }
  };
  try {
    for await (const chunk of chunks) {
      await settle((done) => {
        z.write(chunk, () => {
          done();
        });
      });
      if (failure.cause !== undefined) throw failure.cause;
      yield* drain();
    }
    // 'end' は readable 側の印 —— 出てきた分をすべて 'data' で渡し終えている。
    await settle((done) => {
      z.once("end", () => {
        done();
      });
      z.end();
    });
    if (failure.cause !== undefined) throw failure.cause;
    yield* drain();
  } finally {
    z.destroy();
  }
}

export interface Line {
  text: string;
  /** cap を超えていて、text は先頭 cap バイトまで。 */
  cut: boolean;
  /** NUL を含む・UTF-8 でない。text は空。 */
  binary: boolean;
  /** 行の本来の長さ (改行と、その直前の \r を除く。切る前)。 */
  bytes: number;
}

const NL = 0x0a;
const CR = 0x0d;

/**
 * 末尾が多バイト文字の途中で終わっていたら、その文字を落とす。
 * 末尾 3 バイトまで戻る (UTF-8 の 1 文字は最長 4 バイト)。
 */
export const cutUtf8 = (bytes: Buffer): Buffer => {
  for (let back = 1; back <= 3 && back <= bytes.length; back++) {
    const b = bytes[bytes.length - back] ?? 0;
    if ((b & 0xc0) === 0x80) continue; // 続きのバイト。先頭を探してさらに戻る
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return need > back ? bytes.subarray(0, bytes.length - back) : bytes;
  }
  return bytes;
};

const strict = new TextDecoder("utf-8", { fatal: true });

/** NUL を含まず、UTF-8 として読めれば text。読めなければ undefined (= binary)。 */
const asText = (bytes: Buffer): string | undefined => {
  if (bytes.includes(0)) return undefined;
  try {
    return strict.decode(bytes);
  } catch {
    return undefined;
  }
};

/**
 * chunk の列を行に割る。`lineCap` を超える行は先頭だけを持つ。
 */
export async function* splitLines(
  chunks: AsyncIterable<Buffer>,
  lineCap: number,
): AsyncGenerator<Line> {
  // 組み立て中の 1 行。head は先頭 (合計 ≤ lineCap + 1 —— \r かどうかを見るため
  // 1 バイト余分に持つ)、dropped は cap を超えて捨てた分 (数えるだけ)。
  const cur = { head: [] as Buffer[], held: 0, dropped: 0, last: -1, started: false };

  const take = (piece: Buffer): void => {
    if (piece.length === 0) return;
    cur.started = true;
    cur.last = piece[piece.length - 1] ?? -1;
    const room = lineCap + 1 - cur.held;
    if (room > 0) {
      const kept = piece.subarray(0, room);
      cur.head.push(kept);
      cur.held += kept.length;
      cur.dropped += piece.length - kept.length;
    } else {
      cur.dropped += piece.length;
    }
  };

  const flush = (): Line => {
    const total = cur.held + cur.dropped;
    const trailingCr = cur.last === CR;
    const bytes = total - (trailingCr ? 1 : 0);
    let body: Buffer = Buffer.concat(cur.head);
    // \r が手元にあれば落とす (捨てた側に在ったなら、もう無い)
    if (trailingCr && cur.dropped === 0) body = body.subarray(0, body.length - 1);
    const cut = bytes > lineCap;
    if (cut) body = cutUtf8(body.subarray(0, lineCap));
    const text = asText(body);
    cur.head = [];
    cur.held = 0;
    cur.dropped = 0;
    cur.last = -1;
    cur.started = false;
    return text === undefined
      ? { text: "", cut, binary: true, bytes }
      : { text, cut, binary: false, bytes };
  };

  for await (const chunk of chunks) {
    let from = 0;
    while (from < chunk.length) {
      const nl = chunk.indexOf(NL, from);
      if (nl === -1) {
        take(chunk.subarray(from));
        break;
      }
      take(chunk.subarray(from, nl));
      yield flush();
      from = nl + 1;
    }
  }
  if (cur.started) yield flush();
}
