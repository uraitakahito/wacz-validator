/**
 * Rule: browserhive/screenshots (error / warning · browserhive profile 限定)
 *
 * 取り込みが時点ごとに撮ったスクリーンショットを、package が決まりどおりに持っているか。WACZ Profile 1.24.0 は
 * `browserhive:capture.screenshots` に時点ごと（`after-load`・`after-behaviors`）の成り行き —— 持っている絵と、
 * 持たない理由 —— を並べさせ、絵に写りうる物を package に残さないと頼まれた取り込みには絵を持たせない。
 * BrowserHive WARC Profile 1.3.0 は、絵を `resource`（block は WebP の静止画）と、それを `WARC-Refers-To` で指す
 * `metadata` の組で書かせる。見るのは:
 *
 *   - `screenshots` が配列で、項目がどれもオブジェクト。時点の並びが `after-load` 1 つと、`settings.behaviors` が
 *     空でなければその後の `after-behaviors` 1 つで、ほかの項目は無い
 *   - 絵を持たない項目（`skipped` を持つ）は `stage` と `skipped` だけを持ち、理由が `disabled`・`secret`・`withheld`・
 *     `task-budget`・`failed` のどれか。2 つ以上が当たるときは、この並びで先の物を書く決まりなので: `secret` は
 *     `settings.secrets` が空でないときだけ。空でなければ、どの項目も `disabled` か `secret`。下の「絵を持っては
 *     ならない package」の 2 つ目から後のどれかに当たれば、どの項目も `task-budget` でも `failed` でもない
 *   - 絵を持つ項目は `url`・`date`・`record`・`bytes` を持ち、`url` が `urn:browserhive:screenshot:<stage>:` で始まり、
 *     `record`（山括弧なし）の名指す `resource` が在り、`url`・`date`・`bytes` がその `WARC-Target-URI`・`WARC-Date`・
 *     `Content-Length` と同じ
 *   - どの項目も名指さないスクリーンショット（`WARC-Target-URI` が `urn:browserhive:screenshot:` の resource）が無い
 *   - 絵を持ってはならない package が、絵（項目か resource）を持たない。当たる条件ごとに言う: `settings.secrets` が
 *     空でない／`settings.contentTypePolicies` が空でない／`document` が `withheld` を持つ／`action: no-archive` の
 *     レコードが、`resourceType` に `Document`・`Image`・`Media` を持つか `resourceType` を持たない／
 *     `truncated: url-policy` のレコードの指す response を `record` で名指す `trace/events.jsonl` の行が、同じ 3 つの
 *     `resourceType` を持つか `resourceType` を持たないか、名指す行が無い
 *   - `snapshots` が `withheld` と記録する時点の項目は `skipped` を持つ
 *   - resource: `WARC-Target-URI` が `urn:browserhive:screenshot:<時点>:<URL>` の形、`Content-Type` が `image/webp`、
 *     `WARC-Block-Digest` と `WARC-Payload-Digest` が在り（sha256 なら）block を言う。block が WebP の静止画
 *   - metadata: resource ごとにちょうど 1 つ。`WARC-Target-URI`・`WARC-Date` が resource と同じで、`screenshot`・
 *     `document-uri`・`viewport`・`device-pixel-ratio`・`image-size` を持ち、`action`・`truncated`・`window`・`snapshot` を
 *     持たない。`screenshot` が URI の中の時点、URI の中の URL が `document-uri` から fragment を除いた物。`viewport`・
 *     `image-size`・`device-pixel-ratio` が仕様の書式。`image-size` が画像自身の幅と高さ
 *   - resource も metadata も `WARC-Concurrent-To` を持たない
 *   - `screenshot` の欄を持つ metadata が、スクリーンショットの resource を指す
 *   - 索引にスクリーンショットの resource を指す行（`filename` と `offset` がそのレコード）が在り、その鍵が
 *     `WARC-Target-URI` そのままで、JSON に `status` が無い
 *
 * **画像の縦横の比は warning。** 仕様は「viewport を写し、その先を写さない」（MUST）から、画像の縦横の比が pixel への
 * 丸めを除いて viewport と同じになると言うが、その文に規範の語は無く、丸め方も決めていない。比の違う画像は、
 * 取り込みのページの全体を写した物か、viewport の一部だけの物でありうるので言う。
 *
 * **ここで言わないこと。** 組の metadata が resource と別の本に在ることは `browserhive/exchange-in-one-file` が言う
 * （WARC Profile 1.3.0 の Records and files）。metadata の `WARC-Payload-Digest` は `warc/fields-by-type` が言う
 * （WARC 1.1 が metadata に禁じる）。`pages/pages.jsonl` にスクリーンショットの行が在ることは `browserhive/snapshots` の
 * 行の並びの検査が言う。絵の中身（何が写っているか、取り込みが絵のために viewport を変えなかったか）は、
 * package からは分からない。
 *
 * **読めない物には照らさない。** `settings.behaviors` が読めなければ時点の並びを、`settings.secrets` が読めなければ
 * `secret` の理由を見ない。それぞれの形は `browserhive/settings-shape` が言う。
 *
 * **archive 自身の宣言 (`conformsTo`) で分ける。** スクリーンショットは WACZ Profile 1.24.0 で入ったので、それより前を
 * 名乗る archive と、名乗りが無いか読めない archive には当てない。
 *
 * Spec: https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.24.0/#screenshots
 *   （索引は同じ版の #archive-files）と
 *   https://uraitakahito.github.io/browserhive-warc-spec/1.3.0/#screenshots
 */
import { ok } from "../../result.js";
import { parseCdxj, type CdxjEntry } from "../../wacz/cdxj-parser.js";
import { fieldValues, parseWarcFieldsBody } from "../../wacz/named-fields.js";
import type { WaczReader } from "../../wacz/reader.js";
import { getHeader, parseWarcRecord, type ParsedWarcRecord, type WarcHeader } from "../../wacz/warc-header.js";
import { iterateWarcMembers } from "../../wacz/warc-iter.js";
import {
  SCREENSHOT_RATIO,
  SCREENSHOT_SIZE,
  SCREENSHOT_URI,
  parseScreenshotSize,
  parseScreenshotUri,
  readWebpStill,
  sameAspect,
} from "../browserhive-screenshot.js";
import { isRecord, profileAtLeast, readCapture } from "../browserhive-storage.js";
import { readTraceLines } from "../browserhive-trace.js";
import type { MsgParams } from "../../i18n/translate.js";
import type { Issue, IssueLocation, ValidationRule } from "../domain.js";
import { compareSha256 } from "./warc-payload-digest.js";

const RULE = "browserhive/screenshots";
const DATAPACKAGE = "datapackage.json";
const CDXJ_ENTRY = "indexes/index.cdxj";

/** 絵を持たない理由。2 つ以上が当たるときは、この並びで先の物を書く。 */
const SKIPPED_REASONS: readonly string[] = ["disabled", "secret", "withheld", "task-budget", "failed"];
/** 絵を持つ項目が、`stage` のほかに必ず持つ member。 */
const PICTURE_MEMBERS = ["url", "date", "record", "bytes"] as const;
/** スクリーンショットの metadata の本文が必ず持つ欄。 */
const REQUIRED_FIELDS: readonly string[] = ["screenshot", "document-uri", "viewport", "device-pixel-ratio", "image-size"];
/** スクリーンショットの metadata の本文が持ってはならない欄。持てば、読み手が別の種類のレコードと取り違える。 */
const FORBIDDEN_FIELDS: readonly string[] = ["action", "truncated", "window", "snapshot"];
/** 書式の決まっている欄と、その形。 */
const FIELD_FORMS: readonly (readonly [string, RegExp])[] = [
  ["viewport", SCREENSHOT_SIZE],
  ["device-pixel-ratio", SCREENSHOT_RATIO],
  ["image-size", SCREENSHOT_SIZE],
];
/** 絵に写る物を取りに行く要求の種類。ブラウザの語で、字のまま比べる。 */
const SHOWN_RESOURCE_TYPES: ReadonlySet<string> = new Set(["Document", "Image", "Media"]);

/** 本の中のレコード 1 つ。落ちたときに名指す本と位置を持つ。 */
interface Located {
  readonly entry: string;
  readonly offset: number;
  readonly record: ParsedWarcRecord;
}

/** metadata のレコードと、その本文の欄。 */
interface Metadata extends Located {
  readonly fields: readonly WarcHeader[];
}

/**
 * 方針が要求に当たった証拠のレコード。`kind` は、要求の種類を package がどう言っているか: 絵に写る種類
 * （`typed`）、種類の欄が無い（`untyped`）、trace に名指す行が無い（`untraced`）。
 */
interface Evidence {
  readonly at: Located;
  readonly kind: "typed" | "untyped" | "untraced";
  readonly resourceType: string;
}

/** JSON の値を文字で。無い値は `undefined`。 */
const json = (v: unknown): string => (v === undefined ? "undefined" : JSON.stringify(v));

/** 文字の欄の値を見せる。文字はそのまま、ほかは JSON。 */
const shown = (v: unknown): string => (typeof v === "string" ? v : json(v));

/** 数の欄の値を見せる。数は 10 進、ほかは JSON —— 文字で書いた数は引用符つきになり、数と取り違えない。 */
const shownNumber = (v: unknown): string => (typeof v === "number" ? String(v) : json(v));

/** 型の名。落ちたときに何が在ったかを言うため。 */
const typeName = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

/** 欄の最初の値。無ければ `undefined`。 */
const field = (fields: readonly WarcHeader[], name: string): string | undefined => fieldValues(fields, name)[0];

/** digest の欄が `bytes` を言っているか。sha256 でなければ計算できないので、言っていると見なす。 */
const describes = (declared: string, bytes: Buffer): boolean =>
  !declared.toLowerCase().startsWith("sha256:") || compareSha256(declared.slice("sha256:".length), bytes).same;

/**
 * archive の全部の本を 1 度読み、resource を `WARC-Record-ID` で、metadata を `WARC-Refers-To` で引けるようにする。
 * スクリーンショットの resource（`WARC-Target-URI` が urn の物）、`screenshot` の欄を持つ metadata、方針が要求に
 * 当たったことを言う metadata（`action: no-archive` と `truncated: url-policy`）は、別にも並べる。
 */
const readRecords = async (
  wacz: WaczReader,
): Promise<{
  resources: Map<string, Located>;
  shots: Located[];
  metadataByTarget: Map<string, Metadata[]>;
  describing: Metadata[];
  notArchived: Metadata[];
  bodyNotKept: Metadata[];
}> => {
  const resources = new Map<string, Located>();
  const shots: Located[] = [];
  const metadataByTarget = new Map<string, Metadata[]>();
  const describing: Metadata[] = [];
  const notArchived: Metadata[] = [];
  const bodyNotKept: Metadata[] = [];
  for (const entry of wacz.warcEntries()) {
    const buf = await wacz.readEntry(entry);
    if (buf === undefined) continue;
    for (const member of iterateWarcMembers(buf, { loose: true })) {
      const record = parseWarcRecord(member.raw);
      if (record === null) continue;
      const located: Located = { entry, offset: member.offset, record };
      const type = (getHeader(record, "WARC-Type") ?? "").toLowerCase();
      if (type === "resource") {
        const id = getHeader(record, "WARC-Record-ID");
        if (id !== undefined && !resources.has(id)) resources.set(id, located);
        if ((getHeader(record, "WARC-Target-URI") ?? "").startsWith(SCREENSHOT_URI)) shots.push(located);
      } else if (type === "metadata") {
        const metadata: Metadata = { ...located, fields: parseWarcFieldsBody(record.body).fields };
        const target = getHeader(record, "WARC-Refers-To");
        if (target !== undefined) {
          const list = metadataByTarget.get(target);
          if (list === undefined) metadataByTarget.set(target, [metadata]);
          else list.push(metadata);
        }
        const has = (name: string): boolean => fieldValues(metadata.fields, name).length > 0;
        if (has("screenshot")) describing.push(metadata);
        // スクリーンショット・写し・開かせなかったウィンドウの metadata は、止めた要求のレコードにも本文の無い応答の
        // レコードにも数えない（WARC Profile が読み手に禁じる）。その欄を持つこと自体は、それぞれの rule が言う。
        if (has("screenshot") || has("snapshot") || has("window")) continue;
        if (fieldValues(metadata.fields, "action").includes("no-archive")) notArchived.push(metadata);
        if (fieldValues(metadata.fields, "truncated").includes("url-policy")) bodyNotKept.push(metadata);
      }
    }
  }
  return { resources, shots, metadataByTarget, describing, notArchived, bodyNotKept };
};

/**
 * `no-archive` の方針が、絵に写る種類の要求に当たったことを言うレコード: `resourceType` が `Document`・`Image`・
 * `Media` か、`resourceType` を持たない（package は、その要求の種類を言えない）。
 */
const notArchivedEvidence = (records: readonly Metadata[]): Evidence[] =>
  records.flatMap((at): Evidence[] => {
    const types = fieldValues(at.fields, "resourceType");
    if (types.length === 0) return [{ at, kind: "untyped", resourceType: "" }];
    const type = types.find((t) => SHOWN_RESOURCE_TYPES.has(t));
    return type === undefined ? [] : [{ at, kind: "typed", resourceType: type }];
  });

/**
 * `no-body` の方針が、絵に写る種類の要求に当たったことを言うレコード。本文の無い応答のレコードは要求の種類を
 * 持たないので、その response を `record` で名指す trace の行から読む: 行の `resourceType` が同じ 3 つか、行が
 * `resourceType` を持たないか、名指す行が無い（producer が行を trace から落とした）。
 */
const bodyNotKeptEvidence = async (wacz: WaczReader, records: readonly Metadata[]): Promise<Evidence[]> => {
  if (records.length === 0) return [];
  /** `record` の値（山括弧なし）→ それを持つ行の `resourceType`。 */
  const typesByRecord = new Map<string, unknown[]>();
  for (const { parsed } of (await readTraceLines(wacz)) ?? []) {
    const record = parsed?.["record"];
    if (parsed === null || typeof record !== "string") continue;
    typesByRecord.set(record, [...(typesByRecord.get(record) ?? []), parsed["resourceType"]]);
  }
  return records.flatMap((at): Evidence[] => {
    const target = getHeader(at.record, "WARC-Refers-To") ?? "";
    const types = typesByRecord.get(target.replace(/^<|>$/g, ""));
    if (types === undefined) return [{ at, kind: "untraced", resourceType: "" }];
    if (types.includes(undefined)) return [{ at, kind: "untyped", resourceType: "" }];
    const type = types.find((t): t is string => typeof t === "string" && SHOWN_RESOURCE_TYPES.has(t));
    return type === undefined ? [] : [{ at, kind: "typed", resourceType: type }];
  });
};

/** 索引の行と、その行番号。読めない行は飛ばす（`cdxj/index-valid-data` が言う）。 */
const readIndexLines = (text: string): { line: number; entry: CdxjEntry }[] =>
  text.split("\n").flatMap((raw, i) => {
    const [entry] = parseCdxj(raw).entries;
    return entry === undefined ? [] : [{ line: i + 1, entry }];
  });

export const browserhiveScreenshotsRule: ValidationRule = {
  name: "browserhive/screenshots",
  descriptionKey: `${RULE}.desc`,
  conformance: "MUST",
  docs: [
    {
      label: "BrowserHive WARC Profile §Screenshots",
      url: {
        en: "https://uraitakahito.github.io/browserhive-warc-spec/1.3.0/#screenshots",
        ja: "https://uraitakahito.github.io/browserhive-warc-spec/1.3.0/ja/#screenshots",
      },
    },
    {
      label: "BrowserHive WACZ Profile §screenshots",
      url: {
        en: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.24.0/#screenshots",
        ja: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.24.0/ja/#screenshots",
      },
    },
    {
      label: "BrowserHive WACZ Profile §Archive files",
      url: {
        en: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.24.0/#archive-files",
        ja: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.24.0/ja/#archive-files",
      },
    },
  ],
  applicability: {
    excludeProfiles: ["spec", "lenient"],
  },
  run: async (wacz) => {
    const capture = await readCapture(wacz);
    if (capture === undefined || !profileAtLeast(capture["conformsTo"], 1, 24)) return ok([]);

    const issues: Issue[] = [];
    const issue = (messageKey: string, params: MsgParams, location: IssueLocation): void => {
      issues.push({
        rule: RULE,
        // 縦横の比だけは、仕様が規範の語なしに言う帰結なので warning（上の説明）。
        severity: messageKey !== "aspect" ? "error" : "warning",
        messageKey: `${RULE}.${messageKey}`,
        params,
        location,
      });
    };
    /** 2 つの値が違えば言う。`where` の `field` が `found`、`other` の `otherField` が `expected`。 */
    const compare = (
      shot: string,
      [where, name, found]: readonly [string, string, string],
      [other, otherField, expected]: readonly [string, string, string],
      location: IssueLocation,
    ): void => {
      if (found !== expected) issue("mismatch", { shot, where, field: name, found, other, otherField, expected }, location);
    };
    const inDatapackage: IssueLocation = { entry: DATAPACKAGE };
    const at = (located: Located): IssueLocation => ({ entry: located.entry, offset: located.offset });

    // ---- screenshots の形 ----
    const screenshots = capture["screenshots"];
    const items: Record<string, unknown>[] = [];
    if (!Array.isArray(screenshots)) {
      issue("shape", { at: "screenshots", found: typeName(screenshots) }, inDatapackage);
    } else {
      screenshots.forEach((item: unknown, index) => {
        if (isRecord(item)) items.push(item);
        else issue("shape", { at: `screenshots[${String(index)}]`, found: typeName(item) }, inDatapackage);
      });
    }

    // 時点の並び。behaviors が読めなければ照らさない（settings の形は browserhive/settings-shape が言う）。
    const settings = isRecord(capture["settings"]) ? capture["settings"] : {};
    const behaviors = settings["behaviors"];
    if (Array.isArray(screenshots) && Array.isArray(behaviors) && items.length === screenshots.length) {
      const expected = behaviors.length > 0 ? ["after-load", "after-behaviors"] : ["after-load"];
      const found = JSON.stringify(items.map((item) => item["stage"]));
      if (found !== JSON.stringify(expected)) {
        issue("stages", { found, expected: JSON.stringify(expected), behaviors: String(behaviors.length) }, inDatapackage);
      }
    }

    // ---- 絵を持ってはならない package か ----
    const { resources, shots, metadataByTarget, describing, notArchived, bodyNotKept } = await readRecords(wacz);
    const secrets = Array.isArray(settings["secrets"]) ? settings["secrets"] : undefined;
    const hasSecrets = secrets !== undefined && secrets.length > 0;
    const contentTypePolicies = settings["contentTypePolicies"];
    const hasMediaTypePolicy = Array.isArray(contentTypePolicies) && contentTypePolicies.length > 0;
    const document = capture["document"];
    const documentWithheld = isRecord(document) ? document["withheld"] : undefined;
    const notArchivedHits = notArchivedEvidence(notArchived);
    const bodyNotKeptHits = await bodyNotKeptEvidence(wacz, bodyNotKept);
    /** `withheld` の理由が当たる条件（`secret` より後ろの物）。当たれば、項目は `task-budget` にも `failed` にもならない。 */
    const withheldBecause = [
      ...(hasMediaTypePolicy ? ["settings.contentTypePolicies"] : []),
      ...(documentWithheld !== undefined ? ["document.withheld"] : []),
      ...(notArchivedHits.length > 0 ? ["action: no-archive"] : []),
      ...(bodyNotKeptHits.length > 0 ? ["truncated: url-policy"] : []),
    ];

    /** `snapshots` が `withheld` と記録する時点。 */
    const snapshots: unknown = capture["snapshots"];
    const withheldStages = new Set(
      (Array.isArray(snapshots) ? snapshots : []).flatMap((item: unknown) =>
        isRecord(item) && item["skipped"] === "withheld" ? [item["stage"]] : [],
      ),
    );

    // ---- 項目と、スクリーンショットの resource ----
    let pictures = 0;
    const named = new Set<Located>();
    for (const item of items) {
      const stage = shown(item["stage"]);
      const skipped = item["skipped"];
      if (skipped !== undefined) {
        if (typeof skipped !== "string" || !SKIPPED_REASONS.includes(skipped)) {
          issue("skipped", { stage, found: shown(skipped) }, inDatapackage);
        } else if (skipped === "secret" && secrets?.length === 0) {
          issue("secret-without-secrets", { stage }, inDatapackage);
        } else if (hasSecrets && skipped !== "disabled" && skipped !== "secret") {
          issue("skipped-not-secret", { stage, found: skipped }, inDatapackage);
        } else if (!hasSecrets && withheldBecause.length > 0 && (skipped === "task-budget" || skipped === "failed")) {
          issue("skipped-not-withheld", { stage, found: skipped, because: withheldBecause.join(", ") }, inDatapackage);
        }
        const extra = Object.keys(item).filter((member) => member !== "stage" && member !== "skipped");
        if (extra.length > 0) issue("skipped-members", { stage, members: extra.join(", ") }, inDatapackage);
        continue;
      }

      pictures += 1;
      if (withheldStages.has(item["stage"])) issue("snapshot-withheld", { stage }, inDatapackage);
      const missing = PICTURE_MEMBERS.filter((member) => item[member] === undefined);
      if (missing.length > 0) issue("missing-member", { stage, members: missing.join(", ") }, inDatapackage);
      const url = item["url"];
      if (url !== undefined && (typeof url !== "string" || !url.startsWith(`${SCREENSHOT_URI}${stage}:`))) {
        issue("url", { stage, url: shown(url) }, inDatapackage);
      }
      const record = item["record"];
      if (record === undefined) continue;
      const resource = typeof record === "string" ? resources.get(`<${record}>`) : undefined;
      if (resource === undefined) {
        issue("no-resource", { stage, record: shown(record) }, inDatapackage);
        continue;
      }
      named.add(resource);
      const uri = shown(getHeader(resource.record, "WARC-Target-URI"));
      const checks: readonly (readonly [string, string, string, string | undefined])[] = [
        ["url", shown(url), "WARC-Target-URI", getHeader(resource.record, "WARC-Target-URI")],
        ["date", shown(item["date"]), "WARC-Date", getHeader(resource.record, "WARC-Date")],
        ["bytes", shownNumber(item["bytes"]), "Content-Length", getHeader(resource.record, "Content-Length")],
      ];
      for (const [member, found, header, expected] of checks) {
        if (item[member] === undefined) continue; // 無い member は missing-member が言う
        compare(uri, ["screenshots", member, found], ["resource", header, shown(expected)], inDatapackage);
      }
    }

    // どの項目も名指さないスクリーンショット。
    for (const shot of shots) {
      if (named.has(shot)) continue;
      issue(
        "unlisted",
        {
          url: shown(getHeader(shot.record, "WARC-Target-URI")),
          record: shown(getHeader(shot.record, "WARC-Record-ID")),
        },
        at(shot),
      );
    }

    // 絵を持ってはならない package が絵を持つ。条件ごとに 1 件 —— レコードが証拠の条件は、最初の 1 つを名指して数を添える。
    if (pictures > 0 || shots.length > 0) {
      const held = { entries: pictures, records: shots.length };
      if (hasSecrets) issue("forbidden-secrets", held, inDatapackage);
      if (hasMediaTypePolicy) issue("forbidden-content-type-policies", held, inDatapackage);
      if (documentWithheld !== undefined) {
        issue("forbidden-document-withheld", { ...held, withheld: shown(documentWithheld) }, inDatapackage);
      }
      const policyHits: readonly (readonly [string, readonly Evidence[]])[] = [
        ["forbidden-no-archive", notArchivedHits],
        ["forbidden-no-body", bodyNotKeptHits],
      ];
      for (const [messageKey, hits] of policyHits) {
        const [first] = hits;
        if (first === undefined) continue;
        issue(
          messageKey,
          {
            ...held,
            url: shown(getHeader(first.at.record, "WARC-Target-URI")),
            kind: first.kind,
            resourceType: first.resourceType,
            count: hits.length,
          },
          at(first.at),
        );
      }
    }

    // ---- WARC のレコードの組 ----
    const paired = new Set<Metadata>();
    for (const shot of shots) {
      const uri = getHeader(shot.record, "WARC-Target-URI") ?? "";
      const parts = parseScreenshotUri(uri);
      if (parts === undefined) issue("resource-uri", { url: uri }, at(shot));
      const contentType = getHeader(shot.record, "Content-Type");
      if (contentType?.trim().toLowerCase() !== "image/webp") {
        issue("content-type", { url: uri, found: shown(contentType) }, at(shot));
      }
      for (const name of ["WARC-Block-Digest", "WARC-Payload-Digest"]) {
        const declared = getHeader(shot.record, name);
        if (declared === undefined) issue("digest-missing", { url: uri, field: name }, at(shot));
        else if (!describes(declared, shot.record.body)) issue("digest", { url: uri, field: name }, at(shot));
      }
      if (getHeader(shot.record, "WARC-Concurrent-To") !== undefined) {
        issue("concurrent-to", { url: uri, type: "resource" }, at(shot));
      }
      const image = readWebpStill(shot.record.body);
      if (image.kind !== "still") issue(image.kind, { url: uri }, at(shot));

      // 組の metadata。同じ本の物を先に見る。別の本にしか無ければ、それは browserhive/exchange-in-one-file が言う。
      const candidates = metadataByTarget.get(getHeader(shot.record, "WARC-Record-ID") ?? "") ?? [];
      for (const candidate of candidates) paired.add(candidate);
      const metadata = candidates.find((m) => m.entry === shot.entry) ?? candidates[0];
      if (metadata === undefined) {
        issue("no-metadata", { url: uri }, at(shot));
        continue;
      }
      if (candidates.length > 1) issue("metadata-repeated", { url: uri, count: candidates.length }, at(shot));
      for (const header of ["WARC-Target-URI", "WARC-Date"]) {
        compare(
          uri,
          ["metadata", header, shown(getHeader(metadata.record, header))],
          ["resource", header, shown(getHeader(shot.record, header))],
          at(metadata),
        );
      }
      if (getHeader(metadata.record, "WARC-Concurrent-To") !== undefined) {
        issue("concurrent-to", { url: uri, type: "metadata" }, at(metadata));
      }
      const absent = REQUIRED_FIELDS.filter((name) => field(metadata.fields, name) === undefined);
      if (absent.length > 0) issue("metadata-field-missing", { url: uri, fields: absent.join(", ") }, at(metadata));
      const carried = FORBIDDEN_FIELDS.filter((name) => field(metadata.fields, name) !== undefined);
      if (carried.length > 0) issue("metadata-field-forbidden", { url: uri, fields: carried.join(", ") }, at(metadata));

      // 組の 2 つのレコードは同じことを言う: screenshot は URI の中の時点、URI の中の URL は document-uri から fragment を除いた物。
      const stage = field(metadata.fields, "screenshot");
      const documentUri = field(metadata.fields, "document-uri");
      if (parts !== undefined && stage !== undefined) {
        compare(uri, ["metadata", "screenshot", stage], ["resource", "WARC-Target-URI (stage)", parts.stage], at(metadata));
      }
      if (parts !== undefined && documentUri !== undefined) {
        const withoutFragment = documentUri.split("#", 1)[0] ?? documentUri;
        compare(uri, ["resource", "WARC-Target-URI (URL)", parts.url], ["metadata", "document-uri (no fragment)", withoutFragment], at(shot));
      }
      for (const [name, form] of FIELD_FORMS) {
        const value = field(metadata.fields, name);
        if (value !== undefined && !form.test(value)) issue("field-form", { url: uri, field: name, found: value }, at(metadata));
      }

      // image-size は画像自身の幅と高さ。縦横の比は、丸めを除いて viewport と同じ（こちらは warning）。
      if (image.kind !== "still") continue;
      const actual = `${String(image.width)}x${String(image.height)}`;
      const imageSize = field(metadata.fields, "image-size");
      if (imageSize !== undefined && SCREENSHOT_SIZE.test(imageSize) && imageSize !== actual) {
        issue("image-size", { url: uri, declared: imageSize, actual }, at(metadata));
      }
      const viewport = field(metadata.fields, "viewport");
      const viewportSize = viewport === undefined ? undefined : parseScreenshotSize(viewport);
      if (viewport !== undefined && viewportSize !== undefined && !sameAspect(image, viewportSize)) {
        issue("aspect", { url: uri, image: actual, viewport }, at(shot));
      }
    }

    // screenshot の欄を持つのに、スクリーンショットの resource を指さない metadata。
    for (const metadata of describing) {
      if (paired.has(metadata)) continue;
      issue(
        "metadata-orphan",
        {
          url: shown(getHeader(metadata.record, "WARC-Target-URI")),
          refersTo: shown(getHeader(metadata.record, "WARC-Refers-To")),
        },
        at(metadata),
      );
    }

    // ---- 索引 ----
    // スクリーンショットの resource を指す行が在り、鍵は WARC-Target-URI のまま、JSON に status が無い。行は鍵や url
    // ではなく指すレコードで探す（browserhive/snapshots と同じ）。
    const cdxjBuf = await wacz.readEntry(CDXJ_ENTRY);
    if (cdxjBuf !== undefined) {
      const lines = readIndexLines(cdxjBuf.toString("utf-8"));
      for (const shot of shots) {
        const uri = getHeader(shot.record, "WARC-Target-URI") ?? "";
        const file = shot.entry.slice("archive/".length);
        const rows = lines.filter(
          ({ entry }) => entry.fields["filename"] === file && String(entry.fields["offset"]) === String(shot.offset),
        );
        if (rows.length === 0) {
          issue("not-indexed", { url: uri }, { entry: CDXJ_ENTRY });
          continue;
        }
        for (const { line, entry } of rows) {
          const location: IssueLocation = { entry: CDXJ_ENTRY, line };
          compare(uri, ["indexes/index.cdxj", "urlkey", entry.surt], ["resource", "WARC-Target-URI", uri], location);
          if (entry.fields["status"] !== undefined) {
            issue("index-status", { url: uri, status: shown(entry.fields["status"]) }, location);
          }
        }
      }
    }
    return ok(issues);
  },
};
