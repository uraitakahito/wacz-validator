/**
 * Rule: browserhive/frame-snapshots (error · browserhive profile 限定)
 *
 * 子フレームの写しを、archive のどこから読んでも同じ物が指されているか。BrowserHive WARC Profile 1.5.0 は、時点の
 * 写しを撮るときに主フレームの下の同じ origin の枠の文書を前順（親が先、深さ優先）に 1 から番号を付けて写させ、
 * `urn:browserhive:frame-snapshot:<stage>:<n>:<子の文書の URL>` の `resource` と、それを `WARC-Refers-To` で指す
 * `metadata`（`snapshot`・`document-uri`・`secrets-replaced` に `frame`・`parent`）の組で書かせる。写した子を持つ
 * 枠の要素は、親の写しの中で `data-browserhive-snapshot="<子の URI>"` を持つ。BrowserHive WACZ Profile 1.27.0 は、
 * 書いた時点の `browserhive:capture.snapshots[]` の項目に `frames` と `frameCounts` を並べさせ、子を索引に載せ、
 * ページ一覧に載せさせない。指摘の種類（message key）は、食い違いごとに 1 つ:
 *
 datapackage（時点の項目ごと）:
 *
 *   - `stage-frames`      写しを撮らなかった時点の項目（`skipped` を持つ）が、`frames` も `frameCounts` も持たない。
 *                         以下はどれも、写しを書いた時点の項目で見る
 *   - `frames`            `frames` が配列
 *   - `entry`             `frames` の項目がオブジェクトで、`frame` が 1 以上の整数、`parent` が 0 以上の整数
 *   - `number`            `frame` が並びの順に 1 から 1 つずつ
 *   - `parent`            `parent` が 0（主の写し）か、前の項目かその祖先の `frame` —— 前順の並び
 *   - `withheld-descendant` `parent` が `skipped: "withheld"` の子なら、その子も `skipped: "withheld"` —— 方針が
 *                         伏せた文書の中の枠は写さない
 *   - `skipped`           書かなかった子の理由が `too-large`・`withheld`・`task-budget`・`failed` のどれか
 *   - `skipped-members`   書かなかった子の項目が `frame`・`parent`・`skipped` のほかを持たない
 *   - `counts`            `frameCounts` がオブジェクトで、`read`・`unreadable`・`withheld` が 0 以上の整数
 *   - `withheld-count`    `frameCounts.withheld` が、`skipped` が `withheld` の項目の数
 *   - `read-count`        `frameCounts.read` が、ほかの項目の数以上
 *
 * 書いた子ごと:
 *
 *   - `url`               `url` が `urn:browserhive:frame-snapshot:<stage>:<frame>:` で始まる
 *   - `no-resource`       `record`（山括弧なし）の名指す `resource` が在る
 *   - `mismatch`          `url`・`date`・`bytes` がその `WARC-Target-URI`・`WARC-Date`・`Content-Length` と、
 *                         metadata の `WARC-Target-URI`・`WARC-Date` が resource と、metadata の `snapshot`・`frame`・
 *                         `parent`・`secrets-replaced` の欄が項目の `stage`・`frame`・`parent`・`secretsReplaced` と、
 *                         索引の行の鍵が `WARC-Target-URI` と同じ
 *   - `content-type`      resource の `Content-Type` が `text/html; charset=utf-8`
 *   - `no-metadata`       resource を指す metadata が在る
 *   - `metadata-repeated` resource を指す metadata が 1 つだけ
 *   - `document-uri`      `WARC-Target-URI` の番号の後ろの URL が、metadata の `document-uri` から fragment を除いた物
 *   - `document-record`   metadata の `document-record` は、在れば archive の `response` の記録を名指す —— 届けた記録が
 *                         archive に無ければ書かない（WARC Profile 1.5.0）
 *   - `concurrent-to`     resource も metadata も `WARC-Concurrent-To` を持たない
 *   - `script`            写しの本文に script の要素が無い（読み方は `browserhive-snapshot-html.ts`）
 *   - `not-indexed`       索引に resource を指す行（`filename` と `offset` がその記録）が在る
 *   - `index-status`      その行の JSON に `status` が無い —— 写しはサーバの応答ではない
 *
 * 親と子の対応（時点ごと。親は `parent` が 0 なら主の写し、ほかはその番号の子の写し）:
 *
 *   - `attribute-missing` 書いた子の親の写しに、`data-browserhive-snapshot` が子の `url` の要素が在る
 *   - `attribute-stray`   写しの `data-browserhive-snapshot` が名指すのは、その写しを親とする書いた子の `url` だけ
 *   - `attribute-element` `data-browserhive-snapshot` を持つ要素は `frame` か `iframe`
 *
 * archive の全体:
 *
 *   - `unlisted`          どの項目の `frames` も名指さない子の写し（`WARC-Target-URI` が
 *                         `urn:browserhive:frame-snapshot:` の resource）が無い
 *   - `in-pages`          ページ一覧に子の写しの行（`url` が `urn:browserhive:frame-snapshot:`）が無い
 *
 * **主の写しは見ない。** 時点の項目そのもの・主の写しの組・ページ一覧の並び・mainPageURL は `browserhive/snapshots`
 * が言う。主の写しが無い（`record` が resource を名指さない）時点では、`parent` が 0 の子の属性を見ない。
 * 組の metadata が resource と別の本に在ることは `browserhive/exchange-in-one-file` が言い、ここではどの本にも
 * 無いときだけ言う。
 *
 * 書かなかった子（`too-large` など）の下に書いた子が在ってよい。親の写しが無いので、その子を名指す属性は無い。
 *
 * **archive の中だけでは決められないことは見ない。** 写した枠が同じ origin だったこと・写さなかった枠の数
 * （`frameCounts.unreadable` と、`read` のうち項目を持たない枠）が本当のこと・枠の要素の `src` が元のままであること・
 * `document-uri` と `document-record` が子の文書を指すこと・`document-record` を書かなかった子に、それと決まる
 * 記録が無かったこと・伏せるべき子を伏せたこと。
 *
 * **読めない物には照らさない。** `frame` か `parent` の読めない項目が在れば、その時点の番号と並びと対応を見ない。
 * ページ一覧に JSON として読めない行が在ればページ一覧を、索引が無ければ索引を見ない（それぞれ
 * `pages/page-schema`・`wacz/required-files` が言う）。
 *
 * **archive 自身の宣言 (`conformsTo`) で分ける。** 子フレームの写しは WACZ Profile 1.27.0 で入ったので、それより
 * 前を名乗る archive と、名乗りが無いか読めない archive には当てない。
 *
 * Spec: https://uraitakahito.github.io/browserhive-warc-spec/1.5.0/#frame-snapshots
 *   （記録は同じ版の #frame-snapshot-records、属性は #frame-snapshot-references）と
 *   https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.27.0/#snapshot-frames
 *   （名指さない子の写しは同じ版の #snapshots、索引は #archive-files、ページ一覧は #pages。これらの節は
 *   `browserhive/snapshots` が前の版で指すので、出典には載せない）
 */
import { ok } from "../../result.js";
import { fieldRecord, parseWarcFieldsBody } from "../../wacz/named-fields.js";
import { getHeader } from "../../wacz/warc-header.js";
import { hasScriptElement, snapshotAttributes } from "../browserhive-snapshot-html.js";
import { isRecord, profileAtLeast, readCapture } from "../browserhive-storage.js";
import type { Issue, IssueLocation, ValidationRule } from "../domain.js";
import { readResponses } from "../response-records.js";
import {
  indexLinesOf,
  metadataOf,
  readIndexLines,
  readPageLines,
  readSnapshotRecords,
  type Located,
} from "../snapshot-records.js";

const RULE = "browserhive/frame-snapshots";
const DATAPACKAGE = "datapackage.json";
const PAGES_ENTRY = "pages/pages.jsonl";
const CDXJ_ENTRY = "indexes/index.cdxj";

/** 子の写しの `WARC-Target-URI` の頭。後ろに時点、`:`、番号、`:`、子の文書の URL が続く。 */
const FRAME_SNAPSHOT_URI = "urn:browserhive:frame-snapshot:";
/** 子の写しの resource の型（WARC Profile 1.5.0）。 */
const SNAPSHOT_CONTENT_TYPE = "text/html; charset=utf-8";
/** 子を書かなかった理由（WACZ Profile 1.27.0）。 */
const SKIPPED_REASONS: ReadonlySet<string> = new Set(["too-large", "withheld", "task-budget", "failed"]);
/** 書かなかった子の項目が持つ member（WACZ Profile 1.27.0: これだけを持つ）。 */
const SKIPPED_MEMBERS: ReadonlySet<string> = new Set(["frame", "parent", "skipped"]);
/** `frameCounts` の member。 */
const COUNT_MEMBERS = ["read", "unreadable", "withheld"] as const;
/** `data-browserhive-snapshot` を持ってよい要素。 */
const FRAME_ELEMENTS: ReadonlySet<string> = new Set(["frame", "iframe"]);

/** JSON の値を文字で。無い値は `undefined`。 */
const json = (v: unknown): string => (v === undefined ? "undefined" : JSON.stringify(v));
/** 文字の欄の値を見せる。文字はそのまま、ほかは JSON。 */
const shown = (v: unknown): string => (typeof v === "string" ? v : json(v));
/** 数の欄の値を見せる。数は 10 進、ほかは JSON —— 文字で書いた数は引用符つきになり、数と取り違えない。 */
const shownNumber = (v: unknown): string => (typeof v === "number" ? String(v) : json(v));
/** 型の名。落ちたときに何が在ったかを言うため。 */
const typeName = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** `frames` の項目 1 つ。`frame`・`parent` が読めた物だけ。 */
interface FrameEntry {
  readonly frame: number;
  readonly parent: number;
  readonly item: Record<string, unknown>;
}

/** 書いた子と、その `record` の名指す resource（無ければ `undefined`）。 */
interface Written {
  readonly frame: number;
  readonly parent: number;
  readonly url: string;
  readonly resource: Located | undefined;
}

export const browserhiveFrameSnapshotsRule: ValidationRule = {
  name: "browserhive/frame-snapshots",
  descriptionKey: `${RULE}.desc`,
  conformance: "MUST",
  docs: [
    {
      label: "BrowserHive WARC Profile §Frame snapshots",
      url: {
        en: "https://uraitakahito.github.io/browserhive-warc-spec/1.5.0/#frame-snapshots",
        ja: "https://uraitakahito.github.io/browserhive-warc-spec/1.5.0/ja/#frame-snapshots",
      },
    },
    {
      label: "BrowserHive WARC Profile §The records of a frame snapshot",
      url: {
        en: "https://uraitakahito.github.io/browserhive-warc-spec/1.5.0/#frame-snapshot-records",
        ja: "https://uraitakahito.github.io/browserhive-warc-spec/1.5.0/ja/#frame-snapshot-records",
      },
    },
    {
      label: "BrowserHive WARC Profile §Naming a frame snapshot from its parent",
      url: {
        en: "https://uraitakahito.github.io/browserhive-warc-spec/1.5.0/#frame-snapshot-references",
        ja: "https://uraitakahito.github.io/browserhive-warc-spec/1.5.0/ja/#frame-snapshot-references",
      },
    },
    {
      label: "BrowserHive WACZ Profile §Frames",
      url: {
        en: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.27.0/#snapshot-frames",
        ja: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.27.0/ja/#snapshot-frames",
      },
    },
  ],
  applicability: {
    excludeProfiles: ["spec", "lenient"],
  },
  run: async (wacz) => {
    const capture = await readCapture(wacz);
    if (capture === undefined || !profileAtLeast(capture["conformsTo"], 1, 27)) return ok([]);
    const snapshots = capture["snapshots"];
    // snapshots の形は browserhive/snapshots が言う。
    if (!Array.isArray(snapshots)) return ok([]);

    const issues: Issue[] = [];
    const issue = (messageKey: string, params: Record<string, string>, location: IssueLocation): void => {
      issues.push({ rule: RULE, severity: "error", messageKey: `${RULE}.${messageKey}`, params, location });
    };
    const inDatapackage: IssueLocation = { entry: DATAPACKAGE };
    const at = (located: Located): IssueLocation => ({ entry: located.entry, offset: located.offset });

    const records = await readSnapshotRecords(wacz);
    /** `document-record` を照らすときだけ読む。 */
    let responses: Awaited<ReturnType<typeof readResponses>> | undefined;
    const cdxjBuf = await wacz.readEntry(CDXJ_ENTRY);
    const indexLines = cdxjBuf === undefined ? undefined : readIndexLines(cdxjBuf.toString("utf-8"));
    /** どれかの項目の frames が名指した resource。 */
    const named = new Set<Located>();

    for (const item of snapshots) {
      if (!isRecord(item)) continue;
      const stage = shown(item["stage"]);
      if (item["skipped"] !== undefined) {
        // 写しを撮らなかった時点では、子も写さない。
        for (const member of ["frames", "frameCounts"]) {
          if (item[member] !== undefined) issue("stage-frames", { stage, member }, inDatapackage);
        }
        continue;
      }
      const compare = (
        frame: number,
        [where, field, found]: readonly [string, string, string],
        [other, otherField, expected]: readonly [string, string, string],
        location: IssueLocation,
      ): void => {
        if (found !== expected) {
          issue("mismatch", { stage, frame: String(frame), where, field, found, other, otherField, expected }, location);
        }
      };

      const counts = item["frameCounts"];
      const declared = new Map<(typeof COUNT_MEMBERS)[number], number>();
      if (!isRecord(counts)) {
        issue("counts", { stage, member: "frameCounts", found: json(counts) }, inDatapackage);
      } else {
        for (const member of COUNT_MEMBERS) {
          const value = counts[member];
          if (isCount(value)) declared.set(member, value);
          else issue("counts", { stage, member: `frameCounts.${member}`, found: json(value) }, inDatapackage);
        }
      }

      const frames = item["frames"];
      if (!Array.isArray(frames)) {
        issue("frames", { stage, found: typeName(frames) }, inDatapackage);
        continue;
      }
      const entries: FrameEntry[] = [];
      frames.forEach((raw: unknown, index) => {
        const where = `frames[${String(index)}]`;
        if (!isRecord(raw)) {
          issue("entry", { stage, at: where, member: "", found: typeName(raw) }, inDatapackage);
          return;
        }
        const frame = raw["frame"];
        const parent = raw["parent"];
        let readable = true;
        if (!(isCount(frame) && frame >= 1)) {
          issue("entry", { stage, at: where, member: "frame", found: json(frame) }, inDatapackage);
          readable = false;
        }
        if (!isCount(parent)) {
          issue("entry", { stage, at: where, member: "parent", found: json(parent) }, inDatapackage);
          readable = false;
        }
        if (readable) entries.push({ frame: frame as number, parent: parent as number, item: raw });
      });
      const numbered = entries.length === frames.length;

      // 番号と並び（前順）。読めない項目が在れば照らさない。
      if (numbered) {
        const parentOf = new Map<number, number>();
        entries.forEach(({ frame, parent }, index) => {
          if (frame !== index + 1) {
            issue("number", { stage, at: `frames[${String(index)}]`, found: String(frame), expected: String(index + 1) }, inDatapackage);
          }
          // 前順では、親は 0 か、前の項目かその祖先。
          const allowed = new Set<number>([0]);
          for (let up = entries[index - 1]?.frame; up !== undefined && up !== 0; up = parentOf.get(up)) {
            if (allowed.has(up)) break;
            allowed.add(up);
          }
          if (!allowed.has(parent)) issue("parent", { stage, frame: String(frame), parent: String(parent) }, inDatapackage);
          parentOf.set(frame, parent);
        });
      }

      // 書いた子と書かなかった子。
      const written: Written[] = [];
      const withheldFrames = new Set<number>();
      for (const { frame, parent, item: entry } of entries) {
        const skipped = entry["skipped"];
        if (skipped === "withheld") withheldFrames.add(frame);
        if (skipped !== undefined) {
          if (typeof skipped !== "string" || !SKIPPED_REASONS.has(skipped)) {
            issue("skipped", { stage, frame: String(frame), found: shown(skipped) }, inDatapackage);
          }
          const extra = Object.keys(entry).filter((member) => !SKIPPED_MEMBERS.has(member));
          if (extra.length > 0) issue("skipped-members", { stage, frame: String(frame), members: extra.join(", ") }, inDatapackage);
          continue;
        }
        const url = entry["url"];
        if (typeof url !== "string" || !url.startsWith(`${FRAME_SNAPSHOT_URI}${stage}:${String(frame)}:`)) {
          issue("url", { stage, frame: String(frame), url: shown(url) }, inDatapackage);
        }
        const record = entry["record"];
        const resource = typeof record === "string" ? records.resources.get(`<${record}>`) : undefined;
        written.push({ frame, parent, url: shown(url), resource });
        if (resource === undefined) {
          issue("no-resource", { stage, frame: String(frame), record: shown(record) }, inDatapackage);
          continue;
        }
        named.add(resource);
        const targetUri = shown(getHeader(resource.record, "WARC-Target-URI"));
        const date = shown(getHeader(resource.record, "WARC-Date"));
        compare(frame, ["frames", "url", shown(url)], ["resource", "WARC-Target-URI", targetUri], inDatapackage);
        compare(frame, ["frames", "date", shown(entry["date"])], ["resource", "WARC-Date", date], inDatapackage);
        compare(
          frame,
          ["frames", "bytes", shownNumber(entry["bytes"])],
          ["resource", "Content-Length", shown(getHeader(resource.record, "Content-Length"))],
          inDatapackage,
        );
        const contentType = getHeader(resource.record, "Content-Type");
        if (contentType?.toLowerCase().replace(/\s+/g, " ") !== SNAPSHOT_CONTENT_TYPE) {
          issue("content-type", { stage, frame: String(frame), url: targetUri, found: shown(contentType) }, at(resource));
        }
        if (hasScriptElement(resource.record.body.toString("utf-8"))) {
          issue("script", { stage, frame: String(frame), url: targetUri }, at(resource));
        }
        if (getHeader(resource.record, "WARC-Concurrent-To") !== undefined) {
          issue("concurrent-to", { stage, frame: String(frame), url: targetUri, type: "resource" }, at(resource));
        }

        const metadata = metadataOf(records, resource);
        const metadataCount = records.metadataByTarget.get(getHeader(resource.record, "WARC-Record-ID") ?? "")?.length ?? 0;
        if (metadataCount > 1) {
          issue("metadata-repeated", { stage, frame: String(frame), url: targetUri, count: String(metadataCount) }, at(resource));
        }
        if (metadata === undefined) {
          issue("no-metadata", { stage, frame: String(frame), url: targetUri }, at(resource));
        } else {
          const fields = fieldRecord(parseWarcFieldsBody(metadata.record.body).fields);
          if (getHeader(metadata.record, "WARC-Concurrent-To") !== undefined) {
            issue("concurrent-to", { stage, frame: String(frame), url: targetUri, type: "metadata" }, at(metadata));
          }
          // URI の番号の後ろは、写した時点の子の文書の URL から fragment を除いた物（WARC Profile 1.5.0）。
          const head = `${FRAME_SNAPSHOT_URI}${stage}:${String(frame)}:`;
          const documentUri = fields["document-uri"];
          if (targetUri.startsWith(head) && (typeof documentUri !== "string" || targetUri.slice(head.length) !== documentUri.replace(/#.*$/s, ""))) {
            issue("document-uri", { stage, frame: String(frame), url: targetUri, documentUri: shown(documentUri) }, at(metadata));
          }
          const documentRecord = fields["document-record"];
          if (documentRecord !== undefined) {
            responses ??= await readResponses(wacz);
            if (!responses.has(documentRecord.replace(/^<(.*)>$/, "$1"))) {
              issue("document-record", { stage, frame: String(frame), url: targetUri, record: documentRecord }, at(metadata));
            }
          }
          compare(
            frame,
            ["metadata", "WARC-Target-URI", shown(getHeader(metadata.record, "WARC-Target-URI"))],
            ["resource", "WARC-Target-URI", targetUri],
            at(metadata),
          );
          compare(frame, ["metadata", "WARC-Date", shown(getHeader(metadata.record, "WARC-Date"))], ["resource", "WARC-Date", date], at(metadata));
          compare(frame, ["metadata", "snapshot", shown(fields["snapshot"])], ["snapshots", "stage", stage], at(metadata));
          compare(frame, ["metadata", "frame", shown(fields["frame"])], ["frames", "frame", String(frame)], at(metadata));
          compare(frame, ["metadata", "parent", shown(fields["parent"])], ["frames", "parent", String(parent)], at(metadata));
          compare(
            frame,
            ["frames", "secretsReplaced", shownNumber(entry["secretsReplaced"])],
            ["metadata", "secrets-replaced", shown(fields["secrets-replaced"])],
            inDatapackage,
          );
        }

        if (indexLines !== undefined) {
          const rows = indexLinesOf(indexLines, resource);
          if (rows.length === 0) issue("not-indexed", { stage, frame: String(frame), url: targetUri }, { entry: CDXJ_ENTRY });
          for (const { line, entry: row } of rows) {
            const location: IssueLocation = { entry: CDXJ_ENTRY, line };
            compare(frame, ["indexes/index.cdxj", "urlkey", row.surt], ["resource", "WARC-Target-URI", targetUri], location);
            if (row.fields["status"] !== undefined) {
              issue("index-status", { stage, frame: String(frame), url: targetUri, status: shown(row.fields["status"]) }, location);
            }
          }
        }
      }

      // frameCounts と項目の数。withheld はちょうど、read は少なくとも。
      const withheldItems = entries.filter((e) => e.item["skipped"] === "withheld").length;
      const withheldCount = declared.get("withheld");
      if (numbered && withheldCount !== undefined && withheldCount !== withheldItems) {
        issue("withheld-count", { stage, found: String(withheldCount), expected: String(withheldItems) }, inDatapackage);
      }
      const readCount = declared.get("read");
      if (numbered && readCount !== undefined && readCount < entries.length - withheldItems) {
        issue("read-count", { stage, found: String(readCount), items: String(entries.length - withheldItems) }, inDatapackage);
      }

      if (!numbered) continue;
      // 方針が伏せた文書の中の枠も伏せる。
      for (const { frame, parent, item: entry } of entries) {
        if (withheldFrames.has(parent) && entry["skipped"] !== "withheld") {
          issue("withheld-descendant", { stage, frame: String(frame), parent: String(parent) }, inDatapackage);
        }
      }

      // 親と子の対応。親の写し: 0 は主の写し、ほかは書いた子の写し。
      const record = item["record"];
      const main = typeof record === "string" ? records.resources.get(`<${record}>`) : undefined;
      const snapshotOf = new Map<number, Located>();
      if (main !== undefined) snapshotOf.set(0, main);
      for (const { frame, resource } of written) if (resource !== undefined) snapshotOf.set(frame, resource);
      for (const [self, located] of snapshotOf) {
        const uri = shown(getHeader(located.record, "WARC-Target-URI"));
        const attributes = snapshotAttributes(located.record.body.toString("utf-8"));
        const children = new Set(written.filter((w) => w.parent === self).map((w) => w.url));
        const values = new Set<string>();
        for (const { element, value } of attributes) {
          values.add(value);
          if (!FRAME_ELEMENTS.has(element)) {
            issue("attribute-element", { stage, url: uri, element, value }, at(located));
          } else if (!children.has(value)) {
            issue("attribute-stray", { stage, url: uri, value }, at(located));
          }
        }
        for (const child of written) {
          if (child.parent === self && !values.has(child.url)) {
            issue("attribute-missing", { stage, frame: String(child.frame), url: child.url, parent: uri }, at(located));
          }
        }
      }
    }

    // どの項目も名指さない子の写し。
    for (const located of records.resourceList) {
      const uri = getHeader(located.record, "WARC-Target-URI") ?? "";
      if (!uri.startsWith(FRAME_SNAPSHOT_URI) || named.has(located)) continue;
      issue("unlisted", { url: uri, record: shown(getHeader(located.record, "WARC-Record-ID")) }, at(located));
    }

    // ページ一覧に子の写しの行が無い。
    const pagesBuf = await wacz.readEntry(PAGES_ENTRY);
    const pages = pagesBuf === undefined ? null : readPageLines(pagesBuf.toString("utf-8"));
    for (const { line, page } of pages ?? []) {
      const url = page["url"];
      if (typeof url === "string" && url.startsWith(FRAME_SNAPSHOT_URI)) issue("in-pages", { url }, { entry: PAGES_ENTRY, line });
    }
    return ok(issues);
  },
};
