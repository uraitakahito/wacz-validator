/**
 * Rule: browserhive/tls-chain(browserhive profile 限定)
 *
 * `browserhive:capture.tls` が持つ証明書チェーンを、**パッケージの中だけで**
 * 検証する。確かめるのは 4 つ:
 *
 *   1. `chainRef` の指す先が `chains` に在る(宙ぶらりんの参照を弾く)
 *   2. リーフが先頭に並んでいる(BrowserHive WACZ Profile の MUST)
 *   3. 隣り合う証明書が実際に繋がっている(発行者 = 次の subject)
 *   4. その繋がりが署名で裏付けられている
 *
 * ルート証明書は見ない。ルートストアは**検査する側のもの**で、時とともに変わる
 * ——「今日通るアーカイブが来年落ちる」判定は、アーカイブについての事実ではない。
 * ここが答えるのは「このパッケージが持っているものだけで辿れるか」。
 *
 * 版の条件を持たないのは、この 4 つが `san` の有無に依らないため。`san` を要る
 * 検査は `browserhive/tls-san` が別に持つ —— まとめると、`san` の入る前に撮られた
 * アーカイブでチェーン検証まで走らなくなる。
 *
 * Spec: https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.1.0/#tls
 */
import { ok } from "../../result.js";
import { displayDn, parseChain, readTls } from "../browserhive-tls.js";
import type { Issue, ValidationRule } from "../domain.js";

interface CertReport {
  subject: string;
  issuer: string;
  /** 次の証明書と繋がるか。末尾は相手が居ないので null。 */
  linkedToNext: boolean | null;
  /** 次の証明書の鍵で署名を検証できるか。末尾は null。 */
  signatureOk: boolean | null;
}

export const browserhiveTlsChainRule: ValidationRule = {
  name: "browserhive/tls-chain",
  descriptionKey: "browserhive/tls-chain.desc",
  conformance: "MUST",
  docs: [
    {
      label: "BrowserHive WACZ Profile §tls",
      url: {
        en: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.1.0/#tls",
        ja: "https://uraitakahito.github.io/browserhive-specs/wacz-profile/1.1.0/ja/#tls",
      },
    },
  ],
  applicability: {
    // 規格外の producer 指標。browserhive profile のときだけ走る。
    excludeProfiles: ["spec", "lenient"],
  },

  run: async (wacz) => {
    const tls = await readTls(wacz);
    // tls は WACZ Profile の任意 member。不在は違反ではない。
    if (tls === undefined) return ok([]);

    const issues: Issue[] = [];
    const verified: Record<string, CertReport[]> = {};

    for (const [host, observed] of Object.entries(tls.hosts)) {
      // null は「HTTPS で到達したが何も明かさなかった」。チェーンは元から無い。
      if (observed === null) continue;
      const ref = observed.chainRef;
      if (typeof ref !== "string") continue; // 取得できなかった。tls-chain の管轄外。

      const chain = tls.chains[ref];
      if (chain === undefined) {
        issues.push({
          rule: "browserhive/tls-chain",
          severity: "error",
          messageKey: "browserhive/tls-chain.dangling-ref",
          params: { host, chainRef: ref },
        });
        continue;
      }

      const certs = parseChain(chain);
      if (certs === null) {
        issues.push({
          rule: "browserhive/tls-chain",
          severity: "error",
          messageKey: "browserhive/tls-chain.unparseable",
          params: { host, chainRef: ref },
        });
        continue;
      }

      // リーフが先頭か。leaf は自分が名乗る host を覆っているはずで、覆っていない
      // なら並びが違うか、そもそも別の証明書。
      if (certs[0]?.checkHost(host) === undefined) {
        issues.push({
          rule: "browserhive/tls-chain",
          severity: "error",
          messageKey: "browserhive/tls-chain.leaf-not-first",
          params: { host, subject: displayDn(certs[0]?.subject ?? "") },
        });
      }

      const reports: CertReport[] = [];
      for (const [i, cert] of certs.entries()) {
        const next = certs[i + 1];
        if (next === undefined) {
          // 末尾。発行者はパッケージの外に居るので、ここでは何も言えない。
          reports.push({
            subject: displayDn(cert.subject),
            issuer: displayDn(cert.issuer),
            linkedToNext: null,
            signatureOk: null,
          });
          continue;
        }
        const linked = cert.checkIssued(next);
        // 繋がっていない相手の鍵で署名を検証しても意味が無いので、順に見る。
        const signed = linked ? cert.verify(next.publicKey) : false;
        reports.push({
          subject: displayDn(cert.subject),
          issuer: displayDn(cert.issuer),
          linkedToNext: linked,
          signatureOk: signed,
        });
        if (!linked) {
          issues.push({
            rule: "browserhive/tls-chain",
            severity: "error",
            messageKey: "browserhive/tls-chain.broken-link",
            params: { host, index: i, issuer: displayDn(cert.issuer), nextSubject: displayDn(next.subject) },
          });
        } else if (!signed) {
          issues.push({
            rule: "browserhive/tls-chain",
            severity: "error",
            messageKey: "browserhive/tls-chain.bad-signature",
            params: { host, index: i },
          });
        }
      }
      verified[host] = reports;
    }

    // 問題が無くても「何を確かめたか」を残す。出さないと、chain を 1 本も検証して
    // いないアーカイブと、全部通ったアーカイブが同じ見た目になる。
    const hosts = Object.keys(verified);
    if (hosts.length > 0) {
      issues.push({
        rule: "browserhive/tls-chain",
        severity: "info",
        messageKey: "browserhive/tls-chain.verified",
        params: { hosts: hosts.length },
        details: { chain: { hosts: verified } },
      });
    }

    return ok(issues);
  },
};
