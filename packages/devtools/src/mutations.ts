/**
 * 壊し方の一覧。
 *
 * 1 つの壊し方は「何をするか」と「それを検証すると何が出るはずか」を対で持つ。
 * 対にしておくと `--list` がそのまま案内になり、後で自動で答え合わせをしたく
 * なったときの入力にもなる —— 判定を人に任せる今の形を変えずに済む。
 */

/** アーカイブが持つ tls member(検証はしない。壊すのに必要な形だけ)。 */
export interface TlsMember {
  hosts: Record<string, Record<string, unknown> | null>;
  chains: Record<string, string[]>;
}

export interface Mutation {
  readonly name: string;
  /** これを壊したアーカイブを検証すると出るはずの messageKey。 */
  readonly expects: string;
  /**
   * 書き換える ZIP エントリ。
   *
   * `datapackage.json` 以外を選んだ場合、break-wacz が resources の hash と
   * bytes を書き直す —— 壊した覚えのない `datapackage/resource-hashes` が
   * 一緒に鳴ると、どちらが目当ての反応か読めなくなる。
   */
  readonly target: string;
  /**
   * エントリのバイト列を書き換え、新しいバイト列と「何をしたか」を返す。`data` が `null` なら、
   * エントリごと抜く —— break-wacz は resources の行も一緒に落とす（残すと、抜いた覚えのない
   * `datapackage/resource-hashes` が一緒に鳴る）。
   *
   * **壊せない入力では throw する。** 黙って何もせずに終わると、検証が緑のままで
   * 「rule が検出できていない」と読まれる —— 実際には壊れていないだけなのに。
   * 壊し方の嘘は rule の欠陥に化けるので、ここは失敗を隠さない。
   */
  readonly apply: (data: Buffer) => { readonly data: Buffer | null; readonly what: string };
}

export const DATAPACKAGE = "datapackage.json";
export const AXTREE = "accessibility/axtree.jsonl";
export const TRACE = "trace/events.jsonl";
export const RANDOM = "random/values.jsonl";

interface Datapackage {
  "browserhive:capture"?: { tls?: TlsMember };
  resources?: { path?: unknown }[];
  [key: string]: unknown;
}

/** `datapackage.json` の tls を書き換える壊し方を、エントリ単位の形へ包む。 */
const onTls = (
  name: string,
  expects: string,
  mutate: (tls: TlsMember) => string,
): Mutation => ({
  name,
  expects,
  target: DATAPACKAGE,
  apply: (data) => {
    const dp = JSON.parse(data.toString("utf8")) as Datapackage;
    const tls = dp["browserhive:capture"]?.tls;
    if (tls === undefined) {
      throw new Error("browserhive:capture.tls がありません (BrowserHive WACZ ですか)");
    }
    const what = mutate(tls);
    return { data: Buffer.from(`${JSON.stringify(dp, null, 2)}\n`, "utf8"), what };
  },
});

/** `accessibility/axtree.jsonl` の 1 行目を書き換える壊し方を包む。 */
const onAxtree = (
  name: string,
  expects: string,
  mutate: (snapshot: Record<string, unknown>) => string,
): Mutation => ({
  name,
  expects,
  target: AXTREE,
  apply: (data) => {
    const lines = data.toString("utf8").split("\n").filter((l) => l.trim() !== "");
    const first = lines[0];
    if (first === undefined) throw new Error("axtree.jsonl が空です");
    const snapshot = JSON.parse(first) as Record<string, unknown>;
    const what = mutate(snapshot);
    lines[0] = JSON.stringify(snapshot);
    return { data: Buffer.from(`${lines.join("\n")}\n`, "utf8"), what };
  },
});

/** JSON Lines のエントリ `target` の行を書き換える壊し方を包む。`mutate` は行の配列をその場で変える。 */
const onJsonLines = (
  target: string,
  name: string,
  expects: string,
  mutate: (lines: Record<string, unknown>[]) => string,
): Mutation => ({
  name,
  expects,
  target,
  apply: (data) => {
    const lines = data
      .toString("utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    if (lines.length === 0) throw new Error(`${target} に行がありません。この壊し方は使えません`);
    const what = mutate(lines);
    return { data: Buffer.from(lines.map((l) => `${JSON.stringify(l)}\n`).join(""), "utf8"), what };
  },
});

/**
 * `trace/events.jsonl` の行を書き換える壊し方を包む。
 *
 * 相手は BrowserHive WACZ Profile 1.23.0 以上を名乗る WACZ —— それより前を名乗る WACZ は trace を持たず、
 * break-wacz が「エントリがありません」で止める。
 */
const onTraceLines = (name: string, expects: string, mutate: (lines: Record<string, unknown>[]) => string): Mutation =>
  onJsonLines(TRACE, name, expects, mutate);

/**
 * `random/values.jsonl` の行を書き換える壊し方を包む。
 *
 * 相手は BrowserHive WACZ Profile 1.26.0 以上を名乗り、乱数を控えた（`browserhive:capture.random.recorded` が
 * true の）WACZ —— ほかの WACZ はこのエントリを持たず、break-wacz が「エントリがありません」で止める。
 */
const onRandomLines = (name: string, expects: string, mutate: (lines: Record<string, unknown>[]) => string): Mutation =>
  onJsonLines(RANDOM, name, expects, mutate);

/** 木の最初のノードを返す(壊す相手として)。 */
const firstNode = (snapshot: Record<string, unknown>): Record<string, unknown> => {
  const tree = snapshot["tree"];
  if (!Array.isArray(tree) || tree.length === 0) throw new Error("tree が空です");
  const node: unknown = tree[0];
  if (typeof node !== "object" || node === null) throw new Error("ノードが読めません");
  return node as Record<string, unknown>;
};

/** chainRef を持つ host を、鍵の順に並べて返す。 */
const hostsWithChain = (tls: TlsMember): { host: string; ref: string }[] =>
  Object.entries(tls.hosts)
    .flatMap(([host, observed]) => {
      const ref: unknown = observed?.["chainRef"];
      return typeof ref === "string" ? [{ host, ref }] : [];
    })
    .sort((a, b) => a.host.localeCompare(b.host));

/** 証明書が 2 通以上あるチェーンを 1 つ選ぶ。 */
const pickMultiCertChain = (tls: TlsMember): { host: string; ref: string } => {
  const found = hostsWithChain(tls).find((h) => (tls.chains[h.ref]?.length ?? 0) >= 2);
  if (found === undefined) {
    throw new Error("2 通以上のチェーンを持つ host がありません。この壊し方は使えません");
  }
  return found;
};

export const MUTATIONS: readonly Mutation[] = [
  onTls("swap-intermediate", "browserhive/tls-chain.broken-link", (tls) => {
    // DER は正しいまま、繋がりだけを壊す。別 host のチェーンから中間を借りる。
    const target = pickMultiCertChain(tls);
    const donor = hostsWithChain(tls).find(
      (h) => h.ref !== target.ref && (tls.chains[h.ref]?.length ?? 0) >= 2,
    );
    if (donor === undefined) throw new Error("差し替え元になる別のチェーンがありません");
    const chain = tls.chains[target.ref];
    const from = tls.chains[donor.ref];
    if (chain === undefined || from?.[1] === undefined) {
      throw new Error("チェーンの中身が足りません");
    }
    chain[1] = from[1];
    return `${target.host} のチェーンの中間を ${donor.host} のものへ差し替え`;
  }),
  onTls("reverse-chain", "browserhive/tls-chain.leaf-not-first", (tls) => {
    const target = pickMultiCertChain(tls);
    tls.chains[target.ref]?.reverse();
    return `${target.host} のチェーンの並びを逆にした(リーフが末尾へ)`;
  }),
  onTls("drop-chains", "browserhive/tls-chain.dangling-ref", (tls) => {
    const refs = hostsWithChain(tls);
    if (refs.length === 0) throw new Error("chainRef を持つ host がありません");
    tls.chains = {};
    return `chains を空にした(${String(refs.length)} 件の chainRef が宙に浮く)`;
  }),
  onTls("garbage-der", "browserhive/tls-chain.unparseable", (tls) => {
    const target = hostsWithChain(tls)[0];
    if (target === undefined) throw new Error("chainRef を持つ host がありません");
    // base64 としては読めるが、証明書ではないもの。
    tls.chains[target.ref] = ["bm90IGEgY2VydGlmaWNhdGU="];
    return `${target.host} のチェーンを証明書でない base64 に差し替え`;
  }),
  onTls("san-drift", "browserhive/tls-san.drift", (tls) => {
    const entry = Object.entries(tls.hosts).find(
      ([, observed]) => Array.isArray(observed?.["san"]),
    );
    if (entry === undefined) throw new Error("san を持つ host がありません");
    const [host, observed] = entry;
    if (observed === null) throw new Error("unreachable");
    const san = observed["san"];
    if (!Array.isArray(san)) throw new Error("unreachable");
    // 証明書には無い名前を足す。数が変わるので突き合わせで落ちる。
    observed["san"] = [...(san as string[]), "not-in-the-certificate.example"];
    return `${host} の san に、証明書が持たない名前を 1 つ足した`;
  }),

  onAxtree("axtree-drop-level", "browserhive/axtree-shape.missing-member", (snapshot) => {
    // 木そのものを落とす。刈り込み規則ではなく、スナップショットの形の検査。
    delete snapshot["tree"];
    return "スナップショットから tree を落とした";
  }),
  onAxtree("axtree-unknown-property", "browserhive/axtree-shape.unknown-property", (snapshot) => {
    // WACZ Profile が許していない property を 1 つ足す。producer が刈り込み規則を
    // 変えたのに版を上げなかった、という形をなぞる。
    firstNode(snapshot)["focusable"] = true;
    return "最初のノードに focusable を足した(WACZ Profile が許していない property)";
  }),
  onAxtree("axtree-keep-generic", "browserhive/axtree-shape.collapsed-role", (snapshot) => {
    const tree = snapshot["tree"];
    if (!Array.isArray(tree)) throw new Error("tree が配列ではありません");
    // 畳まれているはずの role を差し込む。
    tree.unshift({ role: "generic", children: [] });
    return "畳まれているはずの generic ノードを木の先頭に差し込んだ";
  }),
  onAxtree("axtree-wrong-profile", "browserhive/axtree-shape.unknown-profile", (snapshot) => {
    snapshot["profile"] = "browserhive:axtree/99";
    return "profile を browserhive:axtree/99 に書き換えた";
  }),

  onTraceLines("trace-drop-line", "browserhive/trace-shape.line-count", (lines) => {
    // 要約 (browserhive:capture.trace.lines) はそのまま。response を名指さない行が在ればそれを抜く ——
    // 名指す行を抜くと、名指されなくなった response の指摘 (response-unnamed) も一緒に出る。
    const loose = lines.findIndex((l) => l["record"] === undefined);
    const at = loose === -1 ? lines.length - 1 : loose;
    lines.splice(at, 1);
    return loose === -1
      ? `${String(at + 1)} 行目を抜いた(response を名指す行なので、response-unnamed も出る)`
      : `${String(at + 1)} 行目を抜いた(response を名指さない行)`;
  }),
  onTraceLines("trace-rewrite-record", "browserhive/trace-shape.record-unknown", (lines) => {
    const at = lines.findIndex((l) => typeof l["record"] === "string");
    const line = lines[at];
    if (line === undefined) throw new Error("record を持つ行がありません。この壊し方は使えません");
    // どの本にも無い ID。元の response は名指されなくなるので、response-unnamed も出る。
    line["record"] = "urn:uuid:00000000-0000-0000-0000-000000000000";
    return `${String(at + 1)} 行目の record を、どの本にも無い ID に書き換えた(元の response は名指されなくなる)`;
  }),
  {
    name: "trace-drop-entry",
    expects: "browserhive/trace-shape.missing",
    target: TRACE,
    // 要約はそのまま。エントリと resources の行だけが消える。
    apply: () => ({ data: null, what: "trace/events.jsonl をエントリごと抜いた(resources の行も)" }),
  },

  onRandomLines("random-drop-draw", "browserhive/random-shape.count", (lines) => {
    // 要約 (browserhive:capture.random.draws) はそのまま。最後の値の行を抜く —— その文書の最後の値の行なので、
    // 残った行の seq は 0 から 1 つずつのまま（途中の行を抜くと seq-order も一緒に出る）。
    const at = lines.findLastIndex((l) => l["kind"] === "draw");
    if (at === -1) throw new Error("random/values.jsonl に値の行がありません。この壊し方は使えません");
    lines.splice(at, 1);
    return `${String(at + 1)} 行目（最後の値の行）を抜いた`;
  }),
  {
    name: "random-drop-resource",
    expects: "browserhive/random-shape.not-in-resources",
    target: DATAPACKAGE,
    apply: (data) => {
      // エントリはそのまま。datapackage.json の resources から、その行だけを落とす。
      const dp = JSON.parse(data.toString("utf8")) as Datapackage;
      const resources = dp.resources ?? [];
      if (!resources.some((r) => r.path === RANDOM)) {
        throw new Error("resources に random/values.jsonl がありません。この壊し方は使えません");
      }
      dp.resources = resources.filter((r) => r.path !== RANDOM);
      return { data: Buffer.from(`${JSON.stringify(dp, null, 2)}\n`, "utf8"), what: "resources から random/values.jsonl の行を落とした(エントリは残す)" };
    },
  },
];
