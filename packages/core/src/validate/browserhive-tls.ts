/**
 * `browserhive:capture.tls` を読むための共有部分。
 *
 * 2 つの rule (`browserhive/tls-chain` / `browserhive/tls-san`) が同じ member を
 * 読むので、形の見分けと証明書の解析をここに集める。rule 側は「何を問題とするか」
 * だけを持つ。
 */
import { X509Certificate } from "node:crypto";
import { datapackageOf } from "./datapackage-source.js";
import type { WaczReader } from "../wacz/reader.js";

/** アーカイブが host ごとに申告している TLS の観測。 */
export interface ObservedTls {
  readonly subject?: unknown;
  readonly issuer?: unknown;
  readonly san?: unknown;
  readonly validFrom?: unknown;
  readonly validTo?: unknown;
  readonly chainRef?: unknown;
}

export interface TlsMember {
  /** host → 観測、または `null` (HTTPS で到達したが何も明かさなかった)。 */
  readonly hosts: Record<string, ObservedTls | null>;
  /** chainRef → base64 DER の配列 (リーフが先頭)。 */
  readonly chains: Record<string, readonly string[]>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * `datapackage.json` から `browserhive:capture.tls` を取り出す。
 *
 * 形が合わなければ `undefined`。tls は BrowserHive WACZ Profile の**任意 member** なので、不在は
 * 違反ではない —— 呼び出し側は `undefined` を「何も言うことがない」として扱う。
 *
 * `null` ではなく `undefined` なのは、隣の `readCapture` と揃えるため。
 * どちらも「読んだが無かった」で、`readEntry` 自身がそれを `undefined` で表している。
 */
export const readTls = async (wacz: WaczReader): Promise<TlsMember | undefined> => {
  const { parsed: dp } = await datapackageOf(wacz);
  if (dp === null) return undefined;

  const capture = (dp as Record<string, unknown>)["browserhive:capture"];
  if (!isRecord(capture)) return undefined;
  const tls = capture["tls"];
  if (!isRecord(tls)) return undefined;

  const hosts = tls["hosts"];
  const chains = tls["chains"];
  if (!isRecord(hosts) || !isRecord(chains)) return undefined;

  return {
    hosts: hosts as Record<string, ObservedTls | null>,
    chains: chains as Record<string, readonly string[]>,
  };
};

/**
 * base64 DER の配列を証明書へ。1 通でも解析できなければ `null`。
 *
 * `new X509Certificate()` は壊れた入力で **throw する**。rule の中で投げると
 * engine ごと巻き添えになるので、ここで捕まえて「解析できなかった」に変える。
 */
export const parseChain = (chain: readonly string[]): X509Certificate[] | null => {
  const certs: X509Certificate[] = [];
  for (const b64 of chain) {
    if (typeof b64 !== "string") return null;
    try {
      certs.push(new X509Certificate(Buffer.from(b64, "base64")));
    } catch {
      return null;
    }
  }
  return certs.length > 0 ? certs : null;
};

/** 証明書の `subjectAltName` を DNS 名の配列へ。持たない証明書では空。 */
export const dnsNamesOf = (cert: X509Certificate): string[] =>
  (cert.subjectAltName ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("DNS:"))
    .map((part) => part.slice("DNS:".length));

/**
 * DN を 1 行の表示用文字列にする。
 *
 * `X509Certificate` の `subject` / `issuer` は **改行区切り** で返ってくる
 * (`C=US\nO=…\nCN=WE1`)。そのまま message に差し込むと端末で行が割れるので、
 * common name があればそれを、無ければ全体を 1 行へ畳む —— アーカイブ側の
 * `subject` / `issuer` も common name なので、表示が揃う。
 */
export const displayDn = (dn: string): string =>
  /(?:^|\n)CN=(.+)$/m.exec(dn)?.[1]?.trim() ?? dn.split("\n").join(", ");
