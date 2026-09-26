/**
 * Rule: warc/recording-complete(info / warning · browserhive profile 限定)
 *
 * 一部の producer(browserhive)は、失敗した / 途中で打ち切った HTTP 取得を
 * 通常の `response` レコードではなく `WARC-Type: metadata` レコードとして
 * 記録する。body は `application/warc-fields`(`incomplete: true` /
 * `reason: loadingFailed` / `truncated: ...` / `action: ...` の key:value 行)。本ルールは
 * その metadata を数え、`response` を分母にした「未完了比率」を可視化する
 * (info、比率が高ければ warning)。`details.recording` に内訳とサンプル URL を
 * 載せ、TUI の Recording health パネルが描画する。
 *
 * **方針で省いたもの (blocked) は未完了に数えない。** `deny`・`no-archive` の要求と、
 * `url-policy`・`content-type` で省いた本文は、要求者が頼んだ省略で、記録の欠けではない。
 * 以前は数えていて、`deny` しか当たらない archive にも「未完了」の warning が出ていた。
 * 内訳 (`byReason.blocked`) とサンプルには残すので、何を省いたかは見えるまま。
 *
 * 規格との関係: この metadata 慣習は WARC/WACZ の規格そのものではなく
 * browserhive 固有。よって `applicability.excludeProfiles` で
 * `spec` / `lenient` を除外し、`--profile browserhive` のときだけ走る。
 * 未完了レコードは「実際に起きた HTTP の正しい記録」で spec 違反ではない
 * ため、severity は info/warning(error にしない)。
 */
import { ok } from "../../result.js";
import { getHeader, parseWarcRecord } from "../../wacz/warc-header.js";
import { iterateWarcMembers } from "../../wacz/warc-iter.js";
import type { Issue, ValidationRule } from "../domain.js";

const WARC_ENTRY = "archive/data.warc.gz";
/** 未完了比率がこれを超えたら info から warning に上げる。 */
const WARN_RATIO = 0.1;

type Reason = "failed" | "incomplete" | "truncated" | "blocked";

/** `application/warc-fields` body を key:value に。継続行は折り畳まない。 */
const parseWarcFields = (body: Buffer): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of body.toString("utf-8").split("\n")) {
    const sep = line.indexOf(": ");
    if (sep > 0) out[line.slice(0, sep).trim()] = line.slice(sep + 2).trim();
  }
  return out;
};

/**
 * metadata の fields から未完了の種別を判定する。
 *
 * 本文を省いた理由は `truncated` の欄に入る (browserhive の `buildMetadataRecord` が最初から
 * そう書いている)。以前ここは `skipBodyReason` を読んでいて、browserhive が一度も書いたことの
 * 無い欄だったので、切り詰めも方針の省略もすべて "incomplete" に落ちていた —— fixture に
 * 理由付きの記録が無く、気づかれなかった。
 *
 * - `truncated` が `too-large` / `task-cap`: 上限で落とした本文 ("truncated")
 * - `truncated` が `content-type` / `url-policy`: 方針で省いた本文 ("blocked")
 * - `action` が `deny` / `no-archive`: 方針で記録しなかった要求 ("blocked")
 * - `reason: loadingFailed`: 失敗 ("failed")。残りは未完了 ("incomplete")
 */
const classify = (f: Record<string, string>): Reason => {
  const truncated = f["truncated"];
  if (truncated === "too-large" || truncated === "task-cap") return "truncated";
  if (truncated === "content-type" || truncated === "url-policy") return "blocked";
  if (f["action"] === "deny" || f["action"] === "no-archive") return "blocked";
  if (f["reason"] === "loadingFailed") return "failed";
  return "incomplete"; // reason: "stop-while-pending" 等(stop 時の in-flight ドレイン)
};

export const warcRecordingCompleteRule: ValidationRule = {
  name: "warc/recording-complete",
  descriptionKey: "warc/recording-complete.desc",
  conformance: "MAY",
  docs: [
      {
        label: "WARC 1.1 metadata record",
        url: {
          en: "https://iipc.github.io/warc-specifications/specifications/warc-format/warc-1.1/",
        },
      },
  ],
  // 規格外の producer 指標。browserhive profile のときだけ走る。
  applicability: {
    excludeProfiles: ["spec", "lenient"],
    // 下の classify() が読む `truncated` の "too-large" / "task-cap" は
    // browserhive v1.11.0 (PR #281 / #282) で入った値。metadata 慣習そのもの
    // は v1.4.0 からあるが、それ未満の archive にこの分類を当てると、
    // 切り詰められた応答を "incomplete" に丸めて数字が静かに嘘になる。
    // 誤った内訳を出すくらいなら走らせない — 落としたことは Report.skipped
    // に残るので、読者は「問題なし」と「見ていない」を区別できる。
    profileVersions: { browserhive: ">=1.11.0" },
  },

  run: async (wacz) => {
    const buf = await wacz.readEntry(WARC_ENTRY);
    if (!buf) return ok([]); // WARC 不在は resource-hashes / required-files が cover。

    let responses = 0;
    const byReason: Record<Reason, number> = { failed: 0, incomplete: 0, truncated: 0, blocked: 0 };
    // 案3 で metadata に追加された `resourceType` / `blockedReason` 内訳。
    // 旧 producer のレコードには無いので空のまま残る(欠落 ≠ 0 件の種別)。
    const byResourceType: Record<string, number> = {};
    const byBlockedReason: Record<string, number> = {};
    const samples: { url: string; reason: Reason; resourceType?: string }[] = [];

    for (const member of iterateWarcMembers(buf, { loose: true })) {
      const record = parseWarcRecord(member.raw);
      if (!record) continue;
      const type = (getHeader(record, "WARC-Type") ?? "").toLowerCase();
      if (type === "response") {
        responses += 1;
        continue;
      }
      if (type !== "metadata") continue;
      const fields = parseWarcFields(record.body);
      const reason = classify(fields);
      byReason[reason] += 1;
      const rt = fields["resourceType"];
      if (rt) byResourceType[rt] = (byResourceType[rt] ?? 0) + 1;
      const br = fields["blockedReason"];
      if (br) byBlockedReason[br] = (byBlockedReason[br] ?? 0) + 1;
      if (samples.length < 10) {
        samples.push({
          url: getHeader(record, "WARC-Target-URI") ?? "?",
          reason,
          ...(rt ? { resourceType: rt } : {}),
        });
      }
    }

    // blocked は数えない (上の説明)。内訳には残す。
    const incomplete = byReason.failed + byReason.incomplete + byReason.truncated;
    if (incomplete === 0) return ok([]);

    const ratio = incomplete / (responses + incomplete);
    const percent = Math.round(ratio * 100);
    const issues: Issue[] = [
      {
        rule: "warc/recording-complete",
        severity: ratio > WARN_RATIO ? "warning" : "info",
        messageKey: "warc/recording-complete.incomplete",
        params: { incomplete, total: responses + incomplete, percent },
        location: { entry: WARC_ENTRY },
        details: {
          recording: { responses, incomplete, percent, byReason, byResourceType, byBlockedReason, samples },
        },
      },
    ];
    return ok(issues);
  },
};
