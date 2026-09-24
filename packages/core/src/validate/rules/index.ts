/**
 * Rule registry — engine が実行時に参照する唯一のリスト。
 *
 * 新しい rule を追加する = 専用ファイルから export して、`DEFAULT_RULES`
 * に append する。wacz-validator 内の他の層は新しい rule を知る必要が無い。
 * CLI の将来の `--rule` filter は `ValidationRule.name` で識別する。
 *
 * 順序は cosmetic な理由でしか効かない: renderer は rule が生成した
 * 順に issue を辿るので、意味的にまとまった rule (datapackage/*、
 * cdxj/*、warc/*) を並べておくと読みやすい。
 */
import type { Conformance, DocLink, ValidationRule } from "../domain.js";
import { browserhiveTlsChainRule } from "./browserhive-tls-chain.js";
import { browserhiveAxtreeShapeRule } from "./browserhive-axtree-shape.js";
import { browserhiveUrlPoliciesRule } from "./browserhive-url-policies.js";
import { browserhivePolicyNotTruncatedRule } from "./browserhive-policy-not-truncated.js";
import { browserhiveBehaviorsShapeRule } from "./browserhive-behaviors-shape.js";
import { browserhiveDismissalShapeRule } from "./browserhive-dismissal-shape.js";
import { browserhiveSettingsShapeRule } from "./browserhive-settings-shape.js";
import { browserhiveSettleDeadlineRule } from "./browserhive-settle-deadline.js";
import { browserhiveSettleShapeRule } from "./browserhive-settle-shape.js";
import { browserhiveStorageInventoryRule } from "./browserhive-storage-inventory.js";
import { browserhiveStorageShapeRule } from "./browserhive-storage-shape.js";
import { browserhiveTlsSanRule } from "./browserhive-tls-san.js";
import { cdxjFilenameRule } from "./cdxj-filename.js";
import { cdxjIndexRecognisedRule } from "./cdxj-index-recognised.js";
import { cdxjIndexValidDataRule } from "./cdxj-index-valid-data.js";
import { cdxjNonGzippedRule } from "./cdxj-non-gzipped.js";
import { cdxjPagesMainpageRule } from "./cdxj-pages-mainpage.js";
import { cdxjWarcOffsetsRule } from "./cdxj-warc-offsets.js";
import { datapackageDigestRule } from "./datapackage-digest.js";
import { datapackageFrictionlessSchemaRule } from "./datapackage-frictionless-schema.js";
import { datapackageFrictionlessStructureRule } from "./datapackage-frictionless-structure.js";
import { datapackageHashesRule } from "./datapackage-hashes.js";
import { datapackageProfileRule } from "./datapackage-profile.js";
import { datapackageResourcesCompleteRule } from "./datapackage-resources-complete.js";
import { datapackageWaczVersionRule } from "./datapackage-wacz-version.js";
import { pagesPageSchemaRule } from "./pages-page-schema.js";
import { waczAuthSignatureRule } from "./wacz-auth-signature.js";
import { waczRequiredFilesRule } from "./wacz-required-files.js";
import { waczReservedDirsCleanRule } from "./wacz-reserved-dirs-clean.js";
import { warcExtensionRule } from "./warc-extension.js";
import { warcMembersIndependentRule } from "./warc-members-independent.js";
import { warcPayloadDigestRule } from "./warc-payload-digest.js";
import { warcRecordingCompleteRule } from "./warc-recording-complete.js";
import { warcStorageStoreRule } from "./warc-storage-store.js";

/**
 * 完全な validation セット。datapackage 系と cdxj の構造 check を
 * 先頭に置くことで、最も可能性の高い producer バグが report の上の方に
 * 上がる。cross-layer rule や WARC 内部 rule はその後に続く。
 *
 * library consumer が subset を渡したいときは `runValidation({ rules })`
 * に独自配列を渡せる — engine は `readonly ValidationRule[]` を受け
 * るので、ここからの cherry-pick で柔軟に組める。
 */
export const DEFAULT_RULES: readonly ValidationRule[] = [
  // §5.2 の構造的な MUST 欠落を最上段で。ファイルが欠けていれば他の
  // rule の指摘は二次的なので、最初に「そもそも揃っているか」を出す。
  waczAuthSignatureRule,
  waczRequiredFilesRule,
  // 予約ディレクトリ(archive/indexes/pages)に異物が無いか(MUST NOT)。
  waczReservedDirsCleanRule,
  datapackageProfileRule,
  datapackageWaczVersionRule,
  datapackageHashesRule,
  // 補助: 汎用 descriptor の整形式を公式 Frictionless スキーマで検証 (warning)。
  datapackageFrictionlessSchemaRule,
  // Frictionless の構造 MUST (resources 必須・各 resource に name と path|data) を error で。
  datapackageFrictionlessStructureRule,
  // §5.2.5 digest(SHOULD)+ 全ファイルが resources に列挙されているか(MUST)。
  datapackageDigestRule,
  datapackageResourcesCompleteRule,
  // §5.2.3 pages.jsonl の各 page 行が url/ts を持つか(MUST)。
  pagesPageSchemaRule,
  // cdxj/index-recognised-by-wabac は他の cdxj/* rule より先に来る。
  // 「index が全く無い」状態を最優先で出して、index を読む派生 rule
  // の二次的な不満より前に置きたいため。
  cdxjIndexRecognisedRule,
  // 「index は存在し認識される」の次に「その中身が CDXJ として妥当か」
  // (§5.2.2 MUST contain CDXJ data)。中身がゴミなら以降の filename /
  // offset / mainpage check は前提を欠くので、cdxj 群の早い段で出す。
  cdxjIndexValidDataRule,
  cdxjNonGzippedRule,
  cdxjFilenameRule,
  // §5.2.1 WARC の拡張子と中身の gzip 状態の整合。
  warcExtensionRule,
  warcStorageStoreRule,
  warcMembersIndependentRule,
  cdxjWarcOffsetsRule,
  cdxjPagesMainpageRule,
  warcPayloadDigestRule,
  // browserhive profile 限定: WARC の metadata レコード(未完了/失敗)の比率を
  // 可視化する。spec/lenient では excludeProfiles で除外される。
  warcRecordingCompleteRule,
  // browserhive profile 限定: tls member の証明書チェーンを、パッケージの中だけで
  // 検証する。ルートストアは見ない —— 検査する側の環境と時刻で答えが変わるため。
  browserhiveTlsChainRule,
  // 同上。記録された san を、同じパッケージに入っている証明書と突き合わせる。
  // san は browserhive 3.7.0 で入ったので版の条件を持つ。
  browserhiveAxtreeShapeRule,
  browserhiveBehaviorsShapeRule,
  browserhiveDismissalShapeRule,
  browserhiveSettingsShapeRule,
  // 読み込み後の待ちの終わり方。形は MUST、期限に当たったことは warning で見せる。
  browserhiveSettleShapeRule,
  browserhiveSettleDeadlineRule,
  browserhiveUrlPoliciesRule,
  // 方針で省いた本文が、上限で落とした本文として完全性に載っていないか (profile 1.9.0 の MUST NOT)。
  browserhivePolicyNotTruncatedRule,
  browserhiveStorageInventoryRule,
  browserhiveStorageShapeRule,
  browserhiveTlsSanRule,
];

/**
 * rule 名 → spec の規範レベル(RFC 2119)の対応。`DEFAULT_RULES` の宣言から
 * 導出するので二重管理は無い。renderer が issue.rule から表示用に引く
 * (`spec-sections.ts` の `specUrl` と対称な、render 時解決のパターン)。
 */
const RULE_CONFORMANCE = new Map<string, Conformance>(
  DEFAULT_RULES.map((rule) => [rule.name, rule.conformance]),
);

/** rule 名から spec 規範レベルを引く。未知の rule 名は `undefined`(badge を出さない)。 */
export const conformanceForRule = (rule: string): Conformance | undefined =>
  RULE_CONFORMANCE.get(rule);

/**
 * rule 名 → 出典リンクの対応。`RULE_CONFORMANCE` と同じく `DEFAULT_RULES` の
 * 宣言から導出する — 以前は rule-docs.ts という別表に持っていたが、rule を
 * 書く人が「出典も書く」と気づける場所ではなかった。
 */
const RULE_DOCS = new Map<string, readonly DocLink[]>(
  DEFAULT_RULES.map((rule) => [rule.name, rule.docs]),
);

/** rule 名から出典リンク群を引く。未知の rule 名は `undefined`(リンクを出さない)。 */
export const docsForRule = (rule: string): readonly DocLink[] | undefined =>
  RULE_DOCS.get(rule);

/** Re-export for tests / library consumers that want to compose their own list. */
export {
  cdxjFilenameRule,
  cdxjIndexRecognisedRule,
  cdxjIndexValidDataRule,
  cdxjNonGzippedRule,
  cdxjPagesMainpageRule,
  cdxjWarcOffsetsRule,
  datapackageDigestRule,
  datapackageFrictionlessSchemaRule,
  datapackageFrictionlessStructureRule,
  datapackageHashesRule,
  datapackageProfileRule,
  datapackageResourcesCompleteRule,
  datapackageWaczVersionRule,
  pagesPageSchemaRule,
  waczAuthSignatureRule,
  waczRequiredFilesRule,
  waczReservedDirsCleanRule,
  warcExtensionRule,
  warcMembersIndependentRule,
  warcPayloadDigestRule,
  warcRecordingCompleteRule,
  warcStorageStoreRule,
};
