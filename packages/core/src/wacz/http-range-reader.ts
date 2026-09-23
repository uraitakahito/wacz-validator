/**
 * HttpRangeReader
 *
 * yauzl-promise の `Reader` を実装し、http(s) 上の WACZ を range GET で読む。
 * `httpTransport` (wacz/transport.ts) がこの reader を `yauzl.fromReader` に渡す。
 * {@link S3RangeReader} と同じ役割で、違うのは「誰に訊くか」だけ。
 *
 * ## HEAD を使わない
 *
 * S3 版は `HeadObjectCommand` で `ContentLength` を先に取るが、**署名付き URL では
 * HEAD が 403 になる** —— 署名は GET に対して作られているため (実測: capture-ledger が
 * 発行した URL に `curl -I` で 403、同じ URL への range GET は 206)。
 *
 * ## 末尾を 1 往復で取って、持っておく
 *
 * yauzl は EOCD → 中央ディレクトリ → entry ごとの見出し、と小さな読みを重ねる。
 * それをそのまま GET にすると、**1 ファイル開くたびに 18 往復**になった (7 entry の
 * WACZ・実測)。うち 14 は、2 往復目で取った末尾 64 KiB の**内側**の読み直し。
 *
 * 最初の 1 往復を末尾から (`bytes=-65557`) にすれば、総サイズ (`Content-Range` の
 * 分母) と末尾の両方が一度に手に入る。以後、末尾の内側の読みは往復しない。
 * 65,557 B は EOCD が入りうる最大 —— 固定部 22 B ＋ コメント 65,535 B。
 *
 * ## 本文は流す
 *
 * `_createReadStream` は範囲を 1 回の `arrayBuffer()` で受けていた。それだと
 * 6 MiB の WARC の頭 100 行が欲しいだけでも 6 MiB 全部を待つ。本文を chunk で流し、
 * 読み手が閉じたら abort する —— 読まなかった分は、届かない。
 *
 * ## 206 でなければ止まる
 *
 * Range を無視する相手は **200 で全体を返す**。それを「指定した範囲」として扱うと、
 * ZIP の中央ディレクトリを本文の先頭から読むことになり、**壊れた WACZ に見える** ——
 * しかも「検証した」と言ってしまう。静かに間違うより、開けないほうがよい。
 */
import { Buffer } from "node:buffer";
import { Readable } from "node:stream";
import { Reader } from "yauzl-promise";

/** EOCD が入りうる末尾の最大長: 固定部 22 B ＋ コメント 65,535 B。 */
export const TAIL_BYTES = 65_557;

/** `Content-Range: bytes 0-0/11806` の `11806`。読めなければ undefined。 */
export const totalFromContentRange = (header: string | null): number | undefined => {
  const total = header?.split("/")[1];
  if (total === undefined || total === "*") return undefined;
  const size = Number(total);
  return Number.isSafeInteger(size) && size >= 0 ? size : undefined;
};

export class HttpRangeReader extends Reader {
  private readonly url: string;
  /** `openTail` が取った末尾。この内側の読みは往復しない。 */
  private tail: { start: number; bytes: Buffer } | undefined;

  constructor(url: string) {
    super();
    this.url = url;
  }

  /**
   * 末尾 {@link TAIL_BYTES} を取り、総サイズを返す。`fromReader` が size を必須で
   * 要求するので open の前に 1 往復は要る —— その 1 往復で末尾も手に入れる。
   * 総サイズが末尾より小さければ、ファイル全体が手元に来る (それ以上は往復しない)。
   */
  async openTail(): Promise<number> {
    const response = await this.fetchRange(`bytes=-${String(TAIL_BYTES)}`);
    const size = totalFromContentRange(response.headers.get("content-range"));
    if (size === undefined) {
      throw new Error(`no usable Content-Range for ${this.redacted()}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    this.tail = { start: size - bytes.length, bytes };
    return size;
  }

  /** 範囲が丸ごと末尾の内側なら、その写しを返す。 */
  private fromTail(start: number, length: number): Buffer | undefined {
    const tail = this.tail;
    if (tail === undefined) return undefined;
    const from = start - tail.start;
    if (from < 0 || from + length > tail.bytes.length) return undefined;
    return tail.bytes.subarray(from, from + length);
  }

  private async fetchRange(range: string, signal?: AbortSignal): Promise<Response> {
    const response = await fetch(this.url, {
      headers: { range },
      ...(signal !== undefined && { signal }),
    });
    // **206 だけを受ける。** 200 は「Range を無視して全体を返した」で、
    // そのまま読むと別の場所のバイト列を指定した範囲だと思い込む。
    if (response.status !== 206) {
      throw new Error(
        `expected 206 for ${range}, got ${String(response.status)} from ${this.redacted()}`,
      );
    }
    return response;
  }

  /** 失敗の文に URL を出すとき、**query を落とす** —— 署名が混じっているため。 */
  private redacted(): string {
    try {
      const parsed = new URL(this.url);
      parsed.search = "";
      return parsed.toString();
    } catch {
      return "(unparsable url)";
    }
  }

  override async _read(start: number, length: number): Promise<Buffer> {
    const cached = this.fromTail(start, length);
    if (cached !== undefined) return cached;
    const response = await this.fetchRange(`bytes=${String(start)}-${String(start + length - 1)}`);
    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * yauzl が `openReadStream` 経由で entry body を読むときに使う。
   * `Readable.from(asyncGenerator)` にすることで、consume されるまで GET は走らない
   * (S3 版と同じ作法)。読み手が閉じたら abort する —— 残りは届かない。
   *
   * abort は **destroy されたその場**で起こす。`'close'` を待つ形だと、相手が黙って
   * いる間は来ない —— `Readable.from` の `_destroy` は generator の return を待ち、
   * return は次の chunk を待つ。止めたのに繋ぎっぱなし、になる。
   */
  override _createReadStream(start: number, length: number): Readable {
    const cached = this.fromTail(start, length);
    if (cached !== undefined) return Readable.from([cached]);
    const abort = new AbortController();
    const stream = Readable.from(this.chunks(start, length, abort.signal));
    const destroy = stream._destroy.bind(stream);
    stream._destroy = (error, callback) => {
      abort.abort();
      destroy(error, callback);
    };
    return stream;
  }

  private async *chunks(start: number, length: number, signal: AbortSignal): AsyncGenerator<Buffer> {
    let response: Response;
    try {
      response = await this.fetchRange(`bytes=${String(start)}-${String(start + length - 1)}`, signal);
    } catch (cause) {
      // 自分で止めた abort は失敗ではない。
      if (signal.aborted) return;
      throw cause;
    }
    const body = response.body;
    if (body === null) return;
    try {
      for await (const chunk of body) yield Buffer.from(chunk);
    } catch (cause) {
      // 同上。それ以外 (途中で切れた等) はそのまま。
      if (!signal.aborted) throw cause;
    }
  }
}
