/**
 * WARC の記録ごとに出る issue の件数を丸める。
 *
 * engine に issue の上限は無く、記録ごとに 1 件ずつ出す rule は、1 万記録の本で全記録に同じ欠陥が
 * あれば 1 万件を出す。読む人にも JSON を受け取る側にも多すぎるので、WARC 1.1 の rule は
 * **同じ本（entry）・同じ messageKey** の issue を {@link ISSUES_PER_MESSAGE} 件まで出し、最後の 1 件の
 * `params.more` に、出さなかった残りの件数を載せる。JSON の renderer が、`more` を持つ issue の
 * message の後ろに「同じ本にほか N 件」を付ける（`report.more`）。
 *
 * messageKey と severity は変えないので、profile ごとの severity の上書き（messageKey 単位）は
 * そのまま効く。`summary` の件数は、出した issue の数になる。
 */
import type { Issue } from "./domain.js";

/** 同じ本・同じ message で出す件数。最後の 1 件が残りの件数を運ぶ。 */
export const ISSUES_PER_MESSAGE = 4;

interface Bucket {
  kept: Issue[];
  count: number;
}

export class WarcIssueBucket {
  private readonly buckets = new Map<string, Bucket>();

  push(issue: Issue): void {
    const key = `${issue.location?.entry ?? ""}\u0000${issue.messageKey}`;
    const bucket = this.buckets.get(key) ?? { kept: [], count: 0 };
    bucket.count += 1;
    if (bucket.kept.length < ISSUES_PER_MESSAGE) bucket.kept.push(issue);
    this.buckets.set(key, bucket);
  }

  /** 丸めた issue の列。並びは、鍵（本・message）が最初に現れた順、その中は push した順。 */
  drain(): Issue[] {
    const out: Issue[] = [];
    for (const { kept, count } of this.buckets.values()) {
      const more = count - kept.length;
      kept.forEach((issue, i) => {
        out.push(i === kept.length - 1 && more > 0 ? { ...issue, params: { ...issue.params, more } } : issue);
      });
    }
    this.buckets.clear();
    return out;
  }
}
