/**
 * Ink TUI renderer(daemon クライアント側の薄い表示器)。
 *
 * validation は daemon が行い、message / specUrl / conformance まで解決済みの
 * {@link WireReport} を受け取るので、ここでは core の i18n も lookup も呼ばず
 * 解決済みフィールドをそのまま描く(`@wacz-validator/core` を import しない)。
 *
 * Layout ビューでファイルを選んで `enter` を押すと、`bridge`(daemon の窓の口への
 * 薄いブリッジ)でそのファイルの中身を取り、全幅で表示する —— 行の窓 (`readLines`)、
 * 1 行を丸ごと (`readLine`、fields は daemon が割る)、WARC ならレコードの一覧
 * (`readRecords`) と 1 レコード (`readRecord`)。窓の続きは末尾に着いたときに頼む。
 * `bridge` 未指定(テスト等)なら no-op。
 *
 * Exit code の経路: CLI は `render(...)` の後に `instance.waitUntilExit()` を
 * await し、その後 `process.exitCode` をセットする。
 */
import { useEffect, useMemo, useRef, useState, type FC, type ReactNode } from "react";
import {
  Box,
  Text,
  useApp,
  useBoxMetrics,
  useInput,
  useWindowSize,
  type DOMElement,
} from "ink";
import type {
  Field,
  ReadLineResult,
  ReadLinesResult,
  ReadRecordResult,
  ReadRecordsResult,
  RecordSummary,
  ReportEntry,
  ResolvedDocLink,
  WireIssue,
  WireLine,
  WireReport,
} from "@wacz-validator/protocol";
import { buildEntryTree, entryMarker, flattenTree, type TreeRow } from "./render/tree.js";
import { codecName, entryIssues, expectedLabel } from "./render/detail.js";
import { scrollWindow } from "./scroll.js";

/** version + 短い git SHA の組。TUI 自身と daemon の双方を持つ。 */
export interface BuildPair {
  version: string;
  gitSha: string;
}

/** daemon の窓の口への橋。cli.ts が WS の request で組み、App はこれしか知らない。 */
export interface ContentBridge {
  lines: (path: string, from: number, count: number) => Promise<ReadLinesResult>;
  line: (path: string, n: number) => Promise<ReadLineResult>;
  records: (path: string, from: number, count: number) => Promise<ReadRecordsResult>;
  record: (path: string, offset: number, length: number) => Promise<ReadRecordResult>;
}

interface AppProps {
  report: WireReport;
  /** Layout で enter 時に呼ぶ、中身の窓への橋。省略可。 */
  bridge?: ContentBridge;
  /**
   * 描画側(tui)と検証側(daemon)のビルド識別。Header に SHA を出し、
   * 食い違い(= どちらかが古いプロセス)を警告するのに使う。
   */
  build: { tui: BuildPair; daemon: BuildPair };
}

type View = "issues" | "layout" | "content" | "line" | "records" | "record";

/** 1 回に頼む窓の大きさ (daemon の上限と同じ)。 */
const WINDOW = 500;

/** 開いたファイルの行の窓。 */
interface ContentState {
  path: string;
  lines: WireLine[];
  next: number | null;
  gunzipped: boolean;
}

/** 開いた WARC のレコードの一覧 (窓)。 */
interface RecordsState {
  path: string;
  records: RecordSummary[];
  next: number | null;
  total: number;
}

/** WARC はレコードの一覧で開く (行で開いても本文の途中で binary になるだけ)。 */
const isWarc = (path: string): boolean => path.endsWith(".warc.gz") || path.endsWith(".warc");

/** Layout の右ペイン(詳細)に最低限残す桁数(枠 + 余白 + 内容)。 */
const MIN_DETAIL_WIDTH = 30;
/** 極端に狭い端末でも左ツリーに確保する最小桁数。 */
const MIN_TREE_WIDTH = 16;
/** 左ツリーに割く端末幅の目安(割合)。固定幅 treeWidth の基準。 */
const TREE_WIDTH_RATIO = 0.32;
/** 広い端末でも左ツリーがこれ以上は伸びない上限桁数。 */
const TREE_MAX_WIDTH = 44;
/** issues ビューの 1 issue あたりの概算行数(可視 issue 数の見積りに使う・保守的に多め)。 */
const EST_ISSUE_ROWS = 4;

/**
 * 自分の高さを useBoxMetrics で実測し、可視スライス [start,end) だけを描く。
 * focused 指定でカーソル追従、未指定で offset 自由スクロール。推定 reserve は使わない。
 */
const ScrollList: FC<{
  count: number;
  offset: number;
  focused?: number;
  onHeight?: (h: number) => void;
  renderRange: (start: number, end: number) => ReactNode;
}> = ({ count, offset, focused, onHeight, renderRange }) => {
  const ref = useRef<DOMElement | null>(null);
  const { height } = useBoxMetrics(ref);
  useEffect(() => {
    onHeight?.(height);
  }, [height, onHeight]);
  const win = scrollWindow(offset, count, height, focused);
  return (
    <Box ref={ref} flexDirection="column" flexGrow={1} minHeight={0}>
      {renderRange(win.start, win.end)}
    </Box>
  );
};

export const App: FC<AppProps> = ({ report, bridge, build }) => {
  const { exit } = useApp();
  // root を端末サイズに固定(resize 追従)。これと body の flexGrow + 各ビューの実測
  // スクロールにより、フレーム行数が端末を超えない=Ink の縦はみ出し崩れが起きない。
  const { columns, rows } = useWindowSize();
  const [view, setView] = useState<View>("issues");
  const [focused, setFocused] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  // enter で開いたファイルの行の窓と、その content ビューのスクロール位置・実測高。
  // 窓の末尾に着いたら、daemon に続きを頼んで足す (next が null になるまで)。
  const [content, setContent] = useState<ContentState | null>(null);
  const [contentOffset, setContentOffset] = useState(0);
  const [contentH, setContentH] = useState(0);
  // content ビューの行カーソル。scrollWindow が focused 追従で offset を補正するので、
  // カーソルを動かすだけでスクロールも付いてくる(issues / layout と同じ形)。
  const [contentFocused, setContentFocused] = useState(0);
  // 開いた 1 行。fields は daemon が割って返す (tui は割り方を持たない)。
  const [line, setLine] = useState<ReadLineResult | null>(null);
  // WARC のレコードの一覧 (窓) と、開いた 1 レコード。
  const [records, setRecords] = useState<RecordsState | null>(null);
  const [recordsFocused, setRecordsFocused] = useState(0);
  const [recordsH, setRecordsH] = useState(0);
  const [record, setRecord] = useState<ReadRecordResult | null>(null);
  const [recordOffset, setRecordOffset] = useState(0);
  const [recordH, setRecordH] = useState(0);
  // 窓の続きを取りに行っている最中は、二重に頼まない。
  const loading = useRef(false);

  const issues = report.issues;
  // §5.1 風ツリーの行(report が変わらない限り再計算しない)。
  const layoutRows = useMemo(() => flattenTree(buildEntryTree(report.entries)), [report.entries]);
  const rowCount = view === "issues" ? issues.length : layoutRows.length;
  const contentLines = content?.lines.length ?? 0;
  const recordRows = records?.records.length ?? 0;
  const recordLineCount = record === null ? 0 : recordLines(record).length;

  /** 行の窓の続きを足す (next があるときだけ)。 */
  const extendContent = (): void => {
    if (!bridge || loading.current || content === null) return;
    const { path, next } = content;
    if (next === null) return;
    loading.current = true;
    void bridge.lines(path, next, WINDOW).then(
      (page) => {
        loading.current = false;
        setContent((prev) =>
          prev?.path === path
            ? { ...prev, lines: [...prev.lines, ...page.lines], next: page.next }
            : prev,
        );
      },
      () => {
        loading.current = false;
      },
    );
  };

  /** レコードの一覧の続きを足す。 */
  const extendRecords = (): void => {
    if (!bridge || loading.current || records === null) return;
    const { path, next } = records;
    if (next === null) return;
    loading.current = true;
    void bridge.records(path, next, WINDOW).then(
      (page) => {
        loading.current = false;
        setRecords((prev) =>
          prev?.path === path
            ? { ...prev, records: [...prev.records, ...page.records], next: page.next }
            : prev,
        );
      },
      () => {
        loading.current = false;
      },
    );
  };

  /** content の n 行目を丸ごと取って line ビューへ。 */
  const openLine = (n: number): void => {
    if (!bridge || content === null) return;
    const { path } = content;
    void bridge.line(path, n).then(
      (result) => {
        setLine(result);
        setContentFocused(n);
        setView("line");
      },
      () => {
        setLine({ n, text: "(content unavailable)", cut: false, binary: false, bytes: 0, fields: [], gunzipped: false });
        setContentFocused(n);
        setView("line");
      },
    );
  };

  /** 一覧の i 番目のレコードを開く。 */
  const openRecord = (i: number): void => {
    if (!bridge || records === null) return;
    const row = records.records[i];
    if (row === undefined) return;
    void bridge.record(records.path, row.offset, row.length).then(
      (result) => {
        setRecord(result);
        setRecordOffset(0);
        setView("record");
      },
      () => {
        setRecord({ warc: [], body: { kind: "text", content: "(record unavailable)", truncated: false } });
        setRecordOffset(0);
        setView("record");
      },
    );
  };

  useInput((input, key) => {
    if (input === "q" && view !== "issues" && view !== "layout") {
      exit();
      return;
    }
    // line ビュー: 1 行を開いたまま前後に移れる。esc で content の一覧へ戻る。
    if (view === "line") {
      if (key.escape) {
        setView("content");
        return;
      }
      const to = (d: number): void => {
        const n = Math.min(Math.max(0, contentLines - 1), Math.max(0, contentFocused + d));
        if (n !== contentFocused) openLine(n);
      };
      if (key.downArrow || input === "j") to(1);
      else if (key.upArrow || input === "k") to(-1);
      return;
    }
    // content ビュー: 行カーソルを動かし、enter でその 1 行を開く。
    if (view === "content") {
      if (key.escape) {
        setView("layout");
        return;
      }
      const page = Math.max(1, contentH - 1);
      const move = (d: number): void => {
        const to = Math.min(Math.max(0, contentLines - 1), Math.max(0, contentFocused + d));
        setContentFocused(to);
        if (to >= contentLines - 1) extendContent(); // 末尾に着いたら続きを頼む
      };
      if (key.return) {
        if (contentLines > 0) openLine(contentFocused);
        return;
      }
      if (key.downArrow || input === "j") move(1);
      else if (key.upArrow || input === "k") move(-1);
      else if (key.pageDown || input === " ") move(page);
      else if (key.pageUp) move(-page);
      else if (input === "g") setContentFocused(0);
      else if (input === "G") move(contentLines);
      return;
    }
    // records ビュー: レコードを選んで enter で開く。
    if (view === "records") {
      if (key.escape) {
        setView("layout");
        return;
      }
      const page = Math.max(1, recordsH - 1);
      const move = (d: number): void => {
        const to = Math.min(Math.max(0, recordRows - 1), Math.max(0, recordsFocused + d));
        setRecordsFocused(to);
        if (to >= recordRows - 1) extendRecords();
      };
      if (key.return) {
        if (recordRows > 0) openRecord(recordsFocused);
        return;
      }
      if (key.downArrow || input === "j") move(1);
      else if (key.upArrow || input === "k") move(-1);
      else if (key.pageDown || input === " ") move(page);
      else if (key.pageUp) move(-page);
      else if (input === "g") setRecordsFocused(0);
      else if (input === "G") move(recordRows);
      return;
    }
    // record ビュー: 見出しと本文をスクロール。esc で一覧へ。
    if (view === "record") {
      if (key.escape) {
        setView("records");
        return;
      }
      const page = Math.max(1, recordH - 1);
      const max = Math.max(0, recordLineCount - recordH);
      const scroll = (d: number): void => {
        setRecordOffset((o) => Math.min(max, Math.max(0, o + d)));
      };
      if (key.downArrow || input === "j") scroll(1);
      else if (key.upArrow || input === "k") scroll(-1);
      else if (key.pageDown || input === " ") scroll(page);
      else if (key.pageUp) scroll(-page);
      else if (input === "g") setRecordOffset(0);
      else if (input === "G") setRecordOffset(max);
      return;
    }
    if (input === "q" || key.escape) {
      exit();
      return;
    }
    if (key.tab) {
      setView((prev) => (prev === "issues" ? "layout" : "issues"));
      setFocused(0);
      setContent(null);
      setRecords(null);
      return;
    }
    if (key.upArrow && rowCount > 0) {
      setFocused((prev) => Math.max(0, prev - 1));
      return;
    }
    if (key.downArrow && rowCount > 0) {
      setFocused((prev) => Math.min(rowCount - 1, prev + 1));
      return;
    }
    if (key.return && view === "issues" && issues.length > 0) {
      // focused な issue の expansion をトグル(参照同一性のため set を作り直す)。
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(focused)) next.delete(focused);
        else next.add(focused);
        return next;
      });
      return;
    }
    if (key.return && view === "layout" && bridge) {
      const entry = layoutRows[focused]?.entry;
      if (entry?.present !== true) return;
      const path = entry.path;
      // WARC はレコードの一覧へ、それ以外は行の窓へ。どちらも全幅ビュー。
      if (isWarc(path)) {
        void bridge.records(path, 0, WINDOW).then(
          (page) => {
            setRecords({ path, ...page });
            setRecordsFocused(0);
            setView("records");
          },
          () => {
            setRecords({ path, records: [], next: null, total: 0 });
            setRecordsFocused(0);
            setView("records");
          },
        );
        return;
      }
      const show = (page: ContentState): void => {
        setContent(page);
        setContentOffset(0);
        setContentFocused(0);
        setView("content");
      };
      void bridge.lines(path, 0, WINDOW).then(
        (page) => {
          show({ path, ...page });
        },
        () => {
          show({
            path,
            lines: [{ n: 0, text: "(content unavailable)", cut: false, binary: false, bytes: 0 }],
            next: null,
            gunzipped: false,
          });
        },
      );
    }
  });

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Header report={report} view={view} build={build} />
      <Box flexGrow={1} minHeight={0} marginTop={1}>
        {view === "line" && line !== null ? (
          <LineView line={line} total={contentLines} more={content?.next !== null} />
        ) : view === "content" && content !== null ? (
          <ContentView
            content={content}
            offset={contentOffset}
            focused={contentFocused}
            onHeight={setContentH}
          />
        ) : view === "records" && records !== null ? (
          <RecordsView records={records} focused={recordsFocused} onHeight={setRecordsH} />
        ) : view === "record" && record !== null ? (
          <RecordView record={record} offset={recordOffset} onHeight={setRecordH} />
        ) : view === "issues" ? (
          <IssuesView issues={issues} focused={focused} expanded={expanded} />
        ) : (
          <LayoutView rows={layoutRows} focused={focused} report={report} />
        )}
      </Box>
      <Summary report={report} />
      {report.stats ? <Stats stats={report.stats} /> : null}
      <Help view={view} />
    </Box>
  );
};

/** issues ビュー: focused 追従の index 窓で、可視ぶんの IssueRow だけ描く(縦はみ出し防止)。 */
const IssuesView: FC<{
  issues: WireIssue[];
  focused: number;
  expanded: ReadonlySet<number>;
}> = ({ issues, focused, expanded }) => {
  const ref = useRef<DOMElement | null>(null);
  const { height } = useBoxMetrics(ref);
  const visibleIssues = Math.max(1, Math.floor(height / EST_ISSUE_ROWS));
  const win = scrollWindow(0, issues.length, visibleIssues, focused);
  return (
    <Box ref={ref} flexDirection="column" flexGrow={1} minHeight={0}>
      {issues.length === 0 ? (
        <Text color="green">All rules passed.</Text>
      ) : (
        issues.slice(win.start, win.end).map((issue, k) => {
          const i = win.start + k;
          return (
            <IssueRow
              key={`${issue.rule}-${String(i)}`}
              issue={issue}
              focused={i === focused}
              expanded={expanded.has(i)}
            />
          );
        })
      )}
    </Box>
  );
};

/**
 * Layout ビュー: 左に §5.1 風ツリー(実測スクロール・focused 追従)、右に選択行の詳細。
 * その内容は enter で全幅 content ビューに開く(右ペインには出さない)。
 */
const LayoutView: FC<{
  rows: TreeRow[];
  focused: number;
  report: WireReport;
}> = ({ rows, focused, report }) => {
  // 左ツリー幅は端末幅だけから決める固定値。選択ファイルに依存しないので、全幅 root と
  // 右枠の flexGrow と合わせて「枠幅 = columns − treeWidth − margin」が常に一定になる。縦は ScrollList が実測スクロール。
  const { columns } = useWindowSize();
  const treeWidth = Math.max(
    MIN_TREE_WIDTH,
    Math.min(TREE_MAX_WIDTH, Math.round(columns * TREE_WIDTH_RATIO), columns - MIN_DETAIL_WIDTH),
  );
  if (rows.length === 0) return <Text dimColor>(no entries)</Text>;
  const selected = rows[focused]?.entry;
  return (
    <Box width="100%">
      <Box flexDirection="column" flexShrink={0} width={treeWidth}>
        <ScrollList
          count={rows.length}
          offset={0}
          focused={focused}
          renderRange={(start, end) =>
            rows.slice(start, end).map((row, k) => {
              const i = start + k;
              const mk = entryMarker(row.entry);
              const glyph = mk.tone === "error" ? "✗" : mk.tone === "warning" ? "⚠" : "";
              const color = mk.tone === "warning" ? "yellow" : "red";
              const size =
                row.entry?.present === true && row.entry.uncompressedSize !== undefined
                  ? `  ${formatBytes(row.entry.uncompressedSize)}`
                  : "";
              return (
                <Text key={row.path} inverse={i === focused} wrap="truncate-middle">
                  {row.connector}
                  {row.name}
                  <Text dimColor>{size}</Text>
                  {glyph ? <Text color={color}>{`  ${glyph}`}</Text> : null}
                </Text>
              );
            })
          }
        />
      </Box>
      <Box
        flexDirection="column"
        flexGrow={1}
        minWidth={0}
        marginLeft={2}
        borderStyle="round"
        borderDimColor
        paddingX={1}
      >
        <DetailPane entry={selected} report={report} />
      </Box>
    </Box>
  );
};

/** 右ペイン: 選択 entry のメタ情報 + 紐づく issue。内容は enter で全幅ビューに開く。 */
const DetailPane: FC<{
  entry: ReportEntry | undefined;
  report: WireReport;
}> = ({ entry, report }) => {
  if (!entry) return <Text dimColor>(select a file)</Text>;
  return (
    <Box flexDirection="column">
      <Text bold wrap="truncate-end">
        {entry.path}
      </Text>
      <Box>
        <Text dimColor>status </Text>
        {entry.present ? <Text color="green">present</Text> : <Text color="red">MISSING</Text>}
      </Box>
      {entry.present && entry.uncompressedSize !== undefined ? (
        <Box>
          <Text dimColor>size </Text>
          <Text>{`${formatBytes(entry.uncompressedSize)}  (${codecName(entry.compressionMethod)})`}</Text>
        </Box>
      ) : null}
      <Box>
        <Text dimColor>expected </Text>
        <Text>{expectedLabel(entry.expectedBy, entry.expectedSection)}</Text>
      </Box>
      <IssueList entry={entry} report={report} />
      {entry.present ? (
        <Box marginTop={1}>
          <Text dimColor>{isWarc(entry.path) ? "enter でレコードの一覧" : "enter で内容を表示"}</Text>
        </Box>
      ) : null}
    </Box>
  );
};

/** 1 行の一覧向けの見た目。binary は大きさだけ、cut は末尾に印。 */
const lineText = (line: WireLine): string => {
  if (line.binary) return `(binary · ${formatBytes(line.bytes)})`;
  if (line.text === "") return " ";
  return line.cut ? `${line.text} …` : line.text;
};

/** enter で取得した行の窓を、全幅・実測スクロールで表示する(縦はみ出ししない)。 */
const ContentView: FC<{
  content: ContentState;
  offset: number;
  focused: number;
  onHeight: (h: number) => void;
}> = ({ content, offset, focused, onHeight }) => {
  const { lines, next, gunzipped } = content;
  if (lines.length === 0) {
    return (
      <Box>
        <Text dimColor>(empty)</Text>
      </Box>
    );
  }
  const head = gunzipped ? "content (gzip 展開)" : "content";
  // 窓の続きがあるうちは行数に + を付ける。末尾に着いたら次を頼む。
  const total = `${String(lines.length)}${next === null ? "" : "+"}`;
  // 行は端末幅で切る。全部を見る手段は enter (LineView) 側に持たせてある。
  return (
    <Box flexDirection="column" flexGrow={1} minHeight={0} width="100%">
      <Text dimColor>
        {`${head}  line ${String(focused + 1)}/${total}  ↑↓/jk PgUp/PgDn g/G · enter 詳細 · esc back`}
      </Text>
      <ScrollList
        count={lines.length}
        offset={offset}
        focused={focused}
        onHeight={onHeight}
        renderRange={(start, end) =>
          lines.slice(start, end).map((row, k) => (
            <Text
              key={`content-${String(start + k)}`}
              inverse={start + k === focused}
              wrap="truncate-end"
            >
              {lineText(row)}
            </Text>
          ))
        }
      />
    </Box>
  );
};

/**
 * 1 行だけを縦に開くビュー。
 *
 * content の行は端末幅で切られる。`index.cdx.gz` は中央値 563 文字あるので、
 * 切られた側に `offset` / `filename` のような**実際に確かめたい値**が入って
 * いる。ここは切らず、`wrap="wrap"` で折り返して全部見せる。
 *
 * fields は daemon が割って返したもの (割り方は core の explodeLine)。切れた行と
 * binary は割られていないので、1 つの field として見せる。
 */
const LineView: FC<{ line: ReadLineResult; total: number; more: boolean }> = ({
  line,
  total,
  more,
}) => {
  const fields: Field[] =
    line.fields.length > 0
      ? line.fields
      : [
          {
            label: line.binary ? "binary" : "line",
            value: line.binary ? `(${formatBytes(line.bytes)})` : line.text,
            fromJson: false,
          },
        ];
  const width = Math.max(...fields.map((f) => f.label.length));
  const note = line.cut ? " · 4 MiB で切った" : "";
  return (
    <Box flexDirection="column" flexGrow={1} minHeight={0} width="100%">
      <Text dimColor>
        {`line ${String(line.n + 1)} / ${String(total)}${more ? "+" : ""} · ${String(line.bytes)} bytes${note}  ↑↓/jk 前後の行 · esc 一覧へ`}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {fields.map((field, k) => (
          <Box key={`field-${String(k)}-${field.label}`}>
            <Box width={width + 2} flexShrink={0}>
              <Text color={field.fromJson ? "blue" : "cyan"}>{field.label}</Text>
            </Box>
            <Box flexGrow={1}>
              <Text wrap="wrap">{field.value === "" ? " " : field.value}</Text>
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  );
};

/** 一覧の 1 レコード: 索引の印 · 種別 · 状態 · content-type · URI。 */
const recordLine = (row: RecordSummary): string => {
  const mark = row.indexed ? "▪" : "▫";
  const status = row.status === undefined ? "   " : String(row.status).padStart(3);
  const mime = (row.mime ?? row.contentType ?? "").slice(0, 24).padEnd(24);
  return `${mark} ${row.type.padEnd(8)} ${status} ${mime} ${row.uri ?? ""}`;
};

/** WARC のレコードの一覧 (窓)。▪ は索引 (CDXJ) が指すレコード、▫ は索引に無いもの。 */
const RecordsView: FC<{
  records: RecordsState;
  focused: number;
  onHeight: (h: number) => void;
}> = ({ records, focused, onHeight }) => {
  const rows = records.records;
  if (rows.length === 0) {
    return (
      <Box>
        <Text dimColor>(no records)</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" flexGrow={1} minHeight={0} width="100%">
      <Text dimColor>
        {`records ${String(focused + 1)}/${String(records.total)}  ▪ 索引にある · ▫ 索引に無い  ↑↓/jk PgUp/PgDn g/G · enter open · esc back`}
      </Text>
      <ScrollList
        count={rows.length}
        offset={0}
        focused={focused}
        onHeight={onHeight}
        renderRange={(start, end) =>
          rows.slice(start, end).map((row, k) => (
            <Text
              key={`record-${String(start + k)}`}
              inverse={start + k === focused}
              wrap="truncate-end"
            >
              {recordLine(row)}
            </Text>
          ))
        }
      />
    </Box>
  );
};

/** 1 レコードを行に。WARC の見出し → (HTTP の状態行と見出し) → 本文。 */
const recordLines = (record: ReadRecordResult): string[] => {
  const out = record.warc.map((h) => `${h.name}: ${h.value}`);
  if (record.http !== undefined) {
    out.push("", record.http.status, ...record.http.headers.map((h) => `${h.name}: ${h.value}`));
  }
  out.push("");
  const body = record.body;
  if (body.kind === "text") {
    out.push(...body.content.split("\n"));
    if (body.truncated) out.push("…(切れている)");
  } else if (body.kind === "image") {
    out.push(`(image ${body.mime} · ${formatBytes(body.byteLength)} — 端末では出せない)`);
  } else {
    out.push(`(binary${body.mime === undefined ? "" : ` ${body.mime}`} · ${formatBytes(body.byteLength)})`);
  }
  return out;
};

/** 開いた 1 レコード。offset 自由スクロール。 */
const RecordView: FC<{
  record: ReadRecordResult;
  offset: number;
  onHeight: (h: number) => void;
}> = ({ record, offset, onHeight }) => {
  const lines = recordLines(record);
  return (
    <Box flexDirection="column" flexGrow={1} minHeight={0} width="100%">
      <Text dimColor>{`record  ${String(lines.length)} lines  ↑↓/jk PgUp/PgDn g/G · esc 一覧へ`}</Text>
      <ScrollList
        count={lines.length}
        offset={offset}
        onHeight={onHeight}
        renderRange={(start, end) =>
          lines.slice(start, end).map((text, k) => (
            <Text key={`rec-${String(start + k)}`} wrap="truncate-end">
              {text === "" ? " " : text}
            </Text>
          ))
        }
      />
    </Box>
  );
};

/** 選択 file に紐づく issue を全文(icon + rule + message + location)で列挙。 */
const IssueList: FC<{ entry: ReportEntry; report: WireReport }> = ({ entry, report }) => {
  const issues = entryIssues(report, entry.path);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>issues</Text>
      {issues.length === 0 ? (
        <Text color="green">  none</Text>
      ) : (
        issues.map((issue, n) => <IssueLine key={`${issue.rule}-${String(n)}`} issue={issue} />)
      )}
    </Box>
  );
};

/** daemon が解決した specUrl があれば spec への直リンク行を出す(dimmed)。 */
const SpecLink: FC<{ issue: WireIssue; indent: number }> = ({ issue, indent }) => {
  if (issue.specUrl === undefined) return null;
  return (
    <Box marginLeft={indent}>
      <Text dimColor>{`spec ${issue.specUrl}`}</Text>
    </Box>
  );
};

/** rule の出典(公式ドキュメント)リンク群を、ラベル付きで展開ビューに列挙する。 */
const IssueDocs: FC<{ docs: readonly ResolvedDocLink[] }> = ({ docs }) => (
  <Box flexDirection="column" marginTop={1}>
    <Text dimColor>docs:</Text>
    {docs.map((d) => (
      <Text key={d.url} wrap="truncate-end">
        {"  "}
        <Text color="cyan">{d.label}</Text>
        <Text dimColor>{` ${d.url}`}</Text>
      </Text>
    ))}
  </Box>
);

/** spec の規範レベル(MUST/SHOULD/MAY)を rule 名の後に併記。severity とは別軸。 */
const ConfBadge: FC<{ conformance: string | undefined }> = ({ conformance }) => {
  if (conformance === undefined) return null;
  return <Text color="magenta">{` ${conformance}`}</Text>;
};

const IssueLine: FC<{ issue: WireIssue }> = ({ issue }) => {
  const tone = toneFor(issue.severity);
  const loc = formatLocation(issue);
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={tone}>{`${iconFor(issue.severity)} ${issue.rule}`}</Text>
        <ConfBadge conformance={issue.conformance} />
      </Box>
      <Box marginLeft={2}>
        <Text>
          {loc ? <Text dimColor>{`${loc} — `}</Text> : null}
          {issue.message}
        </Text>
      </Box>
      <SpecLink issue={issue} indent={2} />
    </Box>
  );
};

const Stats: FC<{ stats: NonNullable<WireReport["stats"]> }> = ({ stats }) => {
  const recordsLabel = `${String(stats.warcRecordCount)} record${stats.warcRecordCount === 1 ? "" : "s"}`;
  const hostsLabel = `${String(stats.hosts.length)} host${stats.hosts.length === 1 ? "" : "s"}`;
  return (
    <Box>
      <Text
        dimColor
      >{`${recordsLabel}  ·  ${formatBytes(stats.warcArchiveBytes)}  ·  ${hostsLabel}`}</Text>
    </Box>
  );
};

const formatBytes = (n: number): string => {
  if (n < 1024) return `${String(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
};

const Header: FC<{ report: WireReport; view: View; build: AppProps["build"] }> = ({
  report,
  view,
  build,
}) => {
  // http は query を落とした identity が届く（署名は daemon が剥がしている）。
  const sourceLabel =
    report.source.kind === "file"
      ? report.source.path
      : report.source.kind === "http"
        ? report.source.url
        : report.source.uri;
  // tui(描画)と daemon(検証)の SHA 不一致 = どちらかが古いプロセス。
  // 一致なら SHA を 1 つ、食い違えば daemon 側を警告色で添える。
  const drift = build.tui.gitSha !== build.daemon.gitSha;
  return (
    <Box>
      <Text bold>wacz-validator</Text>
      <Text dimColor> {build.tui.version} </Text>
      {drift ? (
        <Text color="yellow">{`·${build.tui.gitSha} `}</Text>
      ) : (
        <Text dimColor>{`·${build.tui.gitSha} `}</Text>
      )}
      {drift ? <Text color="yellow">{`⚠ daemon ·${build.daemon.gitSha} `}</Text> : null}
      <Text> {sourceLabel} </Text>
      <Text inverse={view === "issues"}> Issues </Text>
      <Text> </Text>
      <Text inverse={view === "layout"}> Layout </Text>
    </Box>
  );
};

const IssueRow: FC<{ issue: WireIssue; focused: boolean; expanded: boolean }> = ({
  issue,
  focused,
  expanded,
}) => {
  const tone = toneFor(issue.severity);
  const icon = iconFor(issue.severity);
  const location = formatLocation(issue);
  // 開閉マーカー: 展開中は ▾、focused は ▸、それ以外は空白(2 桁・インデント不変)。
  // focused は明るく、focus を外れた展開行は dim の ▾ で「開いたまま」が分かる。
  const marker = expanded ? "▾ " : focused ? "▸ " : "  ";

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={tone} dimColor={!focused}>
          {marker}
        </Text>
        <Text color={tone}>{`[${icon}] `}</Text>
        <Text bold>{issue.rule}</Text>
        <ConfBadge conformance={issue.conformance} />
      </Box>
      <Box marginLeft={6}>
        <Text>
          {location ? <Text dimColor>{`${location} — `}</Text> : null}
          {issue.message}
        </Text>
      </Box>
      <SpecLink issue={issue} indent={6} />
      {expanded ? (
        <Box marginLeft={6} flexDirection="column">
          {issue.details !== undefined ? <ExpandedDetails details={issue.details} /> : null}
          {issue.docs !== undefined && issue.docs.length > 0 ? <IssueDocs docs={issue.docs} /> : null}
          {issue.details === undefined && !(issue.docs && issue.docs.length > 0) ? (
            <Text dimColor>(これ以上の詳細はありません)</Text>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
};

/**
 * `details` payload を、当てはまる shape 専用 view で render し、
 * それ以外は JSON pretty に fallback する。
 */
export const ExpandedDetails: FC<{ details: unknown }> = ({ details }) => {
  if (typeof details !== "object" || details === null) {
    return <Text dimColor>{JSON.stringify(details, null, 2)}</Text>;
  }
  const d = details as Record<string, unknown>;

  const hasDiff = "expected" in d && "actual" in d;
  const warcHeader = Array.isArray(d["warcHeader"]) ? (d["warcHeader"] as unknown[]) : null;
  const hexPreview = Array.isArray(d["hexPreview"]) ? (d["hexPreview"] as unknown[]) : null;
  const candidates = Array.isArray(d["candidates"]) ? (d["candidates"] as unknown[]) : null;
  const recording =
    typeof d["recording"] === "object" && d["recording"] !== null
      ? (d["recording"] as Record<string, unknown>)
      : null;
  const chain =
    typeof d["chain"] === "object" && d["chain"] !== null
      ? (d["chain"] as Record<string, unknown>)
      : null;

  const consumed = new Set<string>();
  if (hasDiff) {
    consumed.add("expected");
    consumed.add("actual");
  }
  if (warcHeader) consumed.add("warcHeader");
  if (hexPreview) consumed.add("hexPreview");
  if (candidates) consumed.add("candidates");
  if (recording) consumed.add("recording");
  if (chain) consumed.add("chain");

  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) {
    if (!consumed.has(k)) rest[k] = v;
  }

  return (
    <Box flexDirection="column">
      {hasDiff ? <DiffView expected={d["expected"]} actual={d["actual"]} /> : null}
      {recording ? <RecordingHealthView recording={recording} /> : null}
      {chain ? <ChainView chain={chain} /> : null}
      {candidates ? <CandidatesView candidates={candidates} /> : null}
      {warcHeader ? <WarcHeaderView lines={warcHeader} /> : null}
      {hexPreview ? <HexView lines={hexPreview} /> : null}
      {Object.keys(rest).length > 0 ? <Text dimColor>{JSON.stringify(rest, null, 2)}</Text> : null}
    </Box>
  );
};

/**
 * 証明書チェーンを host ごとの梯子として描く。
 *
 * 1 行 1 通で、次と繋がっていれば下向きの罫線を引く。判定を 3 段(繋がり・署名・
 * それ以外)に散らさず 1 行にまとめているのは、読み手が知りたいのが「どこで切れたか」
 * だから —— 通っている段は目立たなくてよい。
 */
const ChainView: FC<{ chain: Record<string, unknown> }> = ({ chain }) => {
  const hosts =
    typeof chain["hosts"] === "object" && chain["hosts"] !== null
      ? (chain["hosts"] as Record<string, unknown>)
      : {};
  return (
    <Box flexDirection="column" marginTop={1}>
      {Object.entries(hosts).map(([host, certs]) => (
        <Box key={host} flexDirection="column">
          <Text bold>{host}</Text>
          {(Array.isArray(certs) ? certs : []).map((raw, i) => {
            const c = (typeof raw === "object" && raw !== null ? raw : {}) as Record<
              string,
              unknown
            >;
            const linked = c["linkedToNext"];
            // 末尾 (null) は「相手がパッケージの外に居る」であって、失敗ではない。
            const mark =
              linked === null || linked === undefined
                ? "  "
                : linked === true && c["signatureOk"] === true
                  ? "─┐"
                  : "─✗";
            const tone = linked === false || c["signatureOk"] === false ? "red" : "green";
            return (
              <Box key={`${host}-${String(i)}`} marginLeft={2}>
                <Text dimColor>{`[${String(i)}] `}</Text>
                <Text>{typeof c["subject"] === "string" ? c["subject"] : ""}</Text>
                <Text color={tone}>{` ${mark}`}</Text>
              </Box>
            );
          })}
        </Box>
      ))}
    </Box>
  );
};

const DiffView: FC<{ expected: unknown; actual: unknown }> = ({ expected, actual }) => (
  <Box flexDirection="column">
    <Box>
      <Text color="green">expected: </Text>
      <Text>{formatValue(expected)}</Text>
    </Box>
    <Box>
      <Text color="red">actual: </Text>
      <Text>{formatValue(actual)}</Text>
    </Box>
  </Box>
);

const WarcHeaderView: FC<{ lines: unknown[] }> = ({ lines }) => (
  <Box flexDirection="column" marginTop={1}>
    <Text dimColor>WARC record header:</Text>
    {lines.map((l, i) => (
      <Text key={`hdr-${String(i)}`}>
        {"  "}
        {String(l)}
      </Text>
    ))}
  </Box>
);

const HexView: FC<{ lines: unknown[] }> = ({ lines }) => (
  <Box flexDirection="column" marginTop={1}>
    <Text dimColor>Payload preview (hex):</Text>
    {lines.map((l, i) => (
      <Text key={`hex-${String(i)}`}>{String(l)}</Text>
    ))}
  </Box>
);

const CandidatesView: FC<{ candidates: unknown[] }> = ({ candidates }) => (
  <Box flexDirection="column" marginTop={1}>
    <Text dimColor>Nearby WARC members:</Text>
    {candidates.map((c, i) => (
      <Text key={`cand-${String(i)}`}>
        {"  "}
        {JSON.stringify(c)}
      </Text>
    ))}
  </Box>
);

/**
 * Recording health パネル(案3)。`warc/recording-complete` が載せる
 * `details.recording` から、未完了比率の棒・件数・内訳・サンプル URL を描く。
 */
const RecordingHealthView: FC<{ recording: Record<string, unknown> }> = ({ recording }) => {
  const responses = Number(recording["responses"] ?? 0);
  const incomplete = Number(recording["incomplete"] ?? 0);
  const percent = Number(recording["percent"] ?? 0);
  const width = 32;
  const filled = Math.min(width, Math.max(0, Math.round((percent / 100) * width)));
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  const asMap = (v: unknown): Record<string, unknown> =>
    typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  // 開放的な map(キーが producer 由来)を "k n · k n" 形に。
  const fmtMap = (m: Record<string, unknown>): string =>
    Object.entries(m)
      .map(([k, v]) => `${k} ${String(Number(v))}`)
      .join(" · ");
  const byReason = asMap(recording["byReason"]);
  const breakdown = ["failed", "incomplete", "truncated", "blocked"]
    .map((k) => `${k} ${String(Number(byReason[k] ?? 0))}`)
    .join(" · ");
  // 案3 で metadata に追加された内訳。レコードに無ければ空 → 行を描かない。
  const byResourceType = asMap(recording["byResourceType"]);
  const byBlockedReason = asMap(recording["byBlockedReason"]);
  const samples = Array.isArray(recording["samples"]) ? recording["samples"] : [];
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>Recording health:</Text>
      <Text>
        {"  responses "}
        {responses}
        {"  incomplete "}
        <Text color="red">{incomplete}</Text>
        {` (${String(percent)}%)`}
      </Text>
      <Text color="red">
        {"  "}
        {bar}
      </Text>
      <Text dimColor>
        {"  "}
        {breakdown}
      </Text>
      {Object.keys(byResourceType).length > 0 ? (
        <Text dimColor>
          {"  by type  "}
          {fmtMap(byResourceType)}
        </Text>
      ) : null}
      {Object.keys(byBlockedReason).length > 0 ? (
        <Text dimColor>
          {"  blocked  "}
          {fmtMap(byBlockedReason)}
        </Text>
      ) : null}
      {samples.slice(0, 8).map((s, i) => (
        <Text key={`rec-${String(i)}`} dimColor>
          {"   - "}
          {JSON.stringify(s)}
        </Text>
      ))}
    </Box>
  );
};

const formatValue = (v: unknown): string => {
  if (typeof v === "string") return v;
  return JSON.stringify(v);
};

const Summary: FC<{ report: WireReport }> = ({ report }) => {
  const s = report.summary;
  const failedColor = s.failed > 0 ? { color: "red" as const } : {};
  const warningsColor = s.warnings > 0 ? { color: "yellow" as const } : {};
  return (
    <Box marginTop={1}>
      <Text color="green">{`${String(s.passed)} passed`}</Text>
      <Text>, </Text>
      <Text {...failedColor}>{`${String(s.failed)} failed`}</Text>
      <Text>, </Text>
      <Text {...warningsColor}>{`${String(s.warnings)} warnings`}</Text>
      <Text dimColor>{`  · ${String(s.durationMs)}ms`}</Text>
    </Box>
  );
};

const HELP: Record<View, string> = {
  issues: "↑↓ navigate · enter expand · tab issues/layout · q quit",
  layout: "↑↓ navigate · enter open · tab issues/layout · q quit",
  content: "↑↓/jk 行 · PgUp/PgDn g/G · enter 詳細 · esc back · q quit",
  line: "↑↓/jk 前後の行 · esc 一覧へ · q quit",
  records: "↑↓/jk レコード · PgUp/PgDn g/G · enter open · esc back · q quit",
  record: "↑↓/jk PgUp/PgDn g/G · esc 一覧へ · q quit",
};

const Help: FC<{ view: View }> = ({ view }) => (
  <Box marginTop={1}>
    <Text dimColor>{HELP[view]}</Text>
  </Box>
);

const toneFor = (severity: WireIssue["severity"]): "red" | "yellow" | "cyan" => {
  switch (severity) {
    case "error":
      return "red";
    case "warning":
      return "yellow";
    default:
      return "cyan";
  }
};

const iconFor = (severity: WireIssue["severity"]): string => {
  switch (severity) {
    case "error":
      return "✗";
    case "warning":
      return "!";
    default:
      return "i";
  }
};

const formatLocation = (issue: WireIssue): string => {
  const loc = issue.location;
  if (!loc) return "";
  let result = loc.entry ?? "";
  if (loc.line !== undefined) result += `:${String(loc.line)}`;
  if (loc.offset !== undefined) result += `@${String(loc.offset)}`;
  return result;
};
