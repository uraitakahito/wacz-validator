// @module-tag engine
/**
 * `browserhive/settle-shape` と `browserhive/settle-deadline` のテスト。
 *
 * settle-shape が守っているのは 3 つの主張で、どれも**待ちの終わり方を読み手が信じてよいか**に
 * 関わる。
 *
 *   1. 在ること。待ちは取り込みのたびに走るので、`dismissal` と違って「しなかった」を
 *      意味する不在が無い。
 *   2. 合図の時刻が、満ちなかったときも `null` として書かれていること。省かれた時刻は
 *      「その合図を見ていなかった」と読まれ、「満ちなかった」とは別の事実になる。
 *   3. `endedBy` が時刻と食い違わないこと。
 *
 * settle-deadline は違反を言う rule ではない。期限に当たったアーカイブで、満ちなかった
 * 合図を warning で名指しする —— 形の正しい `deadline` が、黙って「問題なし」に紛れない
 * ように。
 *
 * どちらも版の条件があるので古い browserhive のアーカイブでは走らない —— 版を下げた
 * ケースを置いて、「見ていない」ことが「問題なし」と混ざらないようにする。
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

const SHAPE = "browserhive/settle-shape";
const DEADLINE = "browserhive/settle-deadline";
/** profile 1.7.0 §settle の「Required: yes」の行。rule の一覧と一致するべきもの。 */
const REQUIRED_MEMBERS = [
  "strategy",
  "endedBy",
  "waitedMs",
  "devicePixelRatio",
  "limits",
  "load",
  "network",
  "cpu",
  "dom",
] as const;
/** 合図と、その時刻の名前。 */
const SIGNALS = [
  ["load", "atMs"],
  ["network", "quietAtMs"],
  ["cpu", "quietAtMs"],
  ["dom", "quietAtMs"],
] as const;
const V103 = { major: 10, minor: 3, patch: 0 };

/** browserhive のアーカイブであることを示すだけの最小の目録。 */
const minimalInventory: Record<string, unknown> = {
  profile: "browserhive:storage/2",
  stage: "after-behaviors",
  valuesRecorded: false,
  origins: [],
};

/** profile 1.7.0 どおりの、静まって終わった settle。 */
const quietSettle = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  strategy: "fully-loaded",
  endedBy: "quiet",
  waitedMs: 2310,
  devicePixelRatio: 1,
  limits: { minMs: 1000, maxMs: 3000, quietMs: 1000, networkConcurrency: 0 },
  load: { atMs: 210 },
  network: { quietAtMs: 2205 },
  cpu: { quietAtMs: 2104 },
  dom: { quietAtMs: 2004 },
  ...over,
});

/** profile 1.7.0 どおりの、DOM が満ちず期限で終わった settle。 */
const deadlineSettle = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  quietSettle({ endedBy: "deadline", waitedMs: 3116, dom: { quietAtMs: null }, ...over });

const settleWithout = (member: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(quietSettle()).filter(([k]) => k !== member));

const runFor = async (
  tmpDir: string,
  options: FixtureOptions,
  rule: string,
  profile: RuleProfile = "browserhive",
  version: { major: number; minor: number; patch: number } = V103,
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

describe("browserhive/settle-shape", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "wacz-validator-settle-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const run = (options: FixtureOptions, version?: typeof V103): Promise<Issue[]> =>
    runFor(tmpDir, { storage: minimalInventory, ...options }, SHAPE, "browserhive", version);
  const keys = (issues: Issue[]): string[] => issues.map((i) => i.messageKey);

  it("profile どおりの settle には何も言わない —— 静まって終わっても、期限で終わっても", async () => {
    expect(await run({ settle: quietSettle() })).toEqual([]);
    expect(await run({ settle: deadlineSettle() })).toEqual([]);
  });

  /**
   * **不在は違反。** 待ちは取り込みのたびに走るので、`dismissal` のように「しなかった」を
   * 意味する不在が無い。
   */
  it("settle が無ければ落とす", async () => {
    expect(keys(await run({}))).toEqual([`${SHAPE}.missing`]);
  });

  it("settle がオブジェクトでなければ落とす", async () => {
    const issues = await run({ settle: ["nope"] as unknown as Record<string, unknown> });
    expect(keys(issues)).toEqual([`${SHAPE}.not-object`]);
    expect(issues[0]?.params?.["found"]).toBe("array");
  });

  /**
   * 9 つを 1 つずつ回すのは、必須一覧そのものを固定するため。1 つだけ試すと、一覧から
   * 別の member を外しても緑のまま通る。
   */
  it.each(REQUIRED_MEMBERS)("member %s を落としたら落とす", async (member) => {
    const issues = await run({ settle: settleWithout(member) });
    expect(keys(issues)).toContain(`${SHAPE}.missing-member`);
    expect(issues.map((i) => i.params?.["member"])).toContain(member);
  });

  it.each(["minMs", "maxMs", "quietMs", "networkConcurrency"])("limits.%s を落としたら落とす", async (name) => {
    const limits = Object.fromEntries(
      Object.entries({ minMs: 1000, maxMs: 3000, quietMs: 1000, networkConcurrency: 0 }).filter(
        ([key]) => key !== name,
      ),
    );
    const issues = await run({ settle: quietSettle({ limits }) });
    expect(issues.map((i) => i.params?.["member"])).toContain(`limits.${name}`);
  });

  it.each([
    ["waitedMs", "2310"],
    ["devicePixelRatio", "1"],
    ["endedBy", "finished"],
    ["limits", 3000],
  ] as const)("%s の型か値が違えば落とす", async (member, value) => {
    const issues = await run({ settle: quietSettle({ [member]: value }) });
    expect(keys(issues)).toContain(`${SHAPE}.wrong-type`);
    expect(issues.map((i) => i.params?.["member"])).toContain(member);
  });

  it("この版が定めていない strategy は落とす", async () => {
    const issues = await run({ settle: quietSettle({ strategy: "network-idle" }) });
    expect(keys(issues)).toEqual([`${SHAPE}.unknown-strategy`]);
    expect(issues[0]?.params?.["found"]).toBe("network-idle");
  });

  /**
   * **満ちなかった時刻も書く。** 省かれた時刻は「見ていなかった」と読まれる。4 つを
   * 1 つずつ回すのは、時刻の名前 (load だけ atMs) を合図ごとに固定するため。
   */
  it.each(SIGNALS)("%s の時刻 (%s) を省いたら落とす", async (signal, field) => {
    const issues = await run({ settle: quietSettle({ [signal]: {} }) });
    expect(keys(issues)).toEqual([`${SHAPE}.missing-time`]);
    expect(issues[0]?.params?.["member"]).toBe(`${signal}.${field}`);
  });

  it.each(SIGNALS)("%s の時刻が数値でも null でもなければ落とす", async (signal, field) => {
    const issues = await run({ settle: quietSettle({ [signal]: { [field]: "2004" } }) });
    expect(keys(issues)).toContain(`${SHAPE}.wrong-type`);
    expect(issues.map((i) => i.params?.["member"])).toContain(`${signal}.${field}`);
  });

  /**
   * **quiet は稼いだ主張でなければならない。** 合図を 1 つでも満たせなかった待ちは期限で
   * 終わっている。4 つを 1 つずつ回すのは、どの合図の null も数えていることを固定するため。
   */
  it.each(SIGNALS)("%s が null なのに quiet なら落とし、その合図を名指しする", async (signal, field) => {
    const issues = await run({ settle: quietSettle({ [signal]: { [field]: null } }) });
    expect(keys(issues)).toEqual([`${SHAPE}.quiet-with-null`]);
    expect(issues[0]?.params?.["signals"]).toBe(signal);
  });

  it("どの合図も満ちたのに deadline なら落とす", async () => {
    const issues = await run({ settle: quietSettle({ endedBy: "deadline" }) });
    expect(keys(issues)).toEqual([`${SHAPE}.deadline-without-null`]);
  });

  /**
   * 版の下限。`settle` を必須にした 1.7.0 を browserhive は 10.3.0 から名乗る。10.2.0 は
   * settle を運ぶが 1.6.0 を名乗るので、1.7.0 の MUST を当てて落とすのは誤り。
   */
  it("10.3.0 未満のアーカイブには当てない", async () => {
    // 10.3.0 なら落ちる形であることを先に確かめる。落ちない形で版だけ下げても、
    // 「見ていない」と「問題なし」が区別できない。
    expect((await run({})).length).toBeGreaterThan(0);
    expect(await run({}, { major: 10, minor: 2, patch: 0 })).toEqual([]);
  });
});

describe("browserhive/settle-deadline", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "wacz-validator-settle-deadline-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const run = (options: FixtureOptions, version?: typeof V103): Promise<Issue[]> =>
    runFor(tmpDir, { storage: minimalInventory, ...options }, DEADLINE, "browserhive", version);

  it("静まって終わったアーカイブには何も言わない", async () => {
    expect(await run({ settle: quietSettle() })).toEqual([]);
  });

  it("期限で終わったら warning で、満ちなかった合図と待った時間を名指しする", async () => {
    const issues = await run({
      settle: deadlineSettle({ cpu: { quietAtMs: null } }),
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe("warning");
    expect(issues[0]?.messageKey).toBe(`${DEADLINE}.still-changing`);
    expect(issues[0]?.params).toEqual({ signals: "cpu, dom", waitedMs: 3116, maxMs: 3000 });
  });

  /**
   * 形の崩れは settle-shape の仕事。ここで重ねて言うと、1 つの誤りが 2 つの issue になる。
   */
  it("settle が無い・時刻が 1 つも null でないアーカイブには何も言わない", async () => {
    expect(await run({})).toEqual([]);
    expect(await run({ settle: quietSettle({ endedBy: "deadline" }) })).toEqual([]);
  });

  it("10.3.0 未満のアーカイブには当てない", async () => {
    expect((await run({ settle: deadlineSettle() })).length).toBe(1);
    expect(await run({ settle: deadlineSettle() }, { major: 10, minor: 2, patch: 0 })).toEqual([]);
  });
});
