#!/usr/bin/env node
/**
 * `wacz-validator-break` —— WACZ をわざと壊し、rule が反応することを確かめるための道具。
 *
 * validator の「緑」は 2 通りの意味を持つ: 検査して問題が無かったのか、そもそも
 * 検査していないのか。区別する方法は 1 つで、**壊して赤くなるところを見る**こと。
 * その 1 手間を毎回スクリプトに書き直さずに済むよう、壊し方をここに集める。
 *
 * 判定はしない。壊した WACZ を書き出すところまでで、赤くなったかは
 * `wacz-validator-validate` に渡して読む —— 道具が「壊した」と「検出された」の両方を
 * 名乗ると、どちらが嘘をついたのか分からなくなる。
 *
 * publish しない (`private`)。壊し方はまだ browserhive 固有で、他の producer に
 * 効く形が見えていない —— 製品の bin に上げるのはその後で足りる。
 */
import { createWriteStream } from "node:fs";
import { argv, exit, stdout } from "node:process";
import { pipeline } from "node:stream/promises";
import { Command } from "commander";
import { ZipArchive } from "archiver";
import { open } from "yauzl-promise";
import { createHash } from "node:crypto";
import { DATAPACKAGE, MUTATIONS } from "./mutations.js";

interface Resource {
  path: string;
  hash: string;
  bytes: number;
  [key: string]: unknown;
}

interface Datapackage {
  resources?: Resource[];
  [key: string]: unknown;
}

/** zip の 1 entry。圧縮の有無まで運ぶ。 */
interface Entry {
  readonly data: Buffer;
  /**
   * 元が無圧縮で格納されていたか。
   *
   * WACZ は WARC を **store** で入れる (中身が既に gzip なので二重に縮めない)。
   * 読み直して deflate で書くと `warc/storage-store` が warning を出す ——
   * 壊した覚えのない指摘が増えると、読み手はそれを追いかけることになる。
   * この道具が変えてよいのは、名乗った 1 箇所だけ。
   */
  readonly stored: boolean;
}

/** zip の全 entry を名前 → 中身で読み出す。 */
const readEntries = async (path: string): Promise<Map<string, Entry>> => {
  const zip = await open(path);
  const out = new Map<string, Entry>();
  try {
    for await (const entry of zip) {
      if (entry.filename.endsWith("/")) continue;
      const stream = await entry.openReadStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      // 0 = store、8 = deflate。
      out.set(entry.filename, {
        data: Buffer.concat(chunks),
        stored: entry.compressionMethod === 0,
      });
    }
  } finally {
    await zip.close();
  }
  return out;
};

const writeZip = async (path: string, entries: Map<string, Entry>): Promise<void> => {
  const archive = new ZipArchive({ zlib: { level: 9 } });
  const sink = createWriteStream(path);
  const done = pipeline(archive, sink);
  for (const [name, entry] of entries) {
    archive.append(entry.data, { name, store: entry.stored });
  }
  await archive.finalize();
  await done;
};

const main = async (): Promise<void> => {
  const program = new Command()
    .name("wacz-validator-break")
    .description("WACZ をわざと壊し、rule が反応することを確かめる (開発用)")
    .argument("[source]", "壊す元の .wacz")
    .argument("[dest]", "書き出す先の .wacz")
    .option("-m, --mutation <name>", "壊し方の名前")
    .option("-l, --list", "壊し方の一覧を出す")
    .parse(argv);

  const opts = program.opts<{ mutation?: string; list?: boolean }>();
  const [source, dest] = program.args;

  if (opts.list === true || source === undefined || dest === undefined) {
    stdout.write("壊し方、書き換える対象、そして出させる報告:\n\n");
    for (const m of MUTATIONS) {
      stdout.write(`  ${m.name.padEnd(24)} ${m.target.padEnd(28)} → ${m.expects}\n`);
    }
    stdout.write("\n  例: wacz-validator-break sample.wacz broken.wacz -m swap-intermediate\n");
    return;
  }

  const mutation = MUTATIONS.find((m) => m.name === opts.mutation);
  if (mutation === undefined) {
    // 名前を間違えたまま「壊した」と思い込むのが最悪なので、黙って既定を選ばない。
    stdout.write(`壊し方 '${opts.mutation ?? "(未指定)"}' は知りません。--list を見てください\n`);
    exit(2);
    return;
  }

  const entries = await readEntries(source);
  const raw = entries.get(mutation.target);
  if (raw === undefined) {
    throw new Error(`${source}: ${mutation.target} がありません (この壊し方は使えません)`);
  }

  const { data, what } = mutation.apply(raw.data);
  if (data === null) entries.delete(mutation.target);
  else entries.set(mutation.target, { data, stored: raw.stored });

  // 壊した先が resources に載っているなら、hash と bytes を書き直す。エントリごと抜いたなら、行も落とす。
  //
  // 直さないと `datapackage/resource-hashes` が一緒に鳴る —— 壊した覚えのない
  // 指摘が並ぶと、どちらが目当ての反応なのか読み手に分からなくなる。この道具が
  // 変えてよいのは、名乗った 1 箇所だけ。
  if (mutation.target !== DATAPACKAGE) {
    const dpEntry = entries.get(DATAPACKAGE);
    if (dpEntry !== undefined) {
      const dp = JSON.parse(dpEntry.data.toString("utf8")) as Datapackage;
      const declared = dp.resources?.find((r) => r.path === mutation.target);
      if (declared !== undefined) {
        if (data === null) {
          dp.resources = (dp.resources ?? []).filter((r) => r !== declared);
        } else {
          declared.hash = `sha256:${createHash("sha256").update(data).digest("hex")}`;
          declared.bytes = data.byteLength;
        }
        entries.set(DATAPACKAGE, {
          data: Buffer.from(`${JSON.stringify(dp, null, 2)}\n`, "utf8"),
          stored: dpEntry.stored,
        });
      }
    }
  }

  await writeZip(dest, entries);

  stdout.write(`壊しました: ${what}\n`);
  stdout.write(`  → ${dest}\n`);
  stdout.write(`期待する報告: ${mutation.expects}\n`);
};

await main();
