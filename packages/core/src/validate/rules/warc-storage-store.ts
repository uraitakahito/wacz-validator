/**
 * Rule: warc/storage-store
 *
 * `archive/` の WARC はどれも WACZ ZIP の中で STORE 方式 (compression
 * method 0) で格納すべきで、DEFLATE では駄目。WARC spec に従って
 * 内側の WARC はすでに gzip 圧縮されているので、その gzip wrapper
 * を更に deflate してもサイズが膨らむだけで展開メリットがなく、
 * downstream ツールが依存する offset / length コントラクトを壊す
 * (CDXJ index の offset は *uncompressed* な ZIP entry を指していて、
 * ここでの "uncompressed" は STORE 格納を意味する)。
 *
 * Spec / 慣習: WACZ は厳密には STORE を mandate しないが、フォーマット
 *       の存在理由である random-access 設計が STORE に依存しており、
 *       参考実装 (browserhive、pywb、wacz-creator) はすべて WARC
 *       entry を STORE で出す。
 * Reference producer: browserhive/src/storage/wacz/packager.ts:152-169
 *       は `archive/` の WARC だけを STORE entry にして、それ以外は
 *       DEFLATE。
 *
 * Severity は `error` ではなく `warning`: DEFLATE で格納された
 * warc.gz でも標準的な ZIP reader で問題なく解凍できるので、entry
 * 全体をメモリに読んでから scan する replay ツールは動く。問題は、
 * CDXJ offset で ZIP の raw bytes に直接 seek するツールにとってで、
 * 全 record を miss する。downstream consumer がどちらのクラスかは
 * 判定できないので、抑止するのではなく表面化する側に倒している。
 */
import { ok } from "../../result.js";
import { ZIP_COMPRESSION_STORE } from "../../wacz/reader.js";
import type { Issue, ValidationRule } from "../domain.js";

export const warcStorageStoreRule: ValidationRule = {
  name: "warc/storage-store",
  descriptionKey: "warc/storage-store.desc",
  conformance: "SHOULD",
  docs: [
      {
        label: "WACZ §archive",
        url: {
          en: "https://specs.webrecorder.net/wacz/1.1.1/#archive",
          ja: "https://uraitakahito.github.io/specs/wacz/1.1.1/#archive",
        },
      },
  ],
  applicability: {
    severityByProfile: {
      lenient: { "warc/storage-store.zip-compressed": "info" },
    },
  },

  run: async (wacz) => {
    const issues: Issue[] = [];
    await Promise.resolve(); // satisfy lint: async function with no await
    // WARC が 1 本も無ければ — 他 rule (required-files、resource-hashes) がより
    // rich な context で表面化する。重複ノイズを避けるためここは silent にしておく。
    for (const entry of wacz.warcEntries()) {
      const meta = wacz.getEntryMeta(entry);
      if (!meta || meta.compressionMethod === ZIP_COMPRESSION_STORE) continue;
      issues.push({
        rule: "warc/storage-store",
        severity: "warning",
        messageKey: "warc/storage-store.zip-compressed",
        params: { entry, method: String(meta.compressionMethod) },
        location: { entry },
        details: {
          expected: ZIP_COMPRESSION_STORE,
          actual: meta.compressionMethod,
          compressedSize: meta.compressedSize,
          uncompressedSize: meta.uncompressedSize,
        },
      });
    }

    return ok(issues);
  },
};
