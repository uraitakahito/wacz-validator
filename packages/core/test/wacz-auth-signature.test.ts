// @module-tag engine
/**
 * `wacz-auth/signature` のテスト。
 *
 * この rule が塞ぐのは、記録されていた 1 つの穴 ——
 * **「改竄された `signedData` は wacz-validator を通り、`wacz-signer verify` でだけ落ちる」**。
 *
 * `datapackage/digest` は `hash` が `datapackage.json` と一致するかまでは見るが、
 * **その `hash` に誰が署名したかは見ていない**。だから `signedData` を丸ごと
 * 差し替えたアーカイブが、これまで無傷で通っていた。
 *
 * ## fixture は本物
 *
 * `fixtures/signing/signed-data.json` は wacz-signer が実際に作ったもの。
 * placeholder にすると、**常に true を返す verifier がここの全テストを通る**。
 * だから各検査を両方向で固定する —— 正しい入力と、その検査だけを落とす 1 つの改変。
 *
 * chain と timestamp は**ここでは見ない**。あれは呼ぶ側の trust anchor を要求する
 * ので、`browserhive/tls-chain` が先に答えを出している方針
 * (「ルートストアは検査する側のもの」) に従って wacz-signer の持ち場に残してある。
 * だから fixture にも `timeSignature` と `timestampCert` は写していない。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseReportSource, type Issue } from "../src/validate/domain.js";
import { runValidation } from "../src/validate/engine.js";
import { DEFAULT_RULES } from "../src/validate/rules/index.js";
import { fileTransport } from "../src/wacz/transport.js";
import { WaczReader } from "../src/wacz/reader.js";
import { buildWacz, type FixtureOptions } from "./fixtures/generator.js";

const RULE = "wacz-auth/signature";

const REAL = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures/signing/signed-data.json"), "utf-8"),
) as Record<string, unknown>;

/** 本物の署名に、壊したい箇所だけを上書きして被せる。 */
const signedData = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...REAL,
  ...over,
});

describe("wacz-auth/signature", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "wacz-validator-signature-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const run = async (options: FixtureOptions): Promise<Issue[]> => {
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
        profile: { name: "spec" },
      });
      if (!result.ok) throw new Error("runValidation returned err — unreachable");
      return result.value.issues.filter((i) => i.rule === RULE);
    } finally {
      await reader.close();
    }
  };

  it("wacz-signer が実際に作った署名を受け入れる", async () => {
    const issues = await run({ signedData: signedData() });
    expect(issues.map((i) => i.messageKey)).toEqual([`${RULE}.verified`]);
    expect(issues[0]?.severity).toBe("info");
  });

  /**
   * **この 1 件がこの rule の存在理由。** 署名を 1 バイト変えるだけで、
   * `wacz-signer verify` を待たずにここで落ちる。
   */
  it("署名を書き換えたら落とす", async () => {
    const sig = Buffer.from(REAL["signature"] as string, "base64");
    sig[0] = (sig[0]! ^ 0xff) & 0xff;
    const issues = await run({ signedData: signedData({ signature: sig.toString("base64") }) });
    expect(issues.map((i) => i.messageKey)).toEqual([`${RULE}.signature-mismatch`]);
    expect(issues[0]?.severity).toBe("error");
  });

  /** 署名は元の `hash` を覆っている。差し替えれば検証は通らない。 */
  it("hash を書き換えたら落とす", async () => {
    const issues = await run({ signedData: signedData({ hash: `sha256:${"0".repeat(64)}` }) });
    expect(issues.map((i) => i.messageKey)).toEqual([`${RULE}.signature-mismatch`]);
  });

  /** 証明書が覆っていない名前を名乗るのは、別の主体の署名を流用した形。 */
  it("証明書が覆っていない domain を名乗ったら落とす", async () => {
    const issues = await run({ signedData: signedData({ domain: "evil.test" }) });
    expect(issues.map((i) => i.messageKey)).toEqual([`${RULE}.domain-mismatch`]);
    expect(issues[0]?.params?.["domain"]).toBe("evil.test");
  });

  it("PEM として読めない domainCert を落とす", async () => {
    const issues = await run({ signedData: signedData({ domainCert: "not a certificate" }) });
    expect(issues.map((i) => i.messageKey)).toEqual([`${RULE}.cert-unparseable`]);
  });

  it.each(["hash", "signature", "domain", "domainCert"])(
    "必須 member %s の欠落を名指しする",
    async (member) => {
      const rest = Object.fromEntries(Object.entries(REAL).filter(([k]) => k !== member));
      const issues = await run({ signedData: rest });
      expect(issues.map((i) => i.messageKey)).toEqual([`${RULE}.missing-member`]);
      expect(issues[0]?.params?.["members"]).toBe(member);
    },
  );

  /**
   * 署名の無いアーカイブは違反ではない —— wacz-auth には匿名形式もあり、署名自体が
   * SHOULD。`datapackage-digest.json` ごと無い場合も同じで、そちらは
   * `datapackage/digest.absent` が既に扱っている。
   */
  it("signedData を持たないアーカイブには何も言わない", async () => {
    expect(await run({})).toEqual([]);
  });

  it("digest エントリごと無いアーカイブにも何も言わない", async () => {
    expect(await run({ digest: "absent" })).toEqual([]);
  });
});
