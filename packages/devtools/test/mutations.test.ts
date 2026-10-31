// @module-tag engine
/**
 * 壊し方そのもののテスト。
 *
 * 見ているのは「rule が反応するか」ではなく **「入力が実際に変わったか」** ——
 * 壊し方が黙って何もしないと、検証は緑のままで「rule が検出できていない」と
 * 読まれる。実際には rule は正しく、壊れていなかっただけなのに。壊し方の嘘は
 * rule の欠陥に化けるので、そこを先に塞ぐ。
 */
import { describe, expect, it } from "vitest";
import { AXTREE, DATAPACKAGE, MUTATIONS, type TlsMember } from "../src/mutations.js";

/** 2 host・2 チェーンの最小形。どの tls の壊し方も適用できる。 */
const tls = (): TlsMember => ({
  hosts: {
    "a.test": { subject: "a.test", san: ["a.test"], chainRef: "aaa" },
    "b.test": { subject: "b.test", san: ["b.test"], chainRef: "bbb" },
  },
  chains: { aaa: ["leaf-a", "inter-a"], bbb: ["leaf-b", "inter-b"] },
});

const datapackageBytes = (member: TlsMember = tls()): Buffer =>
  Buffer.from(
    `${JSON.stringify({ "browserhive:capture": { tls: member } }, null, 2)}\n`,
    "utf8",
  );

const axtreeBytes = (): Buffer =>
  Buffer.from(
    `${JSON.stringify({
      profile: "browserhive:axtree/1",
      url: "https://site.test/",
      takenAt: "2026-08-22T00:00:00.000Z",
      stage: "after-behaviors",
      devicePixelRatio: 1,
      viewport: { width: 1280, height: 800 },
      nodes: 3,
      tree: [{ role: "heading", name: "Example", level: 1 }],
    })}\n`,
    "utf8",
  );

/** その壊し方が想定している、壊せる入力。 */
const inputFor = (target: string): Buffer =>
  target === AXTREE ? axtreeBytes() : datapackageBytes();

describe("MUTATIONS", () => {
  it("名前が重複しない", () => {
    const names = MUTATIONS.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("すべてが messageKey を名乗る", () => {
    for (const m of MUTATIONS) {
      expect(m.expects).toMatch(/^browserhive\/(tls-(chain|san)|axtree-shape)\./);
    }
  });

  it("対象は既知のエントリだけ", () => {
    // 存在しないエントリを名乗る壊し方は、実行時に「そんなファイルは無い」で
    // 終わる —— 壊した覚えのない失敗として読まれるので、ここで止める。
    for (const m of MUTATIONS) expect([DATAPACKAGE, AXTREE]).toContain(m.target);
  });

  it.each(MUTATIONS.map((m) => [m.name, m] as const))(
    "%s は対象を実際に書き換える",
    (_n, m) => {
      const before = inputFor(m.target);
      const { data, what } = m.apply(before);
      // 何も変わっていないなら、この壊し方は嘘をつく。
      expect(data.toString("utf8")).not.toBe(before.toString("utf8"));
      // 何をしたかも名乗ること。--list と出力の両方がこれに依る。
      expect(what).not.toBe("");
    },
  );
});

describe("壊せない入力", () => {
  it("チェーンが 1 本しか無ければ swap は throw する", () => {
    const one = datapackageBytes({
      hosts: { "a.test": { chainRef: "aaa" } },
      chains: { aaa: ["leaf-a", "inter-a"] },
    });
    const swap = MUTATIONS.find((m) => m.name === "swap-intermediate");
    expect(swap).toBeDefined();
    // 黙って成功すると「壊したのに緑」に化ける。失敗は失敗として出す。
    expect(() => swap?.apply(one)).toThrow();
  });

  it("chainRef がどこにも無ければ tls の壊し方は throw する", () => {
    const none = datapackageBytes({ hosts: { "a.test": null }, chains: {} });
    for (const m of MUTATIONS.filter(
      (x) => x.target === DATAPACKAGE && x.name !== "san-drift",
    )) {
      expect(() => m.apply(none)).toThrow();
    }
  });

  it("san を持つ host が無ければ san-drift は throw する", () => {
    const none = datapackageBytes({
      hosts: { "a.test": { chainRef: "aaa" } },
      chains: { aaa: ["leaf-a"] },
    });
    const drift = MUTATIONS.find((m) => m.name === "san-drift");
    expect(() => drift?.apply(none)).toThrow();
  });

  it("axtree.jsonl が空なら axtree の壊し方は throw する", () => {
    const empty = Buffer.from("\n", "utf8");
    for (const m of MUTATIONS.filter((x) => x.target === AXTREE)) {
      expect(() => m.apply(empty)).toThrow();
    }
  });

  it("木が空なら、ノードを触る壊し方は throw する", () => {
    const noTree = Buffer.from(
      `${JSON.stringify({ profile: "browserhive:axtree/1", tree: [] })}\n`,
      "utf8",
    );
    const unknown = MUTATIONS.find((m) => m.name === "axtree-unknown-property");
    expect(() => unknown?.apply(noTree)).toThrow();
  });
});
