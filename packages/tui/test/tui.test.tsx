// @module-tag tui
/**
 * TUI rendering テスト。
 *
 * Ink の `App` を `ink-testing-library` で駆動する。daemon クライアント化後の
 * App は解決済みの {@link WireReport}(`message` / `specUrl` / `conformance` が
 * inline)を受け取り、core の i18n を呼ばずそれを描く。よってモックの issue は
 * `message`(必須)/ 必要なら `specUrl` を直接持たせる。
 *
 * 実 terminal は関わらない(in-memory frame)。byte 単位 snapshot は取らず、
 * substring assertion で意味論的 surface を cover する。
 */
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { render } from "ink-testing-library";
import { render as inkRender } from "ink";
import { describe, expect, it } from "vitest";
import type { ReactElement } from "react";
import type { AbsolutePath, ExpectedBy, Field, RecordSummary, WireLine, WireReport } from "@wacz-validator/protocol";
import { App, type ContentBridge } from "../src/app.js";

/**
 * 端末サイズ(columns × rows)を明示して App を描く小さなハーネス。
 * ink-testing-library の stdout は rows を持たず、Ink の getWindowSize が実端末サイズ
 * (terminal-size)へフォールバックする。「frame ≤ 端末行数」を決定論的に検証するには
 * rows を固定する必要があるので、ink 本体の render に固定サイズの stdout を渡す。
 */
class FakeOut extends EventEmitter {
  readonly columns: number;
  readonly rows: number;
  last = "";
  constructor(columns: number, rows: number) {
    super();
    this.columns = columns;
    this.rows = rows;
  }
  write = (frame: string): void => {
    this.last = frame;
  };
}
/** Ink が stdin に対して呼ぶが、テストでは何もしなくてよいメソッド群の共有 no-op。 */
const noop = (): void => {
  /* unused stdin stub */
};
class FakeIn extends EventEmitter {
  isTTY = true;
  data: string | null = null;
  setEncoding = noop;
  setRawMode = noop;
  resume = noop;
  pause = noop;
  ref = noop;
  unref = noop;
  read = (): string | null => {
    const d = this.data;
    this.data = null;
    return d;
  };
  write = (d: string): void => {
    this.data = d;
    this.emit("readable");
    this.emit("data", d);
  };
}
const renderAt = (
  columns: number,
  rows: number,
  el: ReactElement,
): { stdin: FakeIn; lastFrame: () => string; unmount: () => void } => {
  const stdout = new FakeOut(columns, rows);
  const stdin = new FakeIn();
  const instance = inkRender(el, {
    stdout: stdout as never,
    stderr: new FakeOut(columns, rows) as never,
    stdin: stdin as never,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  return { stdin, lastFrame: (): string => stdout.last, unmount: instance.unmount };
};

const makeReport = (overrides: Partial<WireReport> = {}): WireReport => ({
  validatorVersion: "0.0.0",
  profile: { name: "spec" },
  source: { kind: "file", path: "/tmp/fixture.wacz" as AbsolutePath },
  summary: { passed: 3, failed: 2, warnings: 0, info: 0, durationMs: 12 },
  issues: [
    {
      rule: "datapackage/profile-required",
      severity: "error",
      messageKey: "datapackage/profile-required.missing-field",
      message: 'datapackage.json is missing the "profile" field',
      params: { entry: "datapackage.json" },
      location: { entry: "datapackage.json" },
      details: { expected: "data-package" },
    },
    {
      rule: "cdxj/filename-archive-relative",
      severity: "error",
      messageKey: "cdxj/filename-archive-relative.starts-with-archive",
      message: 'entry "filename" starts with "archive/"',
      params: { entry: "indexes/index.cdxj" },
      location: { entry: "indexes/index.cdxj", line: 1 },
    },
  ],
  entries: [],
  ...overrides,
});

/** Header の build prop スタブ。tui/daemon の SHA を揃え、不一致警告を出さない。 */
const buildStub = {
  tui: { version: "0.0.0", gitSha: "testsha" },
  daemon: { version: "0.0.0", gitSha: "testsha" },
};

describe("tui rendering", () => {
  it("renders all issue rule names and the summary", async () => {
    const { lastFrame } = render(<App report={makeReport()} build={buildStub} />);
    // ビューポートは useBoxMetrics で高さを実測してから可視ぶんを描くので、初回 layout
    // パスが終わるまで 1 tick 待つ(以降のスクロール系テストも同様)。
    await new Promise((resolve) => setTimeout(resolve, 60));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("wacz-validator");
    expect(frame).toContain("datapackage/profile-required");
    expect(frame).toContain("cdxj/filename-archive-relative");
    expect(frame).toContain("3 passed");
    expect(frame).toContain("2 failed");
    expect(frame).toContain("↑↓ navigate");
  });

  it("shows 'All rules passed.' when there are no issues", () => {
    const report = makeReport({
      issues: [],
      summary: { passed: 5, failed: 0, warnings: 0, info: 0, durationMs: 8 },
    });
    const { lastFrame } = render(<App report={report} build={buildStub} />);
    expect(lastFrame() ?? "").toContain("All rules passed.");
  });

  it("starts with the cursor on the first issue", () => {
    const { lastFrame } = render(<App report={makeReport()} build={buildStub} />);
    const frame = lastFrame() ?? "";
    const cursorIdx = frame.indexOf("▸");
    const firstRuleIdx = frame.indexOf("datapackage/profile-required");
    expect(cursorIdx).toBeGreaterThanOrEqual(0);
    expect(cursorIdx).toBeLessThan(firstRuleIdx);
    expect(frame.match(/▸/g)?.length ?? 0).toBe(1);
  });

  it("expands details on enter", async () => {
    const { lastFrame, stdin } = render(<App report={makeReport()} build={buildStub} />);
    expect(lastFrame() ?? "").not.toContain("expected:");
    stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(lastFrame() ?? "").toContain("data-package");
  });

  it("moves the cursor with the down arrow", async () => {
    const { lastFrame, stdin } = render(<App report={makeReport()} build={buildStub} />);
    // 本物の down-arrow は ESC + CSI(`[B`)。ESC 無しの "[B" は ink の
    // デコードが不安定なので、正しい制御シーケンスで決定的に駆動する。
    stdin.write("[B");
    await new Promise((resolve) => setTimeout(resolve, 60));
    const frame = lastFrame() ?? "";
    const cursorIdx = frame.indexOf("▸");
    const firstRuleIdx = frame.indexOf("datapackage/profile-required");
    const secondRuleIdx = frame.indexOf("cdxj/filename-archive-relative");
    expect(cursorIdx).toBeGreaterThan(firstRuleIdx);
    expect(cursorIdx).toBeLessThan(secondRuleIdx);
  });

  it("detail-less issue を enter すると『これ以上の詳細はありません』を出す", async () => {
    const rep = makeReport({
      issues: [{ rule: "x/y", severity: "error", messageKey: "x/y.z", message: "no details here" }],
    });
    const { lastFrame, stdin } = render(<App report={rep} build={buildStub} />);
    stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(lastFrame() ?? "").toContain("これ以上の詳細はありません");
  });

  it("enter で開閉マーカーが ▸ から ▾ に変わる", async () => {
    const { lastFrame, stdin } = render(<App report={makeReport()} build={buildStub} />);
    expect(lastFrame() ?? "").toContain("▸");
    stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(lastFrame() ?? "").toContain("▾");
  });

  it("展開すると docs のラベルと URL を表示する", async () => {
    const rep = makeReport({
      issues: [
        {
          rule: "x/y",
          severity: "error",
          messageKey: "x/y.z",
          message: "m",
          docs: [{ label: "WACZ §archive", url: "https://specs.webrecorder.net/wacz/1.1.1/#archive" }],
        },
      ],
    });
    const { lastFrame, stdin } = render(<App report={rep} build={buildStub} />);
    stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 60));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("WACZ §archive");
    expect(frame).toContain("specs.webrecorder.net/wacz/1.1.1/#archive");
  });

  it("renders the stats footer when report.stats is present", () => {
    const report = makeReport({
      stats: { warcRecordCount: 42, warcArchiveBytes: 5 * 1024 * 1024, hosts: ["a", "b", "c"] },
    });
    const frame = render(<App report={report} build={buildStub} />).lastFrame() ?? "";
    expect(frame).toContain("42 records");
    expect(frame).toContain("5.0 MB");
    expect(frame).toContain("3 hosts");
  });

  it("diff view shows expected/actual for hash-style issues", async () => {
    const report = makeReport({
      issues: [
        {
          rule: "datapackage/resource-hashes",
          severity: "error",
          messageKey: "datapackage/resource-hashes.hash-mismatch",
          message: 'Resource "archive/data.warc.gz" hash mismatch',
          params: { path: "archive/data.warc.gz" },
          details: { expected: "sha256:GOOD", actual: "sha256:BAD" },
        },
      ],
    });
    const { lastFrame, stdin } = render(<App report={report} build={buildStub} />);
    stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 60));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("expected:");
    expect(frame).toContain("actual:");
    expect(frame).toContain("sha256:GOOD");
    expect(frame).toContain("sha256:BAD");
  });

  it("WARC header view renders for CDXJ↔WARC mismatch details", async () => {
    const report = makeReport({
      issues: [
        {
          rule: "cdxj/warc-offsets",
          severity: "error",
          messageKey: "cdxj/warc-offsets.offset-no-match",
          message: "indexes/index.cdxj line 1: offset 99 does not match any WARC member start",
          params: { line: "1", offset: "99" },
          details: {
            requested: { offset: 99, length: 100 },
            candidates: [{ offset: 0, length: 200, warcHeader: ["WARC/1.1"] }],
          },
        },
      ],
    });
    const { lastFrame, stdin } = render(<App report={report} build={buildStub} />);
    stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(lastFrame() ?? "").toContain("Nearby WARC members:");
  });

  it("hex view renders when details carry hexPreview", async () => {
    const report = makeReport({
      issues: [
        {
          rule: "warc/payload-digest",
          severity: "warning",
          messageKey: "warc/payload-digest.mismatch",
          message: "WARC record #1 payload digest mismatch",
          params: { memberIdx: "1" },
          details: {
            expected: "sha256:GOOD",
            actual: "sha256:BAD",
            hexPreview: [
              "00000000  4e a7 5b 0c 1f 8b 08 00  00 00 00 00 00 03 b5 d3   N.[..........X..",
            ],
          },
        },
      ],
    });
    const { lastFrame, stdin } = render(<App report={report} build={buildStub} />);
    stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 60));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Payload preview (hex):");
    expect(frame).toContain("4e a7 5b 0c");
  });

  it("shows a spec URL line when an issue carries a resolved specUrl", () => {
    const report = makeReport({
      issues: [
        {
          rule: "wacz/required-files",
          severity: "error",
          messageKey: "wacz/required-files.missing-archive",
          message: "archive/ has no WARC file",
          specUrl: "https://specs.webrecorder.net/wacz/1.1.1/#archive",
          params: { section: "5.2.1" },
          location: { entry: "archive/" },
        },
      ],
    });
    const frame = render(<App report={report} build={buildStub} />).lastFrame() ?? "";
    expect(frame).toContain("spec https://specs.webrecorder.net/wacz/1.1.1/#archive");
  });

  it("omits the spec line when an issue has no resolved specUrl", () => {
    const report = makeReport({
      issues: [
        {
          rule: "x/y",
          severity: "error",
          messageKey: "x/y.z",
          message: "some issue",
          location: { entry: "datapackage.json" },
        },
      ],
    });
    const frame = render(<App report={report} build={buildStub} />).lastFrame() ?? "";
    expect(frame).not.toContain("spec https://");
  });
});

describe("tui — layout view", () => {
  const withEntries = () =>
    makeReport({
      entries: [
        {
          path: "archive/data.warc.gz",
          present: true,
          uncompressedSize: 100,
          compressionMethod: 0,
          expectedBy: ["datapackage"],
          issues: [{ rule: "datapackage/resource-hashes", severity: "error" }],
        },
        {
          path: "datapackage.json",
          present: true,
          uncompressedSize: 50,
          compressionMethod: 8,
          expectedBy: ["wacz-spec"],
          issues: [],
        },
        {
          path: "pages/extraPages.jsonl",
          present: false,
          expectedBy: ["datapackage"],
          issues: [],
        },
      ],
    });

  it("starts on the Issues view (no file tree)", () => {
    const frame = render(<App report={withEntries()} build={buildStub} />).lastFrame() ?? "";
    expect(frame).not.toContain("data.warc.gz");
  });

  it("Tab switches to the Layout view: §5.1 tree with compact status icons", async () => {
    const { lastFrame, stdin } = render(<App report={withEntries()} build={buildStub} />);
    stdin.write("\t"); // Tab
    await new Promise((resolve) => setTimeout(resolve, 60));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("data.warc.gz"); // tree leaf
    expect(frame).toContain("└──"); // §5.1 connector
    expect(frame).toContain("✗"); // compact status icon (error issue / missing)
    expect(frame).not.toContain("datapackage/resource-hashes");
  });

  it("Layout pane shows metadata + full issue for the selected file", async () => {
    const report = makeReport({
      entries: [
        {
          path: "datapackage.json",
          present: true,
          uncompressedSize: 885,
          compressionMethod: 8,
          expectedBy: ["wacz-spec"],
          issues: [{ rule: "datapackage/profile-required", severity: "error" }],
        },
      ],
      issues: [
        {
          rule: "datapackage/profile-required",
          severity: "error",
          messageKey: "datapackage/profile-required.missing-field",
          message: 'datapackage.json is missing the "profile" field',
          params: { entry: "datapackage.json" },
          location: { entry: "datapackage.json" },
        },
      ],
    });
    const { lastFrame, stdin } = render(<App report={report} build={buildStub} />);
    stdin.write("\t"); // Tab → Layout、focus 0 = datapackage.json(root file）
    await new Promise((resolve) => setTimeout(resolve, 60));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("present"); // status
    expect(frame).toContain("DEFLATE"); // codecName(8)
    expect(frame).toContain("required by §5.2"); // expectedLabel(["wacz-spec"])
    expect(frame).toContain("datapackage/profile-required"); // ペインの issue rule
    expect(frame).toContain("field"); // 全文 message(word-wrap されても "field" は残る）
  });

  it("Layout pane shows MISSING + §5.2 reason for an absent required file", async () => {
    const report = makeReport({
      entries: [
        {
          path: "datapackage.json",
          present: false,
          expectedBy: ["wacz-spec"],
          issues: [{ rule: "wacz/required-files", severity: "error" }],
        },
      ],
      issues: [
        {
          rule: "wacz/required-files",
          severity: "error",
          messageKey: "wacz/required-files.missing-datapackage",
          message: "datapackage.json is missing",
          location: { entry: "datapackage.json" },
        },
      ],
    });
    const { lastFrame, stdin } = render(<App report={report} build={buildStub} />);
    stdin.write("\t");
    await new Promise((resolve) => setTimeout(resolve, 60));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("MISSING"); // pane の status
    expect(frame).toContain("wacz/required-files"); // pane の issue rule
  });

  it("長いファイル名でも端末幅(100)を超えない(左ツリーが折り返さない)", async () => {
    // ink-testing-library は columns=100 固定。100 桁超のファイル名を入れ、左ツリーが
    // maxWidth で頭打ちされて端末幅を超えない(=折り返して崩れない)ことを確かめる。
    const longName = `archive/rec-${"0".repeat(90)}.warc.gz`;
    const report = makeReport({
      entries: [
        {
          path: longName,
          present: true,
          uncompressedSize: 100,
          compressionMethod: 0,
          expectedBy: ["datapackage"],
          issues: [],
        },
      ],
    });
    const { lastFrame, stdin } = render(<App report={report} build={buildStub} />);
    stdin.write("\t"); // → Layout
    await new Promise((resolve) => setTimeout(resolve, 60));
    const max = Math.max(...(lastFrame() ?? "").split("\n").map((l) => l.length));
    expect(max).toBeLessThanOrEqual(100);
  });
});

const REAL_CDXJ =
    'org,wikimedia,upload)/wikipedia/commons/4/4d/icon_pdf_file.png 20220831121514 {"url": "https://upload.wikimedia.org/wikipedia/commons/4/4d/Icon_pdf_file.png", "mime": "image/png", "status": "200", "digest": "sha1:UKKPFYIP53NFMQTHRDY2CQERNZXKXWY3", "length": "1320", "offset": "5504", "filename": "rec-20220831121514140372-203de340fdad.warc.gz", "recordDigest": "sha256:9a5ad858a5a8730074545095192ad070224dcb489d0d6b4e48926a0f7ea89fb7", "referrer": "https://en.wikipedia.org/"}';

describe("tui — content view (行の窓)", () => {
  // ルート直下のファイル 1 つ。tab→Layout 直後の focus=0 がこのファイル行になる。
  // 名前は .warc.gz にしない —— それはレコードの一覧へ行く。
  const reportWithFile = (path = "index.cdxj"): WireReport =>
    makeReport({
      entries: [
        {
          path,
          present: true,
          uncompressedSize: 92700,
          compressionMethod: 8,
          expectedBy: ["datapackage"],
          issues: [],
        },
      ],
    });

  const wire = (n: number, text: string): WireLine => ({
    n,
    text,
    cut: false,
    binary: false,
    bytes: Buffer.byteLength(text),
  });

  /** daemon が割って返す fields の代わり。実物の 1 行だけ割り、他は割らない。 */
  const fieldsOf = (text: string): Field[] =>
    text === REAL_CDXJ
      ? [
          { label: "key", value: "org,wikimedia,upload)/wikipedia/commons/4/4d/icon_pdf_file.png", fromJson: false },
          { label: "timestamp", value: "20220831121514  (2022-08-31 12:15:14 UTC)", fromJson: false },
          { label: "url", value: "https://upload.wikimedia.org/wikipedia/commons/4/4d/Icon_pdf_file.png", fromJson: true },
          { label: "mime", value: "image/png", fromJson: true },
          { label: "status", value: "200", fromJson: true },
          { label: "digest", value: "sha1:UKKPFYIP53NFMQTHRDY2CQERNZXKXWY3", fromJson: true },
          { label: "length", value: "1320", fromJson: true },
          { label: "offset", value: "5504", fromJson: true },
          { label: "filename", value: "rec-20220831121514140372-203de340fdad.warc.gz", fromJson: true },
          {
            label: "recordDigest",
            value: "sha256:9a5ad858a5a8730074545095192ad070224dcb489d0d6b4e48926a0f7ea89fb7",
            fromJson: true,
          },
          { label: "referrer", value: "https://en.wikipedia.org/", fromJson: true },
        ]
      : [{ label: "line", value: text, fromJson: false }];

  /** daemon の代わり。行の列を窓で返し、頼まれた窓を記録する。 */
  const bridgeOf = (lines: string[], window = 500): { bridge: ContentBridge; asked: string[] } => {
    const asked: string[] = [];
    const bridge: ContentBridge = {
      lines: (_path, from, count) => {
        asked.push(`lines:${String(from)}`);
        const take = Math.min(count, window);
        const slice = lines.slice(from, from + take).map((text, i) => wire(from + i, text));
        return Promise.resolve({
          lines: slice,
          next: from + take < lines.length ? from + take : null,
          gunzipped: true,
        });
      },
      line: (_path, n) => {
        asked.push(`line:${String(n)}`);
        const text = lines[n] ?? "";
        return Promise.resolve({ ...wire(n, text), fields: fieldsOf(text), gunzipped: true });
      },
      records: () => Promise.reject(new Error("not a WARC")),
      record: () => Promise.reject(new Error("not a WARC")),
    };
    return { bridge, asked };
  };

  const warcLines = [
    "WARC/1.0",
    "WARC-Type: response",
    "WARC-Target-URI: https://en.wikipedia.org/wiki/World_Wide_Web",
  ];

  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60));

  it("Layout で enter: 全幅 content view に開く(ツリーは消える)", async () => {
    const { bridge } = bridgeOf(warcLines);
    const { lastFrame, stdin } = render(
      <App report={reportWithFile()} bridge={bridge} build={buildStub} />,
    );
    stdin.write("\t"); // → Layout
    await tick();
    stdin.write("\r"); // enter → 全幅 content view(取得 + 遷移)
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("content (gzip 展開)"); // content ビューのヘッダ
    expect(frame).toContain("WARC/1.0"); // 内容(スクロール窓内)
    expect(frame).not.toContain("index.cdxj"); // ツリーは別ビューなので描かれない
  });

  it("content view で esc: Layout に戻る", async () => {
    const { bridge } = bridgeOf(warcLines);
    const { lastFrame, stdin } = render(
      <App report={reportWithFile()} bridge={bridge} build={buildStub} />,
    );
    stdin.write("\t");
    await tick();
    stdin.write("\r"); // → content view
    await tick();
    stdin.write("\u001B"); // esc → Layout
    await tick();
    expect(lastFrame() ?? "").toContain("index.cdxj"); // ツリーが戻る
  });

  it("content をスクロールできる(G で末尾へ・先頭行が窓から外れる)", async () => {
    const many = Array.from({ length: 100 }, (_, i) => `row-${String(i).padStart(3, "0")}`);
    const { bridge } = bridgeOf(many);
    const { lastFrame, stdin } = render(<App report={reportWithFile()} bridge={bridge} build={buildStub} />);
    stdin.write("\t");
    await tick();
    stdin.write("\r"); // → content view(先頭行が窓内)
    await tick();
    expect(lastFrame() ?? "").toContain("row-000");
    stdin.write("G"); // 末尾へジャンプ
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("row-099"); // 末尾行が見える
    expect(frame).not.toContain("row-000"); // 先頭行は窓から外れた
  });

  it("窓の末尾に着いたら、続きを頼んで足す(next が null になるまで)", async () => {
    // 25 行を 10 行ずつ。開いた直後は 10 行 (+ は続きがある印)、G で末尾に着くと次の窓。
    const lines = Array.from({ length: 25 }, (_, i) => `line-${String(i).padStart(2, "0")}`);
    const { bridge, asked } = bridgeOf(lines, 10);
    const { lastFrame, stdin } = render(<App report={reportWithFile()} bridge={bridge} build={buildStub} />);
    stdin.write("\t");
    await tick();
    stdin.write("\r");
    await tick();
    expect(lastFrame() ?? "").toContain("line 1/10+");
    expect(asked).toEqual(["lines:0"]);
    stdin.write("G"); // 末尾へ → 続きを頼む
    await tick();
    expect(asked).toEqual(["lines:0", "lines:10"]);
    expect(lastFrame() ?? "").toContain("/20+");
    stdin.write("G");
    await tick();
    expect(asked).toEqual(["lines:0", "lines:10", "lines:20"]);
    expect(lastFrame() ?? "").toContain("/25 "); // 末尾まで届いたので + が消える
  });

  // どの端末高でも、Layout でも content(100 行ロード)でも、App のフレーム行数が
  // 端末行数を超えないこと(=Ink の縦はみ出し崩れが起きない)を、rows を固定して検証。
  // ※ ink-testing-library は rows を持たず実端末サイズへフォールバックするので renderAt を使う。
  for (const rows of [20, 30, 50]) {
    it(`端末 ${String(rows)} 行: App はその行数を超えない`, async () => {
      const many = Array.from({ length: 100 }, (_, i) => `line-${String(i)}`);
      const { bridge } = bridgeOf(many);
      const { lastFrame, stdin, unmount } = renderAt(
        120,
        rows,
        <App report={reportWithFile()} bridge={bridge} build={buildStub} />,
      );
      stdin.write("\t"); // → Layout
      await tick();
      const layoutH = lastFrame().split("\n").length;
      stdin.write("\r"); // → content view(100 行ロード)
      await tick();
      const contentH = lastFrame().split("\n").length;
      unmount();
      expect(layoutH).toBeLessThanOrEqual(rows);
      expect(contentH).toBeLessThanOrEqual(rows);
    });
  }

  // ── content の行を選んで enter → 1 行だけを縦に開く ────────────────────
  //
  // `index.cdx.gz` の行は中央値 563 文字あり、80 桁の端末では切られて読めない。
  // 端末幅を **明示的に狭く固定** して、切られていた値が詳細ビューで見えることを
  // 見る。ink-testing-library の既定幅では実端末に引きずられ、たまたま全部
  // 収まってしまって検出力が消えるので renderAt を使う。
  //
  // fields は daemon が割って返す (fieldsOf が代わり)。tui は割り方を持たない。

  const openCdxjLine = async (): Promise<{
    lastFrame: () => string;
    stdin: FakeIn;
    unmount: () => void;
    asked: string[];
  }> => {
    const { bridge, asked } = bridgeOf([REAL_CDXJ, "second line", "third line"]);
    const h = renderAt(80, 40, <App report={reportWithFile()} bridge={bridge} build={buildStub} />);
    h.stdin.write("\t"); // → Layout
    await tick();
    h.stdin.write("\r"); // → content
    await tick();
    return { ...h, asked };
  };

  it("content では長い行が端末幅で切られている(前提の確認)", async () => {
    const { lastFrame, unmount } = await openCdxjLine();
    const frame = lastFrame();
    unmount();
    // 行頭は見えるが、末尾側の値は 80 桁に入らない。
    expect(frame).toContain("org,wikimedia,upload)");
    expect(frame).not.toContain("rec-20220831121514140372");
  });

  it("content で enter: daemon が割った 1 行がラベル付きで開き、切れていた値が見える", async () => {
    const { lastFrame, stdin, unmount, asked } = await openCdxjLine();
    stdin.write("\r"); // → line ビュー
    await tick();
    const frame = lastFrame();
    unmount();

    // ── ① 1 行を daemon に頼んでいる (content の窓を使い回さない —— 窓の行は切れうる)。
    expect(asked).toContain("line:0");

    // ── ② 実際に割れていること。
    // `filename` や `rec-…` は **生の JSON 文字列にも現れる** ので、それを
    // 見ても整形の有無を区別できない。JSON の記法そのものが消えたかを見る。
    expect(frame).not.toContain('{"url"');
    expect(frame).not.toContain('", "mime": "');

    // ── ③ 切らずに折り返していること。
    // recordDigest は `sha256:` + 64 桁 = 71 文字。ラベル欄が 14 桁なので値の幅は
    // 66 桁しかなく、67 文字目以降は次の行へ回る。**折り返しは改行を挟む**ので
    // 全長を 1 つの文字列としては assert できない。先頭側と、回り込んだ末尾の
    // 両方が居ることを見る(truncate だと末尾が消える)。
    expect(frame).toContain("sha256:9a5ad858a5a87300745450951"); // 1 行目に載る側
    expect(frame).toContain("89fb7"); // 66 桁を超えて 2 行目へ回った側

    // ── ④ content では切られていた値。
    expect(frame).toContain("rec-20220831121514140372");
    expect(frame).toContain("5504");

    // ── ⑤ 見出しに位置と長さ。
    expect(frame).toContain("line 1 / 3");
    expect(frame).toContain("476 bytes");
  });

  it("line ビューで esc: content に戻り、カーソル位置が保たれる", async () => {
    const { lastFrame, stdin, unmount } = await openCdxjLine();
    stdin.write("\u001B[B"); // ↓ → 2 行目へ
    await tick();
    stdin.write("\r"); // → line
    await tick();
    expect(lastFrame()).toContain("line 2 / 3");
    stdin.write("\u001B"); // esc → content
    await tick();
    const frame = lastFrame();
    unmount();
    expect(frame).toContain("second line");
    expect(frame).toContain("line 2/3"); // カーソルは 2 行目のまま
  });

  it("line ビューのまま ↑↓ で前後の行に移れる(その行も daemon に頼む)", async () => {
    const { lastFrame, stdin, unmount, asked } = await openCdxjLine();
    stdin.write("\r"); // → line (1 行目)
    await tick();
    stdin.write("j"); // 次の行へ(開いたまま)
    await tick();
    const frame = lastFrame();
    unmount();
    expect(frame).toContain("line 2 / 3");
    expect(frame).toContain("second line");
    expect(asked.filter((a) => a.startsWith("line:"))).toEqual(["line:0", "line:1"]);
  });

  it("割られていない行は、そのまま 1 つの field で見せる", async () => {
    const { lastFrame, stdin, unmount } = await openCdxjLine();
    stdin.write("G"); // 末尾行(third line)へ
    await tick();
    stdin.write("\r");
    await tick();
    const frame = lastFrame();
    unmount();
    expect(frame).toContain("third line");
    expect(frame).not.toContain("filename");
  });

  it("切れた行・binary の行は、一覧にその印が出る", async () => {
    const bridge: ContentBridge = {
      lines: () =>
        Promise.resolve({
          lines: [
            { n: 0, text: "head of a long line", cut: true, binary: false, bytes: 404_696 },
            { n: 1, text: "", cut: false, binary: true, bytes: 9_930 },
          ],
          next: null,
          gunzipped: false,
        }),
      line: () => Promise.reject(new Error("unused")),
      records: () => Promise.reject(new Error("unused")),
      record: () => Promise.reject(new Error("unused")),
    };
    const { lastFrame, stdin, unmount } = renderAt(
      100,
      20,
      <App report={reportWithFile()} bridge={bridge} build={buildStub} />,
    );
    stdin.write("\t");
    await tick();
    stdin.write("\r");
    await tick();
    const frame = lastFrame();
    unmount();
    expect(frame).toContain("head of a long line …");
    expect(frame).toContain("(binary · 9.7 KB)");
  });
});

describe("tui — records view (WARC はレコードの一覧で開く)", () => {
  const reportWithWarc = (): WireReport =>
    makeReport({
      entries: [
        {
          path: "data.warc.gz",
          present: true,
          uncompressedSize: 6_338_608,
          compressionMethod: 0,
          expectedBy: ["datapackage"],
          issues: [],
        },
      ],
    });

  const rows: RecordSummary[] = [
    { offset: 0, length: 250, type: "warcinfo", contentType: "application/warc-fields", indexed: false },
    {
      offset: 250,
      length: 10_791,
      type: "response",
      uri: "https://news-pctr.c.yimg.jp/t/a.jpg",
      status: 200,
      mime: "image/jpeg",
      indexed: true,
    },
    {
      offset: 11_041,
      length: 300,
      type: "metadata",
      uri: "https://www.googletagmanager.com/gtm.js",
      contentType: "application/warc-fields",
      indexed: false,
    },
  ];

  const bridge: ContentBridge = {
    lines: () => Promise.reject(new Error("a WARC opens as records")),
    line: () => Promise.reject(new Error("a WARC opens as records")),
    records: () => Promise.resolve({ records: rows, next: null, total: rows.length }),
    record: (_path, offset) =>
      Promise.resolve(
        offset === 250
          ? {
              warc: [
                { name: "WARC-Type", value: "response" },
                { name: "WARC-Target-URI", value: "https://news-pctr.c.yimg.jp/t/a.jpg" },
              ],
              http: { status: "HTTP/1.1 200 OK", headers: [{ name: "content-type", value: "image/jpeg" }] },
              body: { kind: "image", mime: "image/jpeg", byteLength: 9_926 },
            }
          : {
              warc: [{ name: "WARC-Type", value: "metadata" }],
              body: { kind: "text", content: "action: no-archive\npattern: *://*.googletagmanager.com/*", truncated: false },
            },
      ),
  };

  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60));

  it("enter で一覧: 種別・状態・content-type・URI と、索引の印", async () => {
    const { lastFrame, stdin, unmount } = renderAt(
      120,
      30,
      <App report={reportWithWarc()} bridge={bridge} build={buildStub} />,
    );
    stdin.write("\t");
    await tick();
    stdin.write("\r"); // → records
    await tick();
    const frame = lastFrame();
    unmount();
    expect(frame).toContain("records 1/3");
    expect(frame).toContain("▪ response 200 image/jpeg");
    expect(frame).toContain("▫ metadata");
    expect(frame).toContain("https://www.googletagmanager.com/gtm.js");
    expect(frame).not.toContain("data.warc.gz"); // ツリーは別ビュー
  });

  it("レコードを選んで enter: 見出しと本文。画像は大きさだけ", async () => {
    const { lastFrame, stdin, unmount } = renderAt(
      120,
      30,
      <App report={reportWithWarc()} bridge={bridge} build={buildStub} />,
    );
    stdin.write("\t");
    await tick();
    stdin.write("\r"); // → records
    await tick();
    stdin.write("j"); // 2 件目 (応答)
    await tick();
    stdin.write("\r"); // → record
    await tick();
    const opened = lastFrame();
    expect(opened).toContain("WARC-Type: response");
    expect(opened).toContain("HTTP/1.1 200 OK");
    expect(opened).toContain("(image image/jpeg · 9.7 KB — 端末では出せない)");
    stdin.write("\u001B"); // esc → 一覧へ
    await tick();
    stdin.write("j"); // 3 件目 (撮らなかった記録)
    await tick();
    stdin.write("\r");
    await tick();
    const meta = lastFrame();
    unmount();
    expect(meta).toContain("action: no-archive");
  });
});


describe("tui — layout view: 右枠の幅はコンテンツに依存しない", () => {
  // 枠線 ─ の最長連続数 = 枠の内側幅。端末幅が同じなら短/長メタで一致するはず。
  const boxWidth = (frame: string): number =>
    Math.max(0, ...frame.split("\n").map((l) => (l.match(/─/g) ?? []).length));

  const reportWith = (path: string, expectedBy: ExpectedBy[]): WireReport =>
    makeReport({
      entries: [{ path, present: true, uncompressedSize: 10, compressionMethod: 0, expectedBy, issues: [] }],
    });

  const widthAfterTab = async (report: WireReport): Promise<number> => {
    const { stdin, lastFrame, unmount } = renderAt(120, 24, <App report={report} build={buildStub} />);
    stdin.write("\t"); // → Layout
    await new Promise((resolve) => setTimeout(resolve, 60)); // 実測 layout パス待ち
    const w = boxWidth(lastFrame());
    unmount();
    return w;
  };

  it("短いメタと長いメタで右枠の横幅が一致する(端末幅 120 固定)", async () => {
    const wShort = await widthAfterTab(reportWith("a.json", []));
    const wLong = await widthAfterTab(reportWith("data.warc.gz", ["datapackage"]));
    expect(wShort).toBeGreaterThan(0);
    expect(wShort).toBe(wLong); // 改修前: 22 ≠ 36 で失敗 / 改修後: 一致
  });
});
