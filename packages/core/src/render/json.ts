/**
 * JSON renderer。
 *
 * engine が生成する `Report` を出力する。各 issue は locale-neutral な
 * `messageKey` + `params` を持つので、ここで選択 locale に解決した
 * `message` を併せて同梱する(機械可読な key と人間可読な message の両方)。
 *
 * 安定したシリアライゼーション: 2 スペースインデント。engine は rule 登録順で
 * issue を出力し、`--lang` を固定すれば message も決定的なので、snapshot は
 * バイト単位で再現可能。
 */
import { t, type Locale } from "../i18n/translate.js";
import { conformanceForRule, docsForRule } from "../validate/rules/index.js";
import { specUrl } from "../validate/spec-sections.js";
import type { Report } from "../validate/domain.js";

export const renderJson = (report: Report, locale: Locale): string => {
  const issues = report.issues.map((issue) => {
    const url = specUrl(issue.params?.["section"]);
    // rule が宣言する spec 規範レベル(MUST/SHOULD/MAY)。severity とは独立。
    const conformance = conformanceForRule(issue.rule);
    // rule の出典(公式ドキュメント)リンク群。conformance と同じく rule 名で解決。
    // URL は locale ごとに持てるので、message と同じタイミングでここで 1 本に
    // 畳む。翻訳が無い spec は `en` に落ちる(型で `en` を必須にしてある)。
    const docs = docsForRule(issue.rule)?.map((d) => ({
      label: d.label,
      url: d.url[locale] ?? d.url.en,
    }));
    // 同じ本の同じ指摘を丸めた issue（`WarcIssueBucket`）は、出さなかった件数を `params.more` に持つ。
    // message の文はどの rule でも同じなので、rule ごとの文ではなくここで 1 度だけ付ける。
    const more = issue.params?.["more"];
    const message = t(issue.messageKey, issue.params ?? {}, locale);
    return {
      ...issue,
      message: typeof more === "number" && more > 0 ? t("report.more", { message, more }, locale) : message,
      // params.section が表で解決できたときだけ spec への直リンクを同梱。
      ...(url !== undefined && { specUrl: url }),
      ...(docs !== undefined && { docs }),
      ...(conformance !== undefined && { conformance }),
    };
  });
  return `${JSON.stringify({ ...report, issues }, null, 2)}\n`;
};
