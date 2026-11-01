/**
 * WARC 1.1 が warcinfo の本文のために名前を決めた欄（'warcinfo' の節）。どれも任意。
 *
 * WARC 1.1 は、warcinfo の本文に使える欄を「DCMI のすべての語と次の欄の定義を含み、それに限らない」と
 * 書く。名前を自分で決めているのはこの 7 つだけで、ほかは DCMI の語か、作り手が決めた名前。
 */
import { WARC11_SPEC_BASE } from "../validate/warc11-fields.js";

export const WARCINFO_FIELD_NAMES: readonly string[] = [
  "operator",
  "software",
  "robots",
  "hostname",
  "ip",
  "http-header-user-agent",
  "http-header-from",
];

/** 7 つの欄を定める節（注釈つき WARC 1.1 の warcinfo）。規則の `docs` と同じ基底。 */
export const WARCINFO_SPEC_URL = `${WARC11_SPEC_BASE}#warcinfo`;
