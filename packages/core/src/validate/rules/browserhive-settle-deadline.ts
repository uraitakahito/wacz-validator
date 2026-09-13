/**
 * Rule: browserhive/settle-deadline (warning · browserhive profile 限定 · >=10.3.0)
 *
 * 読み込み後の待ちが期限に当たったアーカイブで、**撮った時点でページは静まって
 * いなかった**と、どの合図が満ちなかったかを添えて言う。
 *
 * 違反ではない。profile 1.7.0 は `endedBy: "deadline"` を失敗ではないと明記しており、
 * パッケージはその時点までにページがなったものを正しく持っている。この rule は落とす
 * ためではなく、アーカイブを証拠として読む人に「まだ動いていたページ」を見せるために
 * 在る —— その事実はアーカイブの他のどこからも取り戻せない。
 *
 * 規範は無いので conformance は MAY で、severity は warning。形の誤り (null があるのに
 * quiet、など) は `browserhive/settle-shape` が error で言うので、ここでは形の読める
 * `deadline` だけを見る。
 *
 * Spec: https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.7.0/#settle
 */
import { ok } from "../../result.js";
import { isRecord, readCapture } from "../browserhive-storage.js";
import type { ValidationRule } from "../domain.js";
import { SETTLE_SIGNALS } from "./browserhive-settle-shape.js";

const RULE = "browserhive/settle-deadline";

export const browserhiveSettleDeadlineRule: ValidationRule = {
  name: "browserhive/settle-deadline",
  descriptionKey: `${RULE}.desc`,
  conformance: "MAY",
  docs: [
    {
      label: "BrowserHive WACZ Profile §settle",
      url: {
        en: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.7.0/#settle",
        ja: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.7.0/ja/#settle",
      },
    },
  ],
  applicability: {
    excludeProfiles: ["spec", "lenient"],
    profileVersions: { browserhive: ">=10.3.0" },
  },
  run: async (wacz) => {
    const capture = await readCapture(wacz);
    if (capture === undefined) return ok([]);
    const settle = capture["settle"];
    if (!isRecord(settle) || settle["endedBy"] !== "deadline") return ok([]);

    // 満ちなかった合図を名指しする。時刻が null のものだけ —— 形の崩れた合図は
    // settle-shape が言うので、ここでは数えない。
    const unsatisfied = SETTLE_SIGNALS.filter(({ signal, field }) => {
      const outcome = settle[signal];
      return isRecord(outcome) && outcome[field] === null;
    }).map(({ signal }) => signal);
    if (unsatisfied.length === 0) return ok([]);

    const limits = settle["limits"];
    const maxMs = isRecord(limits) && typeof limits["maxMs"] === "number" ? limits["maxMs"] : undefined;
    return ok([
      {
        rule: RULE,
        severity: "warning",
        messageKey: `${RULE}.still-changing`,
        params: {
          signals: unsatisfied.join(", "),
          waitedMs: typeof settle["waitedMs"] === "number" ? settle["waitedMs"] : "?",
          maxMs: maxMs ?? "?",
        },
      },
    ]);
  },
};
