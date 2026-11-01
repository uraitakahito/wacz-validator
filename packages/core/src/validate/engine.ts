/**
 * Validation engine。
 *
 * 登録されている全 rule を与えられた WACZ に対して並列に走らせ、
 * 有効な profile の severity override を適用し、結果を 1 つの `Report`
 * に畳み込む。engine 自体は throw しない — rule の失敗は
 * `Result<Issue[], never>` として返る。
 *
 * 並列性: 各 rule は 1 〜 2 個の ZIP entry を読む。yauzl-promise は
 * 単一の ZipFile handle から並行 read stream を提供できるので、rule
 * を並列に走らせるのは安全であり、小さい WACZ では実時間も短くなる。
 * 将来 profiler ベースで予算を支配する rule を直列化することはあり
 * うる — 現状はシンプルな形が正しく速い。
 *
 * Profile dispatch (粒度が 2 つある):
 *   1. **rule 単位** — `excludeProfiles` に当たれば rule ごと実行しない
 *      (issue が 1 件も生まれない)。
 *   2. **issue 単位** — `severityByProfile[profile]` に messageKey として
 *      列挙された issue だけ severity を書き換える。列挙されていない issue
 *      は rule が push した severity のまま。
 *
 * 1 つの rule が状況に応じて別の severity を出すことがある (例:
 * `datapackage/digest` は不在なら `warning`、hash 不一致なら `error`)。
 * 列挙式なので、「lenient では不在だけ `info` に落とし、改変の疑いは
 * `error` のまま残す」が宣言だけで表現できる。
 *
 * 以前は profile ごとに severity を 1 つ書き、engine が「issue の severity
 * が rule のベースラインと一致するか」で対象を選んでいた。あれは作者の
 * 意図を値の一致で推測するもので、宣言を読んでも挙動が分からなかった。
 */
import {
  DEFAULT_PROFILE,
  DEFAULT_SELECTOR,
  formatSemVer,
  satisfies,
  type ProfileSelector,
} from "@wacz-validator/contract";
import type { Result } from "../result.js";
import { ok } from "../result.js";
import type { WaczReader } from "../wacz/reader.js";
import { buildEntries } from "./entries.js";
import { computeStats } from "./stats.js";
import { collectWarcinfo } from "../describe/warcinfo.js";
import type {
  Issue,
  Report,
  ReportSummary,
  RuleProfile,
  SkippedRule,
  ValidationRule,
} from "./domain.js";

export interface RunOptions {
  validatorVersion: string;
  rules: readonly ValidationRule[];
  /**
   * Profile selector。既定は `"spec"`(バージョンなし)。
   *
   * バージョンを持たない selector は、バージョンに条件を持つ rule の条件を**見ない** —
   * つまり従来どおり全部走る。既定をそちらに置いているので、バージョンを書かない
   * 呼び出しの挙動は変わらない。
   */
  profile?: ProfileSelector;
}

// 定義の持ち主は @wacz-validator/contract (cf. domain.ts の ALL_PROFILES)。
export { DEFAULT_PROFILE };

export const runValidation = async (
  wacz: WaczReader,
  opts: RunOptions,
): Promise<Result<Report, never>> => {
  const startedAt = Date.now();
  const selector: ProfileSelector = opts.profile ?? DEFAULT_SELECTOR;
  const profile: RuleProfile = selector.name;

  const eligible = opts.rules.filter(
    (rule) => !rule.applicability?.excludeProfiles?.includes(profile),
  );
  // バージョンで落とす分は「除外」ではなく「見なかった」なので、記録して report
  // に出す。excludeProfiles との違いはそこ — あちらは profile の定義上
  // 最初から対象外で、報告すべき欠落ではない。
  const skipped: SkippedRule[] = [];
  const { version } = selector;
  const activeRules =
    version === undefined
      ? eligible
      : eligible.filter((rule) => {
          const range = rule.applicability?.profileVersions?.[profile];
          if (range === undefined) return true;
          // satisfies は解せない範囲式で throw する — 宣言の書き間違いが
          // 「範囲外」に化けて rule が静かに消えるより、ここで落ちるほうがよい。
          if (satisfies(version, range)) return true;
          skipped.push({
            rule: rule.name,
            reason: "profile-version",
            range,
          });
          return false;
        });

  const [perRule, stats, warcinfo] = await Promise.all([
    Promise.all(
      activeRules.map(async (rule) => {
        const result = await rule.run(wacz);
        // `Result<Issue[], never>` は ok 分岐しか取りえないが、strict
        // mode では narrowing check が必要。default 分岐は到達不能。
        if (!result.ok) return [];
        return applyProfile(result.value, rule, profile);
      }),
    ),
    computeStats(wacz),
    // 報告の warcinfo の欄。rule と同じ走査（reader ごとに 1 度）を使うので、本を読み直さない。
    collectWarcinfo(wacz),
  ]);

  // `Issue[][]`(rule ごとの箱)を 1 本の列に均す。空の箱は消え、1 つの rule が
  // 複数出したものは並んで入る。
  //
  // **並列に走らせているのに、この並びは実行ごとに変わらない。**
  // `Promise.all` が返すのは「終わった順」ではなく「**渡した配列の順**」で、
  // ここでは `activeRules` の順 = rule の登録順になる。見落としやすいが、
  // これに依存しているものが 2 つある:
  //   - JSON レポートが「構造的な check が先に来る」と約束している
  //     (rules/index.ts の並びがそのまま出力の並び)
  //   - CLI の snapshot テストは JSON 全体をバイト単位で比べている
  // 完了順に push する形へ書き換えると、両方が静かに壊れる。
  const issues = perRule.flat();
  const summary = summarise(issues, activeRules.length, Date.now() - startedAt);
  // ファイル一覧 + issue 紐付け(best-effort)。entryNames/getEntryMeta は
  // central directory 由来で payload を読まないので追加 I/O はほぼ無い。
  const entries = await buildEntries(wacz, issues);

  const report: Report = {
    validatorVersion: opts.validatorVersion,
    profile: {
      name: selector.name,
      // stats / skipped と同じ条件付き spread。バージョンなしなら key ごと出ない
      // ので、「バージョンを問わない」が JSON の形として表れる。
      ...(version !== undefined && { version: formatSemVer(version) }),
    },
    source: wacz.source,
    summary,
    issues,
    entries,
    // 条件付き spread にすることで `stats` を "明示的に undefined" で
    // はなく「不在」として表現できる — exactOptionalPropertyTypes が
    // これを要求する。
    ...(stats !== undefined && { stats }),
    // 同上。バージョンを指定しない実行では 1 件も入らないので key ごと出ず、
    // 従来の JSON と完全に一致する。
    ...(skipped.length > 0 && { skipped }),
    // stats と同じく、読めなかった・1 件も無いときは key ごと出ない。
    ...(warcinfo !== undefined && warcinfo.length > 0 && { warcinfo }),
  };
  return ok(report);
};

/**
 * rule が生成した各 issue に、現在 profile の severity override を適用する。
 *
 * 対象は `severityByProfile[profile]` に **messageKey として列挙された**
 * issue だけ。列挙されていない issue は rule が push した severity のまま
 * 通る。engine は何も推測しない。
 */
const applyProfile = (issues: Issue[], rule: ValidationRule, profile: RuleProfile): Issue[] => {
  const override = rule.applicability?.severityByProfile?.[profile];
  if (override === undefined) return issues;
  return issues.map((issue) => {
    const next = override[issue.messageKey];
    return next === undefined ? issue : { ...issue, severity: next };
  });
};

const summarise = (issues: Issue[], ruleCount: number, durationMs: number): ReportSummary => {
  let failed = 0;
  let warnings = 0;
  let info = 0;
  for (const issue of issues) {
    switch (issue.severity) {
      case "error":
        failed += 1;
        break;
      case "warning":
        warnings += 1;
        break;
      case "info":
        info += 1;
        break;
    }
  }
  // `passed` は issue 単位ではなく rule 単位のカウント: rule が
  // "passed" になるのは error severity の issue を 1 件も出さなかった
  // 場合のみ。warning / info しか出さない rule も headline では
  // passed としてカウントする — fail ではないから。
  const failedRuleNames = new Set(issues.filter((i) => i.severity === "error").map((i) => i.rule));
  const passed = ruleCount - failedRuleNames.size;

  return { passed, failed, warnings, info, durationMs };
};
