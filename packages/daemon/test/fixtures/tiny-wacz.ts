/**
 * daemon の試験用の、手で組む小さな WACZ。
 *
 * core の generator は core の test にしか無く、corpus の標本は応答レコードを持たない。
 * 窓の口を hermetic に試すには「切れる長さの行」「binary の行」「画像の応答」
 * 「索引が指す/指さないレコード」が要るので、STORE だけの ZIP をここで書く
 * (ローカル見出し・中央ディレクトリ・EOCD。ZIP64 無し)。
 */
import { Buffer } from "node:buffer";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { crc32, gzipSync } from "node:zlib";

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const EOCD = 0x06054b50;

/** STORE だけの ZIP。yauzl は STORE でも CRC を見るので、正しく書く。 */
export const zipStore = (entries: { name: string; data: Buffer }[]): Buffer => {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf-8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(CENTRAL, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    parts.push(local, nameBuf, data);
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, eocd]);
};

/** WARC のレコード 1 件 (見出し → 空行 → 本文 → 終端)。 */
const record = (headers: string[], body: Buffer): Buffer =>
  Buffer.concat([
    Buffer.from([...headers, `Content-Length: ${String(body.length)}`, "", ""].join("\r\n"), "utf-8"),
    body,
    Buffer.from("\r\n\r\n", "utf-8"),
  ]);

export const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("not really a png, but the magic is right", "utf-8"),
]);

export interface TinyWacz {
  uri: string;
  dir: string;
  /** WARC の各メンバの位置 (warcinfo・png の応答・metadata の順)。 */
  members: { type: string; offset: number; length: number }[];
}

/** 一時ディレクトリに書き、file:// URI と各メンバの位置を返す。`dir` は呼び手が消す。 */
export const buildTinyWacz = async (): Promise<TinyWacz> => {
  const warcinfo = record(
    ["WARC/1.1", "WARC-Type: warcinfo", "WARC-Date: 2026-09-23T00:00:00Z", "Content-Type: application/warc-fields"],
    Buffer.from("software: tiny-wacz/0\r\n", "utf-8"),
  );
  const http = Buffer.concat([
    Buffer.from(["HTTP/1.1 200 OK", "content-type: image/png", `content-length: ${String(PNG.length)}`, "", ""].join("\r\n"), "utf-8"),
    PNG,
  ]);
  const png = record(
    [
      "WARC/1.1",
      "WARC-Type: response",
      "WARC-Target-URI: https://example.com/a.png",
      "WARC-Date: 2026-09-23T00:00:01Z",
      "Content-Type: application/http;msgtype=response",
    ],
    http,
  );
  const metadata = record(
    [
      "WARC/1.1",
      "WARC-Type: metadata",
      "WARC-Target-URI: https://www.googletagmanager.com/gtm.js",
      "WARC-Date: 2026-09-23T00:00:02Z",
      "Content-Type: application/warc-fields",
    ],
    Buffer.from("action: no-archive\r\npattern: *://*.googletagmanager.com/*\r\n", "utf-8"),
  );
  const gz = [warcinfo, png, metadata].map((raw) => gzipSync(raw));
  const members: TinyWacz["members"] = [];
  let at = 0;
  for (const [i, member] of gz.entries()) {
    members.push({ type: ["warcinfo", "response", "metadata"][i] ?? "?", offset: at, length: member.length });
    at += member.length;
  }
  const [, pngAt, metaAt] = members;
  if (pngAt === undefined || metaAt === undefined) throw new Error("unreachable");
  // 索引: png は data.warc.gz を指す。metadata は**別の WARC 名**を指す (この WARC の
  // 索引ではないので、indexed にならない)。warcinfo は索引に無い。
  const cdxj =
    `com,example)/a.png 20260923000001 ${JSON.stringify({ url: "https://example.com/a.png", mime: "image/png", status: "200", length: String(pngAt.length), offset: String(pngAt.offset), filename: "data.warc.gz" })}\n` +
    `com,googletagmanager)/gtm.js 20260923000002 ${JSON.stringify({ url: "https://www.googletagmanager.com/gtm.js", length: String(metaAt.length), offset: String(metaAt.offset), filename: "other.warc.gz" })}\n`;
  // 行の窓の標本: 短い行 / 4 MiB を超える 1 行 / NUL を含む行
  const lines = Buffer.concat([
    Buffer.from("short line\n", "utf-8"),
    Buffer.alloc(5 * 1024 * 1024, 0x78),
    Buffer.from("\n", "utf-8"),
    Buffer.from([0x62, 0x69, 0x6e, 0x00, 0x61, 0x72, 0x79, 0x0a]),
  ]);
  const bytes = zipStore([
    { name: "archive/data.warc.gz", data: Buffer.concat(gz) },
    { name: "indexes/index.cdxj", data: Buffer.from(cdxj, "utf-8") },
    { name: "lines.txt", data: lines },
    { name: "datapackage.json", data: Buffer.from('{"profile":"data-package","resources":[]}\n', "utf-8") },
  ]);
  const dir = await mkdtemp(join(tmpdir(), "wacz-daemon-"));
  const path = join(dir, "tiny.wacz");
  await writeFile(path, bytes);
  return { uri: pathToFileURL(path).href, dir, members };
};

export const removeTinyWacz = (wacz: TinyWacz): Promise<void> => rm(wacz.dir, { recursive: true, force: true });
