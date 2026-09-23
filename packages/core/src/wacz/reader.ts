/**
 * WaczReader
 *
 * WACZ に合わせた accessor を提供する。
 *
 * reader は `close()` が呼ばれるまで ZIP handle を開きっぱなしにする
 * — rule runner はこれを `finally` で行うので、validation 失敗で fd
 * を漏らさない。
 *
 * `source` field は「この reader を開いた origin」を保持する。
 * `runValidation` は `Report.source` をここから取るので、caller は
 * runValidation に source を別途渡す必要がない (single source of truth)。
 */
import type { Readable } from "node:stream";
import { createGunzip, createInflateRaw } from "node:zlib";
import type { Entry, ZipFile } from "yauzl-promise";
import type { ReportSource } from "../validate/domain.js";
import { decompress, splitLines, type Line } from "./lines.js";
import type { WaczTransport } from "./transport.js";

/**
 * ZIP spec (PKWARE APPNOTE.TXT §4.4.5) の compression method 番号。
 * WACZ では今のところ STORE (無圧縮) と DEFLATE の 2 つしか登場しない。
 */
export const ZIP_COMPRESSION_STORE = 0;
export const ZIP_COMPRESSION_DEFLATE = 8;

export interface ZipEntryMeta {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
}

/** `openLines` が返す、行の流れ。先頭の chunk を見てから返すので `gunzipped` は確定している。 */
export interface LineStream {
  /** 中身が gzip だったので展開している (`.warc.gz` 等)。 */
  gunzipped: boolean;
  lines: AsyncGenerator<Line>;
}

/** 先頭 2 バイトが gzip のマジック (1f 8b) か。 */
const isGzip = (bytes: Buffer): boolean => bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;

/** stream を最後まで読んで 1 つの Buffer に。 */
const collect = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
};

export class WaczReader {
  readonly source: ReportSource;
  private readonly zip: ZipFile;
  private readonly entries: Map<string, Entry>;
  /** `openLines` が開いた元の stream。閉じ忘れは `close()` が片付ける。 */
  private readonly open = new Set<Readable>();

  private constructor(zip: ZipFile, entries: Map<string, Entry>, source: ReportSource) {
    this.zip = zip;
    this.entries = entries;
    this.source = source;
  }

  /**
   * transport から `ZipFile` をもらって `WaczReader` を組み立てる薄い
   * factory。「どう開くか」(file / s3 / 将来の transport) は
   * `WaczTransport` 実装が持ち、ここは transport-agnostic。reader の
   * identity (`source`) も `transport.source` から取る。
   *
   * raw な string (CLI argv 等) から開きたい場合は `parseReportSource`
   * で `ReportSource` を得て `fileTransport` / `s3Transport` を選ぶ
   * (cli.ts の `openWacz` 参照)。
   */
  static async open(transport: WaczTransport): Promise<WaczReader> {
    const zip = await transport.openZip();
    return WaczReader.fromZipHandle(zip, transport.source);
  }

  /**
   * 開いた `ZipFile` から entries map を作って `WaczReader` を組み立てる
   * 共通処理。file / s3 の 2 path どちらでも、 ZIP handle 取得まで終われば
   * あとは同じ手順 (ZIP の async iterator を 1 回 drain して filename →
   * Entry の Map にする) になるので、ここに集約する。
   */
  private static async fromZipHandle(
    zip: ZipFile,
    source: ReportSource,
  ): Promise<WaczReader> {
    const entries = new Map<string, Entry>();
    for await (const entry of zip) {
      entries.set(entry.filename, entry);
    }
    return new WaczReader(zip, entries, source);
  }

  entryNames(): string[] {
    return Array.from(this.entries.keys());
  }

  hasEntry(name: string): boolean {
    return this.entries.has(name);
  }

  /**
   * payload を読まずに entry ごとの metadata を返す。entry が ZIP
   * にどう格納されているかだけを気にする rule が使う (例: rule #6 —
   * WARC は STORE であるべきで、内側の gzip を二重圧縮しないため)。
   */
  getEntryMeta(name: string): ZipEntryMeta | undefined {
    const entry = this.entries.get(name);
    if (!entry) return undefined;
    return {
      name: entry.filename,
      compressionMethod: entry.compressionMethod,
      compressedSize: entry.compressedSize,
      uncompressedSize: entry.uncompressedSize,
    };
  }

  /**
   * entry の uncompressed payload 全体を読む。実運用上 WACZ
   * archive は producer 側の上限で抑えられている (browserhive: 200 MB、
   * pywb / browsertrix-crawler: 設定可能だがほとんど数 GB 以下)
   * ので、entry 全体を Buffer に積むのが今は許容される — もし
   * multi-GB archive を検証する必要が出てきたら、stream + on-the-fly
   * hashing の複雑さを取りに行く価値が出てくる。
   */
  async readEntry(name: string): Promise<Buffer | undefined> {
    const entry = this.entries.get(name);
    if (!entry) return undefined;
    return collect(await entry.openReadStream());
  }

  /**
   * entry を行で**流す**。呼び手が途中で止めれば、その先は読まない —— `readEntry` が
   * 丸ごと積むのに対し、こちらは要る行ぶんの GET で済む (transport が流す形なら)。
   *
   * 展開はここでやる (`decompress: false` で生のまま受ける)。yauzl の CRC 検査は
   * 末尾まで読まないと意味を持たず、途中で止める読みには要らない。中身が gzip
   * (`.warc.gz` 等) なら、先頭 2 バイトを見て展開する —— node の gunzip は
   * 連結メンバも順に解く。
   *
   * 止めるときは、**元の stream を先に閉じる**。中の段 (展開・行割り) から畳むと、
   * 次の chunk を待っている段が「相手が黙っている間」戻らない。元を閉じれば
   * その待ちが戻り、そこから畳める。yauzl は「読んでいる最中の close」を assert で
   * 止める (`Reader.readCount`) ので、閉じ忘れは `close()` も拾う。
   */
  async openLines(name: string, lineCap: number): Promise<LineStream | undefined> {
    const entry = this.entries.get(name);
    if (!entry) return undefined;
    const source = await entry.openReadStream({ decompress: false, validateCrc32: false });
    this.open.add(source);
    source.once("close", () => {
      this.open.delete(source);
    });
    const raw = source as AsyncIterable<Buffer>;
    const inflated =
      entry.compressionMethod === ZIP_COMPRESSION_DEFLATE
        ? decompress(raw, createInflateRaw)
        : raw;
    const iterator = inflated[Symbol.asyncIterator]();
    const first = await iterator.next();
    const gunzipped = !first.done && isGzip(first.value);
    // 先頭の chunk を見てから、残りを続ける列。元が閉じられて待ちが失敗しても、
    // それは止めた側の都合なので、静かに終わる。
    const rest = async function* (): AsyncGenerator<Buffer> {
      if (first.done) return;
      yield first.value;
      for (;;) {
        let next: IteratorResult<Buffer>;
        try {
          next = await iterator.next();
        } catch (cause) {
          if (source.destroyed) return;
          throw cause;
        }
        if (next.done) return;
        yield next.value;
      }
    };
    const inner = splitLines(gunzipped ? decompress(rest(), createGunzip) : rest(), lineCap);
    const lines = async function* (): AsyncGenerator<Line> {
      try {
        for (;;) {
          const line = await inner.next();
          if (line.done) return;
          yield line.value;
        }
      } finally {
        if (!source.destroyed) source.destroy();
        await inner.return(undefined);
      }
    };
    return { gunzipped, lines: lines() };
  }

  /**
   * STORE の entry から範囲を切る。WARC の 1 メンバ (索引の offset / length) を
   * 1 往復で読むための口。DEFLATE の entry は先頭から展開しないと位置が決まらない
   * ので、名指しで断る。
   */
  async member(name: string, offset: number, length: number): Promise<Buffer> {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`no entry: ${name}`);
    if (entry.compressionMethod !== ZIP_COMPRESSION_STORE) {
      throw new Error(
        `${name} is not STORE (method ${String(entry.compressionMethod)}) — a range cannot be cut from a compressed entry`,
      );
    }
    if (offset < 0 || length <= 0 || offset + length > entry.compressedSize) {
      throw new Error(
        `range ${String(offset)}+${String(length)} is outside ${name} (${String(entry.compressedSize)} B)`,
      );
    }
    // yauzl の start / end は「展開しない・CRC を見ない」ときだけ許される。STORE でも
    // validateCrc32 の既定は true なので、明示して外す (外さないと assert で落ちる)。
    const stream = await entry.openReadStream({
      start: offset,
      end: offset + length,
      validateCrc32: false,
    });
    return collect(stream);
  }

  async close(): Promise<void> {
    for (const stream of this.open) {
      if (!stream.destroyed) stream.destroy();
    }
    this.open.clear();
    await this.zip.close();
  }
}
