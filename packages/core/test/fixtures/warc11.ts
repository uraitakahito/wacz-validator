/**
 * WARC 1.1 の rule の試験の足場。
 *
 * WACZ を組んで検証し、WARC 1.1 の決まりを見る rule の issue だけを取り出す。どの試験も
 * 「壊した 1 か所を、狙った rule だけが言う」を確かめたいので、WARC 1.1 の rule の名を
 * ここに 1 度だけ並べる。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseReportSource, type Issue, type Report, type RuleProfile } from "../../src/validate/domain.js";
import { runValidation } from "../../src/validate/engine.js";
import { DEFAULT_RULES } from "../../src/validate/rules/index.js";
import { WaczReader } from "../../src/wacz/reader.js";
import { fileTransport } from "../../src/wacz/transport.js";
import { buildWacz, type FixtureOptions } from "./generator.js";

/** WARC 1.1 の決まりを、profile に依らず見る rule。 */
export const WARC11_RULES: readonly string[] = ["warc/record-structure", "warc/mandatory-fields"];

/** 組んだ WACZ を、渡した profile で検証した報告。 */
export const reportFor = async (options: FixtureOptions = {}, profile: RuleProfile = "spec"): Promise<Report> => {
  const dir = await mkdtemp(join(tmpdir(), "wacz-validator-warc11-"));
  try {
    const { bytes } = await buildWacz(options);
    const path = join(dir, "fixture.wacz");
    await writeFile(path, bytes);
    const source = parseReportSource(path);
    if (!source.ok || source.value.kind !== "file") throw new Error("unreachable: local file");
    const reader = await WaczReader.open(fileTransport(source.value.path));
    try {
      const result = await runValidation(reader, { validatorVersion: "0.0.0", rules: DEFAULT_RULES, profile: { name: profile } });
      if (!result.ok) throw new Error("unreachable: runValidation returned err");
      return result.value;
    } finally {
      await reader.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/** WARC 1.1 の rule が出した issue。 */
export const warc11Issues = (report: Report): Issue[] => report.issues.filter((issue) => WARC11_RULES.includes(issue.rule));

/** 鳴った WARC 1.1 の rule の名（重複なし・並べ替え済み）。 */
export const firedWarc11Rules = (report: Report): string[] => [...new Set(warc11Issues(report).map((i) => i.rule))].sort();

/** 見出しの行（版の行を含む）と block から、記録 1 件のバイト列を組む。壊れた形を直に作るため。 */
export const rawRecord = (lines: readonly (string | Buffer)[], block = "", terminator = "\r\n\r\n"): Buffer =>
  Buffer.concat([
    ...lines.flatMap((line) => [typeof line === "string" ? Buffer.from(line, "utf-8") : line, Buffer.from("\r\n")]),
    Buffer.from("\r\n"),
    Buffer.from(block, "utf-8"),
    Buffer.from(terminator, "utf-8"),
  ]);

/** 形の正しい metadata の記録の見出し（block の長さを入れる）。 */
export const metadataHeader = (id: number, blockLength: number): string[] => [
  "WARC/1.1",
  "WARC-Type: metadata",
  `WARC-Record-ID: <urn:uuid:00000000-0000-0000-0000-${String(id).padStart(12, "0")}>`,
  "WARC-Date: 2026-05-13T00:00:00Z",
  "Content-Type: application/warc-fields",
  `Content-Length: ${String(blockLength)}`,
];
