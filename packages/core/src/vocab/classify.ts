/**
 * warcinfo の本文の欄の名前が、どの語彙の名前かを決める。
 *
 * - `warc`: WARC 1.1 が warcinfo のために名前を決めた 7 欄。`ref` はその節
 * - `dcterms`: DCMI Metadata Terms の property。`ref` は語の URI（`http://purl.org/dc/terms/<名前>`）
 * - `null`: どちらでもない（作り手が決めた名前。BrowserHive の `robots-policy` など）
 *
 * WARC 1.1 は欄の名前の大文字小文字を区別しないので、照らすときも区別しない。`ref` の URI は、
 * 書かれた綴りでなく DCMI の綴り（`conformsTo`）で組む。
 */
import { DCMI_TERM_NAMES, DCMI_TERMS_NAMESPACE } from "./dcmi-terms.js";
import { WARCINFO_FIELD_NAMES, WARCINFO_SPEC_URL } from "./warcinfo-fields.js";

export type FieldVocabulary = "dcterms" | "warc";

export interface FieldClassification {
  vocabulary: FieldVocabulary | null;
  /** `vocabulary` が `null` のときは無い。 */
  ref?: string;
}

const DCMI_BY_LOWER = new Map(DCMI_TERM_NAMES.map((name) => [name.toLowerCase(), name]));
const WARC_FIELDS = new Set(WARCINFO_FIELD_NAMES);

export const classifyWarcinfoField = (name: string): FieldClassification => {
  const lowered = name.toLowerCase();
  if (WARC_FIELDS.has(lowered)) return { vocabulary: "warc", ref: WARCINFO_SPEC_URL };
  const term = DCMI_BY_LOWER.get(lowered);
  if (term !== undefined) return { vocabulary: "dcterms", ref: `${DCMI_TERMS_NAMESPACE}${term}` };
  return { vocabulary: null };
};
