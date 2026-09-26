/**
 * Rule: browserhive/document-withheld (error · browserhive profile 限定 · >=13.0.0)
 *
 * ページから作った記録 (`pages.jsonl` の文字と題、アクセシビリティツリー) を、それを読んだ文書の
 * 扱いで決めているか。profile 1.11.0 の `browserhive:capture.document` に照らす。
 *
 * **3 つは WARC の本文ではなく描画されたページから読む**ので、方針が文書の本文を archive に
 * 入れなくても、それだけでは文字は archive から消えない。profile はそれを `document` の節で
 * 縛る。見るのは 3 つ:
 *
 * ① `withheld` が、`document.url` に方針を照らし直した答えと一致すること (両向き)。URL の方針が
 *    最初に当たったものが `no-body` なら `"url-policy"`、`no-archive` なら `"no-archive"`、`deny`
 *    なら `"deny"`、どの URL の方針にも当たらず、文書の記録の MIME に content-type の方針が当たれば
 *    `"content-type"`。リダイレクトの中継や、遷移で去った文書にだけ当たった方針は、何も伏せない。
 *
 * ② `withheld` があれば、ページ行に `text` も `title` も無く、`accessibility/axtree.jsonl` も
 *    無いこと。ページ行が `textWithheld` を持つなら、値は `withheld` と等しいこと。
 *
 * ③ `withheld` が無ければ、ツリーの各行の `url` が `document.url` と等しいこと —— 要求の URL
 *    ではなく、読んだ文書を名乗る。
 *
 * 加えて、`document.url` が索引にも `no-archive`・`deny` の記録にも無ければ warning にする。身元が
 * archive の中を指していない —— 読んだ文書の要求が記録されていない。
 *
 * **`deny` の扱いは、archive が名乗る profile の版 (`conformsTo`) で分ける。** 1.11.0 から、
 * `deny` の当たった文書は要求されず、`withheld: "deny"` で伏せる。1.10.0 には `deny` の理由が無く、
 * そのころの BrowserHive (v13.0.0〜v17.0.0) は主文書への `deny` で要求を止められずにページを
 * 読んでいた。1.10.0 の archive では `deny` は何も伏せず、`deny` の記録も身元の在り処にならない ——
 * 身元が archive に無いという warning が、その漏れを言う。`conformsTo` が無いか読めなければ、
 * いまの版 (1.11.0) の決まりで照らす。呼び手が名乗る producer の版 (`--profile browserhive@x.y.z`)
 * ではなく archive 自身の宣言で分けるのは、同じ rule の中で決まりが変わるため —— 版を名乗らない
 * 実行でも、古い archive を新しい決まりで落とさない。
 *
 * **`datapackage.json` の `title` は見ない。** profile は「ページから読んではならない」と言う
 * だけで、何を書くかは定めていない。伏せた題を archive は持っていないので、読んだものかどうかを
 * 照らしようがない。
 *
 * **`document` の無い archive は見ない。** profile 1.10.0 より前の archive には身元が無く、
 * 照らしようがない。版を渡さずに走らせたとき、古い archive を一斉に落とさないためでもある。
 *
 * Spec: https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.11.0/#document
 */
import { ok } from "../../result.js";
import { getHeader, parseWarcRecord } from "../../wacz/warc-header.js";
import { iterateWarcMembers } from "../../wacz/warc-iter.js";
import { parsePagesJsonl } from "../../wacz/pages.js";
import type { WaczReader } from "../../wacz/reader.js";
import { AXTREE_ENTRY, readAxtree } from "../browserhive-axtree.js";
import {
  contentTypePolicyFor,
  firstUrlPolicy,
  mimesByUrl,
  policiesOf,
  type Policies,
} from "../browserhive-policies.js";
import { isRecord, readCapture } from "../browserhive-storage.js";
import type { Issue, ValidationRule } from "../domain.js";

const RULE = "browserhive/document-withheld";
const DATAPACKAGE = "datapackage.json";
const PAGES_ENTRY = "pages/pages.jsonl";
const WARC_ENTRY = "archive/data.warc.gz";

/** 方針の名を持つ理由 (profile 1.10.0)。どれも `document.url` から照らし直せる。 */
const POLICY_REASONS_1_10: ReadonlySet<string> = new Set(["url-policy", "content-type", "no-archive"]);
/** profile 1.11.0 から、要求しなかった文書を名乗る `deny` が加わる。 */
const POLICY_REASONS_1_11: ReadonlySet<string> = new Set([...POLICY_REASONS_1_10, "deny"]);
/** 読んだ文書を言えないときの理由。照らし直すものが無い。 */
const UNATTRIBUTED = "unattributed";

/** `conformsTo` の URL から読む profile の版。`/wacz-profile/1.11.0/` の形。 */
const CONFORMS_TO_VERSION = /\/wacz-profile\/(\d+)\.(\d+)\.(\d+)\//;

/**
 * archive が `deny` を伏せる理由として扱う版 (profile 1.11.0 以降) を名乗るか。名乗りが無いか
 * 読めなければ、いまの版の決まりで照らす。
 */
const denyWithholds = (conformsTo: unknown): boolean => {
  if (typeof conformsTo !== "string") return true;
  const match = CONFORMS_TO_VERSION.exec(conformsTo);
  if (match === null) return true;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > 1 || (major === 1 && minor >= 11);
};

/** 型の名前。落ちたときに何が在ったかを言うため。 */
const typeName = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

/**
 * 方針だけから決まる、文書の扱い。`document.url` と、その URL の記録の MIME から。
 *
 * `deny` が最初に当たった文書は要求されない。profile 1.11.0 からは `"deny"` で伏せ、1.10.0 では
 * 何も伏せない (上の説明)。記録の無い文書 (`no-archive`・`deny`) には MIME が無いので、
 * content-type の方針は照らしようがない。
 */
const expectedFor = (
  url: string,
  mimes: readonly string[],
  policies: Policies,
  denyIsReason: boolean,
): "url-policy" | "content-type" | "no-archive" | "deny" | undefined => {
  const first = firstUrlPolicy(url, policies);
  if (first?.action === "no-body") return "url-policy";
  if (first?.action === "no-archive") return "no-archive";
  if (first?.action === "deny") return denyIsReason ? "deny" : undefined;
  if (first !== undefined) return undefined;
  return contentTypePolicyFor(mimes, policies) !== undefined ? "content-type" : undefined;
};

/**
 * WARC の metadata のうち、`actions` のどれかを名乗る記録が指す URL。BrowserHive は記録しなかった
 * 要求 (`no-archive`) と送らなかった要求 (`deny`) をこの形で残す。
 */
const withheldRequestUrls = async (wacz: WaczReader, actions: ReadonlySet<string>): Promise<Set<string>> => {
  const urls = new Set<string>();
  const buf = await wacz.readEntry(WARC_ENTRY);
  if (buf === undefined) return urls;
  for (const member of iterateWarcMembers(buf, { loose: true })) {
    const record = parseWarcRecord(member.raw);
    if (record === null || (getHeader(record, "WARC-Type") ?? "").toLowerCase() !== "metadata") continue;
    const action = record.body
      .toString("utf-8")
      .split("\n")
      .map((line) => line.trim())
      .some((line) => line.startsWith("action: ") && actions.has(line.slice("action: ".length)));
    const url = getHeader(record, "WARC-Target-URI");
    if (action && url !== undefined) urls.add(url);
  }
  return urls;
};

export const browserhiveDocumentWithheldRule: ValidationRule = {
  name: "browserhive/document-withheld",
  descriptionKey: `${RULE}.desc`,
  conformance: "MUST",
  docs: [
    {
      label: "BrowserHive WACZ Profile §document",
      url: {
        en: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.11.0/#document",
        ja: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.11.0/ja/#document",
      },
    },
  ],
  applicability: {
    excludeProfiles: ["spec", "lenient"],
    profileVersions: { browserhive: ">=13.0.0" },
  },
  run: async (wacz) => {
    const capture = await readCapture(wacz);
    if (capture === undefined) return ok([]);
    const document = capture["document"];
    if (document === undefined) return ok([]);

    const issue = (
      messageKey: string,
      params: Record<string, string>,
      entry: string,
      severity: "error" | "warning" = "error",
    ): Issue => ({
      rule: RULE,
      severity,
      messageKey: `${RULE}.${messageKey}`,
      ...(Object.keys(params).length > 0 && { params }),
      location: { entry },
    });

    if (!isRecord(document)) {
      return ok([issue("not-object", { found: typeName(document) }, DATAPACKAGE)]);
    }

    const issues: Issue[] = [];
    const denyIsReason = denyWithholds(capture["conformsTo"]);
    const policyReasons = denyIsReason ? POLICY_REASONS_1_11 : POLICY_REASONS_1_10;
    const withheld = document["withheld"];
    const url = typeof document["url"] === "string" ? document["url"] : undefined;
    const declared = typeof withheld === "string" ? withheld : undefined;

    if (withheld !== undefined && (declared === undefined || (!policyReasons.has(declared) && declared !== UNATTRIBUTED))) {
      issues.push(issue("unknown-reason", { found: declared ?? typeName(withheld) }, DATAPACKAGE));
    }

    // ① 方針に照らし直す。読んだ文書を言えないなら、照らすものが無い。
    if (declared !== UNATTRIBUTED) {
      if (url === undefined) {
        issues.push(issue("missing-url", {}, DATAPACKAGE));
      } else {
        const mimes = await mimesByUrl(wacz);
        const settings = capture["settings"];
        // 方針が読めなければ照らさない。settings の不在や形は別の rule が言う。
        const knownReason = withheld === undefined || (declared !== undefined && policyReasons.has(declared));
        if (isRecord(settings) && knownReason) {
          const expected = expectedFor(url, mimes.get(url) ?? [], policiesOf(settings), denyIsReason);
          if (declared === undefined && expected !== undefined) {
            issues.push(issue("should-withhold", { url, expected }, DATAPACKAGE));
          } else if (declared !== undefined && expected === undefined) {
            issues.push(issue("should-not-withhold", { url, declared }, DATAPACKAGE));
          } else if (declared !== undefined && expected !== undefined && declared !== expected) {
            issues.push(issue("wrong-reason", { url, declared, expected }, DATAPACKAGE));
          }
        }
        // 身元は archive の中を指す。索引に無ければ、no-archive (1.11.0 からは deny も) の記録を探す
        // (WARC を読むのはこのときだけ)。
        const recordedAs: ReadonlySet<string> = new Set(denyIsReason ? ["no-archive", "deny"] : ["no-archive"]);
        if (!mimes.has(url) && !(await withheldRequestUrls(wacz, recordedAs)).has(url)) {
          issues.push(issue("not-in-archive", { url }, DATAPACKAGE, "warning"));
        }
      }
    }

    const pagesBuf = await wacz.readEntry(PAGES_ENTRY);
    const pages = pagesBuf === undefined ? [] : parsePagesJsonl(pagesBuf.toString("utf-8")).entries;
    const tree = await readAxtree(wacz);

    if (withheld !== undefined) {
      // ② 伏せたなら、ページから作ったものは無い。
      const reason = declared ?? typeName(withheld);
      for (const page of pages) {
        if (page["text"] !== undefined) issues.push(issue("text-present", { withheld: reason }, PAGES_ENTRY));
        if (page.title !== undefined) issues.push(issue("title-present", { withheld: reason }, PAGES_ENTRY));
        const textWithheld = page["textWithheld"];
        if (textWithheld !== undefined && textWithheld !== withheld) {
          issues.push(
            issue(
              "text-withheld-mismatch",
              { textWithheld: typeof textWithheld === "string" ? textWithheld : typeName(textWithheld), withheld: reason },
              PAGES_ENTRY,
            ),
          );
        }
      }
      if (tree !== null) issues.push(issue("axtree-present", { withheld: reason }, AXTREE_ENTRY));
    } else {
      // ③ 伏せていないなら、理由は無く、ツリーは読んだ文書を名乗る。
      for (const page of pages) {
        const textWithheld = page["textWithheld"];
        if (textWithheld !== undefined) {
          issues.push(
            issue(
              "text-withheld-unexpected",
              { textWithheld: typeof textWithheld === "string" ? textWithheld : typeName(textWithheld) },
              PAGES_ENTRY,
            ),
          );
        }
      }
      if (tree !== null && url !== undefined) {
        for (const { lineNumber, parsed } of tree) {
          // 読めない行や url の無い行は browserhive/axtree-shape が言う。
          const treeUrl = parsed?.["url"];
          if (typeof treeUrl === "string" && treeUrl !== url) {
            issues.push(issue("tree-url", { line: String(lineNumber), treeUrl, url }, AXTREE_ENTRY));
          }
        }
      }
    }
    return ok(issues);
  },
};
