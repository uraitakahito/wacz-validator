// @module-tag engine
/**
 * `browserhive/storage-inventory` と `browserhive/storage-shape` のテスト。
 *
 * この 2 本が守っているのは 2 つの主張:
 *
 *   1. 目録は **必ず在る** (profile 1.1.0 の MUST)。無いと読み手は
 *      「localStorage から描画したページ」と「見せるものが無かったページ」を
 *      区別できず、`completeness` もそれを言えない (storage は body にならない)。
 *   2. `valuesRecorded` とファイルの有無が **一致する**。読み手はその値だけを見て
 *      「このアーカイブは秘密を運んでいるか」を、本体を開かずに決める。
 *
 * 版の条件があるので、古い browserhive のアーカイブでは走らない —— 版を下げた
 * ケースを 1 つ置いて、「見ていない」ことが「問題なし」と混ざらないようにする。
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

const INVENTORY = "browserhive/storage-inventory";
const SHAPE = "browserhive/storage-shape";
const V6 = { major: 6, minor: 0, patch: 0 };
const DIGEST = `sha256:${"0".repeat(64)}`;

/** profile どおりの目録。 */
const goodInventory = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  profile: "browserhive:storage/1",
  stage: "after-behaviors",
  valuesRecorded: false,
  origins: [
    {
      origin: "https://site.test",
      local: { keys: 2, bytes: 40, digest: DIGEST },
      session: { keys: 0, bytes: 0, digest: DIGEST },
    },
  ],
  ...over,
});

/** 値のファイルの 1 行。 */
const goodLine = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  profile: "browserhive:storage/1",
  origin: "https://site.test",
  takenAt: "2026-09-06T01:22:14.881Z",
  stage: "after-behaviors",
  areas: { local: { theme: "dark" }, session: {} },
  ...over,
});

const runFor = async (
  tmpDir: string,
  options: FixtureOptions,
  rule: string,
  profile: RuleProfile = "browserhive",
  version: { major: number; minor: number; patch: number } = V6,
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
      profile: { name: profile, version },
    });
    if (!result.ok) throw new Error("runValidation returned err — unreachable");
    return result.value.issues.filter((i) => i.rule === rule);
  } finally {
    await reader.close();
  }
};

describe("browserhive/storage-inventory", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "wacz-validator-storage-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const run = (options: FixtureOptions, version?: typeof V6): Promise<Issue[]> =>
    runFor(tmpDir, options, INVENTORY, "browserhive", version);

  it("profile どおりの目録には何も言わない", async () => {
    expect(await run({ storage: goodInventory() })).toEqual([]);
  });

  // **この 1 件がこの rule の存在理由。** 目録は MUST なので、不在は違反。
  //
  // `tls` を置いて `browserhive:capture` は在る状態にする —— そうしないと
  // 「capture ごと無い」と「storage だけ無い」が混ざり、後者を検べたことにならない。
  const CAPTURE_WITHOUT_STORAGE: FixtureOptions = { tls: { hosts: {}, chains: {} } };

  it("目録が無いこと自体を違反として報告する", async () => {
    const issues = await run(CAPTURE_WITHOUT_STORAGE);
    expect(issues.map((i) => i.messageKey)).toEqual([`${INVENTORY}.missing`]);
  });

  it("古い browserhive のアーカイブには当てない", async () => {
    // 1.1.0 を名乗っていないものに 1.1.0 の MUST を当てて落とすのは、検証器として誤り。
    expect(await run(CAPTURE_WITHOUT_STORAGE, { major: 5, minor: 18, patch: 0 })).toEqual([]);
  });

  // browserhive のものではない (capture ごと無い) アーカイブ。この rule の
  // 相手ではないので黙る —— 別の rule が capture の不在を見る。
  it("browserhive:capture ごと無いアーカイブには何も言わない", async () => {
    expect(await run({})).toEqual([]);
  });

  it("必須 member の欠落を名指しする", async () => {
    const rest = { ...goodInventory() };
    delete rest["valuesRecorded"];
    const issues = await run({ storage: rest });
    expect(issues.map((i) => i.messageKey)).toContain(`${INVENTORY}.missing-member`);
  });

  it("知らない profile を報告する", async () => {
    const issues = await run({ storage: goodInventory({ profile: "browserhive:storage/99" }) });
    expect(issues.map((i) => i.messageKey)).toContain(`${INVENTORY}.unknown-profile`);
  });

  it("stage が規範の値でなければ報告する", async () => {
    // stage が規範なのは、ページが動作しながら storage に書くから ——
    // behavior の前後で別の状態を表す。
    const issues = await run({ storage: goodInventory({ stage: "before-behaviors" }) });
    expect(issues.map((i) => i.messageKey)).toContain(`${INVENTORY}.unknown-stage`);
  });

  // 空の origin と読めなかった origin を混ぜると、この member が取り除こうとした
  // 曖昧さが戻る。両方を名乗る形も、どちらでもない形も、それを混ぜている。
  it("両 area と unreadable の両方を名乗る origin を報告する", async () => {
    const issues = await run({
      storage: goodInventory({
        origins: [
          {
            origin: "https://site.test",
            unreadable: true,
            local: { keys: 0, bytes: 0, digest: DIGEST },
            session: { keys: 0, bytes: 0, digest: DIGEST },
          },
        ],
      }),
    });
    expect(issues.map((i) => i.messageKey)).toEqual([`${INVENTORY}.origin-form`]);
  });

  it("どちらでもない origin を報告する", async () => {
    const issues = await run({
      storage: goodInventory({ origins: [{ origin: "https://site.test" }] }),
    });
    expect(issues.map((i) => i.messageKey)).toEqual([`${INVENTORY}.origin-form`]);
  });

  it("unreadable な origin だけなら何も言わない", async () => {
    expect(
      await run({
        storage: goodInventory({
          origins: [{ origin: "https://blocked.test", unreadable: true }],
        }),
      }),
    ).toEqual([]);
  });

  it("digest の形が違えば報告する", async () => {
    const issues = await run({
      storage: goodInventory({
        origins: [
          {
            origin: "https://site.test",
            local: { keys: 1, bytes: 2, digest: "md5:abc" },
            session: { keys: 0, bytes: 0, digest: DIGEST },
          },
        ],
      }),
    });
    expect(issues.map((i) => i.messageKey)).toEqual([`${INVENTORY}.digest-shape`]);
  });

  it("keys が負なら報告する", async () => {
    const issues = await run({
      storage: goodInventory({
        origins: [
          {
            origin: "https://site.test",
            local: { keys: -1, bytes: 0, digest: DIGEST },
            session: { keys: 0, bytes: 0, digest: DIGEST },
          },
        ],
      }),
    });
    expect(issues.map((i) => i.messageKey)).toEqual([`${INVENTORY}.area-count`]);
  });

  it("新旧どちらの profile の綴りも受け付ける", async () => {
    // 検証器が新しい方しか読めなければ、適合していた古いアーカイブを一斉に落とす。
    for (const profile of ["browserhive:storage/1", "browserhive:storage/2"]) {
      expect(await run({ storage: goodInventory({ profile }) })).toEqual([]);
    }
  });

  /**
   * **この 1 件が排他検査の回帰よけ。**
   *
   * `unreadable === hasAreas` は「両方 true」と「両方 false」で発火する XNOR。
   * `valuesOversize` を持つ項目が area を落とすと `false === false` になり、
   * **落とされた origin が軒並み `origin-form` で赤くなる**。profile 1.6.0 が
   * area を持たせたままにしているのはそのため (読み手が「どれだけ失ったか」を
   * 知れるのが第一の理由だが、ここも同じ結論を支えている)。
   */
  it("valuesOversize は area を持ったまま素通りする", async () => {
    expect(
      await run({
        storage: goodInventory({
          valuesRecorded: true,
          origins: [
            {
              origin: "https://heavy.test",
              local: { keys: 1, bytes: 2_129_905, digest: DIGEST },
              session: { keys: 0, bytes: 0, digest: DIGEST },
              valuesOversize: true,
            },
          ],
        }),
      }),
    ).toEqual([]);
  });

  /**
   * `unreadable` と同じ形にしたくなる誘惑への歯止め。profile 1.6.0 は
   * `valuesOversize` を持つ項目に area を持たせたままにすることを MUST と
   * しており、落とすと「どれだけ失ったか」を読み手が知れなくなる。
   *
   * この 1 件が無いと、排他検査を三値に「直して」も何も赤くならない。
   */
  it("area を持たない valuesOversize を報告する", async () => {
    const issues = await run({
      storage: goodInventory({
        valuesRecorded: true,
        origins: [{ origin: "https://heavy.test", valuesOversize: true }],
      }),
    });
    expect(issues.map((i) => i.messageKey)).toEqual([`${INVENTORY}.origin-form`]);
  });

  it("valuesOversize が true 以外なら報告する", async () => {
    // この member の意味は 1 つで、在ること自体がそれを述べる。false を書けるように
    // すると「落とされていない」を 2 通りで表せてしまう。
    const issues = await run({
      storage: goodInventory({
        valuesRecorded: true,
        origins: [
          {
            origin: "https://heavy.test",
            local: { keys: 1, bytes: 10, digest: DIGEST },
            session: { keys: 0, bytes: 0, digest: DIGEST },
            valuesOversize: false,
          },
        ],
      }),
    });
    expect(issues.map((i) => i.messageKey)).toEqual([`${INVENTORY}.oversize-shape`]);
  });

  it("valuesOversize と unreadable の同居を報告する", async () => {
    // 読めなかった storage には、超えるべき大きさが無い。
    const issues = await run({
      storage: goodInventory({
        valuesRecorded: true,
        origins: [{ origin: "https://blocked.test", unreadable: true, valuesOversize: true }],
      }),
    });
    expect(issues.map((i) => i.messageKey)).toEqual([`${INVENTORY}.oversize-with-unreadable`]);
  });

  it("値を求めていない取り込みの valuesOversize を報告する", async () => {
    // どの origin の値ももともと運ばれる予定が無い。ここで立てるのは、
    // **誰も下していない判断**の報告になる。
    const issues = await run({
      storage: goodInventory({
        origins: [
          {
            origin: "https://heavy.test",
            local: { keys: 1, bytes: 2_129_905, digest: DIGEST },
            session: { keys: 0, bytes: 0, digest: DIGEST },
            valuesOversize: true,
          },
        ],
      }),
    });
    expect(issues.map((i) => i.messageKey)).toEqual([`${INVENTORY}.oversize-without-values`]);
  });
});

describe("browserhive/storage-shape", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "wacz-validator-storage-shape-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const run = (options: FixtureOptions): Promise<Issue[]> => runFor(tmpDir, options, SHAPE);

  it("値を持たないアーカイブには何も言わない", async () => {
    expect(await run({ storage: goodInventory() })).toEqual([]);
  });

  it("valuesRecorded: true と値のファイルが揃っていれば何も言わない", async () => {
    expect(
      await run({
        storage: goodInventory({ valuesRecorded: true }),
        storageValues: [goodLine()],
      }),
    ).toEqual([]);
  });

  // ここが 2 段構えの本体。片方だけ動くと、読み手の判別が嘘になる。
  it("true と言ったのにファイルが無ければ報告する", async () => {
    const issues = await run({ storage: goodInventory({ valuesRecorded: true }) });
    expect(issues.map((i) => i.messageKey)).toEqual([`${SHAPE}.declared-but-absent`]);
  });

  it("ファイルが在るのに true と言っていなければ報告する", async () => {
    const issues = await run({ storage: goodInventory(), storageValues: [goodLine()] });
    expect(issues.map((i) => i.messageKey)).toContain(`${SHAPE}.present-but-undeclared`);
  });

  it("JSON として読めない行を報告する", async () => {
    const issues = await run({
      storage: goodInventory({ valuesRecorded: true }),
      storageValues: "{ではない\n",
    });
    expect(issues.map((i) => i.messageKey)).toEqual([`${SHAPE}.not-json`]);
  });

  it("必須 member の欠落を名指しする", async () => {
    const rest = { ...goodLine() };
    delete rest["takenAt"];
    const issues = await run({
      storage: goodInventory({ valuesRecorded: true }),
      storageValues: [rest],
    });
    expect(issues.map((i) => i.messageKey)).toContain(`${SHAPE}.missing-member`);
  });

  it("areas が local と session を持たなければ報告する", async () => {
    const issues = await run({
      storage: goodInventory({ valuesRecorded: true }),
      storageValues: [goodLine({ areas: { local: {} } })],
    });
    expect(issues.map((i) => i.messageKey)).toContain(`${SHAPE}.areas-shape`);
  });

  // 「読めなかった」と「読んで値が在った」を同時に主張している。どちらかが嘘。
  it("目録が unreadable と言った origin に値が在れば報告する", async () => {
    const issues = await run({
      storage: goodInventory({
        valuesRecorded: true,
        origins: [{ origin: "https://site.test", unreadable: true }],
      }),
      storageValues: [goodLine()],
    });
    expect(issues.map((i) => i.messageKey)).toContain(`${SHAPE}.unreadable-has-values`);
  });

  /**
   * `unreadable` とは矛盾の中身が違う —— こちらは「読めたが大きすぎるので運ばないと
   * 決めた」と「ここに在る」の同居。producer が**上限の判定と行を書く判定を別々に
   * 書いた**ときに出る形なので、直す先も違う。だから別の messageKey を持つ。
   */
  it("目録が valuesOversize と言った origin に値が在れば報告する", async () => {
    const issues = await run({
      storage: goodInventory({
        valuesRecorded: true,
        origins: [
          {
            origin: "https://site.test",
            local: { keys: 1, bytes: 2_129_905, digest: DIGEST },
            session: { keys: 0, bytes: 0, digest: DIGEST },
            valuesOversize: true,
          },
        ],
      }),
      storageValues: [goodLine()],
    });
    expect(issues.map((i) => i.messageKey)).toEqual([`${SHAPE}.oversize-has-values`]);
  });

  it("目録と行の profile が食い違えば報告する", async () => {
    // 綴りが 1 つしかなかった頃は、定数と比べることで一致が自動的に取れていた。
    // 2 つ読めるようになったので、ここを見ないと `/2` の目録に `/1` の行が
    // 並ぶアーカイブが素通りする。
    const issues = await run({
      storage: goodInventory({ profile: "browserhive:storage/2", valuesRecorded: true }),
      storageValues: [goodLine({ profile: "browserhive:storage/1" })],
    });
    expect(issues.map((i) => i.messageKey)).toEqual([`${SHAPE}.unknown-profile`]);
  });

  it("目録と行がそろって /2 なら何も言わない", async () => {
    expect(
      await run({
        storage: goodInventory({ profile: "browserhive:storage/2", valuesRecorded: true }),
        storageValues: [goodLine({ profile: "browserhive:storage/2" })],
      }),
    ).toEqual([]);
  });
});
