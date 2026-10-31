// @module-tag engine
/**
 * browserhive の tls member に対する 2 rule のテスト。
 *
 * 証明書は実物(`fixtures/certificates.ts`)。合成できないので実アーカイブから
 * 取り出したものを使い、**壊れたチェーンも実バイトで作る** —— 別チェーンの中間を
 * リーフの下に置けば `checkIssued` が false になる。作り物の DER を置くより、
 * 「本物の証明書が繋がらない」形のほうが検査したい状況に近い。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseReportSource, type Issue, type RuleProfile } from "../src/validate/domain.js";
import { runValidation } from "../src/validate/engine.js";
import { DEFAULT_RULES } from "../src/validate/rules/index.js";
import { fileTransport } from "../src/wacz/transport.js";
import { WaczReader } from "../src/wacz/reader.js";
import { buildWacz, type FixtureOptions } from "./fixtures/generator.js";
import {
  IANA_INTERMEDIATE,
  IANA_LEAF,
  IANA_SAN,
  OTHER_INTERMEDIATE,
} from "./fixtures/certificates.js";

const CHAIN = "browserhive/tls-chain";
const SAN = "browserhive/tls-san";
const HOST = "www.iana.org";
const REF = "9a57318f8c89976c";

/** 正しく繋がる 2 通のチェーンを持つ tls member。 */
const goodTls = (): NonNullable<FixtureOptions["tls"]> => ({
  hosts: { [HOST]: { subject: HOST, issuer: "WE1", san: [...IANA_SAN], chainRef: REF } },
  chains: { [REF]: [IANA_LEAF, IANA_INTERMEDIATE] },
});

const runFor = async (
  tmpDir: string,
  options: FixtureOptions,
  profile: RuleProfile = "browserhive",
  version?: { major: number; minor: number; patch: number },
): Promise<Issue[]> => {
  const { bytes } = await buildWacz(options);
  const path = join(tmpDir, "fixture.wacz");
  await writeFile(path, bytes);
  const source = parseReportSource(path);
  if (!source.ok || source.value.kind !== "file") throw new Error("unreachable");
  const reader = await WaczReader.open(fileTransport(source.value.path));
  try {
    const result = await runValidation(reader, {
      validatorVersion: "0.0.0",
      rules: DEFAULT_RULES,
      profile: version === undefined ? { name: profile } : { name: profile, version },
    });
    if (!result.ok) throw new Error("runValidation returned err — unreachable");
    return result.value.issues;
  } finally {
    await reader.close();
  }
};

const of = (issues: Issue[], rule: string): Issue[] => issues.filter((i) => i.rule === rule);

describe("browserhive/tls-chain", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "wacz-validator-tls-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("繋がるチェーンでは error を出さず、検証したことを info で残す", async () => {
    const issues = of(await runFor(tmpDir, { tls: goodTls() }), CHAIN);
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    const info = issues.find((i) => i.severity === "info");
    expect(info?.messageKey).toBe(`${CHAIN}.verified`);
    // 「1 本も検証していない」と「全部通った」を区別できるよう、details に結果を残す。
    const chain = (info?.details as { chain?: { hosts?: Record<string, unknown[]> } }).chain;
    expect(chain?.hosts?.[HOST]).toHaveLength(2);
  });

  it("別チェーンの中間を混ぜると broken-link を出す", async () => {
    // 実バイトのまま組み替える。DER は正しく、繋がりだけが壊れている状態。
    const tls = goodTls();
    tls.chains[REF] = [IANA_LEAF, OTHER_INTERMEDIATE];
    const issues = of(await runFor(tmpDir, { tls }), CHAIN);
    expect(issues.map((i) => i.messageKey)).toContain(`${CHAIN}.broken-link`);
  });

  it("順序を入れ替えるとリーフが先頭でないことを出す", async () => {
    const tls = goodTls();
    tls.chains[REF] = [IANA_INTERMEDIATE, IANA_LEAF];
    const keys = of(await runFor(tmpDir, { tls }), CHAIN).map((i) => i.messageKey);
    expect(keys).toContain(`${CHAIN}.leaf-not-first`);
  });

  it("指す先の無い chainRef を出す", async () => {
    const tls = goodTls();
    tls.chains = {};
    const keys = of(await runFor(tmpDir, { tls }), CHAIN).map((i) => i.messageKey);
    expect(keys).toContain(`${CHAIN}.dangling-ref`);
  });

  it("証明書にならない中身は例外にせず unparseable として報告する", async () => {
    // `new X509Certificate()` は throw する。rule の中で投げると engine ごと
    // 巻き添えになるので、issue に変わっていることを確かめる。
    const tls = goodTls();
    tls.chains[REF] = ["bm90IGEgY2VydGlmaWNhdGU="];
    const keys = of(await runFor(tmpDir, { tls }), CHAIN).map((i) => i.messageKey);
    expect(keys).toContain(`${CHAIN}.unparseable`);
  });

  it("tls が無ければ何も言わない", async () => {
    expect(of(await runFor(tmpDir, {}), CHAIN)).toEqual([]);
  });

  it("spec profile では走らない", async () => {
    expect(of(await runFor(tmpDir, { tls: goodTls() }, "spec"), CHAIN)).toEqual([]);
  });
});

describe("browserhive/tls-san", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "wacz-validator-san-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("証明書と一致する san では何も言わない", async () => {
    expect(of(await runFor(tmpDir, { tls: goodTls() }), SAN)).toEqual([]);
  });

  it("証明書に無い名前を記録していれば drift を出す", async () => {
    const tls = goodTls();
    tls.hosts[HOST] = { ...tls.hosts[HOST], san: [HOST, "extra.test"] };
    const keys = of(await runFor(tmpDir, { tls }), SAN).map((i) => i.messageKey);
    expect(keys).toContain(`${SAN}.drift`);
  });

  it("host を覆わない san を出す", async () => {
    const tls = goodTls();
    tls.hosts[HOST] = { ...tls.hosts[HOST], san: ["other.test"] };
    const keys = of(await runFor(tmpDir, { tls }), SAN).map((i) => i.messageKey);
    expect(keys).toContain(`${SAN}.host-not-covered`);
  });

  it("san が無ければ missing を出す", async () => {
    const tls = goodTls();
    const withoutSan = { ...tls.hosts[HOST] };
    delete withoutSan["san"];
    tls.hosts[HOST] = withoutSan;
    const keys = of(await runFor(tmpDir, { tls }), SAN).map((i) => i.messageKey);
    expect(keys).toContain(`${SAN}.missing`);
  });

  it("san が入る前の版では走らせず、tls-chain だけを残す", async () => {
    // 走らせなかったことは Report.skipped に残るので、読者は「問題なし」と
    // 「見ていない」を区別できる。ここで確かめるのは、chain の検証まで
    // 道連れにしていないこと。
    const tls = goodTls();
    const withoutSan = { ...tls.hosts[HOST] };
    delete withoutSan["san"];
    tls.hosts[HOST] = withoutSan;
    const issues = await runFor(tmpDir, { tls }, "browserhive", { major: 3, minor: 6, patch: 0 });
    expect(of(issues, SAN)).toEqual([]);
    expect(of(issues, CHAIN).some((i) => i.severity === "info")).toBe(true);
  });
});
