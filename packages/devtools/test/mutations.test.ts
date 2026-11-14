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
import { AXTREE, DATAPACKAGE, MUTATIONS, RANDOM, TRACE, type TlsMember } from "../src/mutations.js";

/** 2 host・2 チェーンの最小形。どの tls の壊し方も適用できる。 */
const tls = (): TlsMember => ({
  hosts: {
    "a.test": { subject: "a.test", san: ["a.test"], chainRef: "aaa" },
    "b.test": { subject: "b.test", san: ["b.test"], chainRef: "bbb" },
  },
  chains: { aaa: ["leaf-a", "inter-a"], bbb: ["leaf-b", "inter-b"] },
});

/** tls と、乱数の控えを載せた resources。どの datapackage.json の壊し方も適用できる。 */
const datapackageBytes = (member: TlsMember = tls()): Buffer =>
  Buffer.from(
    `${JSON.stringify({ resources: [{ path: "random/values.jsonl" }, { path: "random/recorder.js" }], "browserhive:capture": { tls: member } }, null, 2)}\n`,
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

/** response を名指す行と、名指さない行。どの trace の壊し方も適用できる。 */
const traceLines = (): Record<string, unknown>[] => [
  { profile: "browserhive:trace/1", kind: "request", id: "1.1", hop: 0, outcome: "finished", record: "urn:uuid:00000000-0000-0000-0000-000000000200" },
  { profile: "browserhive:trace/1", kind: "request", id: "1.2", hop: 0, outcome: "pending" },
];

const traceBytes = (lines: Record<string, unknown>[] = traceLines()): Buffer =>
  Buffer.from(lines.map((line) => `${JSON.stringify(line)}\n`).join(""), "utf8");

/** 2 つの文書の行と、それぞれの値の行。どの random の壊し方も適用できる。 */
const randomLines = (): Record<string, unknown>[] => [
  { profile: "browserhive:random/1", kind: "document", document: 0, url: "https://site.test/", frame: "main", dpr: 1 },
  { profile: "browserhive:random/1", kind: "draw", document: 0, seq: 0, api: "Math.random", caller: "", value: 0.5 },
  { profile: "browserhive:random/1", kind: "document", document: 1, url: "https://site.test/frame", frame: "frame", dpr: 1 },
  { profile: "browserhive:random/1", kind: "draw", document: 0, seq: 1, api: "Math.random", caller: "", value: 0.25 },
  { profile: "browserhive:random/1", kind: "draw", document: 1, seq: 0, api: "Math.random", caller: "", value: 0.75 },
];

const randomBytes = (lines: Record<string, unknown>[] = randomLines()): Buffer =>
  Buffer.from(lines.map((line) => `${JSON.stringify(line)}\n`).join(""), "utf8");

/** その壊し方が想定している、壊せる入力。 */
const inputFor = (target: string): Buffer =>
  target === AXTREE ? axtreeBytes() : target === TRACE ? traceBytes() : target === RANDOM ? randomBytes() : datapackageBytes();

describe("MUTATIONS", () => {
  it("名前が重複しない", () => {
    const names = MUTATIONS.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("すべてが messageKey を名乗る", () => {
    for (const m of MUTATIONS) {
      expect(m.expects).toMatch(/^browserhive\/(tls-(chain|san)|axtree-shape|trace-shape|random-shape)\./);
    }
  });

  it("対象は既知のエントリだけ", () => {
    // 存在しないエントリを名乗る壊し方は、実行時に「そんなファイルは無い」で
    // 終わる —— 壊した覚えのない失敗として読まれるので、ここで止める。
    for (const m of MUTATIONS) expect([DATAPACKAGE, AXTREE, TRACE, RANDOM]).toContain(m.target);
  });

  it.each(MUTATIONS.map((m) => [m.name, m] as const))(
    "%s は対象を実際に書き換える",
    (_n, m) => {
      const before = inputFor(m.target);
      const { data, what } = m.apply(before);
      // 何も変わっていないなら、この壊し方は嘘をつく。エントリごと抜く壊し方は `null` を返す。
      expect(data?.toString("utf8")).not.toBe(before.toString("utf8"));
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
    for (const m of MUTATIONS.filter((x) => x.expects.startsWith("browserhive/tls-chain."))) {
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

  it("trace に行が無ければ、行を触る壊し方は throw する", () => {
    for (const name of ["trace-drop-line", "trace-rewrite-record"]) {
      const m = MUTATIONS.find((x) => x.name === name);
      expect(m).toBeDefined();
      expect(() => m?.apply(Buffer.from("\n", "utf8"))).toThrow();
    }
  });

  it("record を持つ行が無ければ trace-rewrite-record は throw する", () => {
    const rewrite = MUTATIONS.find((m) => m.name === "trace-rewrite-record");
    expect(() => rewrite?.apply(traceBytes(traceLines().slice(1)))).toThrow();
  });

  it("値の行が無ければ random-drop-draw は throw する（行の無いエントリでも）", () => {
    const drop = MUTATIONS.find((m) => m.name === "random-drop-draw");
    expect(drop).toBeDefined();
    expect(() => drop?.apply(randomBytes(randomLines().filter((l) => l["kind"] === "document")))).toThrow();
    expect(() => drop?.apply(Buffer.from("\n", "utf8"))).toThrow();
  });

  it("resources に random/values.jsonl が無ければ random-drop-resource は throw する", () => {
    const drop = MUTATIONS.find((m) => m.name === "random-drop-resource");
    expect(drop).toBeDefined();
    const without = Buffer.from(`${JSON.stringify({ resources: [{ path: "random/recorder.js" }] })}\n`, "utf8");
    expect(() => drop?.apply(without)).toThrow();
  });
});

describe("trace の壊し方", () => {
  const linesAfter = (name: string, input: Buffer = traceBytes()): Record<string, unknown>[] => {
    const { data } = MUTATIONS.find((m) => m.name === name)?.apply(input) ?? { data: null };
    return (data?.toString("utf8") ?? "")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  };

  it("trace-drop-line は、response を名指さない行を抜く（在れば）", () => {
    expect(linesAfter("trace-drop-line")).toEqual(traceLines().slice(0, 1));
    // どの行も response を名指すなら、最後の行を抜く。
    const named = [traceLines()[0] ?? {}, { ...traceLines()[0], id: "1.3" }];
    expect(linesAfter("trace-drop-line", traceBytes(named))).toEqual(named.slice(0, 1));
  });

  it("trace-rewrite-record は、record を持つ最初の行だけを書き換える", () => {
    const [first, second] = traceLines();
    const after = linesAfter("trace-rewrite-record");
    expect(after[0]).toEqual({ ...first, record: "urn:uuid:00000000-0000-0000-0000-000000000000" });
    expect(after[1]).toEqual(second);
  });

  it("trace-drop-entry は、エントリごと抜く（null を返す）", () => {
    expect(MUTATIONS.find((m) => m.name === "trace-drop-entry")?.apply(traceBytes()).data).toBeNull();
  });
});

describe("random の壊し方", () => {
  it("random-drop-draw は、最後の値の行だけを抜く（文書の行と、ほかの値の行は残す）", () => {
    const { data } = MUTATIONS.find((m) => m.name === "random-drop-draw")?.apply(randomBytes()) ?? { data: null };
    const after = (data?.toString("utf8") ?? "")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(after).toEqual(randomLines().slice(0, -1));
  });

  it("random-drop-resource は、resources の random/values.jsonl の行だけを落とす", () => {
    const { data } = MUTATIONS.find((m) => m.name === "random-drop-resource")?.apply(datapackageBytes()) ?? { data: null };
    const after = JSON.parse(data?.toString("utf8") ?? "{}") as { resources?: unknown; "browserhive:capture"?: unknown };
    expect(after.resources).toEqual([{ path: "random/recorder.js" }]);
    expect(after["browserhive:capture"]).toEqual({ tls: tls() });
  });
});
