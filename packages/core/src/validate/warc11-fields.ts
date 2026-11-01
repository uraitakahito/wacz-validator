/**
 * WARC 1.1 の名前付き欄の目録。
 *
 * 1.1 の §5（Named fields）は欄ごとに「どの type に必須か・書いてよいか・書いてはいけないか」と
 * 値の形を定める。それを 1 つの表に写し、`warc/mandatory-fields`・`warc/fields-by-type`・
 * `warc/field-values` はこの表を読むだけにする。欄ごとに rule を切ると docs の表が読めなくなり、
 * 1 本にまとめると message が何を言っているか分からなくなるので、見る場所（有無・type との対応・
 * 値の形）で rule を分け、知識はここに 1 度だけ書く。
 *
 * 表に書けない決まりは、記録を跨いで見る rule が持つ:
 *   - `WARC-Segment-Number` が分割の先頭で "1" になること、`WARC-Segment-Total-Length` が最後の
 *     continuation にだけ在ること → `warc/segmentation`
 *   - identical-payload-digest の revisit に `WARC-Payload-Digest` が要ること → `warc/revisit`
 *   - block が空でない記録に `Content-Type` が在るべきこと（should） → `warc/content-type`
 *
 * 「payload の定義が無い記録」: §6 で payload を定義しているのは response（entity-body）・
 * resource と conversion（block）・revisit（元の payload）だけで、warcinfo と metadata には無い。
 * §5.9 と §5.18 は well-defined payload の無い記録に `WARC-Payload-Digest` と
 * `WARC-Identified-Payload-Type` を書くことを禁じるので、この 2 type では「禁止」に置く。
 *
 * 出典は注釈つき WARC 1.1 の各欄の節（アンカーは見出しの id）。本文は写さない。
 */

/**
 * 出典リンクの基底。注釈つき WARC 1.1（IIPC の warc-specifications の fork を Pages で配った頁。
 * 本文は IIPC の頁と同じ）。rule の `docs` は docs の抽出器がソースの文字列として読むので、各 rule に
 * 同じ基底を文字列で書く。基底がこれと揃っていることは `rule-docs.test.ts` が見る。
 */
export const WARC11_SPEC_BASE =
  "https://uraitakahito.github.io/warc-specifications/specifications/warc-format/warc-1.1-annotated/";

/** §5.5 が定める 8 つの type。他は拡張で、読む側は無視する。 */
export const WARC_RECORD_TYPES = [
  "warcinfo",
  "response",
  "resource",
  "request",
  "metadata",
  "revisit",
  "conversion",
  "continuation",
] as const;
export type WarcRecordType = (typeof WARC_RECORD_TYPES)[number];

export const isWarcRecordType = (value: string): value is WarcRecordType =>
  (WARC_RECORD_TYPES as readonly string[]).includes(value);

/** §6.7.2・§6.7.3 の 2 つの revisit profile。 */
export const REVISIT_PROFILE_IDENTICAL_PAYLOAD_DIGEST =
  "http://netpreserve.org/warc/1.1/revisit/identical-payload-digest";
export const REVISIT_PROFILE_SERVER_NOT_MODIFIED =
  "http://netpreserve.org/warc/1.1/revisit/server-not-modified";

/** §5.13 の reason-token。他は拡張。 */
export const TRUNCATED_REASONS = ["length", "time", "disconnect", "unspecified"] as const;

/**
 * 欄がその type でどう扱われるか。
 *   - mandatory: shall have（無ければ違反）
 *   - optional: may be used
 *   - forbidden: shall not be used（在れば違反）
 *   - undefined: 仕様が定義しない（在っても違反とは言えない。`WARC-Profile` の revisit 以外）
 */
export type FieldPresence = "mandatory" | "optional" | "forbidden" | "undefined";

/** 値の形。`warc/field-values` が `checkFieldValue` で照らす。 */
export type FieldValueKind =
  | "record-id"
  | "uri"
  | "date"
  | "digits"
  | "record-type"
  | "labelled-digest"
  | "ip-address"
  | "truncated-reason"
  | "media-type"
  | "text";

export interface WarcFieldSpec {
  /** 正しい綴り。照合は大小を無視する。 */
  name: string;
  /** 注釈つき 1.1 の見出しの id。 */
  anchor: string;
  value: FieldValueKind;
  /** 同じ記録に繰り返して書ける（§5.1 の例外。`WARC-Concurrent-To` だけ）。 */
  repeatable?: true;
  /** 書いていない type は optional。 */
  mandatoryOn?: readonly WarcRecordType[];
  forbiddenOn?: readonly WarcRecordType[];
  undefinedOn?: readonly WarcRecordType[];
}

const ALL: readonly WarcRecordType[] = WARC_RECORD_TYPES;
const except = (...types: readonly WarcRecordType[]): readonly WarcRecordType[] =>
  ALL.filter((t) => !types.includes(t));

/** §5.2〜§5.22 と Content-Length・Content-Type。並びは仕様の節の順。 */
export const WARC11_FIELDS: readonly WarcFieldSpec[] = [
  { name: "WARC-Record-ID", anchor: "warc-record-id-mandatory", value: "record-id", mandatoryOn: ALL },
  { name: "Content-Length", anchor: "content-length-mandatory", value: "digits", mandatoryOn: ALL },
  { name: "WARC-Date", anchor: "warc-date-mandatory", value: "date", mandatoryOn: ALL },
  { name: "WARC-Type", anchor: "warc-type-mandatory", value: "record-type", mandatoryOn: ALL },
  // 在るべき条件（block が空でない・continuation 以外）は should なので `warc/content-type` が見る。
  { name: "Content-Type", anchor: "content-type", value: "media-type" },
  {
    name: "WARC-Concurrent-To",
    anchor: "warc-concurrent-to",
    value: "record-id",
    repeatable: true,
    forbiddenOn: ["warcinfo", "conversion", "continuation"],
  },
  { name: "WARC-Block-Digest", anchor: "warc-block-digest", value: "labelled-digest" },
  // payload の定義が無い記録には書かない（§5.9）。
  { name: "WARC-Payload-Digest", anchor: "warc-payload-digest", value: "labelled-digest", forbiddenOn: ["warcinfo", "metadata"] },
  { name: "WARC-IP-Address", anchor: "warc-ip-address", value: "ip-address", forbiddenOn: ["warcinfo", "conversion", "continuation"] },
  {
    name: "WARC-Refers-To",
    anchor: "warc-refers-to",
    value: "record-id",
    forbiddenOn: ["warcinfo", "response", "resource", "request", "continuation"],
  },
  { name: "WARC-Refers-To-Target-URI", anchor: "warc-refers-to-target-uri", value: "uri", forbiddenOn: except("revisit") },
  { name: "WARC-Refers-To-Date", anchor: "warc-refers-to-date", value: "date", forbiddenOn: except("revisit") },
  {
    name: "WARC-Target-URI",
    anchor: "warc-target-uri",
    value: "uri",
    mandatoryOn: ["response", "resource", "request", "revisit", "conversion", "continuation"],
    forbiddenOn: ["warcinfo"],
  },
  { name: "WARC-Truncated", anchor: "warc-truncated", value: "truncated-reason" },
  { name: "WARC-Warcinfo-ID", anchor: "warc-warcinfo-id", value: "record-id", forbiddenOn: ["warcinfo"] },
  { name: "WARC-Filename", anchor: "warc-filename", value: "text", forbiddenOn: except("warcinfo") },
  { name: "WARC-Profile", anchor: "warc-profile", value: "uri", mandatoryOn: ["revisit"], undefinedOn: except("revisit") },
  // payload の定義が無い記録には書かない（§5.18）。
  { name: "WARC-Identified-Payload-Type", anchor: "warc-identified-payload-type", value: "media-type", forbiddenOn: ["warcinfo", "metadata"] },
  // 分割の先頭でも必須（値 "1"）だが、先頭かどうかは列を見ないと分からないので `warc/segmentation` が見る。
  { name: "WARC-Segment-Number", anchor: "warc-segment-number", value: "digits", mandatoryOn: ["continuation"] },
  { name: "WARC-Segment-Origin-ID", anchor: "warc-segment-origin-id", value: "record-id", mandatoryOn: ["continuation"], forbiddenOn: except("continuation") },
  // 最後の continuation にだけ必須。どれが最後かは `warc/segmentation` が見る。
  { name: "WARC-Segment-Total-Length", anchor: "warc-segment-total-length", value: "digits", forbiddenOn: except("continuation") },
];

const BY_LOWER_NAME = new Map(WARC11_FIELDS.map((spec) => [spec.name.toLowerCase(), spec]));

/** 欄の名（大小を無視）から目録の 1 行を引く。目録に無い名（拡張の欄）は `undefined`。 */
export const warcFieldSpec = (name: string): WarcFieldSpec | undefined => BY_LOWER_NAME.get(name.toLowerCase());

/** その type でその欄がどう扱われるか。 */
export const fieldPresence = (spec: WarcFieldSpec, type: WarcRecordType): FieldPresence => {
  if (spec.mandatoryOn?.includes(type)) return "mandatory";
  if (spec.forbiddenOn?.includes(type)) return "forbidden";
  if (spec.undefinedOn?.includes(type)) return "undefined";
  return "optional";
};

/** 出典リンク。基底 ＋ 見出しの id。 */
export const warc11Url = (anchor: string): string => `${WARC11_SPEC_BASE}#${anchor}`;
