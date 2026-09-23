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
 * 総サイズは **最初の range GET の `Content-Range`** から読む ({@link probeSize})。
 * `bytes 0-0/11806` の `/` の後ろが全体の長さ。
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

/** `Content-Range: bytes 0-0/11806` の `11806`。読めなければ undefined。 */
export const totalFromContentRange = (header: string | null): number | undefined => {
  const total = header?.split("/")[1];
  if (total === undefined || total === "*") return undefined;
  const size = Number(total);
  return Number.isSafeInteger(size) && size >= 0 ? size : undefined;
};

export class HttpRangeReader extends Reader {
  private readonly url: string;

  constructor(url: string) {
    super();
    this.url = url;
  }

  /**
   * 総サイズを 1 バイトだけ取って調べる。`fromReader` が size を必須で要求するので、
   * open の前に 1 往復だけ必要になる。
   */
  async probeSize(): Promise<number> {
    const response = await this.range(0, 0);
    const size = totalFromContentRange(response.headers.get("content-range"));
    if (size === undefined) {
      throw new Error(`no usable Content-Range for ${this.redacted()}`);
    }
    return size;
  }

  private async range(start: number, end: number): Promise<Response> {
    const response = await fetch(this.url, {
      headers: { range: `bytes=${String(start)}-${String(end)}` },
    });
    // **206 だけを受ける。** 200 は「Range を無視して全体を返した」で、
    // そのまま読むと別の場所のバイト列を指定した範囲だと思い込む。
    if (response.status !== 206) {
      throw new Error(
        `expected 206 for bytes=${String(start)}-${String(end)}, got ${String(response.status)} ` +
          `from ${this.redacted()}`,
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
    const response = await this.range(start, start + length - 1);
    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * yauzl が `openReadStream` 経由で entry body を読むときに使う。
   * `Readable.from(asyncGenerator)` にすることで、consume されるまで GET は走らない
   * (S3 版と同じ作法)。
   */
  override _createReadStream(start: number, length: number): Readable {
    return Readable.from(this.streamForRange(start, length));
  }

  private async *streamForRange(start: number, length: number): AsyncGenerator<Buffer> {
    yield await this._read(start, length);
  }
}
